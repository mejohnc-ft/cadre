import { useMutation, useQuery } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import {
  PageEmpty,
  PageRows,
  PageSection,
  PageShell,
} from "@/components/layout/page-shell";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import {
  Item,
  ItemActions,
  ItemContent,
  ItemDescription,
  ItemTitle,
} from "@/components/ui/item";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Separator } from "@/components/ui/separator";
import { Textarea } from "@/components/ui/textarea";
import {
  createArtifactMutationOptions,
  deleteArtifactMutationOptions,
  saveArtifactVersionMutationOptions,
} from "@/lib/artifacts/mutations";
import {
  type Artifact,
  type ArtifactKind,
  artifactDetailQueryOptions,
  artifactsQueryOptions,
} from "@/lib/artifacts/queries";
import { queryClient } from "@/query-client";

export const Route = createFileRoute("/_authed/admin/artifacts")({
  component: ArtifactsPage,
});

const KINDS: ArtifactKind[] = [
  "instructions",
  "skill",
  "harness_settings",
  "mcp_config",
];

const KIND_LABEL: Record<ArtifactKind, string> = {
  instructions: "Instructions (CLAUDE.md / AGENTS.md)",
  skill: "Skill",
  harness_settings: "Harness settings",
  mcp_config: "MCP config",
};

function ArtifactsPage() {
  const artifacts = useQuery(artifactsQueryOptions());
  const del = useMutation(deleteArtifactMutationOptions(queryClient));
  const [creating, setCreating] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);

  const rows = artifacts.data?.artifacts ?? [];

  return (
    <PageShell
      action={
        <Button onClick={() => setCreating(true)} size="sm" variant="outline">
          New artifact
        </Button>
      }
      description="Versioned context your coworkers are made of. An instructions artifact is written into a harness's workspace as the file it reads on its own — CLAUDE.md for Claude Code, AGENTS.md for Pi and OpenCode. Attach one on a coworker's profile."
      title="Artifacts"
    >
      <PageSection title="All artifacts">
        {rows.length === 0 ? (
          <PageEmpty>No artifacts yet.</PageEmpty>
        ) : (
          <PageRows>
            {rows.map((artifact, index) => (
              <div key={artifact.id}>
                <Item size="sm">
                  <ItemContent>
                    <ItemTitle>{artifact.name}</ItemTitle>
                    <ItemDescription>
                      {KIND_LABEL[artifact.kind]} · v{artifact.latestVersion}
                      {artifact.description ? ` · ${artifact.description}` : ""}
                    </ItemDescription>
                  </ItemContent>
                  <ItemActions>
                    <Button
                      onClick={() => setEditingId(artifact.id)}
                      size="sm"
                      variant="ghost"
                    >
                      Edit
                    </Button>
                    <Button
                      disabled={del.isPending}
                      onClick={() => del.mutate(artifact.id)}
                      size="sm"
                      variant="ghost"
                    >
                      Delete
                    </Button>
                  </ItemActions>
                </Item>
                {index !== rows.length - 1 && <Separator />}
              </div>
            ))}
          </PageRows>
        )}
      </PageSection>

      {creating ? <CreateDialog onClose={() => setCreating(false)} /> : null}
      {editingId ? (
        <EditDialog id={editingId} onClose={() => setEditingId(null)} />
      ) : null}
    </PageShell>
  );
}

function CreateDialog({ onClose }: { onClose: () => void }) {
  const create = useMutation(createArtifactMutationOptions(queryClient));
  const [kind, setKind] = useState<ArtifactKind>("instructions");
  const [name, setName] = useState("");
  const [content, setContent] = useState("");

  return (
    <Dialog onOpenChange={(open) => !open && onClose()} open>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>New artifact</DialogTitle>
          <DialogDescription>
            Version 1. Editing later appends a version; nothing is overwritten.
          </DialogDescription>
        </DialogHeader>
        <div className="flex flex-col gap-3">
          <Select
            onValueChange={(v) => v && setKind(v as ArtifactKind)}
            value={kind}
          >
            <SelectTrigger>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectGroup>
                {KINDS.map((k) => (
                  <SelectItem key={k} value={k}>
                    {KIND_LABEL[k]}
                  </SelectItem>
                ))}
              </SelectGroup>
            </SelectContent>
          </Select>
          <Input
            onChange={(e) => setName(e.target.value)}
            placeholder="Name"
            value={name}
          />
          <Textarea
            className="min-h-64 font-mono text-xs"
            onChange={(e) => setContent(e.target.value)}
            placeholder="Content…"
            value={content}
          />
        </div>
        <DialogFooter>
          <Button onClick={onClose} size="sm" variant="ghost">
            Cancel
          </Button>
          <Button
            disabled={create.isPending || !name || !content}
            onClick={() =>
              create.mutate(
                { kind, name, content },
                { onSuccess: () => onClose() },
              )
            }
            size="sm"
          >
            {create.isPending ? "Creating…" : "Create"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function EditDialog({ id, onClose }: { id: string; onClose: () => void }) {
  const detail = useQuery(artifactDetailQueryOptions(id));
  const save = useMutation(saveArtifactVersionMutationOptions(queryClient));
  const [content, setContent] = useState("");
  useEffect(() => {
    if (detail.data) setContent(detail.data.artifact.content);
  }, [detail.data]);

  const artifact = detail.data?.artifact as
    | (Artifact & { content: string })
    | undefined;

  return (
    <Dialog onOpenChange={(open) => !open && onClose()} open>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{artifact?.name ?? "Artifact"}</DialogTitle>
          <DialogDescription>
            {detail.data
              ? `${detail.data.versions.length} version(s); saving appends v${(artifact?.latestVersion ?? 0) + 1}.`
              : "Loading…"}
          </DialogDescription>
        </DialogHeader>
        <Textarea
          className="min-h-80 font-mono text-xs"
          onChange={(e) => setContent(e.target.value)}
          value={content}
        />
        <DialogFooter>
          <Button onClick={onClose} size="sm" variant="ghost">
            Close
          </Button>
          <Button
            disabled={save.isPending || content === artifact?.content}
            onClick={() =>
              save.mutate({ id, content }, { onSuccess: () => onClose() })
            }
            size="sm"
          >
            {save.isPending ? "Saving…" : "Save new version"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
