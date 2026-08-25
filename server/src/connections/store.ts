import { and, asc, eq } from "drizzle-orm";
import type { AuditStore } from "../audit";
import { recordAuditEvent } from "../audit";
import { decryptSecret, encryptSecret } from "../credentials";
import type { Database } from "../db/client";
import { connectionGrants, connections } from "../db/schema";
import { opOtp, opPassword, opUsername } from "./onepassword";
import { totpCode } from "./totp";

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
  opRef: string | null;
  opAccount: string | null;
  allowedPaths: string[] | null;
  notes: string | null;
  grants: string[];
  lastVerifiedAt: string | null;
  lastVerifyStatus: string | null;
  lastVerifyNote: string | null;
  hasSession: boolean;
  sessionCapturedAt: string | null;
  sessionExpiresHint: string | null;
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
    opRef: row.opRef,
    opAccount: row.opAccount,
    allowedPaths: row.allowedPaths ?? null,
    notes: row.notes,
    lastVerifiedAt: row.lastVerifiedAt?.toISOString() ?? null,
    lastVerifyStatus: row.lastVerifyStatus,
    lastVerifyNote: row.lastVerifyNote,
    hasSession: row.sessionEncrypted !== null,
    sessionCapturedAt: row.sessionCapturedAt?.toISOString() ?? null,
    sessionExpiresHint: row.sessionExpiresHint,
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
      opRef?: string | null;
      opAccount?: string | null;
      secret?: string;
      totpSeed?: string | null;
      allowedPaths?: string[] | null;
      notes?: string | null;
      actor?: string;
    }): Promise<{ created: boolean }> {
      const [existing] = await database
        .select({ id: connections.id, baseUrl: connections.baseUrl })
        .from(connections)
        .where(eq(connections.id, input.id))
        .limit(1);
      if (!existing && !input.secret && input.kind !== "web") {
        throw new Error("A new connection needs a secret.");
      }
      /*
       * A changed base URL with the old secret is the exfiltration shape: the vault would send a
       * stored token wherever the URL now points. Whoever legitimately moves an endpoint has the
       * credential and can retype it; whoever cannot retype it should not be moving the endpoint.
       */
      if (
        existing &&
        (input.baseUrl ?? null) !== existing.baseUrl &&
        !input.secret
      ) {
        throw new Error(
          "Changing the base URL requires re-entering the secret.",
        );
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
        opRef: input.opRef ?? null,
        opAccount: input.opAccount ?? null,
        allowedPaths:
          input.allowedPaths === undefined ? null : input.allowedPaths,
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
          secretEncrypted: encrypted ?? null,
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

    /** What a verification run concluded, written to the connection it verified. */
    async recordVerify(
      id: string,
      outcome: { status: "ok" | "failed"; note: string },
    ): Promise<void> {
      await database
        .update(connections)
        .set({
          lastVerifiedAt: new Date(),
          lastVerifyStatus: outcome.status,
          lastVerifyNote: outcome.note.slice(0, 500),
        })
        .where(eq(connections.id, id));
      await recordAuditEvent(audit, {
        eventType: "connection.verified",
        targetType: "connection",
        targetId: id,
        payload: { connection: id, status: outcome.status },
      });
    },

    /** The decrypted secret, for the egress proxy and the secret-typing verb alone. */
    async secretOf(id: string): Promise<string | null> {
      const [row] = await database
        .select({
          secretEncrypted: connections.secretEncrypted,
          opRef: connections.opRef,
          opAccount: connections.opAccount,
        })
        .from(connections)
        .where(eq(connections.id, id))
        .limit(1);
      if (!row) return null;
      // Sourced from 1Password on the host, read fresh and never stored, when a reference is set.
      if (row.opRef) {
        return opPassword(row.opAccount ?? "", row.opRef);
      }
      return row.secretEncrypted
        ? decryptSecret(encryptionKey, row.secretEncrypted)
        : null;
    },

    /** The current one-time code: from 1Password if referenced, else computed from a stored seed. */
    async totpCodeOf(id: string): Promise<string | null> {
      const [row] = await database
        .select({
          totpEncrypted: connections.totpEncrypted,
          opRef: connections.opRef,
          opAccount: connections.opAccount,
        })
        .from(connections)
        .where(eq(connections.id, id))
        .limit(1);
      if (!row) return null;
      if (row.opRef) {
        return opOtp(row.opAccount ?? "", row.opRef);
      }
      if (!row.totpEncrypted) return null;
      const seed = await decryptSecret(encryptionKey, row.totpEncrypted);
      return totpCode(seed);
    },

    /**
     * The full credential a coworker needs to sign in, fetched fresh from 1Password on the host —
     * username, password, and this minute's one-time code. This is the deliberate approval point:
     * `op` runs here, prompting the operator's Touch ID when the vault is locked. The values are
     * read once and never stored.
     */
    async opCredsOf(id: string): Promise<{
      username: string | null;
      password: string | null;
      otp: string | null;
    } | null> {
      const [row] = await database
        .select({
          username: connections.username,
          opRef: connections.opRef,
          opAccount: connections.opAccount,
        })
        .from(connections)
        .where(eq(connections.id, id))
        .limit(1);
      if (!row?.opRef) return null;
      const account = row.opAccount ?? "";
      const [username, password, otp] = await Promise.all([
        row.username
          ? Promise.resolve(row.username)
          : opUsername(account, row.opRef),
        opPassword(account, row.opRef).catch(() => null),
        opOtp(account, row.opRef),
      ]);
      await recordAuditEvent(audit, {
        eventType: "connection.secret_typed",
        targetType: "connection",
        targetId: id,
        payload: {
          connection: id,
          via: "op-cred",
          fields: "username,password,otp",
        },
      });
      return { username, password, otp };
    },

    /** Seal a captured browser session onto the connection. The plaintext is never returned. */
    async storeSession(
      id: string,
      stateJson: string,
      expiresHint: string | null,
    ): Promise<void> {
      const encrypted = await encryptSecret(encryptionKey, stateJson);
      await database
        .update(connections)
        .set({
          sessionEncrypted: encrypted,
          sessionCapturedAt: new Date(),
          sessionExpiresHint: expiresHint,
          updatedAt: new Date(),
        })
        .where(eq(connections.id, id));
      await recordAuditEvent(audit, {
        eventType: "connection.session_captured",
        targetType: "connection",
        targetId: id,
        payload: { connection: id, expiresHint },
      });
    },

    /** The decrypted session (storageState JSON), for injecting into a computer alone. */
    async sessionOf(id: string): Promise<string | null> {
      const [row] = await database
        .select({ sessionEncrypted: connections.sessionEncrypted })
        .from(connections)
        .where(eq(connections.id, id))
        .limit(1);
      return row?.sessionEncrypted
        ? decryptSecret(encryptionKey, row.sessionEncrypted)
        : null;
    },

    /** Forget a captured session (e.g. it expired). */
    async clearSession(id: string): Promise<void> {
      await database
        .update(connections)
        .set({
          sessionEncrypted: null,
          sessionCapturedAt: null,
          sessionExpiresHint: null,
        })
        .where(eq(connections.id, id));
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
