import { mutationOptions, type QueryClient } from "@tanstack/react-query";
import { client } from "@/lib/client";
import { type ActionPolicy, computerKeys } from "./queries";

/** Stopping frees the container; resetting also deletes the browser profile. */
export type ComputerAction = "stop" | "reset";

function invalidateComputers(queryClient: QueryClient) {
  return queryClient.invalidateQueries({ queryKey: computerKeys.all });
}

export function setComputerStateMutationOptions(queryClient: QueryClient) {
  return mutationOptions({
    mutationFn: async (variables: {
      botId: string;
      action: ComputerAction;
    }) => {
      await client(
        `/api/computers/${encodeURIComponent(variables.botId)}/computers/${variables.action}`,
        {
          method: "POST",
          fallback: `The computer could not be ${variables.action}.`,
        },
      );
    },
    onSuccess: () => invalidateComputers(queryClient),
  });
}

/**
 * Replace the whole policy.
 *
 * A PUT rather than a patch because the rules are ordered and evaluated as a set: sending a
 * difference would leave the server deciding where a new rule belongs, and where a deny sits
 * relative to an allow is most of what a policy means.
 */
export function saveActionPolicyMutationOptions(queryClient: QueryClient) {
  return mutationOptions({
    mutationFn: (next: ActionPolicy): Promise<ActionPolicy> =>
      client("/api/computers/policy", "policy", {
        method: "PUT",
        body: next,
        fallback: "The boundary could not be saved.",
      }),
    onSuccess: () => invalidateComputers(queryClient),
  });
}

export function mintEnrollmentTokenMutationOptions() {
  return mutationOptions({
    mutationFn: (): Promise<{ token: string; expiresAt: string }> =>
      client("/api/admin/nodes/enrollment-tokens", {
        method: "POST",
        fallback: "An enrollment token could not be minted.",
      }).then((response) => response.json()),
  });
}

export function setNodePlacementMutationOptions(queryClient: QueryClient) {
  return mutationOptions({
    mutationFn: async (variables: {
      nodeId: string;
      placementEnabled: boolean;
    }) => {
      await client(`/api/admin/nodes/${encodeURIComponent(variables.nodeId)}`, {
        method: "PATCH",
        body: { placementEnabled: variables.placementEnabled },
        fallback: "The node could not be updated.",
      });
    },
    onSuccess: () => invalidateComputers(queryClient),
  });
}

export function removeNodeMutationOptions(queryClient: QueryClient) {
  return mutationOptions({
    mutationFn: async (nodeId: string) => {
      await client(`/api/admin/nodes/${encodeURIComponent(nodeId)}`, {
        method: "DELETE",
        fallback: "The node could not be removed.",
      });
    },
    onSuccess: () => invalidateComputers(queryClient),
  });
}

export function moveComputerMutationOptions(queryClient: QueryClient) {
  return mutationOptions({
    mutationFn: (variables: {
      botId: string;
      nodeId: string;
    }): Promise<{ from: string; to: string; bytes: number }> =>
      client(
        `/api/admin/computers/${encodeURIComponent(variables.botId)}/move`,
        {
          method: "POST",
          body: { nodeId: variables.nodeId },
          fallback: "The computer could not be moved.",
        },
      ).then((response) => response.json()),
    onSuccess: () => invalidateComputers(queryClient),
  });
}
