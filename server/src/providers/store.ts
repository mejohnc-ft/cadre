import { eq, ne } from "drizzle-orm";
import { decryptSecret, encryptSecret } from "../credentials";
import type { Database } from "../db/client";
import { modelProviders, modelRoutes } from "../db/schema";

/**
 * Providers and model routing, behind one store.
 *
 * `routeFor(agentId)` is the one question the runtime asks: which endpoint, which wire shape,
 * which model, which key — the coworker's route if it has one, else the default provider. The key
 * is decrypted only there, per call, so revoking a provider takes effect on the next run.
 *
 * When no provider exists at all the store answers null and the runtime falls back to the
 * environment (`OPENAI_COMPATIBLE_BASE_URL`, `HARNESS_*`), which is how a deployment configured
 * before providers existed keeps working unchanged.
 */

export const PROVIDER_KINDS = [
  "anthropic",
  "openai",
  "openai-compatible",
  "anthropic-compatible",
] as const;
export type ProviderKind = (typeof PROVIDER_KINDS)[number];

export type Provider = {
  id: string;
  name: string;
  kind: ProviderKind;
  baseUrl: string | null;
  defaultModel: string;
  isDefault: boolean;
  updatedAt: string;
};

export type ModelRoute = {
  agentId: string;
  providerId: string;
  model: string;
  fallbacks: Array<{ providerId: string; model: string }>;
};

/** Everything a run needs to reach its model. `key` is the decrypted secret; never log it. */
export type ResolvedRoute = {
  providerId: string;
  kind: ProviderKind;
  baseUrl: string | null;
  model: string;
  key: string;
};

function toProvider(row: typeof modelProviders.$inferSelect): Provider {
  return {
    id: row.id,
    name: row.name,
    kind: row.kind as ProviderKind,
    baseUrl: row.baseUrl,
    defaultModel: row.defaultModel,
    isDefault: row.isDefault,
    updatedAt: row.updatedAt.toISOString(),
  };
}

export function createProviderStore(database: Database, encryptionKey: string) {
  return {
    async list(): Promise<Provider[]> {
      const rows = await database.select().from(modelProviders);
      return rows
        .map(toProvider)
        .sort((a, b) =>
          a.isDefault === b.isDefault
            ? a.id.localeCompare(b.id)
            : a.isDefault
              ? -1
              : 1,
        );
    },

    async get(id: string): Promise<Provider | null> {
      const [row] = await database
        .select()
        .from(modelProviders)
        .where(eq(modelProviders.id, id))
        .limit(1);
      return row ? toProvider(row) : null;
    },

    async upsert(input: {
      id: string;
      name: string;
      kind: ProviderKind;
      baseUrl?: string | null;
      defaultModel: string;
      isDefault?: boolean;
      /** Absent on update keeps the stored key. */
      key?: string;
    }): Promise<Provider> {
      return database.transaction(async (tx) => {
        const [existing] = await tx
          .select({ keyEncrypted: modelProviders.keyEncrypted })
          .from(modelProviders)
          .where(eq(modelProviders.id, input.id))
          .limit(1);
        const keyEncrypted = input.key
          ? await encryptSecret(encryptionKey, input.key)
          : existing?.keyEncrypted;
        if (!keyEncrypted) {
          throw new Error("A key is required for a new provider.");
        }
        const values = {
          name: input.name,
          kind: input.kind,
          baseUrl: input.baseUrl?.trim() || null,
          defaultModel: input.defaultModel,
          isDefault: input.isDefault ?? false,
          keyEncrypted,
          updatedAt: new Date(),
        };
        const [row] = await tx
          .insert(modelProviders)
          .values({ id: input.id, ...values })
          .onConflictDoUpdate({ target: modelProviders.id, set: values })
          .returning();
        // One default at a time: making this one the default clears the others.
        if (values.isDefault) {
          await tx
            .update(modelProviders)
            .set({ isDefault: false })
            .where(ne(modelProviders.id, input.id));
        }
        if (!row) throw new Error("The provider could not be stored.");
        return toProvider(row);
      });
    },

    async remove(id: string): Promise<boolean> {
      const removed = await database
        .delete(modelProviders)
        .where(eq(modelProviders.id, id))
        .returning({ id: modelProviders.id });
      return removed.length > 0;
    },

    // ---- routes --------------------------------------------------------------------------------

    async routeOf(agentId: string): Promise<ModelRoute | null> {
      const [row] = await database
        .select()
        .from(modelRoutes)
        .where(eq(modelRoutes.agentId, agentId))
        .limit(1);
      return row
        ? {
            agentId: row.agentId,
            providerId: row.providerId,
            model: row.model,
            fallbacks: row.fallbacks ?? [],
          }
        : null;
    },

    async setRoute(input: {
      agentId: string;
      providerId: string;
      model: string;
      fallbacks?: Array<{ providerId: string; model: string }>;
    }): Promise<void> {
      await database
        .insert(modelRoutes)
        .values({
          agentId: input.agentId,
          providerId: input.providerId,
          model: input.model,
          fallbacks: input.fallbacks ?? [],
        })
        .onConflictDoUpdate({
          target: modelRoutes.agentId,
          set: {
            providerId: input.providerId,
            model: input.model,
            fallbacks: input.fallbacks ?? [],
          },
        });
    },

    async clearRoute(agentId: string): Promise<boolean> {
      const removed = await database
        .delete(modelRoutes)
        .where(eq(modelRoutes.agentId, agentId))
        .returning({ agentId: modelRoutes.agentId });
      return removed.length > 0;
    },

    /** A provider's decrypted key, for the egress proxy alone. */
    async secretOf(providerId: string): Promise<string | null> {
      const [row] = await database
        .select({ keyEncrypted: modelProviders.keyEncrypted })
        .from(modelProviders)
        .where(eq(modelProviders.id, providerId))
        .limit(1);
      return row ? decryptSecret(encryptionKey, row.keyEncrypted) : null;
    },

    /**
     * The route a run uses: the coworker's own, else the default provider. Null when the
     * deployment has no providers — the caller falls back to the environment.
     */
    async routeFor(agentId: string): Promise<ResolvedRoute | null> {
      const route = await this.routeOf(agentId);
      const [providerRow] = route
        ? await database
            .select()
            .from(modelProviders)
            .where(eq(modelProviders.id, route.providerId))
            .limit(1)
        : await database
            .select()
            .from(modelProviders)
            .where(eq(modelProviders.isDefault, true))
            .limit(1);
      if (!providerRow) return null;
      return {
        providerId: providerRow.id,
        kind: providerRow.kind as ProviderKind,
        baseUrl: providerRow.baseUrl,
        model: route?.model ?? providerRow.defaultModel,
        key: await decryptSecret(encryptionKey, providerRow.keyEncrypted),
      };
    },
  };
}

export type ProviderStore = ReturnType<typeof createProviderStore>;
