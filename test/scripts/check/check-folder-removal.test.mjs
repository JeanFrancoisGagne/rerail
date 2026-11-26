// scripts/check/check-folder-removal.mjs, the rows of scripts/check/check-owned-builtins.mjs over test/: every folder a
// test makes is removed through the helper that names a process left running in it and waits out any other holder on
// Windows.

import { spawnSync } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { ownedBuiltinProblems, RULES } from "../../../scripts/check/check-owned-builtins.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const { owner: HELPER, exempt: EXEMPT } = RULES.find(row => row.id === "test-rm");
const rules = (problems) => problems.map(({ path, line, rule }) => `${path}:${line}:${rule}`);
const places = (problems) => problems.map(({ path, line }) => `${path}:${line}`);

/** Each fs module, with the removals it holds. */
const REMOVALS = {
  "node:fs": ["rm", "rmSync", "rmdir", "rmdirSync"],
  "fs": ["rm", "rmSync", "rmdir", "rmdirSync"],
  "node:fs/promises": ["rm", "rmdir"],
  "fs/promises": ["rm", "rmdir"],
};

/** A call of `callee` that removes a folder as the removal `name` does: an rmdir in any form, an rm given recursive. */
const removal = (callee, name) => (name.startsWith("rmdir") ? `${callee}(root);` : `${callee}(root, { recursive: true });`);

/** Every way a test reaches the removal `name` of `module` and calls it, as the file's text and the line of the call. */
const FORMS = {
  "named import": (module, name) => ({ text: `import { ${name} } from "${module}";\n${removal(name, name)}\n`, line: 2 }),
  "renamed import": (module, name) => ({ text: `import { ${name} as remove } from "${module}";\n${removal("remove", name)}\n`, line: 2 }),
  "namespace import": (module, name) => ({ text: `import * as fs from "${module}";\n${removal(`fs.${name}`, name)}\n`, line: 2 }),
  "default import": (module, name) => ({ text: `import fs from "${module}";\n${removal(`fs.${name}`, name)}\n`, line: 2 }),
  "import = require": (module, name) => ({ text: `import fs = require("${module}");\n${removal(`fs.${name}`, name)}\n`, line: 2 }),
  "require": (module, name) => ({ text: `const fs = require("${module}");\n${removal(`fs.${name}`, name)}\n`, line: 2 }),
  "destructured require": (module, name) => ({ text: `const { ${name} } = require("${module}");\n${removal(name, name)}\n`, line: 2 }),
  "import()": (module, name) => ({ text: `const fs = await import("${module}");\n${removal(`fs.${name}`, name)}\n`, line: 2 }),
  "destructured import()": (module, name) => ({
    text: `const { mkdtempSync, ${name} } = await import("${module}");\n${removal(name, name)}\n`, line: 2,
  }),
  "renamed in a destructured import()": (module, name) => ({
    text: `const { ${name}: remove } = await import("${module}");\n${removal("remove", name)}\n`, line: 2,
  }),
  "member of import()": (module, name) => ({ text: `${removal(`(await import("${module}")).${name}`, name)}\n`, line: 1 }),
  "vi.importActual": (module, name) => ({
    text: `const { ${name}: actual } = await vi.importActual("${module}");\n${removal("actual", name)}\n`, line: 2,
  }),
  "createRequire": (module, name) => ({
    text: `const fs = createRequire(import.meta.url)("${module}");\n${removal(`fs.${name}`, name)}\n`, line: 2,
  }),
  "getBuiltinModule": (module, name) => ({ text: `${removal(`process.getBuiltinModule("${module}").${name}`, name)}\n`, line: 1 }),
  "element access": (module, name) => ({ text: `import * as fs from "${module}";\n${removal(`fs["${name}"]`, name)}\n`, line: 2 }),
  "destructured namespace": (module, name) => ({
    text: `import * as fs from "${module}";\nconst { ${name}: remove } = fs;\n${removal("remove", name)}\n`, line: 3,
  }),
  "alias": (module, name) => ({ text: `import { ${name} } from "${module}";\nconst remove = ${name};\n${removal("remove", name)}\n`, line: 3 }),
};

describe("check-folder-removal", () => {
  it("flags a test that removes its temp folder directly", () => {
    const problems = ownedBuiltinProblems([{
      path: "test/a.test.ts",
      text: 'import { mkdtemp, rm } from "node:fs/promises";\nafterEach(async () => {\n  await rm(root, { recursive: true, force: true });\n});\n',
    }]);
    expect(rules(problems)).toEqual(["test/a.test.ts:3:test-rm"]);
    expect(problems[0].message).toContain(HELPER);
  });

  it("flags every other way a test removes a folder itself", () => {
    expect(rules(ownedBuiltinProblems([
      { path: "test/b.test.ts", text: 'import { rmSync as remove } from "node:fs";\nremove(root, { force: true, recursive: true });\n' },
      { path: "test/c.test.ts", text: 'import * as fs from "node:fs";\nfs.rmSync(root, { recursive: true });\nfs.rmdirSync(root);\n' },
      { path: "test/d.test.mjs", text: 'import fs from "fs";\nawait fs.promises.rm(root, options);\n' },
      { path: "test/e.test.ts", text: 'import { promises as p } from "node:fs";\nawait p.rmdir(root);\nawait p.rm(root, { ...forced });\n' },
      { path: "test/support/f.ts", text: 'import { rimraf } from "rimraf";\n' },
    ]))).toEqual([
      "test/b.test.ts:2:test-rm", "test/c.test.ts:2:test-rm", "test/c.test.ts:3:test-rmdir", "test/d.test.mjs:2:test-rm",
      "test/e.test.ts:2:test-rmdir", "test/e.test.ts:3:test-rm", "test/support/f.ts:1:test-rimraf",
    ]);
  });

  it.each(Object.keys(FORMS))("finds a folder removal reached through %s, from every fs module", (form) => {
    const missed = [];
    for (const [module, names] of Object.entries(REMOVALS)) {
      for (const name of names) {
        const { text, line } = FORMS[form](module, name);
        const found = ownedBuiltinProblems([{ path: "test/a.test.ts", text }]).map(problem => problem.line);
        if (found.join() !== String(line)) missed.push(`${module} ${name}: lines [${found.join()}], expected ${line}\n${text}`);
      }
    }
    expect(missed).toEqual([]);
  });

  it("reads a key of rm's options it cannot name as one that may ask for recursive, and recursive: false as no", () => {
    expect(places(ownedBuiltinProblems([{
      path: "test/a.test.ts",
      text: 'import { rmSync } from "node:fs";\nrmSync(root, { ["recursive"]: true });\nrmSync(root, { [key]: true });\nrmSync(root, { force: true, recursive: false });\n',
    }]))).toEqual(["test/a.test.ts:2", "test/a.test.ts:3"]);
  });

  it("finds rimraf however a test loads it, and not a type-only import, which loads nothing", () => {
    expect(places(ownedBuiltinProblems([
      { path: "test/a.test.ts", text: 'const { rimraf } = require("rimraf");\n' },
      { path: "test/b.test.ts", text: 'const { rimrafSync } = await import("rimraf");\n' },
      { path: "test/c.test.ts", text: 'import type { RimrafOptions } from "rimraf";\n' },
    ]))).toEqual(["test/a.test.ts:1", "test/b.test.ts:1"]);
  });

  it("leaves to the code under test a mock that hands its call on to the real rm, and finds a removal a mock makes", () => {
    const mocked = 'vi.mock("node:fs/promises", { spy: true });\nconst { rm: actualRm } = await vi.importActual("node:fs/promises");\n';
    expect(places(ownedBuiltinProblems([
      { path: "test/a.test.ts", text: `${mocked}vi.mocked(rm).mockImplementation(async (target, options) => await actualRm(target, options));\n` },
      { path: "test/b.test.ts", text: `${mocked}vi.mocked(rm).mockImplementationOnce(async (target) => {\n  await actualRm(target, { recursive: true });\n});\n` },
      { path: "test/c.test.ts", text: `${mocked}vi.mocked(rm).mockImplementation(async (target, options) => await actualRm(root, options));\n` },
    ]))).toEqual(["test/b.test.ts:4", "test/c.test.ts:3"]);
  });

  it("allows removing one file, the helper itself, the exempt files and code outside test/", () => {
    expect(ownedBuiltinProblems([
      { path: "test/a.test.ts", text: 'import { rm, rmSync } from "node:fs/promises";\nawait rm(file);\nrmSync(file, { force: true, recursive: false });\n' },
      { path: "test/b.test.ts", text: 'import { removeFolder } from "./support/platform/remove-folder.js";\nawait removeFolder(root);\n' },
      { path: "test/c.test.ts", text: 'import type { rm } from "node:fs/promises";\nconst fake: typeof rm = async () => {};\nawait fake(root, { recursive: true });\n' },
      { path: HELPER, text: 'import { rm } from "node:fs/promises";\nawait rm(path, { recursive: true, force: true });\n' },
      ...[...EXEMPT.keys()].map(path => ({ path, text: 'import { rm } from "node:fs/promises";\nawait rm(prefix, { recursive: true, force: true });\n' })),
      { path: "src/a.ts", text: 'import { rm } from "node:fs/promises";\nawait rm(path, { recursive: true });\n' },
    ])).toEqual([]);
  });

  it("passes on this checkout's test/", () => {
    const run = spawnSync(process.execPath, [join(ROOT, "scripts/check/check-folder-removal.mjs")], { cwd: ROOT, encoding: "utf8" });
    expect(run.stderr).toBe("");
    expect(run.status).toBe(0);
  });
});
