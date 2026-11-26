#!/usr/bin/env node
// Every folder a test makes is removed through test/support/platform/remove-folder.ts: the rows of
// check-owned-builtins.mjs's RULES over test/ (test-rm, test-rmdir, test-rimraf), whose header gives the reason and
// each form of removal they find, run over every tracked or new .ts, .mts, .js and .mjs file under test/.
//
//   node scripts/check/check-folder-removal.mjs   (npm run check:folder-removal; part of npm run check)
import { checkFolder, RULES } from "./check-owned-builtins.mjs";

const { owner } = RULES.find(rule => rule.id === "test-rm");
checkFolder("check-folder-removal", "test", files => `${files} files remove folders only through ${owner}`);
