import type { AuditStore } from "../audit";
import { recordAuditEvent } from "../audit";
import type { ComputerLocation, ComputerProvider } from "../computer/provider";
import type { ComputerStatus } from "../computer/schema";
import {
  createDockerSupervisorProvider,
  type SupervisorProvider,
} from "../computer/supervisor";
import {
  LOCAL_NODE,
  type MeshNode,
  type NodeStore,
  type PlacementStore,
} from "./store";

/**
 * One logical deployment across many machines.
 *
 * The gateway asks a provider where a Bot's computer is; this one answers by looking up the Bot's
 * placement, choosing the node that holds it, and delegating to that node's supervisor client.
 * Nothing above it knows there is more than one machine, which is what keeps the channel, the
 * audit trail and the policy node-independent.
 *
 * `local` is the deployment's own supervisor from configuration; every other node was enrolled
 * and lives in the database. Clients for enrolled nodes are built on first use and kept, keyed by
 * what they were built from, so a re-enrolment with a new address or token is picked up.
 *
 * Moving a Bot is: bundle out of the source, ensure on the target, bundle in, stop the source,
 * record the placement — in that order, so a failure at any step leaves the Bot on the source with
 * its state intact.
 */

export type NodeCapacity = {
  id: string;
  name: string;
  backend: string;
  placementEnabled: boolean;
  reachable: boolean;
  capacity: unknown;
  error?: string;
};

export type MeshOptions = {
  /** The deployment's own supervisor, or none when this server has no local computers. */
  local?: SupervisorProvider;
  nodes: NodeStore;
  placements: PlacementStore;
  audit: AuditStore;
  /** A client for an enrolled node. Injectable for tests. */
  clientFor?: (node: MeshNode, token: string) => SupervisorProvider;
};

export type MeshProvider = ComputerProvider & {
  nodeOf(botId: string): Promise<string>;
  capacityByNode(): Promise<NodeCapacity[]>;
  move(
    botId: string,
    toNode: string,
    actorId?: string,
  ): Promise<{ botId: string; from: string; to: string; bytes: number }>;
  listPlaced(): Promise<Array<ComputerLocation & { node: string }>>;
};

function defaultClient(node: MeshNode, token: string): SupervisorProvider {
  const host = new URL(node.supervisorUrl).hostname;
  return createDockerSupervisorProvider({
    baseUrl: node.supervisorUrl,
    token,
    // The node publishes its computers on its own address; a loopback URL from a remote
    // supervisor is that machine's loopback, not ours.
    publicHost: host,
    hostForPort: (port) => `http://${host}:${port}`,
  });
}

export function createMeshProvider(options: MeshOptions): MeshProvider {
  const clientFor = options.clientFor ?? defaultClient;
  const clients = new Map<
    string,
    { key: string; client: SupervisorProvider }
  >();

  async function clientForNode(nodeId: string): Promise<SupervisorProvider> {
    if (nodeId === LOCAL_NODE) {
      if (!options.local) {
        throw new Error(
          "This deployment has no local supervisor; the Bot must be placed on an enrolled node.",
        );
      }
      return options.local;
    }
    const node = await options.nodes.get(nodeId);
    if (!node) throw new Error(`Node "${nodeId}" is not enrolled.`);
    const token = await options.nodes.tokenFor(nodeId);
    if (token === null) throw new Error(`Node "${nodeId}" has no token.`);
    const key = `${node.supervisorUrl}|${token.length}|${node.backend}`;
    const cached = clients.get(nodeId);
    if (cached && cached.key === key) return cached.client;
    const client = clientFor(node, token);
    clients.set(nodeId, { key, client });
    return client;
  }

  async function providerFor(botId: string): Promise<SupervisorProvider> {
    return clientForNode(await options.placements.get(botId));
  }

  const mesh: MeshProvider = {
    name: options.local ? `Mesh (local: ${options.local.name})` : "Mesh",
    isolation: "per-bot",

    nodeOf: (botId) => options.placements.get(botId),

    locate: async (botId) => (await providerFor(botId)).locate(botId),
    status: async (botId): Promise<ComputerStatus> => {
      try {
        return await (await providerFor(botId)).status(botId);
      } catch (error) {
        return {
          botId,
          state: "unreachable",
          reason: error instanceof Error ? error.message : String(error),
        };
      }
    },
    stop: async (botId) => (await providerFor(botId)).stop(botId),
    reset: async (botId) => (await providerFor(botId)).reset(botId),
    sessionOf: async (botId) => {
      const provider = await providerFor(botId);
      return provider.sessionOf ? provider.sessionOf(botId) : undefined;
    },
    warm: async () => {
      await options.local?.warm?.();
    },

    /** Every computer on every node that answers. A node that does not is skipped, not fatal. */
    list: async () =>
      (await mesh.listPlaced()).map(({ node: _n, ...rest }) => rest),

    listPlaced: async () => {
      const out: Array<ComputerLocation & { node: string }> = [];
      const nodeIds = [
        ...(options.local ? [LOCAL_NODE] : []),
        ...(await options.nodes.list()).map((node) => node.id),
      ];
      await Promise.all(
        nodeIds.map(async (nodeId) => {
          try {
            const client = await clientForNode(nodeId);
            for (const computer of await client.list()) {
              out.push({ ...computer, node: nodeId });
            }
          } catch {
            // A node that is asleep or gone lists nothing; the page says so per node.
          }
        }),
      );
      return out;
    },

    capacity: async () => ({ nodes: await mesh.capacityByNode() }),

    capacityByNode: async () => {
      const entries: NodeCapacity[] = [];
      const targets: MeshNode[] = [
        ...(options.local
          ? [
              {
                id: LOCAL_NODE,
                name: "This machine",
                supervisorUrl: "",
                backend: options.local.name,
                placementEnabled: true,
                enrolledAt: "",
                lastSeenAt: null,
                lastHealth: null,
              },
            ]
          : []),
        ...(await options.nodes.list()),
      ];
      await Promise.all(
        targets.map(async (node) => {
          try {
            const client = await clientForNode(node.id);
            const capacity = client.capacity ? await client.capacity() : null;
            // The local node's backend is whatever its supervisor says it runs, not the client's
            // class name.
            const backend =
              node.id === LOCAL_NODE
                ? ((
                    await client
                      .health()
                      .catch((): { backend?: string } => ({}))
                  ).backend ?? node.backend)
                : node.backend;
            entries.push({
              id: node.id,
              name: node.name,
              backend,
              placementEnabled: node.placementEnabled,
              reachable: true,
              capacity,
            });
            if (node.id !== LOCAL_NODE) {
              await options.nodes.recordHealth(
                node.id,
                (capacity ?? {}) as Record<string, unknown>,
              );
            }
          } catch (error) {
            entries.push({
              id: node.id,
              name: node.name,
              backend: node.backend,
              placementEnabled: node.placementEnabled,
              reachable: false,
              capacity: null,
              error: error instanceof Error ? error.message : String(error),
            });
          }
        }),
      );
      const rank = (id: string) => (id === LOCAL_NODE ? 0 : 1);
      return entries.sort(
        (a, b) => rank(a.id) - rank(b.id) || a.id.localeCompare(b.id),
      );
    },

    move: async (botId, toNode, actorId) => {
      const from = await options.placements.get(botId);
      if (from === toNode) {
        throw new Error(`${botId} is already on ${toNode}.`);
      }
      if (toNode !== LOCAL_NODE) {
        const node = await options.nodes.get(toNode);
        if (!node) throw new Error(`Node "${toNode}" is not enrolled.`);
        if (!node.placementEnabled) {
          throw new Error(`Node "${toNode}" is not accepting placements.`);
        }
      }
      const source = await clientForNode(from);
      const target = await clientForNode(toNode);

      // What there is to carry. A Bot that never had a computer has nothing to move; its next
      // action simply starts on the new node.
      let bundle: Uint8Array | null = null;
      const status = await source.status(botId);
      if (status.state === "ready" || status.state === "starting") {
        await source.locate(botId);
        bundle = await source.bundle(botId);
      }

      await target.locate(botId);
      if (bundle) await target.restore(botId, bundle);
      if (bundle) await source.stop(botId);

      await options.placements.set(botId, toNode, from);
      await recordAuditEvent(options.audit, {
        eventType: "computer.moved",
        targetType: "bot",
        targetId: botId,
        ...(actorId ? { actorUserId: actorId } : {}),
        payload: {
          bot: botId,
          from,
          to: toNode,
          bytes: bundle?.byteLength ?? 0,
        },
      });
      return { botId, from, to: toNode, bytes: bundle?.byteLength ?? 0 };
    },
  };

  return mesh;
}
