import { and, desc, eq } from "drizzle-orm";
import type { Database } from "../db/client";
import { artifacts, artifactVersions, profileArtifacts } from "../db/schema";

/**
 * The artifact registry, behind one store.
 *
 * Create makes version 1; update appends a version and moves `latestVersion`. Nothing is ever
 * overwritten, so a profile pinned to an old version keeps it and a diff is always available.
 * Attaching an artifact to a profile is a join row; resolving a profile's artifacts for a run
 * returns the content at the pinned version, or the latest.
 */

export const ARTIFACT_KINDS = [
  "instructions",
  "skill",
  "harness_settings",
  "mcp_config",
] as const;
export type ArtifactKind = (typeof ARTIFACT_KINDS)[number];

export type Artifact = {
  id: string;
  kind: ArtifactKind;
  name: string;
  description: string | null;
  latestVersion: number;
  updatedAt: string;
};

export type ArtifactWithContent = Artifact & {
  version: number;
  content: string;
};

export type ResolvedArtifact = {
  id: string;
  kind: ArtifactKind;
  name: string;
  version: number;
  content: string;
};

function slug(name: string): string {
  return (
    name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 40) || "artifact"
  );
}

export function createArtifactStore(database: Database) {
  return {
    async list(kind?: ArtifactKind): Promise<Artifact[]> {
      const rows = await database
        .select()
        .from(artifacts)
        .where(kind ? eq(artifacts.kind, kind) : undefined)
        .orderBy(desc(artifacts.updatedAt));
      return rows.map((row) => ({
        id: row.id,
        kind: row.kind as ArtifactKind,
        name: row.name,
        description: row.description,
        latestVersion: row.latestVersion,
        updatedAt: row.updatedAt.toISOString(),
      }));
    },

    async get(
      id: string,
      version?: number,
    ): Promise<ArtifactWithContent | null> {
      const [row] = await database
        .select()
        .from(artifacts)
        .where(eq(artifacts.id, id))
        .limit(1);
      if (!row) return null;
      const wanted = version ?? row.latestVersion;
      const [content] = await database
        .select({ content: artifactVersions.content })
        .from(artifactVersions)
        .where(
          and(
            eq(artifactVersions.artifactId, id),
            eq(artifactVersions.version, wanted),
          ),
        )
        .limit(1);
      return {
        id: row.id,
        kind: row.kind as ArtifactKind,
        name: row.name,
        description: row.description,
        latestVersion: row.latestVersion,
        updatedAt: row.updatedAt.toISOString(),
        version: wanted,
        content: content?.content ?? "",
      };
    },

    async versions(
      id: string,
    ): Promise<Array<{ version: number; createdAt: string }>> {
      const rows = await database
        .select({
          version: artifactVersions.version,
          createdAt: artifactVersions.createdAt,
        })
        .from(artifactVersions)
        .where(eq(artifactVersions.artifactId, id))
        .orderBy(desc(artifactVersions.version));
      return rows.map((r) => ({
        version: r.version,
        createdAt: r.createdAt.toISOString(),
      }));
    },

    async create(input: {
      kind: ArtifactKind;
      name: string;
      description?: string;
      content: string;
      createdBy?: string;
    }): Promise<Artifact> {
      const id = `${input.kind}-${slug(input.name)}-${crypto.randomUUID().slice(0, 8)}`;
      return database.transaction(async (tx) => {
        const [row] = await tx
          .insert(artifacts)
          .values({
            id,
            kind: input.kind,
            name: input.name,
            description: input.description ?? null,
            ownerUserId: input.createdBy ?? null,
            latestVersion: 1,
          })
          .returning();
        await tx.insert(artifactVersions).values({
          artifactId: id,
          version: 1,
          content: input.content,
          createdBy: input.createdBy ?? null,
        });
        if (!row) throw new Error("The artifact could not be stored.");
        return {
          id: row.id,
          kind: row.kind as ArtifactKind,
          name: row.name,
          description: row.description,
          latestVersion: 1,
          updatedAt: row.updatedAt.toISOString(),
        };
      });
    },

    /** Append a new version. Returns the new version number. */
    async update(
      id: string,
      input: { content: string; description?: string; createdBy?: string },
    ): Promise<number> {
      return database.transaction(async (tx) => {
        const [row] = await tx
          .select({ latest: artifacts.latestVersion })
          .from(artifacts)
          .where(eq(artifacts.id, id))
          .limit(1);
        if (!row) throw new Error(`Artifact ${id} was not found.`);
        const next = row.latest + 1;
        await tx.insert(artifactVersions).values({
          artifactId: id,
          version: next,
          content: input.content,
          createdBy: input.createdBy ?? null,
        });
        await tx
          .update(artifacts)
          .set({
            latestVersion: next,
            updatedAt: new Date(),
            ...(input.description !== undefined
              ? { description: input.description }
              : {}),
          })
          .where(eq(artifacts.id, id));
        return next;
      });
    },

    async remove(id: string): Promise<boolean> {
      const removed = await database
        .delete(artifacts)
        .where(eq(artifacts.id, id))
        .returning({ id: artifacts.id });
      return removed.length > 0;
    },

    // ---- profile attachment ------------------------------------------------------------------

    async attach(agentId: string, artifactId: string, pinnedVersion?: number) {
      await database
        .insert(profileArtifacts)
        .values({ agentId, artifactId, pinnedVersion: pinnedVersion ?? null })
        .onConflictDoUpdate({
          target: [profileArtifacts.agentId, profileArtifacts.artifactId],
          set: { pinnedVersion: pinnedVersion ?? null },
        });
    },

    async detach(agentId: string, artifactId: string): Promise<boolean> {
      const removed = await database
        .delete(profileArtifacts)
        .where(
          and(
            eq(profileArtifacts.agentId, agentId),
            eq(profileArtifacts.artifactId, artifactId),
          ),
        )
        .returning({ artifactId: profileArtifacts.artifactId });
      return removed.length > 0;
    },

    async forProfile(
      agentId: string,
    ): Promise<Array<Artifact & { pinnedVersion: number | null }>> {
      const rows = await database
        .select({
          id: artifacts.id,
          kind: artifacts.kind,
          name: artifacts.name,
          description: artifacts.description,
          latestVersion: artifacts.latestVersion,
          updatedAt: artifacts.updatedAt,
          pinnedVersion: profileArtifacts.pinnedVersion,
        })
        .from(profileArtifacts)
        .innerJoin(artifacts, eq(profileArtifacts.artifactId, artifacts.id))
        .where(eq(profileArtifacts.agentId, agentId));
      return rows.map((row) => ({
        id: row.id,
        kind: row.kind as ArtifactKind,
        name: row.name,
        description: row.description,
        latestVersion: row.latestVersion,
        updatedAt: row.updatedAt.toISOString(),
        pinnedVersion: row.pinnedVersion,
      }));
    },

    /** A profile's artifacts with content, at their pinned or latest version, for a run. */
    async resolveForRun(agentId: string): Promise<ResolvedArtifact[]> {
      const attached = await database
        .select({
          id: artifacts.id,
          kind: artifacts.kind,
          name: artifacts.name,
          latestVersion: artifacts.latestVersion,
          pinnedVersion: profileArtifacts.pinnedVersion,
        })
        .from(profileArtifacts)
        .innerJoin(artifacts, eq(profileArtifacts.artifactId, artifacts.id))
        .where(eq(profileArtifacts.agentId, agentId));
      const resolved: ResolvedArtifact[] = [];
      for (const row of attached) {
        const version = row.pinnedVersion ?? row.latestVersion;
        const [content] = await database
          .select({ content: artifactVersions.content })
          .from(artifactVersions)
          .where(
            and(
              eq(artifactVersions.artifactId, row.id),
              eq(artifactVersions.version, version),
            ),
          )
          .limit(1);
        resolved.push({
          id: row.id,
          kind: row.kind as ArtifactKind,
          name: row.name,
          version,
          content: content?.content ?? "",
        });
      }
      return resolved;
    },
  };
}

export type ArtifactStore = ReturnType<typeof createArtifactStore>;
