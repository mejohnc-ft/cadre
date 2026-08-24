import { useMutation, useQuery } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { ComputerView } from "@/components/computer/computer-view";
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
  connectBeginMutationOptions,
  connectCaptureMutationOptions,
  grantConnectionMutationOptions,
  msConnectPollMutationOptions,
  msConnectStartMutationOptions,
  removeConnectionMutationOptions,
  revokeConnectionMutationOptions,
  saveConnectionMutationOptions,
  verifyConnectionMutationOptions,
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
  const verify = useMutation(verifyConnectionMutationOptions(queryClient));
  const connectBegin = useMutation(connectBeginMutationOptions(queryClient));
  const connectCapture = useMutation(
    connectCaptureMutationOptions(queryClient),
  );
  const [verifying, setVerifying] = useState<string | null>(null);
  // The connect dialog opens IMMEDIATELY on click — before any slow work — so it always appears.
  const [connecting, setConnecting] = useState<{
    id: string;
    name: string;
    botId: string;
  } | null>(null);
  const [connectNote, setConnectNote] = useState("");
  const msStart = useMutation(msConnectStartMutationOptions());
  const msPoll = useMutation(msConnectPollMutationOptions(queryClient));
  const [msDevice, setMsDevice] = useState<{
    id: string;
    name: string;
    userCode: string;
    verificationUri: string;
  } | null>(null);
  const [msStatus, setMsStatus] = useState("");
  const [cred, setCred] = useState<{
    id: string;
    name: string;
    loginUrl: string;
    tag: string;
  } | null>(null);
  const [credUser, setCredUser] = useState("");
  const [credPass, setCredPass] = useState("");
  const [credTotp, setCredTotp] = useState("");
  const [credOpRef, setCredOpRef] = useState("");
  const [credOpAccount, setCredOpAccount] = useState("");
  const [credStatus, setCredStatus] = useState("");
  const [editing, setEditing] = useState<Connection | "new" | null>(null);
  const [granting, setGranting] = useState<Connection | null>(null);
  const [grantee, setGrantee] = useState("");

  const rows = connections.data?.connections ?? [];
  const agentIds = agents.data?.map((agent) => agent.id) ?? [];

  // The coworker whose browser the login runs in. Prefer Incident Buddy; fall back to the first.
  const connectBot = agentIds.includes("incident-buddy")
    ? "incident-buddy"
    : agentIds[0];

  /**
   * The chosen flow: paste the admin credentials once in a normal form (clipboard works — this is
   * not the screencast), and Cadre signs the coworker's browser in and captures the session. From
   * then on the coworker works visibly in the admin UI, reusing the session. The password is sealed
   * under the master key, typed into the browser by the server, and never enters the VM or a model.
   */
  async function signInWithCred() {
    if (!cred || !connectBot) return;
    const useOp = credOpRef.trim().length > 0;
    setCredStatus(
      useOp
        ? "Reading the credentials from 1Password and signing in…"
        : "Saving and signing in… (this signs the browser in and captures the session)",
    );
    try {
      await save.mutateAsync({
        id: cred.id,
        name: cred.name,
        kind: "web",
        service: cred.tag,
        loginUrl: cred.loginUrl,
        username: credUser,
        ...(useOp
          ? {
              opRef: credOpRef.trim(),
              opAccount: credOpAccount.trim() || "my.1password.com",
            }
          : { secret: credPass, ...(credTotp ? { totpSeed: credTotp } : {}) }),
      });
      await grant.mutateAsync({ id: cred.id, agentId: connectBot });
      const result = await verify.mutateAsync({ id: cred.id });
      if (result.status === "ok") {
        setCredStatus(
          "Signed in and session captured. The coworker can now work in the admin UI.",
        );
        setCredPass("");
        setCredTotp("");
        setTimeout(() => setCred(null), 1500);
      } else {
        setCredStatus(`Sign-in failed: ${result.note}`);
      }
    } catch (error) {
      setCredStatus(
        `Failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  /**
   * Microsoft device-code sign-in: get a code, show it, and poll until the person finishes signing
   * in on their own browser. No screencast, no password in Cadre.
   */
  async function startMs(service: { id: string; name: string }) {
    setMsStatus("Getting a sign-in code from Microsoft…");
    setMsDevice({
      id: service.id,
      name: service.name,
      userCode: "",
      verificationUri: "",
    });
    try {
      const started = await msStart.mutateAsync({
        id: service.id,
        name: service.name,
      });
      setMsDevice({
        id: service.id,
        name: service.name,
        userCode: started.userCode,
        verificationUri: started.verificationUri,
      });
      setMsStatus("Open the link, enter the code, and sign in. Waiting…");
    } catch (error) {
      setMsStatus(
        `Could not start: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  // Poll for completion while the device-code dialog is open with a live code.
  // biome-ignore lint/correctness/useExhaustiveDependencies: poll only keys off the connection id.
  useEffect(() => {
    if (!msDevice?.userCode) return;
    let stop = false;
    const tick = async () => {
      if (stop) return;
      const result = await msPoll.mutateAsync(msDevice.id);
      if (stop) return;
      if (result.status === "connected") {
        setMsStatus("Connected.");
        setMsDevice(null);
      } else if (result.status === "pending") {
        setTimeout(tick, 4000);
      } else if (result.status === "expired") {
        setMsStatus("The code expired. Start again.");
      } else if (result.status === "failed") {
        setMsStatus(`Sign-in failed: ${result.error ?? ""}`);
      }
    };
    const timer = setTimeout(tick, 4000);
    return () => {
      stop = true;
      clearTimeout(timer);
    };
  }, [msDevice?.id, msDevice?.userCode]);

  /**
   * Open the sign-in dialog and start the login. The dialog appears at once (the live screen shows
   * the browser booting); the slow work — ensure the connection, grant it, open the real login —
   * runs after, with its status shown in the dialog. Nothing can make the click do nothing.
   */
  async function openConnect(service: {
    id: string;
    name: string;
    loginUrl: string;
    tag: string;
  }) {
    if (!connectBot) return;
    setConnectNote("Starting the browser and opening the sign-in page…");
    setConnecting({ id: service.id, name: service.name, botId: connectBot });
    try {
      await save.mutateAsync({
        id: service.id,
        name: service.name,
        kind: "web",
        service: service.tag,
        loginUrl: service.loginUrl,
      });
      await grant.mutateAsync({ id: service.id, agentId: connectBot });
      const result = await connectBegin.mutateAsync({
        id: service.id,
        agentId: connectBot,
      });
      setConnectNote(
        result.ok
          ? "Sign in on the screen below — password, MFA, everything — then click Capture."
          : `Could not open the sign-in: ${result.note}`,
      );
    } catch (error) {
      setConnectNote(
        `Could not open the sign-in: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

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
      <PageSection title="Sessions">
        <p className="mb-3 text-muted-foreground text-sm">
          The browser sign-ins Cadre keeps for systems that need one. You sign
          in yourself on the vendor's real page — password, MFA, everything — in{" "}
          {connectBot ?? "a coworker"}'s browser, and the session is captured.
          No password is entered into Cadre; sessions are encrypted at rest and
          never leave the server.
        </p>
        <PageRows>
          {[
            {
              tag: "microsoft",
              id: "m365-admin",
              name: "Microsoft 365 Admin",
              provider: "Microsoft · admin center sign-in",
              loginUrl: "https://admin.microsoft.com",
            },
            {
              tag: "microsoft",
              id: "outlook",
              name: "Outlook",
              provider: "Microsoft · web sign-in",
              loginUrl: "https://outlook.office.com/mail/",
            },
            {
              tag: "google",
              id: "google-workspace",
              name: "Google Workspace Admin",
              provider: "Google · admin console sign-in",
              loginUrl: "https://admin.google.com",
            },
          ].map((service, index) => {
            const conn = rows.find((c) => c.id === service.id);
            const connected = Boolean(conn?.hasSession);
            return (
              <div key={service.id}>
                {index > 0 ? <Separator /> : null}
                <Item>
                  <ItemContent>
                    <ItemTitle className="flex items-center gap-2">
                      {service.name}
                      <Badge variant={connected ? "secondary" : "outline"}>
                        {connected ? "Connected" : "Not connected"}
                      </Badge>
                    </ItemTitle>
                    <ItemDescription>
                      {service.provider}
                      {conn?.sessionCapturedAt
                        ? ` · signed in ${new Date(conn.sessionCapturedAt).toLocaleString()}`
                        : ""}
                    </ItemDescription>
                  </ItemContent>
                  <ItemActions>
                    <Button
                      onClick={() => {
                        setCredUser(conn?.username ?? "");
                        setCredPass("");
                        setCredTotp("");
                        setCredOpRef(conn?.opRef ?? "");
                        setCredOpAccount(conn?.opAccount ?? "");
                        setCredStatus("");
                        setCred(service);
                      }}
                      size="sm"
                      variant={connected ? "outline" : "default"}
                    >
                      {connected ? "Reconnect" : "Connect"}
                    </Button>
                  </ItemActions>
                </Item>
              </div>
            );
          })}
        </PageRows>
      </PageSection>

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
                      {connection.hasSession ? (
                        <Badge variant="secondary">session ready</Badge>
                      ) : null}
                      {connection.lastVerifyStatus ? (
                        <Badge
                          variant={
                            connection.lastVerifyStatus === "ok"
                              ? "secondary"
                              : "destructive"
                          }
                        >
                          {connection.lastVerifyStatus === "ok"
                            ? "sign-in verified"
                            : "verify failed"}
                        </Badge>
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
                        {connection.lastVerifyNote
                          ? ` · ${connection.lastVerifyNote}`
                          : ""}
                      </span>
                    </ItemDescription>
                  </ItemContent>
                  <ItemActions>
                    {connection.kind === "web" && connection.loginUrl ? (
                      <Button
                        disabled={!connectBot || connection.grants.length === 0}
                        onClick={() =>
                          openConnect({
                            id: connection.id,
                            name: connection.name,
                            loginUrl: connection.loginUrl as string,
                            tag: connection.service,
                          })
                        }
                        size="sm"
                        title={
                          connection.grants.length === 0
                            ? "Grant this connection to a coworker first"
                            : "Sign in yourself on the live screen; the session is captured"
                        }
                        variant="outline"
                      >
                        Sign in yourself
                      </Button>
                    ) : null}
                    {connection.kind === "web" ? (
                      <Button
                        disabled={verify.isPending}
                        onClick={() => {
                          setVerifying(connection.id);
                          verify.mutate(
                            { id: connection.id },
                            { onSettled: () => setVerifying(null) },
                          );
                        }}
                        size="sm"
                        variant="ghost"
                      >
                        {verifying === connection.id
                          ? "Signing in…"
                          : "Verify (auto)"}
                      </Button>
                    ) : null}
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

      <Dialog
        onOpenChange={(open) => {
          if (!open) setCred(null);
        }}
        open={!!cred}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Connect {cred?.name}</DialogTitle>
            <DialogDescription>
              Enter the admin sign-in once. Cadre signs {connectBot}'s browser
              in and keeps the session, so the coworker works right in the admin
              center after this. The password is encrypted, typed by the server,
              and never enters the computer or a model.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-3">
            <Input
              autoComplete="off"
              onChange={(event) => setCredUser(event.target.value)}
              placeholder="Admin username (e.g. you@tenant.onmicrosoft.com)"
              value={credUser}
            />
            <Input
              autoComplete="off"
              onChange={(event) => setCredPass(event.target.value)}
              placeholder="Password (paste — clipboard works here)"
              type="password"
              value={credPass}
            />
            <Input
              autoComplete="off"
              onChange={(event) => setCredTotp(event.target.value)}
              placeholder="Authenticator setup key / TOTP seed (optional)"
              type="password"
              value={credTotp}
            />
            <div className="rounded-md border border-dashed p-3">
              <p className="mb-2 text-muted-foreground text-xs">
                Or pull the password and one-time code from 1Password — nothing
                is stored in Cadre, and the container never sees 1Password. Fill
                the item reference and leave the password blank.
              </p>
              <Input
                autoComplete="off"
                className="mb-2 font-mono text-xs"
                onChange={(event) => setCredOpRef(event.target.value)}
                placeholder="1Password item, e.g. op://Private/Microsoft 365"
                value={credOpRef}
              />
              <Input
                autoComplete="off"
                className="font-mono text-xs"
                onChange={(event) => setCredOpAccount(event.target.value)}
                placeholder="Account (default my.1password.com)"
                value={credOpAccount}
              />
            </div>
            {credStatus ? (
              <p className="text-muted-foreground text-sm">{credStatus}</p>
            ) : null}
            {cred?.tag === "microsoft" ? (
              <button
                className="text-muted-foreground text-xs underline"
                onClick={() => {
                  const service = cred;
                  setCred(null);
                  if (service) startMs(service);
                }}
                type="button"
              >
                Or sign in with a code on your own browser (no password stored)
              </button>
            ) : null}
          </div>
          <DialogFooter>
            <Button onClick={() => setCred(null)} variant="ghost">
              Cancel
            </Button>
            <Button
              disabled={
                !credUser ||
                (!credPass && !credOpRef.trim()) ||
                verify.isPending
              }
              onClick={signInWithCred}
            >
              {verify.isPending ? "Signing in…" : "Sign in & capture"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog
        onOpenChange={(open) => {
          if (!open) setMsDevice(null);
        }}
        open={!!msDevice}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Sign in to {msDevice?.name}</DialogTitle>
            <DialogDescription>
              Open the link in your own browser, enter the code, and sign in —
              password, MFA, everything. Your password never comes to Cadre;
              Microsoft hands back a token when you're done.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4 py-2 text-center">
            {msDevice?.userCode ? (
              <>
                <a
                  className="inline-block text-primary underline"
                  href={msDevice.verificationUri}
                  rel="noreferrer"
                  target="_blank"
                >
                  {msDevice.verificationUri}
                </a>
                <div className="select-all rounded-md bg-muted py-4 font-mono text-3xl tracking-widest">
                  {msDevice.userCode}
                </div>
              </>
            ) : null}
            <p className="text-muted-foreground text-sm">{msStatus}</p>
          </div>
          <DialogFooter>
            <Button onClick={() => setMsDevice(null)} variant="outline">
              Close
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog
        onOpenChange={(open) => {
          if (!open) setConnecting(null);
        }}
        open={!!connecting}
      >
        <DialogContent className="sm:max-w-2xl">
          <DialogHeader>
            <DialogTitle>Sign in to {connecting?.name}</DialogTitle>
            <DialogDescription>
              This is the real vendor page, open in {connecting?.botId}'s
              browser. Click "Take control" below, sign in yourself — password,
              MFA, everything — then click "I'm signed in — capture" to store
              the session. No password is entered into Cadre.
            </DialogDescription>
          </DialogHeader>
          {connecting ? (
            <div className="space-y-3">
              <ComputerView computerId={connecting.botId} />
              {connectNote ? (
                <p className="text-muted-foreground text-sm">{connectNote}</p>
              ) : null}
            </div>
          ) : null}
          <DialogFooter>
            <Button onClick={() => setConnecting(null)} variant="ghost">
              Cancel
            </Button>
            <Button
              disabled={connectCapture.isPending}
              onClick={() => {
                if (!connecting) return;
                connectCapture.mutate(
                  {
                    id: connecting.id,
                    agentId: connecting.botId,
                  },
                  {
                    onSuccess: (result) => {
                      setConnectNote(result.note);
                      if (result.ok) setConnecting(null);
                    },
                  },
                );
              }}
            >
              {connectCapture.isPending
                ? "Capturing…"
                : "I'm signed in — capture"}
            </Button>
          </DialogFooter>
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
  const [idTouched, setIdTouched] = useState(false);
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
    setIdTouched(false);
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

  // The id is derived from the name unless the operator has typed one — nobody should have to
  // think about slugs to save a login. It stays visible so a collision is obvious before saving.
  const slugify = (value: string) =>
    value
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 40);
  const effectiveId = existing?.id ?? (idTouched ? id : slugify(name));

  const missing: string[] = [];
  if (!existing) {
    if (!name.trim()) missing.push("a name");
    if (!effectiveId) missing.push("a name that yields an id");
    if (!service.trim()) missing.push("a service");
    // A web login can be session-only (sign in yourself), so no password is required for it.
    if (!secret.trim() && kind !== "web") {
      missing.push("a token");
    }
  } else if (!name.trim()) {
    missing.push("a name");
  }
  const ready = missing.length === 0;

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
          <Input
            onChange={(event) => setName(event.target.value)}
            placeholder="Name, like Microsoft 365 (Contoso)"
            value={name}
          />
          {existing ? null : (
            <div className="flex items-center gap-2 text-muted-foreground text-xs">
              <span className="shrink-0">Saved as id:</span>
              <Input
                className="h-7 font-mono text-xs"
                onChange={(event) => {
                  setIdTouched(true);
                  setId(event.target.value);
                }}
                placeholder="auto from name"
                value={effectiveId}
              />
            </div>
          )}
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
                  ? "Password (optional — leave blank to sign in yourself)"
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
        <DialogFooter className="flex-col items-stretch gap-2 sm:flex-row sm:items-center sm:justify-end">
          {ready ? null : (
            <span className="mr-auto text-muted-foreground text-xs">
              Add {missing.join(", ")} to save.
            </span>
          )}
          <Button onClick={props.onClose} variant="ghost">
            Cancel
          </Button>
          <Button
            disabled={!ready || props.pending}
            onClick={() =>
              props.onSave({
                id: existing?.id ?? effectiveId,
                name: name.trim(),
                kind,
                service: service.trim() || slugify(name),
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
