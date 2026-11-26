import { describe, expect, it } from "vitest";
import { parseArguments } from "../../../src/runtime/command-arguments.js";

const accepted = { flags: ["--json", "--print"], options: ["--repo", "--name"] };
const parse = (argv: readonly string[]) => parseArguments(argv, accepted, argument => `Unknown test option: ${argument}`);

describe("a command's arguments", () => {
  it("are read as flags and option values in any order", () => {
    const { flags, options } = parse(["--repo", "/work/app", "--json", "--name", "main"]);
    expect([...flags]).toEqual(["--json"]);
    expect([...options]).toEqual([["--repo", "/work/app"], ["--name", "main"]]);
  });

  it("read nothing from no arguments", () => {
    const { flags, options } = parse([]);
    expect(flags.size).toBe(0);
    expect(options.size).toBe(0);
  });

  it("keep the last value of an option given twice", () => {
    expect(parse(["--repo", "/first", "--repo", "/second"]).options.get("--repo")).toBe("/second");
  });

  it("refuse a word the command does not accept with the command's own message", () => {
    expect(() => parse(["--json", "--force"])).toThrow(/^Unknown test option: --force$/u);
    expect(() => parse(["/work/app"])).toThrow(/^Unknown test option: \/work\/app$/u);
  });

  it("refuse an option with no value after it, or another option in its place", () => {
    expect(() => parse(["--json", "--repo"])).toThrow(/^--repo requires a value$/u);
    expect(() => parse(["--repo", "--json"])).toThrow(/^--repo requires a value$/u);
  });
});
