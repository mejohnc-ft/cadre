import { queryOptions } from "@tanstack/react-query";
import { client } from "@/lib/client";

/** One Bot's computer, as Admin sees it. */
export type ComputerProfile = {
  botId: string;
  running: boolean;
  startedAt: string | null;
  /** Absent when the provider does not report egress at all, which is not the same as none. */
  egress?: string | null;
};

/** Whether each Bot has a browser profile of its own, or they share one. */
export type ComputerIsolation = "per-bot" | "shared";

/** What the list endpoint answers: the computers, and how they are separated. */
export type ComputerFleet = {
  computers: ComputerProfile[];
  isolation?: ComputerIsolation;
};

/**
 * Whether the boundary acts on its verdict.
 *
 * `dry-run` records what it would have refused without refusing it, which is how a policy is tried
 * out before it stops a Bot mid-task.
 */
export type PolicyMode = "dry-run" | "enforce";

/** The rules a Bot's actions are judged against. */
export type ActionPolicy = {
  mode: PolicyMode;
  deny: string[];
  allow: string[];
};

export const computerKeys = {
  all: ["computers"] as const,
  fleet: () => ["computers", "fleet"] as const,
  policy: () => ["computers", "policy"] as const,
  nodes: () => ["computers", "nodes"] as const,
  placements: () => ["computers", "placements"] as const,
};

/** One machine in the mesh, with what its supervisor reported when asked just now. */
export type MeshNode = {
  id: string;
  name: string;
  backend: string;
  placementEnabled: boolean;
  reachable: boolean;
  capacity: {
    budget?: { cpus?: number; memoryBytes?: number };
    used?: { cpus: number; memoryBytes: number };
    available?: { cpus: number | null; memoryBytes: number | null };
    computers?: Array<{ botId: string; status: string }>;
  } | null;
  error?: string;
};

export type PlacedComputer = {
  botId: string;
  status: "running" | "stopped";
  node: string;
  startedAt?: string;
};

export function meshNodesQueryOptions() {
  return queryOptions({
    queryKey: computerKeys.nodes(),
    queryFn: (): Promise<MeshNode[]> =>
      client("/api/admin/nodes", "nodes", {
        fallback: "The nodes could not be listed.",
      }),
    refetchInterval: 15_000,
  });
}

export function placementsQueryOptions() {
  return queryOptions({
    queryKey: computerKeys.placements(),
    queryFn: (): Promise<PlacedComputer[]> =>
      client("/api/admin/computers/placements", "computers", {
        fallback: "The placements could not be listed.",
      }),
  });
}

/**
 * The deployment-wide fleet route.
 *
 * Not a Bot id in a member route, which is what this used to be. That placeholder stopped working
 * when the server began checking whether the caller may act as the Bot in the path: a placeholder
 * is not a Bot, so the list 404d and this screen showed nothing at all.
 */
const FLEET_PATH = "/api/computers/fleet";

/** No envelope key: the body carries both the list and the isolation mode. */
export function computerFleetQueryOptions() {
  return queryOptions({
    queryKey: computerKeys.fleet(),
    queryFn: async (): Promise<ComputerFleet> => {
      const response = await client(FLEET_PATH, {
        fallback: "The computers could not be listed.",
      });
      return response.json();
    },
  });
}

export function actionPolicyQueryOptions() {
  return queryOptions({
    queryKey: computerKeys.policy(),
    queryFn: (): Promise<ActionPolicy> =>
      client("/api/computers/policy", "policy", {
        fallback: "The boundary could not be read.",
      }),
  });
}
