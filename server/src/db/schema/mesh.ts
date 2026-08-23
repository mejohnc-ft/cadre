import { boolean, index, pgTable, text, timestamp } from "drizzle-orm/pg-core";
import { users } from "./core";
import { jsonb } from "./json";

/**
 * The mesh: every machine this deployment may place a computer on, and where each Bot's is.
 *
 * A node is a supervisor somewhere on the tailnet, enrolled by presenting a one-time token the
 * administrator minted here. Its own bearer token is held encrypted, exactly as a credential is,
 * and read only when the server calls it. The deployment's own supervisor — the one in
 * `COMPUTER_SUPERVISOR_URL` — is the implicit node `local` and has no row.
 *
 * A placement is one fact: which node holds this Bot's computer now. Moving a Bot is a bundle
 * copied between two supervisors and this row updated last, so a crash mid-move leaves the Bot
 * where it was rather than nowhere.
 */

const createdAt = () =>
  timestamp("created_at", { withTimezone: true }).notNull().defaultNow();

export const nodes = pgTable("nodes", {
  /** A slug the administrator recognises: the machine's name, lower-cased. */
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  supervisorUrl: text("supervisor_url").notNull(),
  /** The supervisor's bearer token, AES-GCM under KEY_ENCRYPTION_KEY. Never returned by any route. */
  tokenEncrypted: text("token_encrypted").notNull(),
  backend: text("backend").notNull(),
  /** Whether new computers may be placed here. Off, existing computers stay reachable. */
  placementEnabled: boolean("placement_enabled").notNull().default(true),
  enrolledBy: text("enrolled_by").references(() => users.id, {
    onDelete: "set null",
  }),
  enrolledAt: createdAt(),
  lastSeenAt: timestamp("last_seen_at", { withTimezone: true }),
  /** The last /v1/health and /v1/capacity answers, for the page that lists nodes. */
  lastHealth: jsonb("last_health").$type<Record<string, unknown>>(),
});

export const nodeEnrollmentTokens = pgTable("node_enrollment_tokens", {
  id: text("id").primaryKey(),
  /** SHA-256 of the token. The token itself is shown once and never stored. */
  tokenHash: text("token_hash").notNull().unique(),
  createdBy: text("created_by").references(() => users.id, {
    onDelete: "set null",
  }),
  createdAt: createdAt(),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  usedAt: timestamp("used_at", { withTimezone: true }),
  usedByNode: text("used_by_node"),
});

export const placements = pgTable(
  "placements",
  {
    botId: text("bot_id").primaryKey(),
    /** `local` for the deployment's own supervisor; otherwise a nodes.id. */
    nodeId: text("node_id").notNull(),
    placedAt: createdAt(),
    movedFrom: text("moved_from"),
  },
  (table) => [index("placements_node_idx").on(table.nodeId)],
);
