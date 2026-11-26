/**
 * The `--flag` and `--option value` arguments of a `rerail` command and of the daemon process. It imports nothing, so
 * a command module that reads its arguments with it loads no other module for that.
 */

/** Parsed `--flag` / `--option value` arguments; every name is validated against the accepted sets. */
export interface ParsedArguments {
  flags: ReadonlySet<string>;
  options: ReadonlyMap<string, string>;
}

/**
 * `argv` read against the flags and options a command accepts. Throws `unknownMessage(argument)` for any other word,
 * and `<option> requires a value` for an option that ends `argv` or is followed by a word that starts with `--`. An
 * option given twice keeps its last value.
 */
export function parseArguments(
  argv: readonly string[],
  accepted: { flags: readonly string[]; options: readonly string[] },
  unknownMessage: (argument: string) => string,
): ParsedArguments {
  const flags = new Set<string>();
  const options = new Map<string, string>();
  let index = 0;
  while (index < argv.length) {
    const argument = argv[index] ?? "";
    if (accepted.flags.includes(argument)) {
      flags.add(argument);
      index += 1;
      continue;
    }
    if (!accepted.options.includes(argument)) throw new Error(unknownMessage(argument));
    const value = argv[index + 1];
    if (value === undefined || value.startsWith("--")) throw new Error(`${argument} requires a value`);
    options.set(argument, value);
    index += 2;
  }
  return { flags, options };
}
