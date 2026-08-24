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
      opRef?: string | null;
      opAccount?: string | null;
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

export function connectBeginMutationOptions(queryClient: QueryClient) {
  return mutationOptions({
    mutationFn: async (input: {
      id: string;
      agentId?: string;
    }): Promise<{ ok: boolean; note: string; botId?: string }> => {
      const response = await client(
        `/api/admin/connections/${encodeURIComponent(input.id)}/connect-begin`,
        {
          method: "POST",
          body: input.agentId ? { agentId: input.agentId } : {},
          fallback: "Could not begin the sign-in.",
        },
      );
      return (await response.json()) as {
        ok: boolean;
        note: string;
        botId?: string;
      };
    },
  });
}

export function connectCaptureMutationOptions(queryClient: QueryClient) {
  return mutationOptions({
    mutationFn: async (input: {
      id: string;
      agentId?: string;
    }): Promise<{ ok: boolean; note: string; cookieCount?: number }> => {
      const response = await client(
        `/api/admin/connections/${encodeURIComponent(input.id)}/connect-capture`,
        {
          method: "POST",
          body: input.agentId ? { agentId: input.agentId } : {},
          fallback: "Could not capture the session.",
        },
      );
      return (await response.json()) as {
        ok: boolean;
        note: string;
        cookieCount?: number;
      };
    },
    onSettled: () => invalidate(queryClient),
  });
}

export function msConnectStartMutationOptions() {
  return mutationOptions({
    mutationFn: async (input: {
      id: string;
      name: string;
    }): Promise<{
      userCode: string;
      verificationUri: string;
      expiresIn: number;
      interval: number;
    }> => {
      const response = await client(
        `/api/admin/connections/${encodeURIComponent(input.id)}/ms-connect/start`,
        {
          method: "POST",
          body: { name: input.name },
          fallback: "Could not start Microsoft sign-in.",
        },
      );
      return (await response.json()) as {
        userCode: string;
        verificationUri: string;
        expiresIn: number;
        interval: number;
      };
    },
  });
}

export function msConnectPollMutationOptions(queryClient: QueryClient) {
  return mutationOptions({
    mutationFn: async (
      id: string,
    ): Promise<{ status: string; error?: string }> => {
      const response = await client(
        `/api/admin/connections/${encodeURIComponent(id)}/ms-connect/poll`,
        { method: "POST", fallback: "Could not check the sign-in." },
      );
      return (await response.json()) as { status: string; error?: string };
    },
    onSettled: () => invalidate(queryClient),
  });
}
