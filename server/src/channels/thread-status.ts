import type { ThreadReader } from "./thread-routes";

/**
 * Build a {@link ThreadReader} from the thread store's own lookup.
 *
 * Typed as narrowly as this file needs it — a predicate over a thread and a person — rather than
 * as the concrete runner, so the route is testable with a function and the runner can change shape
 * without this file noticing.
 */
export function createThreadReader(store: {
  hasThread: (threadId: string, userId: string) => Promise<boolean>;
}): ThreadReader {
  return async (threadId, userId) =>
    (await store.hasThread(threadId, userId)) ? "known" : "unknown";
}
