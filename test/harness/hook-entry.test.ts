import { spawnSync } from "node:child_process";
import { existsSync, realpathSync } from "node:fs";
import { chmod, mkdir, mkdtemp, realpath, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { HOOK_COMPILE_CACHE_DIR } from "../../src/engine/index.js";
import { removeFolder } from "../support/platform/remove-folder.js";

const WINDOWS = process.platform === "win32";
const HOOK_ENTRY = pathToFileURL(resolve(import.meta.dirname, "../../src/harness/hook-entry.ts")).href;

/** A hook's entry as the build writes it: the file set-up registers, which loads the hook's bundle beside it. */
const ENTRY = `import { loadHook } from ${JSON.stringify(HOOK_ENTRY)};\nawait loadHook(import.meta.url, "./claude-hook-bundle.mjs");\n`;

/** Stands in for the hook's bundle: reports Node's compile cache folder, or null where it is off, and its argv[1]. */
const BUNDLE = [
  'import { getCompileCacheDir } from "node:module";',
  "process.stdout.write(JSON.stringify({ cache: getCompileCacheDir() ?? null, argv1: process.argv[1] }));",
].join("\n");

const temporaryDirectories: string[] = [];
afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map(path => removeFolder(path)));
});

interface Place {
  base: string;
  entry: string;
  bundle: string;
  home: string;
}

/** The entry and bundle of a hook, a temporary folder (`tmp`) and a Rerail home (`rerail-home`) for one test. */
async function place(): Promise<Place> {
  const base = await mkdtemp(join(tmpdir(), "rerail-hook-entry-"));
  temporaryDirectories.push(base);
  const entry = join(base, "claude-hook.mjs");
  const bundle = join(base, "claude-hook-bundle.mjs");
  await writeFile(entry, ENTRY);
  await writeFile(bundle, BUNDLE);
  await mkdir(join(base, "tmp"));
  const home = join(base, "rerail-home");
  await mkdir(home);
  return { base, entry, bundle: await realpath(bundle), home };
}

interface Ran {
  status: number | null;
  cache: string | null;
  argv1: string | null;
  stderr: string;
}

/**
 * `node <script>` as a coding agent starts a hook, with the place's temporary folder and Rerail home and none of the
 * caller's cache settings.
 */
function run(at: Place, script: string, env: NodeJS.ProcessEnv = {}): Ran {
  const temp = join(at.base, "tmp");
  const { NODE_COMPILE_CACHE: _cache, NODE_DISABLE_COMPILE_CACHE: _off, ...caller } = process.env;
  const result = spawnSync(process.execPath, ["--import", "tsx", script], {
    input: "{}",
    encoding: "utf8",
    env: { ...caller, TMPDIR: temp, TMP: temp, TEMP: temp, RERAIL_HOME: at.home, ...env },
  });
  const answer = JSON.parse(result.stdout || "{}") as { cache?: string | null; argv1?: string };
  // Node gives a module its path with links followed (a short Windows name or macOS's /var among them).
  const argv1 = answer.argv1 === undefined ? null : realpathSync(answer.argv1);
  return { status: result.status, cache: answer.cache ?? null, argv1, stderr: result.stderr };
}

describe("a hook's entry", () => {
  // The bundle serves the hook only when it is the launched script, as if `node <bundle>` had started it.
  it("loads the hook's bundle as the script node was started with", async () => {
    const at = await place();
    const { status, argv1, stderr } = run(at, at.entry);
    expect(status, stderr).toBe(0);
    expect(argv1).toBe(at.bundle);
  }, 30_000);

  it("turns Node's compile cache on before the bundle loads: in the Rerail home on macOS and Linux, Node's own folder on Windows", async () => {
    const at = await place();
    const { cache, stderr } = run(at, at.entry);
    expect(cache, stderr).not.toBeNull();
    const folder = WINDOWS ? join(at.base, "tmp", "node-compile-cache") : join(at.home, HOOK_COMPILE_CACHE_DIR);
    expect(dirname(await realpath(cache ?? ""))).toBe(await realpath(folder));
    if (!WINDOWS) expect((await stat(folder)).mode & 0o777).toBe(0o700);
  }, 30_000);

  it("reads the code it kept at an earlier event instead of compiling the bundle again", async () => {
    const at = await place();
    run(at, at.entry);
    const second = run(at, at.entry, { NODE_DEBUG_NATIVE: "COMPILE_CACHE" });
    expect(second.stderr).toMatch(/\[compile cache\] V8 code cache for \S+ \S*claude-hook-bundle\.mjs was accepted/u);
  }, 60_000);

  // `hook-bundle-cost.test.ts` imports the built entries to count what they load.
  it("only loads the bundle when another module imports it: no cache, and the bundle serves nothing", async () => {
    const at = await place();
    const importer = join(at.base, "importer.mjs");
    await writeFile(importer, `await import(${JSON.stringify(pathToFileURL(at.entry).href)});\n`);
    const { cache, argv1, stderr } = run(at, importer);
    expect({ cache, argv1 }, stderr).toEqual({ cache: null, argv1: await realpath(importer) });
  }, 30_000);
});

// The temporary folder is shared between accounts on Linux, and compiled code read from a folder another account can
// write is code that account chose. Windows has no POSIX owner or mode: there the cache is in the person's own
// temporary folder.
describe.skipIf(WINDOWS)("a hook's entry on macOS and Linux", () => {
  it("runs the hook without the cache where the cache folder is open to other accounts", async () => {
    const at = await place();
    const folder = join(at.home, HOOK_COMPILE_CACHE_DIR);
    await mkdir(folder);
    await chmod(folder, 0o777);
    const { status, cache, argv1, stderr } = run(at, at.entry);
    expect({ status, cache, argv1 }, stderr).toEqual({ status: 0, cache: null, argv1: at.bundle });
  }, 30_000);

  it("runs the hook without the cache where the cache folder is a link", async () => {
    const at = await place();
    const elsewhere = join(at.base, "elsewhere");
    await mkdir(elsewhere, { mode: 0o700 });
    await symlink(elsewhere, join(at.home, HOOK_COMPILE_CACHE_DIR));
    const { status, cache, stderr } = run(at, at.entry);
    expect({ status, cache }, stderr).toEqual({ status: 0, cache: null });
  }, 30_000);

  // `rerail uninstall --delete-data` removes the home; a hook entry left behind must not bring it back.
  it("runs the hook without the cache, and makes no Rerail home, where the home is gone", async () => {
    const at = await place();
    const gone = join(at.base, "no-home");
    const { status, cache, stderr } = run(at, at.entry, { RERAIL_HOME: gone });
    expect({ status, cache }, stderr).toEqual({ status: 0, cache: null });
    expect(existsSync(gone)).toBe(false);
  }, 30_000);
});
