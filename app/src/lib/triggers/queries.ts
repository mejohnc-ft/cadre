import { queryOptions } from "@tanstack/react-query";
import { client } from "@/lib/client";

export type Trigger = {
  id: string;
  name: string;
  agentId: string;
  kind: "cron" | "webhook";
  schedule: string | null;
  prompt: string;
  enabled: boolean;
  threadMode: "continue" | "new";
  threadId: string | null;
  lastFiredAt: string | null;
  lastStatus: string | null;
  lastReply: string | null;
};

export const triggerKeys = {
  all: ["triggers"] as const,
};

export function triggersQueryOptions() {
  return queryOptions({
    queryKey: triggerKeys.all,
    queryFn: (): Promise<{ triggers: Trigger[] }> =>
      client("/api/admin/triggers", "triggers", {
        fallback: "The triggers could not be loaded.",
      }),
    refetchInterval: 15_000,
  });
}
