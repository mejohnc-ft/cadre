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
  createTriggerMutationOptions,
  fireTriggerMutationOptions,
  removeTriggerMutationOptions,
  updateTriggerMutationOptions,
} from "@/lib/triggers/mutations";
import { type Trigger, triggersQueryOptions } from "@/lib/triggers/queries";
import { queryClient } from "@/query-client";

export const Route = createFileRoute("/_authed/admin/triggers")({
  component: TriggersPage,
});

function TriggersPage() {
  const triggers = useQuery(triggersQueryOptions());
  const agents = useQuery(agentListQueryOptions());
  const create = useMutation(createTriggerMutationOptions(queryClient));
  const update = useMutation(updateTriggerMutationOptions(queryClient));
  const remove = useMutation(removeTriggerMutationOptions(queryClient));
  const fire = useMutation(fireTriggerMutationOptions(queryClient));
  const [adding, setAdding] = useState(false);
  const [token, setToken] = useState<{ id: string; token: string } | null>(
    null,
  );
  const [firing, setFiring] = useState<string | null>(null);

  const rows = triggers.data?.triggers ?? [];

  return (
    <PageShell
      action={
        <Button onClick={() => setAdding(true)} size="sm" variant="outline">
          Add a trigger
        </Button>
      }
      description="Runs that start themselves. A cron trigger fires on a schedule; a webhook trigger fires when an outside system calls its URL. Every firing is an ordinary governed run, audited like any other."
      title="Triggers"
    >
      <PageSection title="Triggers">
        {rows.length === 0 ? (
          <PageEmpty>
            No triggers yet. Add one to give a coworker a schedule or a webhook.
          </PageEmpty>
        ) : (
          <PageRows>
            {rows.map((trigger, index) => (
              <div key={trigger.id}>
                {index > 0 ? <Separator /> : null}
                <Item>
                  <ItemContent>
                    <ItemTitle className="flex items-center gap-2">
                      {trigger.name}
                      <Badge variant="outline">{trigger.kind}</Badge>
                      {trigger.enabled ? null : (
                        <Badge variant="secondary">paused</Badge>
                      )}
                      {trigger.lastStatus ? (
                        <Badge
                          variant={
                            trigger.lastStatus === "ok"
                              ? "secondary"
                              : trigger.lastStatus === "running"
                                ? "outline"
                                : "destructive"
                          }
                        >
                          {trigger.lastStatus}
                        </Badge>
                      ) : null}
                    </ItemTitle>
                    <ItemDescription>
                      {trigger.agentId}
                      {trigger.kind === "cron" && trigger.schedule
                        ? ` · ${trigger.schedule}`
                        : ""}
                      {trigger.lastFiredAt
                        ? ` · last fired ${new Date(trigger.lastFiredAt).toLocaleString()}`
                        : " · never fired"}
                      {trigger.lastReply ? (
                        <span className="mt-1 block truncate text-muted-foreground">
                          {trigger.lastReply}
                        </span>
                      ) : null}
                    </ItemDescription>
                  </ItemContent>
                  <ItemActions>
                    <Button
                      disabled={fire.isPending}
                      onClick={() => {
                        setFiring(trigger.id);
                        fire.mutate(trigger.id, {
                          onSettled: () => setFiring(null),
                        });
                      }}
                      size="sm"
                      variant="outline"
                    >
                      {firing === trigger.id ? "Firing…" : "Fire now"}
                    </Button>
                    <Button
                      onClick={() =>
                        update.mutate({
                          id: trigger.id,
                          patch: { enabled: !trigger.enabled },
                        })
                      }
                      size="sm"
                      variant="ghost"
                    >
                      {trigger.enabled ? "Pause" : "Resume"}
                    </Button>
                    <Button
                      onClick={() => remove.mutate(trigger.id)}
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

      <AddTriggerDialog
        agents={agents.data?.map((a) => a.id) ?? []}
        onClose={() => setAdding(false)}
        onCreate={(input) =>
          create.mutate(input, {
            onSuccess: (result) => {
              setAdding(false);
              if (result.token) {
                setToken({ id: result.trigger.id, token: result.token });
              }
            },
          })
        }
        open={adding}
        pending={create.isPending}
      />

      <Dialog onOpenChange={(open) => !open && setToken(null)} open={!!token}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Webhook created</DialogTitle>
            <DialogDescription>
              This token is shown once and never again. The caller sends it in
              the X-Cadre-Token header, or as ?token=.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-2">
            <div className="rounded-md bg-muted p-3 font-mono text-xs break-all">
              POST /api/hooks/{token?.id}
            </div>
            <div className="rounded-md bg-muted p-3 font-mono text-xs break-all">
              {token?.token}
            </div>
          </div>
          <DialogFooter>
            <Button onClick={() => setToken(null)} variant="outline">
              I saved it
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </PageShell>
  );
}

function AddTriggerDialog(props: {
  open: boolean;
  agents: string[];
  pending: boolean;
  onClose: () => void;
  onCreate: (input: {
    name: string;
    agentId: string;
    kind: Trigger["kind"];
    schedule?: string;
    prompt: string;
    threadMode: Trigger["threadMode"];
  }) => void;
}) {
  const [name, setName] = useState("");
  const [agentId, setAgentId] = useState("");
  const [kind, setKind] = useState<Trigger["kind"]>("cron");
  const [schedule, setSchedule] = useState("0 7 * * 1-5");
  const [prompt, setPrompt] = useState("");
  const [threadMode, setThreadMode] =
    useState<Trigger["threadMode"]>("continue");

  const ready =
    name.trim() &&
    agentId &&
    prompt.trim() &&
    (kind === "webhook" || schedule.trim());

  return (
    <Dialog onOpenChange={(open) => !open && props.onClose()} open={props.open}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Add a trigger</DialogTitle>
          <DialogDescription>
            What should fire, when, and what it says to the coworker.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-3">
          <Input
            onChange={(event) => setName(event.target.value)}
            placeholder="Name, like Morning briefing"
            value={name}
          />
          <Select onValueChange={(v) => setAgentId(v ?? "")} value={agentId}>
            <SelectTrigger>
              <SelectValue placeholder="Which coworker" />
            </SelectTrigger>
            <SelectContent>
              <SelectGroup>
                {props.agents.map((id) => (
                  <SelectItem key={id} value={id}>
                    {id}
                  </SelectItem>
                ))}
              </SelectGroup>
            </SelectContent>
          </Select>
          <Select
            onValueChange={(v) => setKind((v as Trigger["kind"]) ?? "cron")}
            value={kind}
          >
            <SelectTrigger>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectGroup>
                <SelectItem value="cron">On a schedule (cron)</SelectItem>
                <SelectItem value="webhook">On a webhook call</SelectItem>
              </SelectGroup>
            </SelectContent>
          </Select>
          {kind === "cron" ? (
            <Input
              onChange={(event) => setSchedule(event.target.value)}
              placeholder='Cron, like "0 7 * * 1-5"'
              value={schedule}
            />
          ) : null}
          <Textarea
            onChange={(event) => setPrompt(event.target.value)}
            placeholder="What each firing says to the coworker"
            rows={4}
            value={prompt}
          />
          <Select
            onValueChange={(v) =>
              setThreadMode((v as Trigger["threadMode"]) ?? "continue")
            }
            value={threadMode}
          >
            <SelectTrigger>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectGroup>
                <SelectItem value="continue">
                  One standing thread (remembers earlier firings)
                </SelectItem>
                <SelectItem value="new">A fresh thread every firing</SelectItem>
              </SelectGroup>
            </SelectContent>
          </Select>
        </div>
        <DialogFooter>
          <Button onClick={props.onClose} variant="ghost">
            Cancel
          </Button>
          <Button
            disabled={!ready || props.pending}
            onClick={() =>
              props.onCreate({
                name: name.trim(),
                agentId,
                kind,
                ...(kind === "cron" ? { schedule: schedule.trim() } : {}),
                prompt,
                threadMode,
              })
            }
          >
            Create
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
