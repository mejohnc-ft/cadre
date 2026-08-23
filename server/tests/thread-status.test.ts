import { describe, expect, test } from "bun:test";
import { createThreadReader } from "../src/channels/thread-status";

describe("reading whether the thread store still has a thread", () => {
  test("a thread the store holds for this person is known", async () => {
    const reader = createThreadReader({ hasThread: async () => true });
    await expect(reader("thread-1", "user-1")).resolves.toBe("known");
  });

  test("a thread the store does not hold for this person is unknown", async () => {
    const reader = createThreadReader({ hasThread: async () => false });
    await expect(reader("thread-1", "user-1")).resolves.toBe("unknown");
  });

  test("a failing lookup is not swallowed as unknown — the check itself failed", async () => {
    const reader = createThreadReader({
      hasThread: async () => {
        throw new Error("connection reset");
      },
    });
    await expect(reader("thread-1", "user-1")).rejects.toThrow(
      "connection reset",
    );
  });

  test("asks the store about the exact thread and user it was given", async () => {
    const seen: Array<[string, string]> = [];
    const reader = createThreadReader({
      hasThread: async (threadId, userId) => {
        seen.push([threadId, userId]);
        return true;
      },
    });
    await reader("thread-abc", "user-xyz");
    expect(seen).toEqual([["thread-abc", "user-xyz"]]);
  });
});
