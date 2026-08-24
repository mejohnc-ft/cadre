import { afterAll, describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { createDatabase } from "../src/db/client";
import { agents, modelProviders } from "../src/db/schema";
import { createProviderStore } from "../src/providers/store";
import { TEST_POOL } from "./support/database";

/**
 * Providers and routing against a live database: the key round-trips encrypted, one default at a
 * time, and routeFor answers the coworker's route, the default, or null.
 */

const databaseUrl =
  process.env.DATABASE_URL ??
  "postgres://openbot:openbot@localhost:5432/openbot";
const database = createDatabase(databaseUrl, TEST_POOL);
const KEK = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=";
const store = createProviderStore(database, KEK);

const suffix = crypto.randomUUID().slice(0, 8);
const providerA = `test-a-${suffix}`;
const providerB = `test-b-${suffix}`;
const agentId = `provider-test-${suffix}`;

afterAll(async () => {
  await database.delete(modelProviders).where(eq(modelProviders.id, providerA));
  await database.delete(modelProviders).where(eq(modelProviders.id, providerB));
  await database.delete(agents).where(eq(agents.id, agentId));
});

describe("provider store", () => {
  test("keys round-trip encrypted; the ciphertext is not the key", async () => {
    await store.upsert({
      id: providerA,
      name: "A",
      kind: "openai-compatible",
      baseUrl: "https://a.example/v1",
      defaultModel: "model-a",
      isDefault: true,
      key: "secret-key-a",
    });
    const [row] = await database
      .select({ keyEncrypted: modelProviders.keyEncrypted })
      .from(modelProviders)
      .where(eq(modelProviders.id, providerA));
    expect(row?.keyEncrypted).not.toContain("secret-key-a");
    const route = await store.routeFor("nobody-with-a-route");
    expect(route).toMatchObject({
      providerId: providerA,
      model: "model-a",
      key: "secret-key-a",
    });
  });

  test("making another provider default clears the first", async () => {
    await store.upsert({
      id: providerB,
      name: "B",
      kind: "anthropic-compatible",
      baseUrl: "https://b.example",
      defaultModel: "model-b",
      isDefault: true,
      key: "secret-key-b",
    });
    const providers = await store.list();
    const defaults = providers.filter((p) => p.isDefault).map((p) => p.id);
    expect(defaults).toEqual([providerB]);
  });

  test("a coworker's route overrides the default; clearing it restores it", async () => {
    await database
      .insert(agents)
      .values({
        id: agentId,
        name: agentId,
        type: "built_in",
        configuration: {},
      })
      .onConflictDoNothing();
    await store.setRoute({ agentId, providerId: providerA, model: "model-x" });
    let route = await store.routeFor(agentId);
    expect(route).toMatchObject({ providerId: providerA, model: "model-x" });

    expect(await store.clearRoute(agentId)).toBe(true);
    route = await store.routeFor(agentId);
    expect(route).toMatchObject({ providerId: providerB, model: "model-b" });
  });

  test("update without a key keeps the stored key", async () => {
    await store.upsert({
      id: providerA,
      name: "A renamed",
      kind: "openai-compatible",
      baseUrl: "https://a.example/v1",
      defaultModel: "model-a2",
    });
    await store.setRoute({ agentId, providerId: providerA, model: "model-a2" });
    const route = await store.routeFor(agentId);
    expect(route?.key).toBe("secret-key-a");
  });
});
