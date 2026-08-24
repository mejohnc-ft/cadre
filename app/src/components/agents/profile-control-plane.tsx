import { useMutation, useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  attachArtifactMutationOptions,
  detachArtifactMutationOptions,
} from "@/lib/artifacts/mutations";
import {
  agentArtifactsQueryOptions,
  artifactsQueryOptions,
} from "@/lib/artifacts/queries";
import {
  clearModelRouteMutationOptions,
  setModelRouteMutationOptions,
} from "@/lib/models/mutations";
import {
  modelRouteQueryOptions,
  providersQueryOptions,
} from "@/lib/models/queries";
import { queryClient } from "@/query-client";

/**
 * The part of a coworker's profile that is the control plane: which model it runs on, and which
 * artifacts (instructions, skills) it carries. Shown for every coworker; the harness is fixed by
 * the coworker's type and shown for reference.
 */
export function ProfileControlPlane({
  agentId,
  harness,
}: {
  agentId: string;
  harness: string | null;
}) {
  return (
    <section className="flex flex-col gap-4 text-left">
      {harness ? (
        <div className="text-sm">
          <span className="text-muted-foreground">Harness: </span>
          <span className="font-medium">{harness}</span>
        </div>
      ) : null}
      <ModelRow agentId={agentId} />
      <ArtifactRow agentId={agentId} />
    </section>
  );
}

function ModelRow({ agentId }: { agentId: string }) {
  const providers = useQuery(providersQueryOptions());
  const route = useQuery(modelRouteQueryOptions(agentId));
  const setRoute = useMutation(setModelRouteMutationOptions(queryClient));
  const clearRoute = useMutation(clearModelRouteMutationOptions(queryClient));
  const [providerId, setProviderId] = useState<string>("");
  const [model, setModel] = useState<string>("");

  const list = providers.data?.providers ?? [];
  const current = route.data?.route ?? null;
  const chosenProvider =
    list.find((p) => p.id === (providerId || current?.providerId)) ?? null;

  if (list.length === 0) {
    return (
      <p className="text-muted-foreground text-sm">
        No providers configured. Add one under Model Routing to route this
        coworker.
      </p>
    );
  }

  return (
    <div className="flex flex-col gap-2">
      <span className="font-medium text-sm">Model</span>
      {current ? (
        <p className="text-muted-foreground text-xs">
          Routed to {current.providerId} · {current.model}.
        </p>
      ) : (
        <p className="text-muted-foreground text-xs">
          Follows the deployment default. Choose a provider to override.
        </p>
      )}
      <div className="flex flex-wrap items-center gap-2">
        <Select
          onValueChange={(v) => {
            setProviderId(v ?? "");
            const p = list.find((x) => x.id === v);
            setModel(p?.defaultModel ?? "");
          }}
          value={providerId || current?.providerId || ""}
        >
          <SelectTrigger className="w-44" size="sm">
            <SelectValue placeholder="Provider" />
          </SelectTrigger>
          <SelectContent>
            <SelectGroup>
              {list.map((p) => (
                <SelectItem key={p.id} value={p.id}>
                  {p.name}
                </SelectItem>
              ))}
            </SelectGroup>
          </SelectContent>
        </Select>
        <input
          className="h-8 w-40 rounded-md border border-input bg-transparent px-2 text-sm"
          onChange={(e) => setModel(e.target.value)}
          placeholder={chosenProvider?.defaultModel ?? "model"}
          value={model || current?.model || ""}
        />
        <Button
          disabled={
            setRoute.isPending ||
            !(providerId || current?.providerId) ||
            !(model || current?.model)
          }
          onClick={() =>
            setRoute.mutate({
              agentId,
              providerId: providerId || current?.providerId || "",
              model: model || current?.model || "",
            })
          }
          size="sm"
          variant="outline"
        >
          {setRoute.isPending ? "Saving…" : "Route"}
        </Button>
        {current ? (
          <Button
            disabled={clearRoute.isPending}
            onClick={() => clearRoute.mutate(agentId)}
            size="sm"
            variant="ghost"
          >
            Use default
          </Button>
        ) : null}
      </div>
    </div>
  );
}

function ArtifactRow({ agentId }: { agentId: string }) {
  const all = useQuery(artifactsQueryOptions());
  const attached = useQuery(agentArtifactsQueryOptions(agentId));
  const attach = useMutation(attachArtifactMutationOptions(queryClient));
  const detach = useMutation(detachArtifactMutationOptions(queryClient));
  const [toAttach, setToAttach] = useState("");

  const attachedList = attached.data?.artifacts ?? [];
  const attachedIds = new Set(attachedList.map((a) => a.id));
  const available = (all.data?.artifacts ?? []).filter(
    (a) => !attachedIds.has(a.id),
  );

  return (
    <div className="flex flex-col gap-2">
      <span className="font-medium text-sm">Artifacts</span>
      {attachedList.length === 0 ? (
        <p className="text-muted-foreground text-xs">None attached.</p>
      ) : (
        <ul className="flex flex-col gap-1">
          {attachedList.map((artifact) => (
            <li
              className="flex items-center justify-between text-sm"
              key={artifact.id}
            >
              <span>
                {artifact.name}{" "}
                <span className="text-muted-foreground text-xs">
                  ({artifact.kind}
                  {artifact.pinnedVersion
                    ? ` · pinned v${artifact.pinnedVersion}`
                    : " · latest"}
                  )
                </span>
              </span>
              <Button
                disabled={detach.isPending}
                onClick={() =>
                  detach.mutate({ agentId, artifactId: artifact.id })
                }
                size="sm"
                variant="ghost"
              >
                Remove
              </Button>
            </li>
          ))}
        </ul>
      )}
      {available.length > 0 ? (
        <div className="flex items-center gap-2">
          <Select onValueChange={(v) => setToAttach(v ?? "")} value={toAttach}>
            <SelectTrigger className="w-44" size="sm">
              <SelectValue placeholder="Attach an artifact" />
            </SelectTrigger>
            <SelectContent>
              <SelectGroup>
                {available.map((a) => (
                  <SelectItem key={a.id} value={a.id}>
                    {a.name}
                  </SelectItem>
                ))}
              </SelectGroup>
            </SelectContent>
          </Select>
          <Button
            disabled={attach.isPending || !toAttach}
            onClick={() =>
              attach.mutate(
                { agentId, artifactId: toAttach },
                { onSuccess: () => setToAttach("") },
              )
            }
            size="sm"
            variant="outline"
          >
            Attach
          </Button>
        </div>
      ) : null}
    </div>
  );
}
