import { queryOptions } from "@tanstack/react-query";
import { client } from "@/lib/client";

export type Provider = {
  id: string;
  name: string;
  kind: "anthropic" | "openai" | "openai-compatible" | "anthropic-compatible";
  baseUrl: string | null;
  defaultModel: string;
  isDefault: boolean;
  updatedAt: string;
};

export type ModelRoute = {
  agentId: string;
  providerId: string;
  model: string;
  fallbacks: Array<{ providerId: string; model: string }>;
};

export type UsageRow = {
  agentId: string;
  runs: number;
  costUsd: number;
  durationMs: number;
};

export const modelKeys = {
  all: ["models"] as const,
  providers: () => ["models", "providers"] as const,
  route: (agentId: string) => ["models", "route", agentId] as const,
  usage: () => ["models", "usage"] as const,
};

export function providersQueryOptions() {
  return queryOptions({
    queryKey: modelKeys.providers(),
    queryFn: (): Promise<{ providers: Provider[] }> =>
      client("/api/admin/providers", "providers", {
        fallback: "The providers could not be loaded.",
      }),
  });
}

export function modelRouteQueryOptions(agentId: string) {
  return queryOptions({
    queryKey: modelKeys.route(agentId),
    queryFn: (): Promise<{ route: ModelRoute | null }> =>
      client(
        `/api/admin/agents/${encodeURIComponent(agentId)}/model-route`,
        "route",
        { fallback: "The model route could not be loaded." },
      ),
  });
}

export function usageQueryOptions() {
  return queryOptions({
    queryKey: modelKeys.usage(),
    queryFn: (): Promise<{ days: number; usage: UsageRow[] }> =>
      client("/api/admin/usage", "usage", {
        fallback: "Usage could not be loaded.",
      }),
    refetchInterval: 30_000,
  });
}
