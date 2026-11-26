/**
 * The stores one request reads through. A read asks each lookup once: the checkout at a folder, the repositories Rerail
 * knows and the rule catalog. Before, `GET /api/presentation` found its folder's checkout through two resolvers, and a
 * coding agent's read found its own checkout again in each helper that guards it, each time reading the identity file,
 * the real path and the database.
 */
import type { RepositoryStartState } from "../engine/catalog/repository-model.js";
import { spelledCheckout } from "../engine/catalog/repository-registry.js";
import { checkoutStatus, stateOf } from "../runtime/repository-start.js";
import type { OperationMethod, RerailApiStores } from "./operation.js";

/** Each request view's answers by question, while its request runs; a view whose request ended has none. */
const answers = new WeakMap<RerailApiStores, Map<string, unknown>>();

/**
 * `run` over a view of `stores` that serves one request. A read (GET) remembers each answer of {@link askedOnce} and of
 * the view's `checkouts`, `ruleCatalog` and `repositoryState` until `run` settles, and forgets them then: the next
 * request asks the stores again, so a checkout recorded, a repository started or stopped, or a rule changed between two
 * requests shows in the second, and no caller's answers reach another request. A write remembers nothing, since it may
 * read again what it changed. Stores that already serve one request are used as they are.
 */
export async function inOneRequest<T>(stores: RerailApiStores, method: OperationMethod, run: (stores: RerailApiStores) => T | Promise<T>): Promise<T> {
  if (method !== "GET" || answers.has(stores)) return await run(stores);
  const view = requestView(stores);
  answers.set(view, new Map());
  try {
    return await run(view);
  } finally {
    answers.delete(view);
  }
}

/**
 * `answer()` the first time the request `stores` serves asks `question`, and that same answer after, while the request
 * runs; `answer()` each time on stores that serve no request now, such as a write's or the change stream's. A thrown
 * answer is not kept. Each question names its asker and every input of the answer, so one key has one answer type.
 */
export function askedOnce<T>(stores: RerailApiStores, question: string, answer: () => T): T {
  const asked = answers.get(stores);
  if (asked === undefined) return answer();
  if (asked.has(question)) return asked.get(question) as T; // Set below from this question's own `answer`.
  const answered = answer();
  asked.set(question, answered);
  return answered;
}

type OwnLookups = Pick<RerailApiStores, "checkouts" | "ruleCatalog" | "repositoryState">;

/** `stores`, but for the lookups a request repeats, which ask through {@link askedOnce}. */
function requestView(stores: RerailApiStores): RerailApiStores {
  const own: OwnLookups = {
    checkouts: () => workspace => askedOnce(view, `checkout of folder\u0000${workspace}`, () => stores.checkouts()(workspace)),
    ruleCatalog: () => askedOnce(view, "rule catalog", () => stores.ruleCatalog()),
    repositoryState: (workspace, spelling) => startState(view, workspace, spelling),
  };
  const isOwn = (key: string | symbol): key is keyof OwnLookups => typeof key === "string" && Object.hasOwn(own, key);
  // Every other member is the stores' own, called on them: they keep private fields a proxy cannot reach.
  const view: RerailApiStores = new Proxy(stores, { get: (target, key) => (isOwn(key) ? own[key] : boundTo(target, Reflect.get(target, key))) });
  return view;
}

/**
 * Whether Rerail is on in the checkout `stores` found at `workspace`, from that same lookup: what `startStateReader`
 * answers from a lookup of its own. With `spelling`, also what Rerail 0.1.4 saved under it (`spelledCheckout`).
 */
function startState(stores: RerailApiStores, workspace: string, spelling: string | undefined): RepositoryStartState {
  const checkout = stores.checkouts()(workspace);
  // No checkout is stopped, read without opening a database that may not exist yet.
  if (checkout === undefined) return "stopped";
  return stateOf(checkoutStatus(stores.database(), spelling === undefined ? checkout : spelledCheckout(checkout, spelling)));
}

/** `value` called on `target`, as a property read of `target` gives it. */
function boundTo(target: object, value: unknown): unknown {
  return typeof value === "function" ? (value as (...parameters: unknown[]) => unknown).bind(target) : value;
}
