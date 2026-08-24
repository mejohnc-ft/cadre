import { and, asc, eq } from "drizzle-orm";
import type { AuditStore } from "../audit";
import { recordAuditEvent } from "../audit";
import { decryptSecret, encryptSecret } from "../credentials";
import type { Database } from "../db/client";
import { connectionGrants, connections } from "../db/schema";

/**
 * The connections vault: named credentials for outside services, readable by no coworker.
 *
 * Secrets are AES-GCM under KEY_ENCRYPTION_KEY exactly as provider keys are, write-only through
 * the admin routes, and decrypted in two places only: the egress proxy injecting an API token
 * into a forwarded request, and the gateway typing a web password into a named page field. Both
 * check a grant first — the administrator's standing answer to "may this coworker use this
 * credential" — and both leave an audit row that names the connection and never the value.
 */

export const CONNECTION_KINDS = ["api", "cli", "web"] as const;
export type ConnectionKind = (typeof CONNECTION_KINDS)[number];

export type Connection = {
  id: string;
  name: string;
  kind: ConnectionKind;
  service: string;
  baseUrl: string | null;
  loginUrl: string | null;
  username: string | null;
  hasTotp: boolean;
  notes: string | null;
  grants: string[];
  updatedAt: string;
};

function toConnection(
  row: typeof connections.$inferSelect,
  grants: string[],
): Connection {
  return {
    id: row.id,
    name: row.name,
    kind: row.kind as ConnectionKind,
    service: row.service,
    baseUrl: row.baseUrl,
    loginUrl: row.loginUrl,
    username: row.username,
    hasTotp: row.totpEncrypted !== null,
    notes: row.notes,
    grants,
    updatedAt: row.updatedAt.toISOString(),
  };
}

export function createConnectionStore(
  database: Database,
  encryptionKey: string,
  audit: AuditStore,
) {
  async function grantsOf(): Promise<Map<string, string[]>> {
    const rows = await database.select().from(connectionGrants);
    const map = new Map<string, string[]>();
    for (const row of rows) {
      const list = map.get(row.connectionId) ?? [];
      list.push(row.agentId);
      map.set(row.connectionId, list);
    }
    return map;
  }

  return {
    async list(): Promise<Connection[]> {
      const [rows, grants] = await Promise.all([
        database.select().from(connections).orderBy(asc(connections.id)),
        grantsOf(),
      ]);
      return rows.map((row) => toConnection(row, grants.get(row.id) ?? []));
    },

    async get(id: string): Promise<Connection | null> {
      const [row] = await database
        .select()
        .from(connections)
        .where(eq(connections.id, id))
        .limit(1);
      if (!row) return null;
      const grants = await database
        .select()
        .from(connectionGrants)
        .where(eq(connectionGrants.connectionId, id));
      return toConnection(
        row,
        grants.map((grant) => grant.agentId),
      );
    },

    /** Upsert. `secret` and `totpSeed` absent keep what is stored; the routes never return either. */
    async upsert(input: {
      id: string;
      name: string;
      kind: ConnectionKind;
      service: string;
      baseUrl?: string | null;
      loginUrl?: string | null;
      username?: string | null;
      secret?: string;
      totpSeed?: string | null;
      notes?: string | null;
      actor?: string;
    }): Promise<{ created: boolean }> {
      const [existing] = await database
        .select({ id: connections.id })
        .from(connections)
        .where(eq(connections.id, input.id))
        .limit(1);
      if (!existing && !input.secret) {
        throw new Error("A new connection needs a secret.");
      }
      const encrypted = input.secret
        ? await encryptSecret(encryptionKey, input.secret)
        : undefined;
      const totpEncrypted =
        input.totpSeed === null
          ? null
          : input.totpSeed
            ? await encryptSecret(encryptionKey, input.totpSeed)
            : undefined;
      const values = {
        name: input.name,
        kind: input.kind,
        service: input.service,
        baseUrl: input.baseUrl ?? null,
        loginUrl: input.loginUrl ?? null,
        username: input.username ?? null,
        notes: input.notes ?? null,
        updatedAt: new Date(),
        ...(encrypted ? { secretEncrypted: encrypted } : {}),
        ...(totpEncrypted !== undefined ? { totpEncrypted } : {}),
      };
      if (existing) {
        await database
          .update(connections)
          .set(values)
          .where(eq(connections.id, input.id));
      } else {
        await database.insert(connections).values({
          id: input.id,
          ...values,
          secretEncrypted: encrypted as string,
        });
      }
      await recordAuditEvent(audit, {
        eventType: "connection.saved",
        targetType: "connection",
        targetId: input.id,
        payload: {
          connection: input.id,
          service: input.service,
          kind: input.kind,
          secretChanged: Boolean(input.secret),
          by: input.actor ?? null,
        },
      });
      return { created: !existing };
    },

    async remove(id: string, actor?: string): Promise<boolean> {
      const removed = await database
        .delete(connections)
        .where(eq(connections.id, id))
        .returning({ id: connections.id });
      if (removed.length === 0) return false;
      await recordAuditEvent(audit, {
        eventType: "connection.removed",
        targetType: "connection",
        targetId: id,
        payload: { connection: id, by: actor ?? null },
      });
      return true;
    },

    async grant(
      connectionId: string,
      agentId: string,
      grantedBy?: string,
    ): Promise<void> {
      await database
        .insert(connectionGrants)
        .values({ connectionId, agentId, grantedBy: grantedBy ?? null })
        .onConflictDoNothing();
      await recordAuditEvent(audit, {
        eventType: "connection.granted",
        targetType: "connection",
        targetId: connectionId,
        payload: {
          connection: connectionId,
          bot: agentId,
          by: grantedBy ?? null,
        },
      });
    },

    async revoke(connectionId: string, agentId: string): Promise<boolean> {
      const removed = await database
        .delete(connectionGrants)
        .where(
          and(
            eq(connectionGrants.connectionId, connectionId),
            eq(connectionGrants.agentId, agentId),
          ),
        )
        .returning({ agentId: connectionGrants.agentId });
      if (removed.length === 0) return false;
      await recordAuditEvent(audit, {
        eventType: "connection.revoked",
        targetType: "connection",
        targetId: connectionId,
        payload: { connection: connectionId, bot: agentId },
      });
      return true;
    },

    /** Whether this coworker may use this connection. Checked on every use, never cached. */
    async allowed(connectionId: string, agentId: string): Promise<boolean> {
      const [row] = await database
        .select({ agentId: connectionGrants.agentId })
        .from(connectionGrants)
        .where(
          and(
            eq(connectionGrants.connectionId, connectionId),
            eq(connectionGrants.agentId, agentId),
          ),
        )
        .limit(1);
      return row !== undefined;
    },

    /** The decrypted secret, for the egress proxy and the secret-typing verb alone. */
    async secretOf(id: string): Promise<string | null> {
      const [row] = await database
        .select({ secretEncrypted: connections.secretEncrypted })
        .from(connections)
        .where(eq(connections.id, id))
        .limit(1);
      return row ? decryptSecret(encryptionKey, row.secretEncrypted) : null;
    },

    /** The decrypted TOTP seed, or null when the login has none. */
    async totpSeedOf(id: string): Promise<string | null> {
      const [row] = await database
        .select({ totpEncrypted: connections.totpEncrypted })
        .from(connections)
        .where(eq(connections.id, id))
        .limit(1);
      return row?.totpEncrypted
        ? decryptSecret(encryptionKey, row.totpEncrypted)
        : null;
    },
  };
}

export type ConnectionStore = ReturnType<typeof createConnectionStore>;
