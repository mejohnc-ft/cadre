import { afterAll, describe, expect, test } from "bun:test";
import type { BaseEvent, RunAgentInput } from "@ag-ui/client";
import { AbstractAgent, EventType } from "@ag-ui/client";
import { eq } from "drizzle-orm";
import { firstValueFrom, lastValueFrom, Observable, toArray } from "rxjs";
import { createDatabase } from "../src/db/client";
import { threadRuns, threads } from "../src/db/schema";
import { PostgresAgentRunner } from "../src/runtime/postgres-runner";
import { TEST_POOL } from "./support/database";

/**
 * The M0 claim: a conversation survives the process that held it.
 *
 * Runs an agent through one runner, then builds a second runner over the same database — the
 * equivalent of a restart — and checks that connecting to the thread replays what was said, that
 * the thread lists, that the messages are the agent's final transcript, and that another person
 * cannot see it.
 */

const databaseUrl =
  process.env.DATABASE_URL ??
  "postgres://openbot:openbot@localhost:5432/openbot";
const database = createDatabase(databaseUrl, TEST_POOL);

/** An AG-UI agent that answers with one assistant message and then stops. */
class EchoAgent extends AbstractAgent {
  constructor(
    agentId: string,
    private readonly reply: string,
  ) {
    super({ agentId });
  }

  protected run(input: RunAgentInput): Observable<BaseEvent> {
    return new Observable<BaseEvent>((subscriber) => {
      const messageId = `m-${input.runId}`;
      subscriber.next({
        type: EventType.RUN_STARTED,
        threadId: input.threadId,
        runId: input.runId,
      } as BaseEvent);
      subscriber.next({
        type: EventType.TEXT_MESSAGE_START,
        messageId,
        role: "assistant",
      } as BaseEvent);
      subscriber.next({
        type: EventType.TEXT_MESSAGE_CONTENT,
        messageId,
        delta: this.reply,
      } as BaseEvent);
      subscriber.next({
        type: EventType.TEXT_MESSAGE_END,
        messageId,
      } as BaseEvent);
      subscriber.next({
        type: EventType.RUN_FINISHED,
        threadId: input.threadId,
        runId: input.runId,
      } as BaseEvent);
      subscriber.complete();
    });
  }
}

const threadId = `runner-test-${crypto.randomUUID()}`;

afterAll(async () => {
  await database.delete(threads).where(eq(threads.id, threadId));
});

function input(runId: string, text: string): RunAgentInput {
  return {
    threadId,
    runId,
    messages: [{ id: `u-${runId}`, role: "user", content: text }],
    tools: [],
    context: [],
    state: {},
    forwardedProps: {},
  };
}

describe("PostgresAgentRunner", () => {
  test("a run is streamed live, persisted, and replayed by a fresh runner", async () => {
    const first = new PostgresAgentRunner(database, {
      userFor: () => "alice",
    });
    const agent = new EchoAgent("echo", "Hello from the echo agent.");

    const live = await lastValueFrom(
      first
        .run({ threadId, agent, input: input("run-1", "hi") })
        .pipe(toArray()),
    );
    expect(live.map((event) => event.type)).toEqual([
      EventType.RUN_STARTED,
      EventType.TEXT_MESSAGE_START,
      EventType.TEXT_MESSAGE_CONTENT,
      EventType.TEXT_MESSAGE_END,
      EventType.RUN_FINISHED,
    ]);

    // The row is there, owned by the right person.
    const [row] = await database
      .select()
      .from(threads)
      .where(eq(threads.id, threadId));
    expect(row?.userId).toBe("alice");
    expect(row?.agentId).toBe("echo");
    const runs = await database
      .select()
      .from(threadRuns)
      .where(eq(threadRuns.threadId, threadId));
    expect(runs).toHaveLength(1);
    expect(runs[0]?.sequence).toBe(0);

    // "Restart": a second runner over the same database knows nothing until asked.
    const second = new PostgresAgentRunner(database);
    expect(second.getThreadEvents(threadId)).toEqual([]);

    const replayed = await lastValueFrom(
      second.connect({ threadId }).pipe(toArray()),
    );
    expect(replayed.map((event) => event.type)).toContain(
      EventType.TEXT_MESSAGE_CONTENT,
    );
    expect(
      replayed.find((event) => event.type === EventType.TEXT_MESSAGE_CONTENT),
    ).toMatchObject({ delta: "Hello from the echo agent." });

    // Now the sync getters the runtime's /threads endpoints use are populated.
    expect(second.listThreads().map((thread) => thread.id)).toContain(threadId);
    expect(second.getThreadMessages(threadId).map((m) => m.role)).toEqual([
      "user",
      "assistant",
    ]);
  });

  test("a second run on the same thread is appended in order", async () => {
    const runner = new PostgresAgentRunner(database, {
      userFor: () => "alice",
    });
    const agent = new EchoAgent("echo", "Second answer.");
    await lastValueFrom(
      runner.run({ threadId, agent, input: input("run-2", "again") }),
    );
    const runs = await database
      .select({ sequence: threadRuns.sequence, runId: threadRuns.runId })
      .from(threadRuns)
      .where(eq(threadRuns.threadId, threadId))
      .orderBy(threadRuns.sequence);
    expect(runs).toEqual([
      { sequence: 0, runId: "run-1" },
      { sequence: 1, runId: "run-2" },
    ]);
    expect(runs[1]?.runId).toBe("run-2");

    const fresh = new PostgresAgentRunner(database);
    await firstValueFrom(fresh.connect({ threadId }).pipe(toArray()));
    const contents = fresh
      .getThreadEvents(threadId)
      .filter((event) => event.type === EventType.TEXT_MESSAGE_CONTENT)
      .map((event) => (event as { delta: string }).delta);
    expect(contents).toEqual(["Hello from the echo agent.", "Second answer."]);
  });

  test("thread ownership is per person", async () => {
    const runner = new PostgresAgentRunner(database);
    await expect(runner.hasThread(threadId, "alice")).resolves.toBe(true);
    await expect(runner.hasThread(threadId, "bob")).resolves.toBe(false);
    await expect(runner.hasThread("never-existed", "alice")).resolves.toBe(
      false,
    );
  });

  test("connecting to an unknown thread completes with nothing", async () => {
    const runner = new PostgresAgentRunner(database);
    const events = await lastValueFrom(
      runner.connect({ threadId: "nothing-here" }).pipe(toArray()),
    );
    expect(events).toEqual([]);
  });
});
