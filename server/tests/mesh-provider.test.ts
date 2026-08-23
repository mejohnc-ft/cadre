import { describe, expect, test } from "bun:test";
import type { AuditEventInput } from "../src/audit";
import type { SupervisorProvider } from "../src/computer/supervisor";
import { createMeshProvider } from "../src/mesh/provider";
import type { MeshNode, NodeStore, PlacementStore } from "../src/mesh/store";

/**
 * The mesh over fakes: which node a Bot's computer is on decides which supervisor is called, a
 * move carries the bundle in the safe order, and a node that does not answer is reported rather
 * than fatal.
 */

function fakeSupervisor(
  name: string,
  log: string[],
): SupervisorProvider & {
  stored: Uint8Array | null;
} {
  const self = {
    name,
    isolation: "per-bot" as const,
    stored: null as Uint8Array | null,
    running: false,
    async locate(botId: string) {
      log.push(`${name}:locate:${botId}`);
      self.running = true;
      return `http://${name}:4100`;
    },
    async status(botId: string) {
      return {
        botId,
        state: self.running ? ("ready" as const) : ("absent" as const),
      };
    },
    async stop(botId: string) {
      log.push(`${name}:stop:${botId}`);
      const wasRunning = self.running;
      self.running = false;
      return { wasRunning };
    },
    async reset() {
      return { cleared: true };
    },
    async list() {
      return self.running
        ? [
            {
              botId: "bot",
              status: "running" as const,
              url: `http://${name}:4100`,
            },
          ]
        : [];
    },
    async capacity() {
      return { node: name };
    },
    async bundle(botId: string) {
      log.push(`${name}:bundle:${botId}`);
      return new TextEncoder().encode(`bundle-from-${name}`);
    },
    async restore(botId: string, bundle: Uint8Array) {
      log.push(`${name}:restore:${botId}`);
      self.stored = bundle;
    },
    async health() {
      return { status: "ok", backend: name, contract: "v1" };
    },
  };
  return self;
}

function fakeStores(nodes: MeshNode[]) {
  const placements = new Map<string, string>();
  const nodeStore = {
    list: async () => nodes,
    get: async (id: string) => nodes.find((node) => node.id === id) ?? null,
    tokenFor: async (id: string) =>
      nodes.some((n) => n.id === id) ? `tok-${id}` : null,
    recordHealth: async () => {},
  } as unknown as NodeStore;
  const placementStore = {
    get: async (botId: string) => placements.get(botId) ?? "local",
    set: async (botId: string, nodeId: string) => {
      placements.set(botId, nodeId);
    },
    all: async () => Object.fromEntries(placements),
  } as unknown as PlacementStore;
  return { nodeStore, placementStore, placements };
}

const serverNode: MeshNode = {
  id: "server",
  name: "Server",
  supervisorUrl: "http://server:4300",
  backend: "docker",
  placementEnabled: true,
  enrolledAt: "",
  lastSeenAt: null,
  lastHealth: null,
};

describe("mesh provider", () => {
  test("a Bot with no placement lives on the local supervisor", async () => {
    const log: string[] = [];
    const local = fakeSupervisor("local", log);
    const remote = fakeSupervisor("server", log);
    const { nodeStore, placementStore } = fakeStores([serverNode]);
    const mesh = createMeshProvider({
      local,
      nodes: nodeStore,
      placements: placementStore,
      audit: { insert: async () => {} },
      clientFor: () => remote,
    });
    expect(await mesh.locate("bot")).toBe("http://local:4100");
    expect(log).toEqual(["local:locate:bot"]);
  });

  test("moving carries the bundle: export, ensure target, restore, stop source, record", async () => {
    const log: string[] = [];
    const audits: AuditEventInput[] = [];
    const local = fakeSupervisor("local", log);
    const remote = fakeSupervisor("server", log);
    const { nodeStore, placementStore, placements } = fakeStores([serverNode]);
    const mesh = createMeshProvider({
      local,
      nodes: nodeStore,
      placements: placementStore,
      audit: { insert: async (event) => void audits.push(event) },
      clientFor: () => remote,
    });
    await mesh.locate("bot"); // the computer exists locally
    log.length = 0;

    const moved = await mesh.move("bot", "server", "admin");
    expect(moved).toMatchObject({ from: "local", to: "server" });
    expect(log).toEqual([
      "local:locate:bot",
      "local:bundle:bot",
      "server:locate:bot",
      "server:restore:bot",
      "local:stop:bot",
    ]);
    expect(new TextDecoder().decode(remote.stored ?? new Uint8Array())).toBe(
      "bundle-from-local",
    );
    expect(placements.get("bot")).toBe("server");
    expect(audits.map((a) => a.eventType)).toEqual(["computer.moved"]);

    // From now on the Bot's computer is the server's.
    expect(await mesh.locate("bot")).toBe("http://server:4100");
  });

  test("refuses a move to a node not accepting placements, and to the same node", async () => {
    const log: string[] = [];
    const { nodeStore, placementStore } = fakeStores([
      { ...serverNode, placementEnabled: false },
    ]);
    const mesh = createMeshProvider({
      local: fakeSupervisor("local", log),
      nodes: nodeStore,
      placements: placementStore,
      audit: { insert: async () => {} },
      clientFor: () => fakeSupervisor("server", log),
    });
    await expect(mesh.move("bot", "server")).rejects.toThrow(/not accepting/);
    await expect(mesh.move("bot", "local")).rejects.toThrow(/already on/);
  });

  test("capacity lists every node, marking the ones that do not answer", async () => {
    const log: string[] = [];
    const { nodeStore, placementStore } = fakeStores([
      serverNode,
      { ...serverNode, id: "asleep", name: "Asleep" },
    ]);
    const mesh = createMeshProvider({
      local: fakeSupervisor("local", log),
      nodes: nodeStore,
      placements: placementStore,
      audit: { insert: async () => {} },
      clientFor: (node) => {
        if (node.id === "asleep") {
          const dead = fakeSupervisor("asleep", log);
          dead.capacity = async () => {
            throw new Error("no route to host");
          };
          return dead;
        }
        return fakeSupervisor("server", log);
      },
    });
    const report = await mesh.capacityByNode();
    expect(report.map((n) => [n.id, n.reachable])).toEqual([
      ["local", true],
      ["asleep", false],
      ["server", true],
    ]);
    expect(report.find((n) => n.id === "asleep")?.error).toMatch(/no route/);
  });
});
