import { mutationOptions, type QueryClient } from "@tanstack/react-query";
import { client } from "@/lib/client";
import { type Connection, connectionKeys } from "./queries";

function invalidate(queryClient: QueryClient) {
  return queryClient.invalidateQueries({ queryKey: connectionKeys.all });
}

export function saveConnectionMutationOptions(queryClient: QueryClient) {
  return mutationOptions({
    mutationFn: async (input: {
      id: string;
      name: string;
      kind: Connection["kind"];
      service: string;
      baseUrl?: string;
      loginUrl?: string;
      username?: string;
      secret?: string;
      totpSeed?: string;
      allowedPaths?: string[] | null;
      notes?: string;
    }) => {
      await client(`/api/admin/connections/${encodeURIComponent(input.id)}`, {
        method: "PUT",
        body: input,
        fallback: "The connection could not be saved.",
      });
    },
    onSuccess: () => invalidate(queryClient),
  });
}

export function removeConnectionMutationOptions(queryClient: QueryClient) {
  return mutationOptions({
    mutationFn: async (id: string) => {
      await client(`/api/admin/connections/${encodeURIComponent(id)}`, {
        method: "DELETE",
        fallback: "The connection could not be removed.",
      });
    },
    onSuccess: () => invalidate(queryClient),
  });
}

export function grantConnectionMutationOptions(queryClient: QueryClient) {
  return mutationOptions({
    mutationFn: async (input: { id: string; agentId: string }) => {
      await client(
        `/api/admin/connections/${encodeURIComponent(input.id)}/grants`,
        {
          method: "POST",
          body: { agentId: input.agentId },
          fallback: "The grant could not be added.",
        },
      );
    },
    onSuccess: () => invalidate(queryClient),
  });
}

export function revokeConnectionMutationOptions(queryClient: QueryClient) {
  return mutationOptions({
    mutationFn: async (input: { id: string; agentId: string }) => {
      await client(
        `/api/admin/connections/${encodeURIComponent(input.id)}/grants/${encodeURIComponent(input.agentId)}`,
        {
          method: "DELETE",
          fallback: "The grant could not be removed.",
        },
      );
    },
    onSuccess: () => invalidate(queryClient),
  });
}

export function verifyConnectionMutationOptions(queryClient: QueryClient) {
  return mutationOptions({
    mutationFn: async (input: {
      id: string;
      agentId?: string;
    }): Promise<{ status: "ok" | "failed"; note: string }> => {
      const response = await client(
        `/api/admin/connections/${encodeURIComponent(input.id)}/verify`,
        {
          method: "POST",
          body: input.agentId ? { agentId: input.agentId } : {},
          fallback: "The verification could not run.",
        },
      );
      return (await response.json()) as {
        status: "ok" | "failed";
        note: string;
      };
    },
    onSettled: () => invalidate(queryClient),
  });
}
