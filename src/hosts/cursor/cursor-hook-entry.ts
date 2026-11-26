// The file set-up registers as Cursor's hook (`dist/hosts/cursor/cursor-hook.js`): it loads the hook's bundle
// once Node's compile cache is on (`src/harness/hook-entry.ts`).
import { loadHook } from "../../harness/hook-entry.js";

await loadHook(import.meta.url, "./cursor-hook-bundle.js");
