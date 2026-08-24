import { queryOptions } from "@tanstack/react-query";
import { client } from "@/lib/client";

export type ArtifactKind =
  | "instructions"
  | "skill"
  | "harness_settings"
  | "mcp_config";

export type Artifact = {
  id: string;
  kind: ArtifactKind;
  name: string;
  description: string | null;
  latestVersion: number;
  updatedAt: string;
};

export type ArtifactDetail = {
  artifact: Artifact & { version: number; content: string };
  versions: Array<{ version: number; createdAt: string }>;
};

export const artifactKeys = {
  all: ["artifacts"] as const,
  list: () => ["artifacts", "list"] as const,
  detail: (id: string, version?: number) =>
    ["artifacts", "detail", id, version ?? "latest"] as const,
  forAgent: (agentId: string) => ["artifacts", "agent", agentId] as const,
};

export function artifactsQueryOptions() {
  return queryOptions({
    queryKey: artifactKeys.list(),
    queryFn: (): Promise<{ artifacts: Artifact[] }> =>
      client("/api/admin/artifacts", "artifacts", {
        fallback: "Artifacts could not be loaded.",
      }),
  });
}

export function artifactDetailQueryOptions(id: string, version?: number) {
  return queryOptions({
    queryKey: artifactKeys.detail(id, version),
    queryFn: (): Promise<ArtifactDetail> =>
      client(
        `/api/admin/artifacts/${encodeURIComponent(id)}${version ? `?version=${version}` : ""}`,
        "detail",
        { fallback: "The artifact could not be loaded." },
      ),
  });
}

export function agentArtifactsQueryOptions(agentId: string) {
  return queryOptions({
    queryKey: artifactKeys.forAgent(agentId),
    queryFn: (): Promise<{
      artifacts: Array<Artifact & { pinnedVersion: number | null }>;
    }> =>
      client(
        `/api/admin/agents/${encodeURIComponent(agentId)}/artifacts`,
        "artifacts",
        { fallback: "The coworker's artifacts could not be loaded." },
      ),
  });
}
