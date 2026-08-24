import { mutationOptions, type QueryClient } from "@tanstack/react-query";
import { client } from "@/lib/client";
import { type Trigger, triggerKeys } from "./queries";

function invalidate(queryClient: QueryClient) {
  return queryClient.invalidateQueries({ queryKey: triggerKeys.all });
}

export function createTriggerMutationOptions(queryClient: QueryClient) {
  return mutationOptions({
    mutationFn: async (input: {
      name: string;
      agentId: string;
      kind: Trigger["kind"];
      schedule?: string;
      prompt: string;
      threadMode: Trigger["threadMode"];
    }): Promise<{ trigger: Trigger; token?: string }> => {
      const response = await client("/api/admin/triggers", {
        method: "POST",
        body: input,
        fallback: "The trigger could not be created.",
      });
      // Two keys come back — the trigger and, once and never again, the webhook token — so this
      // caller reads the whole envelope instead of unwrapping one key.
      return (await response.json()) as { trigger: Trigger; token?: string };
    },
    onSuccess: () => invalidate(queryClient),
  });
}

export function updateTriggerMutationOptions(queryClient: QueryClient) {
  return mutationOptions({
    mutationFn: async (input: {
      id: string;
      patch: Partial<
        Pick<Trigger, "name" | "schedule" | "prompt" | "enabled" | "threadMode">
      >;
    }) => {
      await client(`/api/admin/triggers/${encodeURIComponent(input.id)}`, {
        method: "PATCH",
        body: input.patch,
        fallback: "The trigger could not be saved.",
      });
    },
    onSuccess: () => invalidate(queryClient),
  });
}

export function removeTriggerMutationOptions(queryClient: QueryClient) {
  return mutationOptions({
    mutationFn: async (id: string) => {
      await client(`/api/admin/triggers/${encodeURIComponent(id)}`, {
        method: "DELETE",
        fallback: "The trigger could not be removed.",
      });
    },
    onSuccess: () => invalidate(queryClient),
  });
}

export function fireTriggerMutationOptions(queryClient: QueryClient) {
  return mutationOptions({
    mutationFn: async (
      id: string,
    ): Promise<{ status: "ok" | "error"; reply: string }> => {
      const response = await client(
        `/api/admin/triggers/${encodeURIComponent(id)}/fire`,
        { method: "POST", fallback: "The firing failed." },
      );
      return (await response.json()) as {
        status: "ok" | "error";
        reply: string;
      };
    },
    onSettled: () => invalidate(queryClient),
  });
}
