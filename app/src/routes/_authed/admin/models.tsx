import { useMutation, useQuery } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { useState } from "react";
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
import {
  removeProviderMutationOptions,
  saveProviderMutationOptions,
} from "@/lib/models/mutations";
import { type Provider, providersQueryOptions } from "@/lib/models/queries";
import { queryClient } from "@/query-client";

export const Route = createFileRoute("/_authed/admin/models")({
  component: ModelsPage,
});

const KINDS: Provider["kind"][] = [
  "anthropic",
  "openai",
  "anthropic-compatible",
  "openai-compatible",
];

function ModelsPage() {
  const providers = useQuery(providersQueryOptions());
  const save = useMutation(saveProviderMutationOptions(queryClient));
  const remove = useMutation(removeProviderMutationOptions(queryClient));
  const [editing, setEditing] = useState<Provider | "new" | null>(null);

  const rows = providers.data?.providers ?? [];

  return (
    <PageShell
      action={
        <Button onClick={() => setEditing("new")} size="sm" variant="outline">
          Add a provider
        </Button>
      }
      description="Where your coworkers' models live. A key is stored encrypted and never shown again. One provider is the deployment default; a coworker can be routed to a different one on its profile."
      title="Model routing"
    >
      <PageSection title="Providers">
        {rows.length === 0 ? (
          <PageEmpty>
            No providers yet. Add one, or set OPENAI_API_KEY and a base URL and
            restart to seed one from the environment.
          </PageEmpty>
        ) : (
          <PageRows>
            {rows.map((provider, index) => (
              <div key={provider.id}>
                <Item size="sm">
                  <ItemContent>
                    <ItemTitle>
                      {provider.name}
                      {provider.isDefault ? (
                        <span className="ml-2 rounded bg-muted px-1.5 py-0.5 text-muted-foreground text-xs">
                          default
                        </span>
                      ) : null}
                    </ItemTitle>
                    <ItemDescription>
                      {provider.kind} · {provider.defaultModel}
                      {provider.baseUrl ? ` · ${provider.baseUrl}` : ""}
                    </ItemDescription>
                  </ItemContent>
                  <ItemActions>
                    <Button
                      onClick={() => setEditing(provider)}
                      size="sm"
                      variant="ghost"
                    >
                      Edit
                    </Button>
                    <Button
                      disabled={remove.isPending}
                      onClick={() => remove.mutate(provider.id)}
                      size="sm"
                      variant="ghost"
                    >
                      Remove
                    </Button>
                  </ItemActions>
                </Item>
                {index !== rows.length - 1 && <Separator />}
              </div>
            ))}
          </PageRows>
        )}
      </PageSection>

      {editing ? (
        <ProviderDialog
          existing={editing === "new" ? null : editing}
          onClose={() => setEditing(null)}
          onSave={(input) =>
            save.mutate(input, { onSuccess: () => setEditing(null) })
          }
          saving={save.isPending}
        />
      ) : null}
    </PageShell>
  );
}

function ProviderDialog({
  existing,
  onClose,
  onSave,
  saving,
}: {
  existing: Provider | null;
  onClose: () => void;
  onSave: (input: {
    id: string;
    name: string;
    kind: Provider["kind"];
    baseUrl?: string;
    defaultModel: string;
    isDefault?: boolean;
    key?: string;
  }) => void;
  saving: boolean;
}) {
  const [id, setId] = useState(existing?.id ?? "");
  const [name, setName] = useState(existing?.name ?? "");
  const [kind, setKind] = useState<Provider["kind"]>(
    existing?.kind ?? "openai-compatible",
  );
  const [baseUrl, setBaseUrl] = useState(existing?.baseUrl ?? "");
  const [defaultModel, setDefaultModel] = useState(
    existing?.defaultModel ?? "",
  );
  const [isDefault, setIsDefault] = useState(existing?.isDefault ?? false);
  const [key, setKey] = useState("");

  return (
    <Dialog onOpenChange={(open) => !open && onClose()} open>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>
            {existing ? `Edit ${existing.name}` : "Add a provider"}
          </DialogTitle>
          <DialogDescription>
            The key is write-only. Leave it blank when editing to keep the one
            already stored.
          </DialogDescription>
        </DialogHeader>
        <div className="flex flex-col gap-3">
          {!existing ? (
            <Input
              onChange={(e) => setId(e.target.value)}
              placeholder="id, e.g. zai (lowercase)"
              value={id}
            />
          ) : null}
          <Input
            onChange={(e) => setName(e.target.value)}
            placeholder="Name"
            value={name}
          />
          <Select
            onValueChange={(v) => v && setKind(v as Provider["kind"])}
            value={kind}
          >
            <SelectTrigger>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectGroup>
                {KINDS.map((k) => (
                  <SelectItem key={k} value={k}>
                    {k}
                  </SelectItem>
                ))}
              </SelectGroup>
            </SelectContent>
          </Select>
          <Input
            onChange={(e) => setBaseUrl(e.target.value)}
            placeholder="Base URL (blank = the vendor's own)"
            value={baseUrl}
          />
          <Input
            onChange={(e) => setDefaultModel(e.target.value)}
            placeholder="Default model, e.g. glm-5.3"
            value={defaultModel}
          />
          <Input
            onChange={(e) => setKey(e.target.value)}
            placeholder={existing ? "New key (blank keeps stored)" : "API key"}
            type="password"
            value={key}
          />
          <label className="flex items-center gap-2 text-sm">
            <input
              checked={isDefault}
              onChange={(e) => setIsDefault(e.target.checked)}
              type="checkbox"
            />
            Deployment default
          </label>
        </div>
        <DialogFooter>
          <Button onClick={onClose} size="sm" variant="ghost">
            Cancel
          </Button>
          <Button
            disabled={saving || !name || !defaultModel || (!existing && !id)}
            onClick={() =>
              onSave({
                id: existing?.id ?? id,
                name,
                kind,
                baseUrl: baseUrl || undefined,
                defaultModel,
                isDefault,
                key: key || undefined,
              })
            }
            size="sm"
          >
            {saving ? "Saving…" : "Save"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
