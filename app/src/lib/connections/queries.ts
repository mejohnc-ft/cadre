import { queryOptions } from "@tanstack/react-query";
import { client } from "@/lib/client";

export type Connection = {
  id: string;
  name: string;
  kind: "api" | "cli" | "web";
  service: string;
  baseUrl: string | null;
  loginUrl: string | null;
  username: string | null;
  hasTotp: boolean;
  allowedPaths: string[] | null;
  notes: string | null;
  grants: string[];
  updatedAt: string;
};

export const connectionKeys = {
  all: ["connections"] as const,
};

export function connectionsQueryOptions() {
  return queryOptions({
    queryKey: connectionKeys.all,
    queryFn: (): Promise<{ connections: Connection[] }> =>
      client("/api/admin/connections", "connections", {
        fallback: "The connections could not be loaded.",
      }),
  });
}
