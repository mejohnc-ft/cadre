import {
  index,
  integer,
  pgTable,
  primaryKey,
  text,
  timestamp,
} from "drizzle-orm/pg-core";
import { agentProfiles } from "./coworker";
import { users } from "./core";

/**
 * Artifacts: the versioned context a coworker is made of, held once and attached to profiles.
 *
 * An artifact is a named, versioned unit — an instructions file (CLAUDE.md / AGENTS.md), a skill,
 * a harness settings file, an MCP config. Editing it makes a new version; a profile references it
 * by a pinned version or "latest". Projected into a harness's workspace at the start of a run, so
 * the same instructions reach whichever engine the profile runs — the server picks the filename
 * per engine, the author writes the content once.
 *
 * `agents`/`agentProfiles` are imported only to scope profile_artifacts; artifacts themselves are
 * deployment-wide and shared between profiles.
 */

const createdAt = () =>
  timestamp("created_at", { withTimezone: true }).notNull().defaultNow();

export const artifacts = pgTable(
  "artifacts",
  {
    id: text("id").primaryKey(),
    /** instructions | skill | harness_settings | mcp_config */
    kind: text("kind").notNull(),
    name: text("name").notNull(),
    description: text("description"),
    ownerUserId: text("owner_user_id").references(() => users.id, {
      onDelete: "set null",
    }),
    /** The current version number; the latest row in artifact_versions. */
    latestVersion: integer("latest_version").notNull().default(1),
    createdAt: createdAt(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [index("artifacts_kind_idx").on(table.kind)],
);

export const artifactVersions = pgTable(
  "artifact_versions",
  {
    artifactId: text("artifact_id")
      .notNull()
      .references(() => artifacts.id, { onDelete: "cascade" }),
    version: integer("version").notNull(),
    content: text("content").notNull(),
    createdBy: text("created_by").references(() => users.id, {
      onDelete: "set null",
    }),
    createdAt: createdAt(),
  },
  (table) => [primaryKey({ columns: [table.artifactId, table.version] })],
);

/** Which artifacts a profile carries, and at which version ("latest" = null). */
export const profileArtifacts = pgTable(
  "profile_artifacts",
  {
    agentId: text("agent_id")
      .notNull()
      .references(() => agentProfiles.agentId, { onDelete: "cascade" }),
    artifactId: text("artifact_id")
      .notNull()
      .references(() => artifacts.id, { onDelete: "cascade" }),
    /** Null follows latest; a number pins that version. */
    pinnedVersion: integer("pinned_version"),
    createdAt: createdAt(),
  },
  (table) => [
    primaryKey({ columns: [table.agentId, table.artifactId] }),
    index("profile_artifacts_artifact_idx").on(table.artifactId),
  ],
);
