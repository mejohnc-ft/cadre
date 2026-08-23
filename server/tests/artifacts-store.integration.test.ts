import { afterAll, describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { createArtifactStore } from "../src/artifacts/store";
import { createDatabase } from "../src/db/client";
import { agentProfiles, agents } from "../src/db/schema";
import { TEST_POOL } from "./support/database";

/**
 * The artifact registry against a live database: versions accrete, a profile resolves its
 * attachment at the pinned or latest version.
 */

const databaseUrl =
  process.env.DATABASE_URL ??
  "postgres://openbot:openbot@localhost:5432/openbot";
const database = createDatabase(databaseUrl, TEST_POOL);
const store = createArtifactStore(database);

const agentId = `artifact-test-${crypto.randomUUID()}`;
let artifactId = "";

afterAll(async () => {
  await database.delete(agents).where(eq(agents.id, agentId));
});

describe("artifact store", () => {
  test("create makes version 1; update appends versions, keeping the old content", async () => {
    const artifact = await store.create({
      kind: "instructions",
      name: "Test Rule",
      content: "v1 content",
    });
    artifactId = artifact.id;
    expect(artifact.latestVersion).toBe(1);

    const v2 = await store.update(artifactId, { content: "v2 content" });
    expect(v2).toBe(2);

    expect((await store.get(artifactId))?.content).toBe("v2 content");
    expect((await store.get(artifactId, 1))?.content).toBe("v1 content");
    expect((await store.versions(artifactId)).map((v) => v.version)).toEqual([
      2, 1,
    ]);
  });

  test("a profile resolves its attached artifact at latest, then at a pin", async () => {
    // A minimal agent + profile the attachment can reference.
    await database
      .insert(agents)
      .values({
        id: agentId,
        name: agentId,
        type: "built_in",
        configuration: {},
      })
      .onConflictDoNothing();
    await database
      .insert(agentProfiles)
      .values({
        agentId,
        title: "t",
        roleDescription: "r",
        avatarSeed: agentId,
        visibility: "public",
      })
      .onConflictDoNothing();

    await store.attach(agentId, artifactId);
    let resolved = await store.resolveForRun(agentId);
    expect(resolved).toHaveLength(1);
    expect(resolved[0]?.content).toBe("v2 content");
    expect(resolved[0]?.version).toBe(2);

    // Pin to version 1: the run now gets the old content.
    await store.attach(agentId, artifactId, 1);
    resolved = await store.resolveForRun(agentId);
    expect(resolved[0]?.content).toBe("v1 content");

    expect(await store.detach(agentId, artifactId)).toBe(true);
    expect(await store.resolveForRun(agentId)).toEqual([]);
  });
});
