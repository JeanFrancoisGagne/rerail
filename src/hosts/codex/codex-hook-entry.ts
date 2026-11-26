// The file set-up registers as Codex's hook (`dist/hosts/codex/codex-hook.js`): it loads the hook's bundle
// once Node's compile cache is on (`src/harness/hook-entry.ts`).
import { loadHook } from "../../harness/hook-entry.js";

await loadHook(import.meta.url, "./codex-hook-bundle.js");
