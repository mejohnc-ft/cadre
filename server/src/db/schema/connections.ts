import { pgTable, primaryKey, text, timestamp } from "drizzle-orm/pg-core";
import { agents } from "./core";
import { jsonb } from "./json";

/**
 * Connections: the credentials a coworker's workflows use, held where no coworker can read them.
 *
 * A connection is a named credential for an outside service — an API token, a CLI login, or a
 * website username and password. The secret is AES-GCM under KEY_ENCRYPTION_KEY like a provider
 * key, written by an administrator and never returned by any route. What a coworker gets is the
 * name: an API connection is reached through the egress proxy, a web login is typed into the page
 * by the server on the coworker's behalf, and in both cases the plaintext never enters the
 * computer's environment or the model's context.
 *
 * Use is granted per coworker. A grant is the administrator's standing answer to "may this
 * coworker use this credential", checked on every use and audited.
 */

const createdAt = () =>
  timestamp("created_at", { withTimezone: true }).notNull().defaultNow();

export const connections = pgTable("connections", {
  /** A slug the administrator recognises: "hover", "netlify", "cloudflare-personal". */
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  /**
   * How the credential is used: "api" through the egress proxy, "web" typed into a page,
   * "cli" injected into a harness run's environment.
   */
  kind: text("kind").notNull(),
  /** The service it belongs to, freeform: "hover", "netlify", "github", "azure". */
  service: text("service").notNull(),
  /** For api connections: where the service's API lives. */
  baseUrl: text("base_url"),
  /** For web logins: the sign-in page. */
  loginUrl: text("login_url"),
  /** For web logins: the account name, which is not a secret and may be typed openly. */
  username: text("username"),
  /**
   * A 1Password item to source the password (and current one-time code) from at sign-in, instead
   * of storing them here. The server reads them with `op` on the host and injects them into the
   * coworker's browser; the container never sees 1Password. `opAccount` + `opRef` like
   * my.1password.com + op://Private/Microsoft 365.
   */
  opAccount: text("op_account"),
  opRef: text("op_ref"),
  /** Null for a session-only web login: connected by signing in yourself, no password stored. */
  secretEncrypted: text("secret_encrypted"),
  /** TOTP seed for logins with one-time codes; the server computes the six digits. */
  totpEncrypted: text("totp_encrypted"),
  /**
   * A captured browser session (Playwright storageState) sealed like every other secret. This is
   * the "auth once, reuse" path: a supervised login produces it, and a run imports it so the
   * coworker starts signed in. Held on the connection so grants and audit already cover it.
   */
  sessionEncrypted: text("session_encrypted"),
  sessionCapturedAt: timestamp("session_captured_at", { withTimezone: true }),
  /** A human hint at when the session likely stops working (earliest cookie expiry). */
  sessionExpiresHint: text("session_expires_hint"),
  /**
   * For api connections: which requests egress will forward, as "METHOD /path" rules with `*` and
   * `**` wildcards. Null or empty forwards the whole API — the token's own scopes then rule.
   */
  allowedPaths: jsonb("allowed_paths").$type<string[]>(),
  notes: text("notes"),
  /** When a verification run last proved this credential signs in, and what it saw. */
  lastVerifiedAt: timestamp("last_verified_at", { withTimezone: true }),
  /** "ok" | "failed" */
  lastVerifyStatus: text("last_verify_status"),
  lastVerifyNote: text("last_verify_note"),
  createdAt: createdAt(),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

export const connectionGrants = pgTable(
  "connection_grants",
  {
    connectionId: text("connection_id")
      .notNull()
      .references(() => connections.id, { onDelete: "cascade" }),
    agentId: text("agent_id")
      .notNull()
      .references(() => agents.id, { onDelete: "cascade" }),
    grantedBy: text("granted_by"),
    createdAt: createdAt(),
  },
  (table) => [primaryKey({ columns: [table.connectionId, table.agentId] })],
);
