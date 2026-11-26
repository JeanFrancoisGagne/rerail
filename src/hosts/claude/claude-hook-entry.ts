// The file set-up registers as Claude Code's hook (`dist/hosts/claude/claude-hook.js`): it loads the hook's bundle
// once Node's compile cache is on (`src/harness/hook-entry.ts`).
import { loadHook } from "../../harness/hook-entry.js";

await loadHook(import.meta.url, "./claude-hook-bundle.js");
