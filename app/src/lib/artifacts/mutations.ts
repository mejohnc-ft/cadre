import { mutationOptions, type QueryClient } from "@tanstack/react-query";
import { client } from "@/lib/client";
import { artifactKeys, type ArtifactKind } from "./queries";

function invalidate(queryClient: QueryClient) {
  return queryClient.invalidateQueries({ queryKey: artifactKeys.all });
}

export function createArtifactMutationOptions(queryClient: QueryClient) {
  return mutationOptions({
    mutationFn: (input: {
      kind: ArtifactKind;
      name: string;
      description?: string;
      content: string;
    }): Promise<{ artifact: { id: string } }> =>
      client("/api/admin/artifacts", {
        method: "POST",
        body: input,
        fallback: "The artifact could not be created.",
      }).then((r) => r.json()),
    onSuccess: () => invalidate(queryClient),
  });
}

export function saveArtifactVersionMutationOptions(queryClient: QueryClient) {
  return mutationOptions({
    mutationFn: async (input: { id: string; content: string }) => {
      await client(
        `/api/admin/artifacts/${encodeURIComponent(input.id)}/versions`,
        {
          method: "POST",
          body: { content: input.content },
          fallback: "The new version could not be saved.",
        },
      );
    },
    onSuccess: () => invalidate(queryClient),
  });
}

export function deleteArtifactMutationOptions(queryClient: QueryClient) {
  return mutationOptions({
    mutationFn: async (id: string) => {
      await client(`/api/admin/artifacts/${encodeURIComponent(id)}`, {
        method: "DELETE",
        fallback: "The artifact could not be deleted.",
      });
    },
    onSuccess: () => invalidate(queryClient),
  });
}

export function attachArtifactMutationOptions(queryClient: QueryClient) {
  return mutationOptions({
    mutationFn: async (input: {
      agentId: string;
      artifactId: string;
      pinnedVersion?: number;
    }) => {
      await client(
        `/api/admin/agents/${encodeURIComponent(input.agentId)}/artifacts`,
        {
          method: "POST",
          body: {
            artifactId: input.artifactId,
            ...(input.pinnedVersion
              ? { pinnedVersion: input.pinnedVersion }
              : {}),
          },
          fallback: "The artifact could not be attached.",
        },
      );
    },
    onSuccess: () => invalidate(queryClient),
  });
}

export function detachArtifactMutationOptions(queryClient: QueryClient) {
  return mutationOptions({
    mutationFn: async (input: { agentId: string; artifactId: string }) => {
      await client(
        `/api/admin/agents/${encodeURIComponent(input.agentId)}/artifacts/${encodeURIComponent(input.artifactId)}`,
        { method: "DELETE", fallback: "The artifact could not be detached." },
      );
    },
    onSuccess: () => invalidate(queryClient),
  });
}
