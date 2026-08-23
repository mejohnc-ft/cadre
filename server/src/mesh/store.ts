import { and, eq, isNull } from "drizzle-orm";
import { decryptSecret, encryptSecret } from "../credentials";
import type { Database } from "../db/client";
import { nodeEnrollmentTokens, nodes, placements } from "../db/schema";

/**
 * The mesh's own tables, behind two small stores.
 *
 * Node tokens are held encrypted under the deployment key and never leave this module except as
 * the bearer header on a call to that node's supervisor. An enrollment token is shown to a person
 * once; only its hash is kept, and it is spent the first time it is used.
 */

export type MeshNode = {
  id: string;
  name: string;
  supervisorUrl: string;
  backend: string;
  placementEnabled: boolean;
  enrolledAt: string;
  lastSeenAt: string | null;
  lastHealth: Record<string, unknown> | null;
};

export type EnrollInput = {
  id: string;
  name: string;
  supervisorUrl: string;
  supervisorToken: string;
  backend: string;
  enrolledBy?: string;
};

const ENROLLMENT_TTL_MS = 30 * 60 * 1000;

async function sha256(value: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(value),
  );
  return Buffer.from(digest).toString("hex");
}

function toNode(row: typeof nodes.$inferSelect): MeshNode {
  return {
    id: row.id,
    name: row.name,
    supervisorUrl: row.supervisorUrl,
    backend: row.backend,
    placementEnabled: row.placementEnabled,
    enrolledAt: row.enrolledAt.toISOString(),
    lastSeenAt: row.lastSeenAt?.toISOString() ?? null,
    lastHealth: row.lastHealth ?? null,
  };
}

export function createNodeStore(database: Database, encryptionKey: string) {
  return {
    async list(): Promise<MeshNode[]> {
      const rows = await database
        .select()
        .from(nodes)
        .orderBy(nodes.enrolledAt);
      return rows.map(toNode);
    },

    async get(id: string): Promise<MeshNode | null> {
      const [row] = await database
        .select()
        .from(nodes)
        .where(eq(nodes.id, id))
        .limit(1);
      return row ? toNode(row) : null;
    },

    /** The node's supervisor token, decrypted for a call and nothing else. */
    async tokenFor(id: string): Promise<string | null> {
      const [row] = await database
        .select({ tokenEncrypted: nodes.tokenEncrypted })
        .from(nodes)
        .where(eq(nodes.id, id))
        .limit(1);
      return row ? decryptSecret(encryptionKey, row.tokenEncrypted) : null;
    },

    async enroll(input: EnrollInput): Promise<MeshNode> {
      const tokenEncrypted = await encryptSecret(
        encryptionKey,
        input.supervisorToken,
      );
      const [row] = await database
        .insert(nodes)
        .values({
          id: input.id,
          name: input.name,
          supervisorUrl: input.supervisorUrl,
          tokenEncrypted,
          backend: input.backend,
          enrolledBy: input.enrolledBy ?? null,
          lastSeenAt: new Date(),
        })
        .onConflictDoUpdate({
          target: nodes.id,
          set: {
            name: input.name,
            supervisorUrl: input.supervisorUrl,
            tokenEncrypted,
            backend: input.backend,
            lastSeenAt: new Date(),
          },
        })
        .returning();
      if (!row) throw new Error("The node could not be stored.");
      return toNode(row);
    },

    async remove(id: string): Promise<boolean> {
      const removed = await database
        .delete(nodes)
        .where(eq(nodes.id, id))
        .returning({ id: nodes.id });
      return removed.length > 0;
    },

    async setPlacementEnabled(id: string, enabled: boolean): Promise<boolean> {
      const updated = await database
        .update(nodes)
        .set({ placementEnabled: enabled })
        .where(eq(nodes.id, id))
        .returning({ id: nodes.id });
      return updated.length > 0;
    },

    async recordHealth(
      id: string,
      health: Record<string, unknown> | null,
    ): Promise<void> {
      await database
        .update(nodes)
        .set({
          lastHealth: health,
          ...(health ? { lastSeenAt: new Date() } : {}),
        })
        .where(eq(nodes.id, id));
    },

    /** A one-time token, returned in the clear exactly once. */
    async mintEnrollmentToken(
      createdBy?: string,
    ): Promise<{ token: string; expiresAt: string }> {
      const token = `slice-enroll-${Buffer.from(
        crypto.getRandomValues(new Uint8Array(24)),
      ).toString("base64url")}`;
      const expiresAt = new Date(Date.now() + ENROLLMENT_TTL_MS);
      await database.insert(nodeEnrollmentTokens).values({
        id: crypto.randomUUID(),
        tokenHash: await sha256(token),
        createdBy: createdBy ?? null,
        expiresAt,
      });
      return { token, expiresAt: expiresAt.toISOString() };
    },

    /** Spend a token. False when it does not exist, is expired, or was already used. */
    async consumeEnrollmentToken(
      token: string,
      nodeId: string,
    ): Promise<boolean> {
      const hash = await sha256(token);
      const used = await database
        .update(nodeEnrollmentTokens)
        .set({ usedAt: new Date(), usedByNode: nodeId })
        .where(
          and(
            eq(nodeEnrollmentTokens.tokenHash, hash),
            isNull(nodeEnrollmentTokens.usedAt),
          ),
        )
        .returning({ expiresAt: nodeEnrollmentTokens.expiresAt });
      const row = used[0];
      return row !== undefined && row.expiresAt.getTime() > Date.now();
    },
  };
}

export type NodeStore = ReturnType<typeof createNodeStore>;

export const LOCAL_NODE = "local";

export function createPlacementStore(database: Database) {
  return {
    /** Where this Bot's computer is. `local` when nothing says otherwise. */
    async get(botId: string): Promise<string> {
      const [row] = await database
        .select({ nodeId: placements.nodeId })
        .from(placements)
        .where(eq(placements.botId, botId))
        .limit(1);
      return row?.nodeId ?? LOCAL_NODE;
    },

    async set(botId: string, nodeId: string, movedFrom?: string) {
      await database
        .insert(placements)
        .values({ botId, nodeId, movedFrom: movedFrom ?? null })
        .onConflictDoUpdate({
          target: placements.botId,
          set: { nodeId, movedFrom: movedFrom ?? null, placedAt: new Date() },
        });
    },

    async all(): Promise<Record<string, string>> {
      const rows = await database
        .select({ botId: placements.botId, nodeId: placements.nodeId })
        .from(placements);
      return Object.fromEntries(rows.map((row) => [row.botId, row.nodeId]));
    },
  };
}

export type PlacementStore = ReturnType<typeof createPlacementStore>;
