/**
 * The first module of each coding agent's hook: the file set-up registers (`dist/hosts/<agent>/<agent>-hook.js`)
 * holds only this and the name of the hook's bundle beside it. Each hook event starts a Node that loads a bundle of
 * over 2 MB, which V8 would otherwise parse and compile again in every process; with Node's compile cache on before the
 * bundle loads, V8 reads the code it compiled at an earlier event instead. Kept to Node's built-ins and two of Rerail's
 * smallest modules, so whatever node starts a hook can parse and run it.
 */
import { lstatSync, mkdirSync } from "node:fs";
import * as nodeModule from "node:module";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { defaultRerailHome, HOOK_COMPILE_CACHE_DIR } from "../engine/storage/rerail-home.js";
import { sameFile } from "./same-file.js";

/**
 * Makes `folder` (0700, inside a Rerail home that exists: a hook never makes the home) and answers whether it is this
 * user's alone: a real directory, not a link, owned by this user, with no group or other permission bits. Compiled code
 * read from a folder another account can write is code that account chose.
 */
function isOwnFolder(folder: string): boolean {
  try {
    mkdirSync(folder, { mode: 0o700 });
  } catch {
    // It is there already, or the Rerail home is not: what lstat finds decides.
  }
  try {
    const info = lstatSync(folder);
    return info.isDirectory() && info.uid === process.getuid?.() && (info.mode & 0o077) === 0;
  } catch {
    return false;
  }
}

/**
 * The folder the hook keeps its compiled code in: undefined for the one Node takes itself, the folder
 * `NODE_COMPILE_CACHE` names or, on Windows, `node-compile-cache` in the person's own temporary folder; on macOS and
 * Linux, whose temporary folder other accounts share, `hook-compile-cache` in the Rerail home; null where that folder
 * is not this user's alone, so the hook runs without the cache.
 */
function cacheFolder(): string | null | undefined {
  if (process.platform === "win32" || process.env.NODE_COMPILE_CACHE !== undefined) return undefined;
  const folder = join(defaultRerailHome(), HOOK_COMPILE_CACHE_DIR);
  return isOwnFolder(folder) ? folder : null;
}

/**
 * Turns on Node's compile cache in this process (`module.enableCompileCache`). It changes no environment, so whatever
 * the hook starts runs as it did before. Node keeps it off where `NODE_DISABLE_COMPILE_CACHE` is set, and a node
 * without one, or a folder Node cannot use, runs the hook as before.
 */
function turnOnCompileCache(): void {
  const folder = cacheFolder();
  if (folder === null) return;
  try {
    // A node before 22.1 has no such export, so the call throws there.
    nodeModule.enableCompileCache(folder);
  } catch {
    // The hook runs without the cache, as on a node that has none.
  }
}

/**
 * Loads the hook's `bundle` (a path relative to `entryUrl`, the entry's `import.meta.url`). Where the entry is the
 * script node was started with, it first turns on the compile cache and names the bundle as that script (argv[1]), so
 * the bundle serves the hook as if `node <bundle>` had started it. Imported by any other module, it only loads the
 * bundle, which then serves nothing.
 */
export async function loadHook(entryUrl: string, bundle: string): Promise<void> {
  const bundleUrl = new URL(bundle, entryUrl);
  const launched = process.argv[1];
  if (launched !== undefined && sameFile(fileURLToPath(entryUrl), launched)) {
    turnOnCompileCache();
    process.argv[1] = fileURLToPath(bundleUrl);
  }
  await import(bundleUrl.href);
}
