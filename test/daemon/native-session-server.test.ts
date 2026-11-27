import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { NativeSessionServer } from "../../src/daemon/native-session-server.js";
import { NativeSessionClient } from "../../src/harness/index.js";
import { RerailRuntime, SqliteSessionReader } from "../../src/runtime/index.js";
import { CodeRuleBridge, RepositoryWorktreeWalks, SqliteAuditStore } from "../../src/engine/index.js";
import { closeNativeTestDaemons, startNativeTestDaemon } from "../support/native-daemon.js";
import { removeFolder } from "../support/platform/remove-folder.js";
import { startTestRepository, stopTestRepository } from "../support/started-repository.js";

describe("NativeSessionServer request boundary", () => {
  let root: string | undefined;
  let server: NativeSessionServer | undefined;

  afterEach(async () => {
    await server?.close();
    vi.useRealTimers();
    if (root !== undefined) await removeFolder(root);
    vi.unstubAllEnvs();
  });

  it("rejects a request addressed to another checkout", async () => {
    root = await mkdtemp(join(tmpdir(), "rerail-native-server-"));
    vi.stubEnv("RERAIL_HOME", join(root, "home"));
    server = new NativeSessionServer({
      workspaceRoot: root,
      modelPath: join(root, "model"),
      databasePath: join(root, "rerail.sqlite"),
    });

    await expect(server.handle({
      workspaceRoot: join(root, "other"), sessionId: "s", host: "omp", operation: "close",
    })).rejects.toThrow("native workspace mismatch");
    await server.close();
  });

  it("counts acknowledged steers once in the session HUD", async () => {
    root = await mkdtemp(join(tmpdir(), "rerail-native-server-"));
    vi.stubEnv("RERAIL_HOME", join(root, "home"));
    startTestRepository(root, join(root, "rerail.sqlite"));
    const databasePath = join(root, "rerail.sqlite");
    server = new NativeSessionServer({
      workspaceRoot: root,
      modelPath: resolve("model"),
      databasePath,
    });
    const reader = new SqliteSessionReader(databasePath);
    const session = { workspaceRoot: root, sessionId: "s", host: "omp" as const };
    try {
      await server.handle({ ...session, operation: "initialize", entries: [] });
      expect(reader.hud("s").steeringCount).toBe(0);
      const receipt = { ...session, operation: "record-steering-delivery" as const, input: { receiptId: "host-steer", ruleIds: [] } };
      await server.handle(receipt);
      await server.handle(receipt);
      expect(reader.hud("s").steeringCount).toBe(1);
      await server.handle({
        ...session,
        operation: "record-steering-delivery" as const,
        input: { receiptId: "attributed-steer", ruleIds: ["rerail:no-raw-sql"] },
      });
      expect(reader.hud("s").steeringCount).toBe(2);
      expect(reader.events("s").filter(event => event.kind === "steering-delivered").map(event => event.payload)).toEqual([
        { ruleIds: [] },
        { ruleIds: ["rerail:no-raw-sql"] },
      ]);
    } finally {
      reader.close();
    }
  });

  it("writes how long initialize took to answer and how long the code-rule evaluator took to open, with the session id, to the daemon log", async () => {
    root = await mkdtemp(join(tmpdir(), "rerail-native-server-"));
    vi.stubEnv("RERAIL_HOME", join(root, "home"));
    const databasePath = join(root, "rerail.sqlite");
    startTestRepository(root, databasePath);
    server = new NativeSessionServer({ workspaceRoot: root, modelPath: resolve("model"), databasePath });
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    try {
      await server.handle({ workspaceRoot: root, sessionId: "timed-session", host: "omp", operation: "initialize", entries: [] });
      const lines = () => stderr.mock.calls.map(([chunk]) => String(chunk));
      expect(lines().filter(line => line.includes("initialized"))).toEqual([
        expect.stringMatching(/^rerail: session timed-session initialized in \d+ ms\n$/u),
      ]);
      // The evaluator opens behind the answer.
      await vi.waitFor(() => expect(lines().filter(line => line.includes("code-rule evaluator"))).toEqual([
        expect.stringMatching(/^rerail: code-rule evaluator of session timed-session opened in \d+ ms\n$/u),
      ]));
    } finally {
      stderr.mockRestore();
    }
  });

  it("records a dropped-events gap in the session's history", async () => {
    root = await mkdtemp(join(tmpdir(), "rerail-native-server-"));
    vi.stubEnv("RERAIL_HOME", join(root, "home"));
    const databasePath = join(root, "rerail.sqlite");
    startTestRepository(root, databasePath);
    server = new NativeSessionServer({ workspaceRoot: root, modelPath: resolve("model"), databasePath });
    const reader = new SqliteSessionReader(databasePath);
    const session = { workspaceRoot: root, sessionId: "s", host: "omp" as const };
    const gap = {
      id: "gap-1", count: 3, kinds: { "user-prompt": 1, call: 2 }, firstEventId: "input:1", lastEventId: "tool-call:2",
      firstDroppedAt: 1_000, lastDroppedAt: 2_000,
    };
    try {
      await server.handle({ ...session, operation: "initialize", entries: [] });
      await expect(server.handle({ ...session, operation: "record-gap", input: { ...gap, count: 0 } })).rejects.toThrow();
      await server.handle({ ...session, operation: "record-gap", input: gap });
      // A record sent again after its acknowledgement was lost is stored once.
      await server.handle({ ...session, operation: "record-gap", input: gap });
      expect(reader.events("s").filter(event => event.kind === "events-dropped")).toEqual([
        expect.objectContaining({ eventId: "events-dropped:gap-1", payload: gap }),
      ]);
    } finally {
      reader.close();
    }
  });

  it("answers initialize before the session's code-rule evaluator opens, and holds a tool call until it has", async () => {
    root = await mkdtemp(join(tmpdir(), "rerail-native-server-"));
    vi.stubEnv("RERAIL_HOME", join(root, "home"));
    const databasePath = join(root, "rerail.sqlite");
    startTestRepository(root, databasePath);
    const opening = Promise.withResolvers<void>();
    const open = CodeRuleBridge.prototype.openWorkspace;
    const spy = vi.spyOn(CodeRuleBridge.prototype, "openWorkspace").mockImplementationOnce(async function (this: CodeRuleBridge, sessionId: string) {
      await opening.promise;
      await open.call(this, sessionId);
    });
    server = new NativeSessionServer({ workspaceRoot: root, modelPath: resolve("model"), databasePath });
    const session = { workspaceRoot: root, sessionId: "s", host: "omp" as const };
    try {
      await server.handle({ ...session, operation: "initialize", entries: [] });
      let called = false;
      const call = server.handle({
        ...session, operation: "ingest",
        event: { kind: "call", eventId: "call", sessionId: "s", toolCallId: "write", toolName: "write", input: { path: "a.py" } },
      }).finally(() => { called = true; });
      await new Promise<void>(resolve => setImmediate(resolve));
      expect(called).toBe(false);
      opening.resolve();
      await call;
    } finally {
      opening.resolve();
      spy.mockRestore();
    }
  });

  describe("while the session's code-rule evaluator is still opening", () => {
    async function held(realOpen = false) {
      root = await mkdtemp(join(tmpdir(), "rerail-native-server-"));
      vi.stubEnv("RERAIL_HOME", join(root, "home"));
      const databasePath = join(root, "rerail.sqlite");
      startTestRepository(root, databasePath);
      const opening = Promise.withResolvers<void>();
      // The held evaluator opens when released (really, when `realOpen`); that the bridge it opens for is closed is under test.
      const open = CodeRuleBridge.prototype.openWorkspace;
      const openSpy = vi.spyOn(CodeRuleBridge.prototype, "openWorkspace").mockImplementationOnce(async function (this: CodeRuleBridge, sessionId: string) {
        await opening.promise;
        if (realOpen) await open.call(this, sessionId);
      });
      const closeSpy = vi.spyOn(CodeRuleBridge.prototype, "close");
      server = new NativeSessionServer({ workspaceRoot: root, modelPath: resolve("model"), databasePath });
      return {
        opening, closeSpy, databasePath,
        session: { workspaceRoot: root, sessionId: "s", host: "omp" as const },
        restore: () => { opening.resolve(); openSpy.mockRestore(); closeSpy.mockRestore(); },
      };
    }

    it("releases the evaluator it closed over while its stores are still open, and waits for that when the server closes", async () => {
      const { opening, closeSpy, session, restore } = await held(true);
      try {
        await server!.handle({ ...session, operation: "initialize", entries: [] });
        await server!.handle({ ...session, operation: "close" });
        opening.resolve();
        await vi.waitFor(() => expect(closeSpy).toHaveBeenCalledTimes(1), { timeout: 20_000 });
        await server!.close();
        await expect(closeSpy.mock.results[0]!.value).resolves.toBeUndefined();
      } finally {
        restore();
      }
    }, 30_000);

    it("closes the session without waiting for it, and the evaluator is closed once it has opened", async () => {
      const { opening, closeSpy, session, restore } = await held();
      try {
        await server!.handle({ ...session, operation: "initialize", entries: [] });
        let closed = false;
        const closing = server!.handle({ ...session, operation: "close" }).then(() => { closed = true; });
        await vi.waitFor(() => expect(closed).toBe(true), { timeout: 20_000 });
        await closing;
        expect(closeSpy).not.toHaveBeenCalled();
        opening.resolve();
        await vi.waitFor(() => expect(closeSpy).toHaveBeenCalledTimes(1), { timeout: 20_000 });
      } finally {
        restore();
      }
    }, 30_000);

    it("replaces the session without waiting for it, and the old evaluator is closed once it has opened", async () => {
      const { opening, closeSpy, databasePath, session, restore } = await held();
      try {
        await server!.handle({ ...session, operation: "initialize", entries: [] });
        let replaced = false;
        const replacing = server!.handle({ ...session, operation: "initialize", entries: [], input: { rebuild: true } }).then(() => { replaced = true; });
        await vi.waitFor(() => expect(replaced).toBe(true), { timeout: 20_000 });
        await replacing;
        expect(closeSpy).not.toHaveBeenCalled();
        opening.resolve();
        await vi.waitFor(() => expect(closeSpy).toHaveBeenCalledTimes(1), { timeout: 20_000 });
        const reader = new SqliteSessionReader(databasePath);
        try {
          expect(reader.sessions().find(recorded => recorded.sessionId === "s")?.endedAt).toBeNull();
        } finally {
          reader.close();
        }
      } finally {
        restore();
      }
    }, 30_000);

    it("ends the audits of the session it replaces at the replace, before the old open finishes", async () => {
      const { opening, databasePath, session, restore } = await held();
      const audits = new SqliteAuditStore(databasePath);
      try {
        await server!.handle({ ...session, operation: "initialize", entries: [] });
        const orphan = audits.start({
          sessionId: "s", workspaceRoot: root!, scope: "repository", mode: "log",
          revision: 0, catalogRevision: null, ruleRevisions: [], paths: [],
        });
        await server!.handle({ ...session, operation: "initialize", entries: [], input: { rebuild: true } });
        expect(audits.get(orphan)?.status).toBe("interrupted");
      } finally {
        audits.close();
        restore();
        opening.resolve();
      }
    }, 30_000);
  });

  it("closes the session a rebuild replaces while the checkout is stopped", async () => {
    root = await mkdtemp(join(tmpdir(), "rerail-native-server-"));
    vi.stubEnv("RERAIL_HOME", join(root, "home"));
    const databasePath = join(root, "rerail.sqlite");
    startTestRepository(root, databasePath);
    server = new NativeSessionServer({ workspaceRoot: root, modelPath: resolve("model"), databasePath });
    const session = { workspaceRoot: root, sessionId: "s", host: "omp" as const };
    await server.handle({ ...session, operation: "initialize", entries: [] });
    // `/rerail-stop` stops the checkout, then the host reattaches with a rebuild.
    stopTestRepository(root, databasePath);
    await server.handle({ ...session, operation: "initialize", entries: [], input: { rebuild: true } });
    const reader = new SqliteSessionReader(databasePath);
    try {
      expect(reader.sessions().find(recorded => recorded.sessionId === "s")?.endedAt).not.toBeNull();
    } finally {
      reader.close();
    }
  });

  it("retires an abandoned session and closes its session store resources after the lease", async () => {
    vi.useFakeTimers();
    root = await mkdtemp(join(tmpdir(), "rerail-native-server-"));
    vi.stubEnv("RERAIL_HOME", join(root, "home"));
    startTestRepository(root, join(root, "rerail.sqlite"));
    const databasePath = join(root, "rerail.sqlite");
    server = new NativeSessionServer({
      workspaceRoot: root,
      modelPath: resolve("model"),
      databasePath,
      sessionLeaseMs: 1_000,
      sessionSweepIntervalMs: 100,
    });
    const request = { workspaceRoot: root, sessionId: "abandoned", host: "omp" as const };
    await server.handle({
      ...request,
      operation: "initialize",
      entries: [],
      input: { cwd: root, rules: [] },
    });

    await vi.advanceTimersByTimeAsync(1_100);

    await expect(server.handle({ ...request, operation: "poll" })).rejects.toThrow("native session is not initialized");
    const reader = new SqliteSessionReader(databasePath);
    expect(reader.sessions()).toContainEqual(expect.objectContaining({
      sessionId: "abandoned",
      endedAt: expect.any(Number),
    }));
    reader.close();
  });

  it("keeps a resident session alive while its host continues polling", async () => {
    vi.useFakeTimers();
    root = await mkdtemp(join(tmpdir(), "rerail-native-server-"));
    vi.stubEnv("RERAIL_HOME", join(root, "home"));
    startTestRepository(root, join(root, "rerail.sqlite"));
    const databasePath = join(root, "rerail.sqlite");
    server = new NativeSessionServer({
      workspaceRoot: root,
      modelPath: resolve("model"),
      databasePath,
      sessionLeaseMs: 1_000,
      sessionSweepIntervalMs: 100,
    });
    const request = { workspaceRoot: root, sessionId: "active", host: "omp" as const };
    await server.handle({
      ...request,
      operation: "initialize",
      entries: [],
      input: { cwd: root, rules: [] },
    });

    for (let heartbeat = 0; heartbeat < 3; heartbeat += 1) {
      await vi.advanceTimersByTimeAsync(750);
      await expect(server.handle({ ...request, operation: "poll" })).resolves.toMatchObject({
        deliveries: [],
      });
    }

    const reader = new SqliteSessionReader(databasePath);
    expect(reader.sessions()).toContainEqual(expect.objectContaining({
      sessionId: "active",
      endedAt: null,
    }));
    reader.close();
  });

  it("makes no sweep timer until a session opens, and drops it once no open session can run out of lease", async () => {
    vi.useFakeTimers();
    root = await mkdtemp(join(tmpdir(), "rerail-native-server-"));
    vi.stubEnv("RERAIL_HOME", join(root, "home"));
    const databasePath = join(root, "rerail.sqlite");
    startTestRepository(root, databasePath);
    const intervals = vi.spyOn(globalThis, "setInterval");
    const cleared = vi.spyOn(globalThis, "clearInterval");
    server = new NativeSessionServer({ workspaceRoot: root, modelPath: resolve("model"), databasePath, sessionLeaseMs: 1_000, sessionSweepIntervalMs: 100 });
    const sweeps = (): unknown[] => intervals.mock.calls.flatMap((call, index) => (call[1] === 100 ? [intervals.mock.results[index]!.value] : []));
    expect(sweeps()).toEqual([]);

    const request = { workspaceRoot: root, sessionId: "swept", host: "pi" as const };
    await server.handle({ ...request, operation: "initialize", entries: [], input: { cwd: root, rules: [] } });
    expect(sweeps()).toHaveLength(1);
    await server.handle({ ...request, operation: "close" });
    await vi.advanceTimersByTimeAsync(100);

    expect(cleared).toHaveBeenCalledWith(sweeps()[0]);
    expect(sweeps()).toHaveLength(1);
  });

  it("answers a new session's first ask for deliveries at once, holds the next after a poll whatever the time, and answers it when the session closes", async () => {
    vi.useFakeTimers();
    root = await mkdtemp(join(tmpdir(), "rerail-native-server-"));
    vi.stubEnv("RERAIL_HOME", join(root, "home"));
    const databasePath = join(root, "rerail.sqlite");
    startTestRepository(root, databasePath);
    server = new NativeSessionServer({ workspaceRoot: root, modelPath: resolve("model"), databasePath });
    const request = { workspaceRoot: root, sessionId: "asking", host: "pi" as const };
    await server.handle({ ...request, operation: "initialize", entries: [], input: { cwd: root, rules: [] } });

    await expect(server.handle({ ...request, operation: "await-deliveries" })).resolves.toEqual({ deliveries: [], entries: [] });
    await expect(server.handle({ ...request, operation: "poll" })).resolves.toMatchObject({ deliveries: [], waitForDeliveries: true });
    let answered = false;
    const asking = server.handle({ ...request, operation: "await-deliveries" }).then((reply) => {
      answered = true;
      return reply;
    });
    await vi.advanceTimersByTimeAsync(600_000);
    expect(answered).toBe(false);

    await server.handle({ ...request, operation: "close" });
    await expect(asking).resolves.toEqual({ deliveries: [], entries: [] });
  });

  it("keeps a session whose ask is held past its lease, and retires it a lease after the ask's client goes away", async () => {
    vi.useFakeTimers();
    root = await mkdtemp(join(tmpdir(), "rerail-native-server-"));
    vi.stubEnv("RERAIL_HOME", join(root, "home"));
    const databasePath = join(root, "rerail.sqlite");
    startTestRepository(root, databasePath);
    server = new NativeSessionServer({ workspaceRoot: root, modelPath: resolve("model"), databasePath, sessionLeaseMs: 1_000, sessionSweepIntervalMs: 100 });
    const request = { workspaceRoot: root, sessionId: "held", host: "pi" as const };
    // A session beside it that holds no ask keeps the sweep going, and runs out of lease as an abandoned one does.
    const beside = { ...request, sessionId: "beside" };
    await server.handle({ ...request, operation: "initialize", entries: [], input: { cwd: root, rules: [] } });
    await server.handle({ ...beside, operation: "initialize", entries: [], input: { cwd: root, rules: [] } });
    await server.handle({ ...request, operation: "poll" });
    // As the daemon's route calls it: with the signal the request's connection ends.
    const route: (input: unknown, signal?: AbortSignal) => Promise<unknown> = server.handle.bind(server);
    const connection = new AbortController();
    const asking = route({ ...request, operation: "await-deliveries" }, connection.signal);
    const ended = (sessionId: string): unknown => {
      const reader = new SqliteSessionReader(databasePath);
      try {
        return reader.sessions().find(recorded => recorded.sessionId === sessionId)?.endedAt;
      } finally {
        reader.close();
      }
    };

    await vi.advanceTimersByTimeAsync(5_000);
    // In the session's lane, behind the sweep's close: it answers once that close has recorded the session's end.
    await expect(server.handle({ ...beside, operation: "poll" })).rejects.toThrow("native session is not initialized");
    expect(ended("beside")).toEqual(expect.any(Number));
    expect(ended("held")).toBeNull();

    connection.abort();
    await expect(asking).resolves.toEqual({ deliveries: [], entries: [] });
    await vi.advanceTimersByTimeAsync(900);
    expect(ended("held")).toBeNull();
    await vi.advanceTimersByTimeAsync(200);
    await expect(server.handle({ ...request, operation: "poll" })).rejects.toThrow("native session is not initialized");
    expect(ended("held")).toEqual(expect.any(Number));
  });

  it("answers an operation that outlasts the reply bound with a ticket, and collects it, and the one queued behind it, in order", async () => {
    root = await mkdtemp(join(tmpdir(), "rerail-native-server-"));
    vi.stubEnv("RERAIL_HOME", join(root, "home"));
    const databasePath = join(root, "rerail.sqlite");
    startTestRepository(root, databasePath);
    server = new NativeSessionServer({ workspaceRoot: root, modelPath: resolve("model"), databasePath, replyWithinMs: 20 });
    const session = { workspaceRoot: root, sessionId: "s", host: "omp" as const };
    const busy = Promise.withResolvers<void>();
    const ingest = RerailRuntime.prototype.ingest;
    const spy = vi.spyOn(RerailRuntime.prototype, "ingest").mockImplementation(async function (this: RerailRuntime, event) {
      if (event.eventId === "slow" || event.eventId === "broken") await busy.promise;
      if (event.eventId === "broken") throw new Error("content store busy");
      return ingest.call(this, event);
    });
    const prompt = (eventId: string) => ({
      ...session, operation: "ingest" as const, deferReply: true,
      event: { kind: "user-prompt", sessionId: "s", eventId, text: eventId },
    });
    const ticketOf = (reply: unknown) => z.object({ pendingReply: z.string(), deliveries: z.tuple([]), entries: z.tuple([]) }).parse(reply).pendingReply;
    const awaitReply = (ticket: string) => server!.handle({ ...session, operation: "await-reply", input: { ticket } });
    /** As the client does: asks again while the daemon is still working on it. */
    const collect = async (ticket: string): Promise<unknown> => {
      for (;;) {
        const reply = await awaitReply(ticket);
        if (z.object({ pendingReply: z.string() }).safeParse(reply).success) continue;
        return reply;
      }
    };
    const reader = new SqliteSessionReader(databasePath);
    try {
      await server.handle({ ...session, operation: "initialize", entries: [] });
      const slow = ticketOf(await server.handle(prompt("slow")));
      // Queued behind the slow one in the session's lane, it is still waiting when its bound runs out too.
      const next = ticketOf(await server.handle(prompt("next")));
      const broken = ticketOf(await server.handle(prompt("broken")));
      expect(ticketOf(await awaitReply(slow))).toBe(slow);
      busy.resolve();
      await expect(collect(slow)).resolves.toEqual({ deliveries: [], entries: [] });
      await expect(collect(next)).resolves.toEqual({ deliveries: [], entries: [] });
      await expect(collect(broken)).rejects.toThrow("content store busy");
      expect(reader.events("s").filter(event => event.kind === "user-prompt").map(event => event.eventId)).toEqual(["slow", "next"]);
      // A collected reply is forgotten.
      await expect(awaitReply(slow)).rejects.toThrow("native deferred reply is unknown");
    } finally {
      busy.resolve();
      spy.mockRestore();
      reader.close();
    }
  });

  it("answers await-code-rules once the session's evaluator has opened, while the session's events go on", async () => {
    root = await mkdtemp(join(tmpdir(), "rerail-native-server-"));
    vi.stubEnv("RERAIL_HOME", join(root, "home"));
    const databasePath = join(root, "rerail.sqlite");
    startTestRepository(root, databasePath);
    const opening = Promise.withResolvers<void>();
    const open = CodeRuleBridge.prototype.openWorkspace;
    const spy = vi.spyOn(CodeRuleBridge.prototype, "openWorkspace").mockImplementationOnce(async function (this: CodeRuleBridge, sessionId: string) {
      await opening.promise;
      await open.call(this, sessionId);
    });
    server = new NativeSessionServer({ workspaceRoot: root, modelPath: resolve("model"), databasePath, replyWithinMs: 20 });
    const session = { workspaceRoot: root, sessionId: "s", host: "omp" as const };
    const pending = z.object({ pendingReply: z.string() });
    try {
      await server.handle({ ...session, operation: "initialize", entries: [] });
      const ticket = pending.parse(await server.handle({ ...session, operation: "await-code-rules", deferReply: true })).pendingReply;
      // Not in the session's lane: a prompt goes through while the evaluator is still opening.
      await server.handle({ ...session, operation: "ingest", event: { kind: "user-prompt", sessionId: "s", eventId: "p", text: "hi" } });
      expect(pending.safeParse(await server.handle({ ...session, operation: "await-reply", input: { ticket } })).success).toBe(true);
      opening.resolve();
      for (;;) {
        const reply = await server.handle({ ...session, operation: "await-reply", input: { ticket } });
        if (pending.safeParse(reply).success) continue;
        expect(reply).toEqual({ deliveries: [], entries: [] });
        break;
      }
    } finally {
      opening.resolve();
      spy.mockRestore();
    }
  });

  it("walks a session's other worktrees with the walks it was given, which the daemon's hook sessions share", async () => {
    root = await mkdtemp(join(tmpdir(), "rerail-native-server-"));
    vi.stubEnv("RERAIL_HOME", join(root, "home"));
    const databasePath = join(root, "rerail.sqlite");
    startTestRepository(root, databasePath);
    const worktreeWalks = new RepositoryWorktreeWalks();
    const of = vi.spyOn(worktreeWalks, "of");
    server = new NativeSessionServer({ workspaceRoot: root, modelPath: resolve("model"), databasePath, worktreeWalks });
    const session = { workspaceRoot: root, sessionId: "s", host: "omp" as const };
    await server.handle({ ...session, operation: "initialize", entries: [] });
    await server.handle({ ...session, operation: "await-code-rules" });
    // The session looks its repository's walk up at its first walk, which a prompt's boundary asks for.
    await server.handle({ ...session, operation: "ingest", event: { kind: "user-prompt", sessionId: "s", eventId: "p", text: "hi" } });
    await vi.waitFor(() => expect(of).toHaveBeenCalledTimes(1), { timeout: 10_000 });
  });
});

describe("native sessions at rest", () => {
  const directories: string[] = [];

  afterEach(async () => {
    await closeNativeTestDaemons();
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
    for (const path of directories.splice(0)) await removeFolder(path);
  });

  it("cost the daemon no request and no timer between two prompts, however far apart, with ten sessions open", async () => {
    vi.useFakeTimers();
    vi.spyOn(process.stderr, "write").mockReturnValue(true);
    const root = await mkdtemp(join(tmpdir(), "rerail-native-idle-"));
    directories.push(root);
    vi.stubEnv("RERAIL_HOME", join(root, "home"));
    const databasePath = join(root, "rerail.sqlite");
    startTestRepository(root, databasePath);
    const server = new NativeSessionServer({ workspaceRoot: root, modelPath: resolve("model"), databasePath });
    // The daemon's HTTP route, in process: each request reaches the server with its connection's signal.
    const route: (input: unknown, signal?: AbortSignal) => Promise<unknown> = server.handle.bind(server);
    const asked: string[] = [];
    vi.stubGlobal("fetch", async (_url: URL, init: RequestInit) => {
      const request = z.object({ operation: z.string() }).passthrough().parse(JSON.parse(String(init.body)));
      asked.push(request.operation);
      try {
        return Response.json(await route(request, init.signal ?? undefined));
      } catch (error) {
        return Response.json({ error: "native-request-invalid", message: error instanceof Error ? error.message : String(error) }, { status: 400 });
      }
    });
    // The timers the native session client and server make, each told by the frame that made it, as the daemon-cost
    // measures counted them; a session's runtime keeps timers of its own (its control poll, its walks) on clocks of
    // their own, which this case does not judge.
    const makers: string[] = [];
    const maker = (stack: string): string =>
      stack.split("\n").slice(1).find(frame => !frame.includes("native-session-server.test.ts") && !frame.includes("node_modules")) ?? "";
    const timeout = globalThis.setTimeout;
    const interval = globalThis.setInterval;
    vi.spyOn(globalThis, "setTimeout").mockImplementation(((...args: Parameters<typeof setTimeout>) => {
      makers.push(maker(new Error().stack ?? ""));
      return timeout(...args);
    }) as typeof setTimeout);
    vi.spyOn(globalThis, "setInterval").mockImplementation(((...args: Parameters<typeof setInterval>) => {
      makers.push(maker(new Error().stack ?? ""));
      return interval(...args);
    }) as typeof setInterval);
    const made = (): number => makers.filter(frame => /native-session-(?:client|server)|delivery-wait/u.test(frame)).length;
    const sessionIds = Array.from({ length: 10 }, (_, index) => `idle-${index}`);
    const clients = sessionIds.map(sessionId => new NativeSessionClient({
      instance: { workspaceRoot: root, url: new URL("http://127.0.0.1:4737") },
      token: "native-token",
      host: "pi", sessionId, entries: () => [],
      appendEntry() {},
      deliver() {},
    }));
    const tally = (operations: readonly string[]): Record<string, number> =>
      operations.reduce<Record<string, number>>((counts, operation) => ({ ...counts, [operation]: (counts[operation] ?? 0) + 1 }), {});
    try {
      for (const client of clients) {
        await client.initialize({ cwd: root, modelPath: resolve("model"), rules: [] });
        await client.activate();
      }
      await vi.advanceTimersByTimeAsync(1_000);
      /** What the ten sessions cost the daemon from one prompt each to the next, `apart` ms later. */
      const fromPromptToNext = async (round: string, apart: number): Promise<{ requests: Record<string, number>; timers: number }> => {
        const [requestsBefore, timersBefore] = [asked.length, made()];
        await Promise.all(clients.map(async (client, index) => await client.ingest({
          kind: "user-prompt", sessionId: sessionIds[index]!, eventId: `${round}-${index}`, text: round,
        })));
        await vi.advanceTimersByTimeAsync(apart);
        return { requests: tally(asked.slice(requestsBefore)), timers: made() - timersBefore };
      };

      const near = await fromPromptToNext("near", 1_000);
      const far = await fromPromptToNext("far", 60_000);

      // Only the prompts reached the daemon, and a minute apart cost what a second apart did.
      expect(near.requests).toEqual({ ingest: 10 });
      expect(far).toEqual(near);
    } finally {
      for (const client of clients) await client.close();
      await server.close();
    }
  }, 60_000);

  it("end the ask the daemon holds for a session when the connection that sent it closes", async () => {
    vi.spyOn(process.stderr, "write").mockReturnValue(true);
    const root = await mkdtemp(join(tmpdir(), "rerail-native-idle-connection-"));
    directories.push(root);
    vi.stubEnv("RERAIL_HOME", join(root, "home"));
    startTestRepository(root);
    const daemon = await startNativeTestDaemon(root);
    // What the daemon's route hands the server with the ask: the signal its connection ends.
    const asked = Promise.withResolvers<AbortSignal>();
    const handle: (this: NativeSessionServer, input: unknown, signal?: AbortSignal) => Promise<unknown> = NativeSessionServer.prototype.handle;
    vi.spyOn(NativeSessionServer.prototype, "handle").mockImplementation(function (this: NativeSessionServer, input: unknown, signal?: AbortSignal) {
      if (z.object({ operation: z.literal("await-deliveries") }).safeParse(input).success && signal !== undefined) asked.resolve(signal);
      return handle.call(this, input, signal);
    });
    const session = { workspaceRoot: root, sessionId: "idle-connection", host: "pi" };
    const send = (body: object, signal?: AbortSignal): Promise<Response> => fetch(new URL("/native/session", daemon.url), {
      method: "POST",
      // The daemon's access capability, as daemon.test.ts sends it, and the native token.
      headers: { "content-type": "application/json", "x-rerail-access": daemon.state().accessToken!, authorization: `Bearer ${daemon.state().nativeToken!}` },
      body: JSON.stringify({ ...session, ...body }),
      ...(signal === undefined ? {} : { signal }),
    });
    expect((await send({ operation: "initialize", entries: [], input: { cwd: root, modelPath: resolve("model"), rules: [] } })).status).toBe(200);
    // A poll takes what the new session owes, so its next ask is held.
    expect((await send({ operation: "poll" })).status).toBe(200);
    const connection = new AbortController();
    const asking = send({ operation: "await-deliveries" }, connection.signal);
    const held = await asked.promise;
    expect(held.aborted).toBe(false);

    connection.abort();
    await expect(asking).rejects.toThrow();

    await new Promise<void>(resolve => {
      if (held.aborted) resolve();
      else held.addEventListener("abort", () => resolve(), { once: true });
    });
    expect(held.aborted).toBe(true);
  }, 30_000);
});
