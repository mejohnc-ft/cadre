import { sql } from "drizzle-orm";
import {
  customType,
  index,
  integer,
  pgTable,
  primaryKey,
  text,
  timestamp,
} from "drizzle-orm/pg-core";
import { jsonb } from "./json";

/**
 * Durable conversation storage — what CopilotKit Intelligence held for the upstream project.
 *
 * A thread is one conversation between one person and one coworker. A run is one turn of the agent
 * inside it: the AG-UI events the agent emitted, compacted, and the message list as the agent saw it
 * when the run ended. The runner (server/src/runtime/postgres-runner.ts) replays runs in order to
 * reconstruct a thread for a late-joining browser, exactly as the in-memory runner does from RAM.
 *
 * Nothing here is append-only in the audit sense; audit_events is the record of what a Bot *did*.
 * This is the record of what was *said*, and a person may clear it.
 */

const createdAt = () =>
  timestamp("created_at", { withTimezone: true }).notNull().defaultNow();
const updatedAt = () =>
  timestamp("updated_at", { withTimezone: true }).notNull().defaultNow();

export const threads = pgTable(
  "threads",
  {
    id: text("id").primaryKey(),
    /** The coworker this thread belongs to; the runtime's agentId. */
    agentId: text("agent_id").notNull(),
    /** Whoever the server's identifyUser resolved for the first run. Scopes thread visibility. */
    userId: text("user_id").notNull(),
    name: text("name"),
    archived: timestamp("archived_at", { withTimezone: true }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [
    index("threads_user_updated_idx").on(table.userId, table.updatedAt),
  ],
);

export const threadRuns = pgTable(
  "thread_runs",
  {
    threadId: text("thread_id")
      .notNull()
      .references(() => threads.id, { onDelete: "cascade" }),
    runId: text("run_id").notNull(),
    /** Monotonic within a thread; replay order. */
    sequence: integer("sequence").notNull(),
    agentId: text("agent_id").notNull(),
    parentRunId: text("parent_run_id"),
    /** Compacted AG-UI events for this run. */
    events: jsonb("events").$type<unknown[]>().notNull(),
    /** The agent's message list at the end of the run — the thread transcript snapshot. */
    messages: jsonb("messages").$type<unknown[]>().notNull(),
    createdAt: createdAt(),
  },
  (table) => [
    primaryKey({ columns: [table.threadId, table.runId] }),
    index("thread_runs_sequence_idx").on(table.threadId, table.sequence),
  ],
);

/** pgvector column. Dimension fixed at 1536 (text-embedding-3-small and most OpenAI-compatible embedders). */
const vector = customType<{ data: number[]; driverData: string }>({
  dataType: () => "vector(1536)",
  toDriver: (value) => `[${value.join(",")}]`,
  fromDriver: (value) =>
    typeof value === "string"
      ? value.slice(1, -1).split(",").map(Number)
      : (value as unknown as number[]),
});

/**
 * What a coworker remembers about a person across threads. One row is one remembered fact or
 * exchange; recall is a cosine top-k over a user+agent scope, prepended to the next run's context.
 */
export const agentMemories = pgTable(
  "agent_memories",
  {
    id: text("id").primaryKey().default(sql`gen_random_uuid()::text`),
    agentId: text("agent_id").notNull(),
    userId: text("user_id").notNull(),
    threadId: text("thread_id"),
    content: text("content").notNull(),
    embedding: vector("embedding"),
    createdAt: createdAt(),
  },
  (table) => [
    index("agent_memories_scope_idx").on(table.agentId, table.userId),
  ],
);
