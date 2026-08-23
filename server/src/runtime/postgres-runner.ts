import type { AbstractAgent, BaseEvent, Message } from "@ag-ui/client";
import { compactEvents, EventType } from "@ag-ui/client";
import type {
  AgentRunnerConnectRequest,
  AgentRunnerIsRunningRequest,
  AgentRunnerRunRequest,
  AgentRunnerStopRequest,
  LocalThreadEndpointRecord,
  LocalThreadEndpointRunner,
} from "@copilotkit/runtime/v2";
import { AgentRunner, finalizeRunEvents } from "@copilotkit/runtime/v2";
import { asc, desc, eq } from "drizzle-orm";
import type { Observable } from "rxjs";
import { ReplaySubject } from "rxjs";
import type { Database } from "../db/client";
import { threadRuns, threads } from "../db/schema";

/**
 * The agent runner that owns this deployment's threads, backed by its own PostgreSQL.
 *
 * Upstream OpenBot ran the CopilotKit runtime in Intelligence mode, where threads, messages and
 * memory lived in a hosted service. Slice keeps the runtime and replaces the runner: the runtime's
 * `AgentRunner` seam is four methods, and `LocalThreadEndpointRunner` adds the thread listing the
 * runtime's own `/threads` endpoints serve from. Everything the browser sees is the same.
 *
 * Live runs are in-process, as they are in the runtime's in-memory runner: the agent's AG-UI events
 * pass through a ReplaySubject to whoever is connected while the run is going. What differs is what
 * happens when the run ends — the compacted events and the message snapshot are written to
 * `thread_runs`, and a thread is rebuilt from those rows the next time anyone asks for it. A server
 * restart forgets nothing but a run that was mid-flight, which the watchdog already treats as
 * interrupted.
 *
 * The runtime's thread getters are synchronous, so each thread's runs are cached in memory once
 * loaded. `hydrate(threadId)` is awaited by `run` and `connect` before they answer; the sync getters
 * serve whatever is cached and return empty for a thread nobody has touched this process lifetime.
 * That matches how the runtime uses them: it connects first, then lists.
 *
 * One server process per deployment for now. Multi-instance fan-out of live events would need
 * LISTEN/NOTIFY or a broker; the durable half needs nothing extra.
 */

type HistoricRun = {
  runId: string;
  agentId: string;
  parentRunId: string | null;
  events: BaseEvent[];
  messages: Message[];
  createdAt: number;
};

type ThreadState = {
  id: string;
  agentId: string;
  userId: string;
  name: string | null;
  createdAt: number;
  updatedAt: number;
  runs: HistoricRun[];
  hydrated: Promise<void> | null;

  // Live-run state; mirrors the in-memory runner.
  isRunning: boolean;
  currentRunId: string | null;
  agent: AbstractAgent | null;
  subject: ReplaySubject<BaseEvent> | null;
  stopRequested: boolean;
  activeFinalize: { stopRequested: boolean } | null;
};

export type PostgresAgentRunnerOptions = {
  /** What to do when a run arrives for a thread that is already running. Default: throw. */
  onConcurrentRun?: "throw" | "supersede";
  /**
   * The person a run belongs to. The runtime's `identifyUser` has already resolved it by the time
   * `run` is called, but the runner is not handed the request; the server passes a resolver that
   * reads the same per-request identity the runtime did. Absent, threads are scoped to "".
   */
  userFor?: (request: AgentRunnerRunRequest) => string;
  /** Called after every persisted run. Memory extraction hangs off this. */
  onRunPersisted?: (run: {
    threadId: string;
    agentId: string;
    userId: string;
    messages: Message[];
  }) => void | Promise<void>;
};

/** The slice of the runner other modules depend on: "does this person have this thread?" */
export type ThreadStore = Pick<PostgresAgentRunner, "hasThread">;

export class PostgresAgentRunner
  extends AgentRunner
  implements LocalThreadEndpointRunner
{
  readonly ɵsupportsLocalThreadEndpoints = true as const;
  private readonly store = new Map<string, ThreadState>();
  private readonly onConcurrentRun: "throw" | "supersede";

  constructor(
    private readonly db: Database,
    private readonly options: PostgresAgentRunnerOptions = {},
  ) {
    super();
    this.onConcurrentRun = options.onConcurrentRun ?? "throw";
  }

  private state(threadId: string): ThreadState {
    let state = this.store.get(threadId);
    if (!state) {
      state = {
        id: threadId,
        agentId: "default",
        userId: "",
        name: null,
        createdAt: Date.now(),
        updatedAt: Date.now(),
        runs: [],
        hydrated: null,
        isRunning: false,
        currentRunId: null,
        agent: null,
        subject: null,
        stopRequested: false,
        activeFinalize: null,
      };
      this.store.set(threadId, state);
    }
    return state;
  }

  /** Load a thread's persisted runs once per process. Idempotent; concurrent callers share the load. */
  async hydrate(threadId: string): Promise<ThreadState> {
    const state = this.state(threadId);
    if (!state.hydrated) {
      state.hydrated = (async () => {
        const [row] = await this.db
          .select()
          .from(threads)
          .where(eq(threads.id, threadId))
          .limit(1);
        if (!row) return;
        state.agentId = row.agentId;
        state.userId = row.userId;
        state.name = row.name;
        state.createdAt = row.createdAt.getTime();
        state.updatedAt = row.updatedAt.getTime();
        const rows = await this.db
          .select()
          .from(threadRuns)
          .where(eq(threadRuns.threadId, threadId))
          .orderBy(asc(threadRuns.sequence));
        state.runs = rows.map((run) => ({
          runId: run.runId,
          agentId: run.agentId,
          parentRunId: run.parentRunId,
          events: run.events as BaseEvent[],
          messages: run.messages as Message[],
          createdAt: run.createdAt.getTime(),
        }));
      })();
    }
    await state.hydrated;
    return state;
  }

  /** Warm the thread index so `listThreads` answers before any thread has been connected to. */
  async warm(): Promise<void> {
    const rows = await this.db
      .select()
      .from(threads)
      .orderBy(desc(threads.updatedAt))
      .limit(1000);
    for (const row of rows) {
      const state = this.state(row.id);
      state.agentId = row.agentId;
      state.userId = row.userId;
      state.name = row.name;
      state.createdAt = row.createdAt.getTime();
      state.updatedAt = row.updatedAt.getTime();
    }
  }

  private async persistRun(
    state: ThreadState,
    run: HistoricRun,
    userId: string,
  ): Promise<void> {
    const now = new Date(run.createdAt);
    await this.db.transaction(async (tx) => {
      await tx
        .insert(threads)
        .values({
          id: state.id,
          agentId: run.agentId,
          userId,
          createdAt: new Date(state.createdAt),
          updatedAt: now,
        })
        .onConflictDoUpdate({
          target: threads.id,
          set: { updatedAt: now, agentId: run.agentId },
        });
      await tx
        .insert(threadRuns)
        .values({
          threadId: state.id,
          runId: run.runId,
          sequence: state.runs.length,
          agentId: run.agentId,
          parentRunId: run.parentRunId,
          events: run.events,
          messages: run.messages,
          createdAt: now,
        })
        .onConflictDoNothing();
    });
  }

  run(request: AgentRunnerRunRequest): Observable<BaseEvent> {
    const state = this.state(request.threadId);
    const runSubject = new ReplaySubject<BaseEvent>(Infinity);

    // The hydrate is the only async step before the agent starts; the subject is returned
    // synchronously and fills once the run begins, which is what a stream consumer expects anyway.
    void this.hydrate(request.threadId).then(
      () => this.startRun(state, request, runSubject),
      (error) => runSubject.error(error),
    );
    return runSubject.asObservable();
  }

  private startRun(
    state: ThreadState,
    request: AgentRunnerRunRequest,
    runSubject: ReplaySubject<BaseEvent>,
  ) {
    if (state.isRunning || state.stopRequested) {
      if (this.onConcurrentRun !== "supersede") {
        runSubject.error(new Error("Thread already running"));
        return;
      }
      const prior = state.agent;
      if (state.activeFinalize) state.activeFinalize.stopRequested = true;
      state.isRunning = false;
      try {
        prior?.abortRun();
      } catch (error) {
        console.error("Failed to abort superseded run", error);
      }
    }

    const userId = this.options.userFor?.(request) ?? state.userId ?? "";
    if (!state.userId) state.userId = userId;
    state.agentId = request.agent.agentId ?? state.agentId;
    state.isRunning = true;
    state.currentRunId = request.input.runId;
    state.agent = request.agent;
    state.stopRequested = false;
    const finalizeControl = { stopRequested: false };
    state.activeFinalize = finalizeControl;

    const currentRunEvents: BaseEvent[] = [];
    const historicMessageIds = new Set<string>();
    for (const run of state.runs) {
      for (const event of run.events) {
        const messageId = (event as { messageId?: unknown }).messageId;
        if (typeof messageId === "string") historicMessageIds.add(messageId);
        if (event.type === EventType.RUN_STARTED) {
          const input = (event as { input?: { messages?: Message[] } }).input;
          for (const message of input?.messages ?? []) {
            historicMessageIds.add(message.id);
          }
        }
      }
    }

    const liveSubject = new ReplaySubject<BaseEvent>(Infinity);
    state.subject = liveSubject;
    const parentRunId = state.runs[state.runs.length - 1]?.runId ?? null;

    const finalizeRun = async (opts: { interruptionMessage?: string }) => {
      const isError = opts.interruptionMessage !== undefined;
      const eventsBefore = currentRunEvents.length;
      const appended = finalizeRunEvents(currentRunEvents, {
        stopRequested: finalizeControl.stopRequested,
        ...(isError ? { interruptionMessage: opts.interruptionMessage } : {}),
      });
      for (const event of appended) {
        runSubject.next(event);
        liveSubject.next(event);
      }
      const ownsThread = state.currentRunId === request.input.runId;
      if (ownsThread && (!isError || eventsBefore > 0)) {
        const run: HistoricRun = {
          runId: request.input.runId,
          agentId: request.agent.agentId ?? "default",
          parentRunId,
          events: compactEvents(currentRunEvents),
          messages: Array.isArray(request.agent.messages)
            ? [...request.agent.messages]
            : [],
          createdAt: Date.now(),
        };
        try {
          await this.persistRun(state, run, userId);
          state.runs.push(run);
          state.updatedAt = run.createdAt;
          await this.options.onRunPersisted?.({
            threadId: state.id,
            agentId: run.agentId,
            userId,
            messages: run.messages,
          });
        } catch (error) {
          // The conversation already happened; losing the row is a durability failure, not a
          // reason to fail the turn the person just watched complete.
          console.error(
            `Failed to persist run ${run.runId} on thread ${state.id}`,
            error,
          );
          state.runs.push(run);
        }
      }
      if (ownsThread) {
        state.currentRunId = null;
        state.agent = null;
        state.stopRequested = false;
        state.isRunning = false;
        state.activeFinalize = null;
      }
      runSubject.complete();
      liveSubject.complete();
      if (state.subject === liveSubject) state.subject = null;
    };

    (async () => {
      try {
        await request.agent.runAgent(request.input, {
          onEvent: ({ event }) => {
            let processed: BaseEvent = event;
            if (event.type === EventType.RUN_STARTED) {
              const started = event as BaseEvent & {
                input?: AgentRunnerRunRequest["input"];
              };
              if (!started.input) {
                const messages = request.input.messages?.filter(
                  (message) => !historicMessageIds.has(message.id),
                );
                started.input = {
                  ...request.input,
                  ...(messages !== undefined ? { messages } : {}),
                };
                processed = started;
              }
            }
            runSubject.next(processed);
            liveSubject.next(processed);
            currentRunEvents.push(processed);
          },
        });
        await finalizeRun({});
      } catch (error) {
        await finalizeRun({
          interruptionMessage:
            error instanceof Error ? error.message : String(error),
        });
      }
    })();
  }

  connect(request: AgentRunnerConnectRequest): Observable<BaseEvent> {
    const connection = new ReplaySubject<BaseEvent>(Infinity);
    void this.hydrate(request.threadId).then(
      (state) => {
        if (state.runs.length === 0 && !state.isRunning) {
          connection.complete();
          return;
        }
        const emitted = new Set<string>();
        for (const event of this.historicEvents(state)) {
          connection.next(event);
          const messageId = (event as { messageId?: unknown }).messageId;
          if (typeof messageId === "string") emitted.add(messageId);
        }
        if (state.subject && (state.isRunning || state.stopRequested)) {
          state.subject.subscribe({
            next: (event) => {
              const messageId = (event as { messageId?: unknown }).messageId;
              if (typeof messageId === "string" && emitted.has(messageId)) {
                return;
              }
              connection.next(event);
            },
            complete: () => connection.complete(),
            error: (error) => connection.error(error),
          });
        } else {
          connection.complete();
        }
      },
      (error) => connection.error(error),
    );
    return connection.asObservable();
  }

  isRunning(request: AgentRunnerIsRunningRequest): Promise<boolean> {
    return Promise.resolve(
      this.store.get(request.threadId)?.isRunning ?? false,
    );
  }

  stop(request: AgentRunnerStopRequest): Promise<boolean | undefined> {
    const state = this.store.get(request.threadId);
    if (!state?.isRunning) return Promise.resolve(false);
    if (request.runId !== undefined && state.currentRunId !== request.runId) {
      return Promise.resolve(false);
    }
    if (state.stopRequested) return Promise.resolve(false);
    const finalizeControl = state.activeFinalize;
    const agent = state.agent;
    if (!agent) return Promise.resolve(false);
    state.stopRequested = true;
    state.isRunning = false;
    if (finalizeControl) finalizeControl.stopRequested = true;
    try {
      agent.abortRun();
      return Promise.resolve(true);
    } catch (error) {
      console.error("Failed to abort agent run", error);
      state.stopRequested = false;
      state.isRunning = true;
      if (finalizeControl) finalizeControl.stopRequested = false;
      return Promise.resolve(false);
    }
  }

  private historicEvents(state: ThreadState): BaseEvent[] {
    if (state.runs.length === 0) return [];
    return compactEvents(state.runs.flatMap((run) => run.events));
  }

  // ---- LocalThreadEndpointRunner -------------------------------------------------------------

  listThreads(): LocalThreadEndpointRecord[] {
    const records: LocalThreadEndpointRecord[] = [];
    for (const state of this.store.values()) {
      if (state.runs.length === 0 && !state.hydrated) continue;
      records.push({
        id: state.id,
        name: state.name,
        agentId: state.agentId,
        organizationId: "",
        createdById: state.userId,
        archived: false,
        createdAt: new Date(state.createdAt).toISOString(),
        updatedAt: new Date(state.updatedAt).toISOString(),
      });
    }
    return records.sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1));
  }

  getThreadMessages(threadId: string): Message[] {
    const state = this.store.get(threadId);
    const last = state?.runs[state.runs.length - 1];
    return last ? [...last.messages] : [];
  }

  getThreadEvents(threadId: string): BaseEvent[] {
    const state = this.store.get(threadId);
    return state ? this.historicEvents(state) : [];
  }

  getThreadState(threadId: string): Record<string, unknown> | null {
    const events = this.getThreadEvents(threadId);
    for (let i = events.length - 1; i >= 0; i--) {
      const event = events[i];
      if (event?.type === EventType.STATE_SNAPSHOT) {
        const snapshot = (event as { snapshot?: unknown }).snapshot;
        return snapshot &&
          typeof snapshot === "object" &&
          !Array.isArray(snapshot)
          ? { ...(snapshot as Record<string, unknown>) }
          : null;
      }
    }
    return null;
  }

  /** Forget every thread this runner knows — cache and rows. Exposed for tests and the clear route. */
  clearThreads(): void {
    this.store.clear();
    void this.db.delete(threads).catch((error) => {
      console.error("Failed to clear threads", error);
    });
  }

  // ---- Slice additions -------------------------------------------------------------------------

  /** Whether a thread exists for this person. The thread-status route's question. */
  async hasThread(threadId: string, userId: string): Promise<boolean> {
    const [row] = await this.db
      .select({ userId: threads.userId })
      .from(threads)
      .where(eq(threads.id, threadId))
      .limit(1);
    return row !== undefined && row.userId === userId;
  }
}
