import { mutationOptions, type QueryClient } from "@tanstack/react-query";
import { client } from "@/lib/client";
import { modelKeys, type Provider } from "./queries";

function invalidate(queryClient: QueryClient) {
  return queryClient.invalidateQueries({ queryKey: modelKeys.all });
}

export function saveProviderMutationOptions(queryClient: QueryClient) {
  return mutationOptions({
    mutationFn: async (input: {
      id: string;
      name: string;
      kind: Provider["kind"];
      baseUrl?: string;
      defaultModel: string;
      isDefault?: boolean;
      key?: string;
    }) => {
      await client(`/api/admin/providers/${encodeURIComponent(input.id)}`, {
        method: "PUT",
        body: input,
        fallback: "The provider could not be saved.",
      });
    },
    onSuccess: () => invalidate(queryClient),
  });
}

export function removeProviderMutationOptions(queryClient: QueryClient) {
  return mutationOptions({
    mutationFn: async (id: string) => {
      await client(`/api/admin/providers/${encodeURIComponent(id)}`, {
        method: "DELETE",
        fallback: "The provider could not be removed.",
      });
    },
    onSuccess: () => invalidate(queryClient),
  });
}

export function setModelRouteMutationOptions(queryClient: QueryClient) {
  return mutationOptions({
    mutationFn: async (input: {
      agentId: string;
      providerId: string;
      model: string;
    }) => {
      await client(
        `/api/admin/agents/${encodeURIComponent(input.agentId)}/model-route`,
        {
          method: "PUT",
          body: { providerId: input.providerId, model: input.model },
          fallback: "The route could not be saved.",
        },
      );
    },
    onSuccess: () => invalidate(queryClient),
  });
}

export function clearModelRouteMutationOptions(queryClient: QueryClient) {
  return mutationOptions({
    mutationFn: async (agentId: string) => {
      await client(
        `/api/admin/agents/${encodeURIComponent(agentId)}/model-route`,
        { method: "DELETE", fallback: "The route could not be cleared." },
      );
    },
    onSuccess: () => invalidate(queryClient),
  });
}
