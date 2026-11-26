import { execFileSync } from "node:child_process";
import { mkdirSync, realpathSync, writeFileSync } from "node:fs";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { eq } from "drizzle-orm";
import { afterEach, describe, expect, it, vi } from "vitest";

/** Identity-file opens and real-path calls Rerail made while `on` is set. */
const fileCalls = vi.hoisted(() => ({ on: false, identityReads: 0, realpaths: 0 }));
vi.mock("node:fs", async importOriginal => {
  const original = await importOriginal<typeof import("node:fs")>();
  const counted = <P extends unknown[], R>(realpath: (...parameters: P) => R) => (...parameters: P): R => {
    if (fileCalls.on) fileCalls.realpaths += 1;
    return realpath(...parameters);
  };
  return {
    ...original,
    realpathSync: Object.assign(counted(original.realpathSync), { native: counted(original.realpathSync.native) }),
    openSync: (...parameters: Parameters<typeof original.openSync>) => {
      // A clone's id lives in Git's common directory, a folder outside Git's in its .rerail folder.
      const name = typeof parameters[0] === "string" ? basename(parameters[0]) : "";
      if (fileCalls.on && (name === "rerail-repository-id" || name === "repository-id")) fileCalls.identityReads += 1;
      return original.openSync(...parameters);
    },
  };
});

import Database from "better-sqlite3";
import { createRerailApi } from "../../src/api/http.js";
import { createRerailMcpHandler } from "../../src/api/mcp.js";
import { operations } from "../../src/api/operations.js";
import { DatabaseApiStores } from "../../src/api/stores.js";
import { CALLER_CWD_HEADER, recordCheckout, repositories } from "../../src/engine/index.js";
import { removeFolder } from "../support/platform/remove-folder.js";

/** Statements run on any connection while `on` is set. */
const statements = { on: false, run: 0 };
{
  const probe = new Database(":memory:");
  const prototype = Object.getPrototypeOf(probe.prepare("SELECT 1")) as Record<string, (...parameters: unknown[]) => unknown>;
  probe.close();
  for (const method of ["run", "get", "all", "iterate"]) {
    const run = prototype[method]!;
    prototype[method] = function (this: unknown, ...parameters: unknown[]) {
      if (statements.on) statements.run += 1;
      return run.apply(this, parameters);
    };
  }
}

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

function gitRepository(path: string, origin: string): string {
  mkdirSync(path, { recursive: true });
  execFileSync("git", ["init", "-q", "-b", "main"], { cwd: path });
  execFileSync("git", ["remote", "add", "origin", origin], { cwd: path });
  return path;
}

/** Stores over a new database, the HTTP API and the MCP endpoint over them, and a started, set-up repository `app`. */
async function daemon() {
  const root = realpathSync.native(await mkdtemp(join(tmpdir(), "rerail-request-lookups-")));
  cleanups.push(() => removeFolder(root));
  const databasePath = join(root, "rerail.sqlite");
  const stores = new DatabaseApiStores(databasePath, {
    health: () => ({ pid: process.pid, database: { path: databasePath, exists: true }, native: { ok: true } }),
    origin: () => "http://127.0.0.1:4737",
  });
  cleanups.push(async () => stores.close());
  const db = stores.database();
  const started = (checkout: string) => {
    const { repositoryKey } = recordCheckout(db, checkout);
    db.update(repositories).set({ started: true, configuredAt: 1 }).where(eq(repositories.repositoryKey, repositoryKey)).run();
    return repositoryKey;
  };
  const main = gitRepository(join(root, "app"), "git@github.com:acme/app.git");
  const repositoryKey = started(main);
  const http = createRerailApi(stores, operations, { version: "0.0.0-test" });
  const mcp = createRerailMcpHandler(stores, operations, { version: "0.0.0-test" });
  return { root, db, main, repositoryKey, started, http, mcp };
}

const presentation = (repository: string) => `/api/presentation?${new URLSearchParams({ repository, host: "claude-code" })}`;

/**
 * What one request costs once the daemon has answered it before: its status, then the statements it ran, the identity
 * files it opened and the real paths it asked for. A list, so a failure prints every count.
 */
async function cost(app: ReturnType<typeof createRerailApi>, path: string): Promise<[number, number, number, number]> {
  await app.request(path);
  statements.run = fileCalls.identityReads = fileCalls.realpaths = 0;
  statements.on = fileCalls.on = true;
  let response: Response;
  try {
    response = await app.request(path);
  } finally {
    statements.on = fileCalls.on = false;
  }
  return [response.status, statements.run, fileCalls.identityReads, fileCalls.realpaths];
}

describe("one request's lookups", () => {
  it("finds the checkout of GET /api/presentation's folder once, for its start state and its scope", async () => {
    const { main, http } = await daemon();
    // Status, statements, identity files, real paths.
    expect(await cost(http, presentation(main))).toEqual([200, 5, 1, 1]);
  });

  it("finds the checkout of GET /api/repository/rules once, for its tag and its answer", async () => {
    const { main, http } = await daemon();
    const rules = `/api/repository/rules?${new URLSearchParams({ checkout: main })}`;
    expect(await cost(http, rules)).toEqual([200, 11, 1, 2]);
  });

  it("answers the next request from what is recorded then: a checkout recorded, a repository stopped, a rule added", async () => {
    const { root, db, main, repositoryKey, started, http } = await daemon();
    const shown = async (folder: string) => await (await http.request(presentation(folder))).json() as { repositoryState: string; scope: unknown };
    const other = gitRepository(join(root, "other"), "git@github.com:acme/other.git");
    expect(await shown(other)).toMatchObject({ repositoryState: "stopped", scope: null });
    const otherKey = started(other);
    expect(await shown(other)).toMatchObject({ repositoryState: "started", scope: { repositoryKey: otherKey, checkoutPath: other } });

    expect(await shown(main)).toMatchObject({ repositoryState: "started" });
    db.update(repositories).set({ started: false }).where(eq(repositories.repositoryKey, repositoryKey)).run();
    expect(await shown(main)).toMatchObject({ repositoryState: "stopped" });

    // The tag of a checkout's rules reads its own rules folder: a rule added there is a new answer, not a 304.
    const rules = `/api/repository/rules?${new URLSearchParams({ checkout: main })}`;
    const tag = (await http.request(rules)).headers.get("etag")!;
    const again = (await http.request(rules, { headers: { "if-none-match": tag } })).status;
    mkdirSync(join(main, ".rerail", "rules"), { recursive: true });
    writeFileSync(join(main, ".rerail", "rules", "local.json"), JSON.stringify({
      format: "rerail.policy/v1", id: "local-needle", revision: 1, mode: "steer", description: "Keep NEEDLE out of Python files.",
      scope: { include: ["**/*.py"], exclude: [] },
      clauses: [{ id: "needle", violation: { code: "NEEDLE", anchor: "witness.span", message: "No NEEDLE" }, forbid: { regex: { pattern: "NEEDLE", source: "file.content" } } }],
    }));
    const after = await http.request(rules, { headers: { "if-none-match": tag } });
    expect([again, after.status, after.headers.get("etag") === tag]).toEqual([304, 200, false]);
  });

  it("never answers one coding agent's call from another's, however their calls interleave", async () => {
    const { root, main, repositoryKey, started, mcp } = await daemon();
    const other = gitRepository(join(root, "other"), "git@github.com:acme/other.git");
    const otherKey = started(other);
    const call = async (cwd: string, repository: string) => {
      const response = await mcp(new Request("http://localhost:4737/mcp", {
        method: "POST",
        headers: { host: "localhost:4737", "content-type": "application/json", accept: "application/json, text/event-stream", [CALLER_CWD_HEADER]: encodeURIComponent(cwd) },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "presentation_get", arguments: { repository, host: "omp" } } }),
      }));
      const { result } = await response.json() as { result: { isError?: boolean; structuredContent?: { scope: { repositoryKey: string } }; content: Array<{ text: string }> } };
      return result.isError === true ? result.content[0]!.text.split(":")[0] : result.structuredContent!.scope.repositoryKey;
    };
    const asked: Array<[string, string]> = [[main, main], [other, other], [main, other], [other, main]];
    const expected = [repositoryKey, otherKey, "agent-not-permitted", "agent-not-permitted"];
    expect(await Promise.all([...asked, ...asked].map(([cwd, repository]) => call(cwd, repository)))).toEqual([...expected, ...expected]);
    for (const [index, [cwd, repository]] of asked.entries()) expect(await call(cwd, repository)).toBe(expected[index]);
  });
});
