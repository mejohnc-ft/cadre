import { boolean, pgTable, text, timestamp } from "drizzle-orm/pg-core";
import { agents } from "./core";

/**
 * Triggers: runs that start themselves.
 *
 * A trigger names a coworker, a prompt, and a cause — a cron schedule, an inbound webhook, or a
 * hand on the Fire button. Each firing is an ordinary run on the ordinary path: same gateway, same
 * boundaries, same audit. The webhook's token is stored hashed and shown exactly once.
 */

const createdAt = () =>
  timestamp("created_at", { withTimezone: true }).notNull().defaultNow();

export const triggers = pgTable("triggers", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  agentId: text("agent_id")
    .notNull()
    .references(() => agents.id, { onDelete: "cascade" }),
  /** "cron" | "webhook" */
  kind: text("kind").notNull(),
  /** Five-field cron expression, for cron triggers. */
  schedule: text("schedule"),
  /** What each firing says to the coworker. A webhook's body is appended. */
  prompt: text("prompt").notNull(),
  /** SHA-256 of the webhook token; null for cron triggers. */
  tokenHash: text("token_hash"),
  enabled: boolean("enabled").notNull().default(true),
  /**
   * "continue" keeps one standing thread so the coworker remembers earlier firings;
   * "new" starts fresh every time.
   */
  threadMode: text("thread_mode").notNull().default("continue"),
  threadId: text("thread_id"),
  lastFiredAt: timestamp("last_fired_at", { withTimezone: true }),
  /** "ok" | "error" | "running" */
  lastStatus: text("last_status"),
  /** The coworker's final text from the last firing, truncated. */
  lastReply: text("last_reply"),
  createdBy: text("created_by"),
  createdAt: createdAt(),
});
