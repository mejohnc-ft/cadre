import { useMutation, useQuery } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { useState } from "react";
import {
  PageEmpty,
  PageRows,
  PageSection,
  PageShell,
} from "@/components/layout/page-shell";
import { Badge } from "@/components/ui/badge";
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
import { agentListQueryOptions } from "@/lib/agents/queries";
import {
  grantConnectionMutationOptions,
  removeConnectionMutationOptions,
  revokeConnectionMutationOptions,
  saveConnectionMutationOptions,
} from "@/lib/connections/mutations";
import {
  type Connection,
  connectionsQueryOptions,
} from "@/lib/connections/queries";
import { queryClient } from "@/query-client";

export const Route = createFileRoute("/_authed/admin/connections")({
  component: ConnectionsPage,
});

function ConnectionsPage() {
  const connections = useQuery(connectionsQueryOptions());
  const agents = useQuery(agentListQueryOptions());
  const save = useMutation(saveConnectionMutationOptions(queryClient));
  const remove = useMutation(removeConnectionMutationOptions(queryClient));
  const grant = useMutation(grantConnectionMutationOptions(queryClient));
  const revoke = useMutation(revokeConnectionMutationOptions(queryClient));
  const [editing, setEditing] = useState<Connection | "new" | null>(null);
  const [granting, setGranting] = useState<Connection | null>(null);
  const [grantee, setGrantee] = useState("");

  const rows = connections.data?.connections ?? [];
  const agentIds = agents.data?.map((agent) => agent.id) ?? [];

  return (
    <PageShell
      action={
        <Button onClick={() => setEditing("new")} size="sm" variant="outline">
          Add a connection
        </Button>
      }
      description="Credentials for the services your coworkers' workflows touch — API tokens, CLI logins, website passwords. A secret is stored encrypted, never shown again, and never enters a computer: API calls go through the egress proxy and web passwords are typed by the server. Use is granted per coworker."
      title="Connections"
    >
      <PageSection title="Vault">
        {rows.length === 0 ? (
          <PageEmpty>
            No connections yet. Add the services your workflows use — a
            Cloudflare API token, a Netlify token, the Hover login.
          </PageEmpty>
        ) : (
          <PageRows>
            {rows.map((connection, index) => (
              <div key={connection.id}>
                {index > 0 ? <Separator /> : null}
                <Item>
                  <ItemContent>
                    <ItemTitle className="flex items-center gap-2">
                      {connection.name}
                      <Badge variant="outline">{connection.kind}</Badge>
                      {connection.hasTotp ? (
                        <Badge variant="secondary">totp</Badge>
                      ) : null}
                      {connection.kind === "api" ? (
                        <Badge
                          variant={
                            (connection.allowedPaths?.length ?? 0) > 0
                              ? "secondary"
                              : "outline"
                          }
                        >
                          {(connection.allowedPaths?.length ?? 0) > 0
                            ? `${connection.allowedPaths?.length} rules`
                            : "whole API"}
                        </Badge>
                      ) : null}
                    </ItemTitle>
                    <ItemDescription>
                      {connection.service}
                      {connection.username ? ` · ${connection.username}` : ""}
                      {connection.baseUrl ? ` · ${connection.baseUrl}` : ""}
                      <span className="mt-1 block text-muted-foreground">
                        {connection.grants.length === 0
                          ? "Granted to nobody yet"
                          : `Granted to ${connection.grants.join(", ")}`}
                      </span>
                    </ItemDescription>
                  </ItemContent>
                  <ItemActions>
                    <Button
                      onClick={() => {
                        setGrantee("");
                        setGranting(connection);
                      }}
                      size="sm"
                      variant="outline"
                    >
                      Grants
                    </Button>
                    <Button
                      onClick={() => setEditing(connection)}
                      size="sm"
                      variant="ghost"
                    >
                      Edit
                    </Button>
                    <Button
                      onClick={() => remove.mutate(connection.id)}
                      size="sm"
                      variant="ghost"
                    >
                      Remove
                    </Button>
                  </ItemActions>
                </Item>
              </div>
            ))}
          </PageRows>
        )}
      </PageSection>

      <EditConnectionDialog
        connection={editing}
        onClose={() => setEditing(null)}
        onSave={(input) =>
          save.mutate(input, { onSuccess: () => setEditing(null) })
        }
        pending={save.isPending}
      />

      <Dialog
        onOpenChange={(open) => !open && setGranting(null)}
        open={!!granting}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Who may use {granting?.name}</DialogTitle>
            <DialogDescription>
              A grant is checked at every use and every use is audited. Revoking
              takes effect on the next call.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-2">
            {(granting?.grants ?? []).map((agentId) => (
              <div
                className="flex items-center justify-between rounded-md border px-3 py-2 text-sm"
                key={agentId}
              >
                <span>{agentId}</span>
                <Button
                  onClick={() => {
                    if (!granting) return;
                    revoke.mutate(
                      { id: granting.id, agentId },
                      {
                        onSuccess: () =>
                          setGranting({
                            ...granting,
                            grants: granting.grants.filter(
                              (id) => id !== agentId,
                            ),
                          }),
                      },
                    );
                  }}
                  size="sm"
                  variant="ghost"
                >
                  Revoke
                </Button>
              </div>
            ))}
            <div className="flex items-center gap-2">
              <Select
                onValueChange={(v) => setGrantee(v ?? "")}
                value={grantee}
              >
                <SelectTrigger className="flex-1">
                  <SelectValue placeholder="Grant a coworker" />
                </SelectTrigger>
                <SelectContent>
                  <SelectGroup>
                    {agentIds
                      .filter((id) => !(granting?.grants ?? []).includes(id))
                      .map((id) => (
                        <SelectItem key={id} value={id}>
                          {id}
                        </SelectItem>
                      ))}
                  </SelectGroup>
                </SelectContent>
              </Select>
              <Button
                disabled={!grantee || grant.isPending}
                onClick={() => {
                  if (!granting || !grantee) return;
                  grant.mutate(
                    { id: granting.id, agentId: grantee },
                    {
                      onSuccess: () => {
                        setGranting({
                          ...granting,
                          grants: [...granting.grants, grantee],
                        });
                        setGrantee("");
                      },
                    },
                  );
                }}
                size="sm"
              >
                Grant
              </Button>
            </div>
          </div>
        </DialogContent>
      </Dialog>
    </PageShell>
  );
}

function EditConnectionDialog(props: {
  connection: Connection | "new" | null;
  pending: boolean;
  onClose: () => void;
  onSave: (input: {
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
  }) => void;
}) {
  const existing = props.connection !== "new" ? props.connection : null;
  const [id, setId] = useState("");
  const [name, setName] = useState("");
  const [kind, setKind] = useState<Connection["kind"]>("api");
  const [service, setService] = useState("");
  const [baseUrl, setBaseUrl] = useState("");
  const [loginUrl, setLoginUrl] = useState("");
  const [username, setUsername] = useState("");
  const [secret, setSecret] = useState("");
  const [totpSeed, setTotpSeed] = useState("");
  const [allowedPaths, setAllowedPaths] = useState("");
  const [seeded, setSeeded] = useState<string | null>(null);

  // Seed the form when a different connection opens; a dialog is reused, state is not.
  const openId = existing?.id ?? (props.connection === "new" ? "new" : null);
  if (openId !== null && openId !== seeded) {
    setSeeded(openId);
    setId(existing?.id ?? "");
    setName(existing?.name ?? "");
    setKind(existing?.kind ?? "api");
    setService(existing?.service ?? "");
    setBaseUrl(existing?.baseUrl ?? "");
    setLoginUrl(existing?.loginUrl ?? "");
    setUsername(existing?.username ?? "");
    setSecret("");
    setTotpSeed("");
    setAllowedPaths((existing?.allowedPaths ?? []).join("\n"));
  }

  const ready =
    (existing ? true : /^[a-z0-9][a-z0-9-]*$/.test(id)) &&
    name.trim() &&
    service.trim() &&
    (existing ? true : secret.trim());

  return (
    <Dialog
      onOpenChange={(open) => !open && props.onClose()}
      open={props.connection !== null}
    >
      <DialogContent>
        <DialogHeader>
          <DialogTitle>
            {existing ? `Edit ${existing.name}` : "Add a connection"}
          </DialogTitle>
          <DialogDescription>
            The secret is stored encrypted and never shown again. Leave it blank
            when editing to keep what is stored.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-3">
          {existing ? null : (
            <Input
              onChange={(event) => setId(event.target.value)}
              placeholder='Short id, like "hover" or "netlify"'
              value={id}
            />
          )}
          <Input
            onChange={(event) => setName(event.target.value)}
            placeholder="Name, like Hover (personal)"
            value={name}
          />
          <Input
            onChange={(event) => setService(event.target.value)}
            placeholder='Service, like "hover" or "cloudflare"'
            value={service}
          />
          <Select
            onValueChange={(v) => setKind((v as Connection["kind"]) ?? "api")}
            value={kind}
          >
            <SelectTrigger>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectGroup>
                <SelectItem value="api">
                  API token (used through the egress proxy)
                </SelectItem>
                <SelectItem value="web">
                  Website login (typed by the server, never seen)
                </SelectItem>
                <SelectItem value="cli">
                  CLI credential (injected into a run)
                </SelectItem>
              </SelectGroup>
            </SelectContent>
          </Select>
          {kind === "api" ? (
            <Input
              onChange={(event) => setBaseUrl(event.target.value)}
              placeholder="API base URL, like https://api.cloudflare.com/client/v4"
              value={baseUrl}
            />
          ) : null}
          {kind === "web" ? (
            <>
              <Input
                onChange={(event) => setLoginUrl(event.target.value)}
                placeholder="Sign-in page, like https://www.hover.com/signin"
                value={loginUrl}
              />
              <Input
                onChange={(event) => setUsername(event.target.value)}
                placeholder="Username or email"
                value={username}
              />
            </>
          ) : null}
          <Input
            onChange={(event) => setSecret(event.target.value)}
            placeholder={
              existing
                ? "New secret (blank keeps the stored one)"
                : kind === "web"
                  ? "Password"
                  : "Token"
            }
            type="password"
            value={secret}
          />
          {kind === "api" ? (
            <Textarea
              onChange={(event) => setAllowedPaths(event.target.value)}
              placeholder={
                "Allowed requests, one per line (blank allows the whole API):\nGET /zones/**\nPOST /zones/*/dns_records"
              }
              rows={3}
              value={allowedPaths}
            />
          ) : null}
          {kind === "web" ? (
            <Input
              onChange={(event) => setTotpSeed(event.target.value)}
              placeholder="TOTP seed, if the login uses one-time codes (optional)"
              type="password"
              value={totpSeed}
            />
          ) : null}
        </div>
        <DialogFooter>
          <Button onClick={props.onClose} variant="ghost">
            Cancel
          </Button>
          <Button
            disabled={!ready || props.pending}
            onClick={() =>
              props.onSave({
                id: existing?.id ?? id,
                name: name.trim(),
                kind,
                service: service.trim(),
                ...(baseUrl.trim() ? { baseUrl: baseUrl.trim() } : {}),
                ...(loginUrl.trim() ? { loginUrl: loginUrl.trim() } : {}),
                ...(username.trim() ? { username: username.trim() } : {}),
                ...(secret ? { secret } : {}),
                ...(totpSeed ? { totpSeed } : {}),
                ...(kind === "api"
                  ? {
                      allowedPaths: allowedPaths
                        .split("\n")
                        .map((line) => line.trim())
                        .filter(Boolean),
                    }
                  : {}),
              })
            }
          >
            Save
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
