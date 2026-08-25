import { eq } from "drizzle-orm";
import {
  describeCall,
  executeTool,
  TOOL_DEFINITIONS,
} from "../../../cli/computer-tools";
import type { AuditStore } from "../audit";
import { recordAuditEvent } from "../audit";
import type { Database } from "../db/client";
import { triggers } from "../db/schema";
import { matches } from "./cron";

/**
 * The trigger engine: runs that start themselves, on the same path every surface uses.
 *
 * A firing sends the trigger's prompt to its coworker through the deployment's own run endpoint —
 * the engine is one more surface, like the browser and the terminal. Harness coworkers do their
 * own work inside their computers; built-in coworkers are offered the computer tools and the
 * engine executes each call against the gateway, exactly as the CLI does, so a scheduled Bot can
 * browse and run commands with every action decided and audited.
 *
 * The scheduler wakes once a minute and fires every enabled cron trigger whose expression matches
 * that minute. A firing already in flight is not stacked: a trigger runs one firing at a time.
 */

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

function toTrigger(row: typeof triggers.$inferSelect): Trigger {
  return {
    id: row.id,
    name: row.name,
    agentId: row.agentId,
    kind: row.kind as Trigger["kind"],
    schedule: row.schedule,
    prompt: row.prompt,
    enabled: row.enabled,
    threadMode: row.threadMode as Trigger["threadMode"],
    threadId: row.threadId,
    lastFiredAt: row.lastFiredAt?.toISOString() ?? null,
    lastStatus: row.lastStatus,
    lastReply: row.lastReply,
  };
}

async function sha256(value: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(value),
  );
  return Buffer.from(digest).toString("hex");
}

export type TriggerEngineOptions = {
  database: Database;
  audit: AuditStore;
  /** Where this server answers its own run requests: loopback, whatever the bind is. */
  selfUrl: string;
  fetchImpl?: typeof fetch;
};

export function createTriggerEngine(options: TriggerEngineOptions) {
  const doFetch = options.fetchImpl ?? fetch;
  const inFlight = new Set<string>();

  async function list(): Promise<Trigger[]> {
    const rows = await options.database.select().from(triggers);
    return rows.map(toTrigger).sort((a, b) => a.name.localeCompare(b.name));
  }

  async function get(id: string): Promise<Trigger | null> {
    const [row] = await options.database
      .select()
      .from(triggers)
      .where(eq(triggers.id, id))
      .limit(1);
    return row ? toTrigger(row) : null;
  }

  /** Create; for a webhook trigger the token is returned once and only its hash is kept. */
  async function create(input: {
    name: string;
    agentId: string;
    kind: "cron" | "webhook";
    schedule?: string;
    prompt: string;
    threadMode?: "continue" | "new";
    createdBy?: string;
  }): Promise<{ trigger: Trigger; token?: string }> {
    const id = `trg-${crypto.randomUUID().slice(0, 12)}`;
    const token =
      input.kind === "webhook"
        ? `cadre-hook-${Buffer.from(crypto.getRandomValues(new Uint8Array(18))).toString("base64url")}`
        : undefined;
    const [row] = await options.database
      .insert(triggers)
      .values({
        id,
        name: input.name,
        agentId: input.agentId,
        kind: input.kind,
        schedule: input.schedule ?? null,
        prompt: input.prompt,
        tokenHash: token ? await sha256(token) : null,
        threadMode: input.threadMode ?? "continue",
        createdBy: input.createdBy ?? null,
      })
      .returning();
    if (!row) throw new Error("The trigger could not be stored.");
    return { trigger: toTrigger(row), ...(token ? { token } : {}) };
  }

  async function update(
    id: string,
    patch: Partial<{
      name: string;
      schedule: string;
      prompt: string;
      enabled: boolean;
      threadMode: "continue" | "new";
    }>,
  ): Promise<boolean> {
    const updated = await options.database
      .update(triggers)
      .set(patch)
      .where(eq(triggers.id, id))
      .returning({ id: triggers.id });
    return updated.length > 0;
  }

  async function remove(id: string): Promise<boolean> {
    const removed = await options.database
      .delete(triggers)
      .where(eq(triggers.id, id))
      .returning({ id: triggers.id });
    return removed.length > 0;
  }

  async function verifyWebhook(id: string, token: string): Promise<boolean> {
    const [row] = await options.database
      .select({ tokenHash: triggers.tokenHash, enabled: triggers.enabled })
      .from(triggers)
      .where(eq(triggers.id, id))
      .limit(1);
    if (!row?.tokenHash || !row.enabled) return false;
    return row.tokenHash === (await sha256(token));
  }

  /**
   * One firing: run the coworker with the trigger's prompt (plus any webhook body), execute the
   * computer tools it calls, record the outcome on the trigger and in the audit trail.
   */
  async function fire(
    trigger: Trigger,
    cause: "cron" | "webhook" | "manual",
    extra?: string,
  ): Promise<{ status: "ok" | "error"; reply: string }> {
    if (inFlight.has(trigger.id)) {
      return { status: "error", reply: "A firing is already running." };
    }
    inFlight.add(trigger.id);
    const threadId =
      trigger.threadMode === "continue"
        ? (trigger.threadId ?? `trigger-${trigger.id}`)
        : crypto.randomUUID();
    await options.database
      .update(triggers)
      .set({ lastStatus: "running", lastFiredAt: new Date(), threadId })
      .where(eq(triggers.id, trigger.id));

    const prompt = extra
      ? `${trigger.prompt}\n\nThe request that fired this:\n\`\`\`\n${extra.slice(0, 4000)}\n\`\`\``
      : trigger.prompt;

    let status: "ok" | "error" = "ok";
    let reply = "";
    try {
      reply = await runToCompletion(trigger.agentId, threadId, prompt);
    } catch (error) {
      status = "error";
      reply = error instanceof Error ? error.message : String(error);
    } finally {
      inFlight.delete(trigger.id);
    }
    await options.database
      .update(triggers)
      .set({ lastStatus: status, lastReply: reply.slice(0, 2000) })
      .where(eq(triggers.id, trigger.id));
    await recordAuditEvent(options.audit, {
      eventType: "trigger.fired",
      targetType: "trigger",
      targetId: trigger.id,
      payload: {
        trigger: trigger.id,
        name: trigger.name,
        bot: trigger.agentId,
        cause,
        status,
        thread: threadId,
      },
    });
    return { status, reply };
  }

  type Message = {
    id: string;
    role: "user" | "assistant" | "tool";
    content: string;
    toolCalls?: Array<{
      id: string;
      type: "function";
      function: { name: string; arguments: string };
    }>;
    toolCallId?: string;
  };

  /** The same run/tool loop the terminal uses, headless. Returns the coworker's final text. */
  async function runToCompletion(
    agentId: string,
    threadId: string,
    prompt: string,
  ): Promise<string> {
    const messages: Message[] = [
      { id: crypto.randomUUID(), role: "user", content: prompt },
    ];
    let finalText = "";
    for (let turn = 0; turn < 45; turn++) {
      const { text, calls } = await runOnce(agentId, threadId, messages);
      if (text) finalText = text;
      if (calls.length === 0) break;
      messages.push({
        id: crypto.randomUUID(),
        role: "assistant",
        content: text,
        toolCalls: calls.map((call) => ({
          id: call.id,
          type: "function",
          function: { name: call.name, arguments: call.arguments || "{}" },
        })),
      });
      for (const call of calls) {
        let parsed: Record<string, unknown> = {};
        try {
          parsed = JSON.parse(call.arguments || "{}");
        } catch {}
        // Only the tools this engine offers are its to execute; a harness's own tool calls come
        // through as activity and are not in TOOL_DEFINITIONS by name.
        const outcome = TOOL_DEFINITIONS.some((t) => t.name === call.name)
          ? await executeTool(options.selfUrl, agentId, call.name, parsed)
          : {
              ok: false,
              reason: `Not a tool this surface executes: ${describeCall(call.name, parsed)}`,
            };
        messages.push({
          id: crypto.randomUUID(),
          role: "tool",
          toolCallId: call.id,
          content: JSON.stringify(outcome),
        });
      }
    }
    return finalText;
  }

  async function runOnce(
    agentId: string,
    threadId: string,
    messages: Message[],
  ): Promise<{
    text: string;
    calls: Array<{ id: string; name: string; arguments: string }>;
  }> {
    const response = await doFetch(
      `${options.selfUrl}/api/copilotkit/agent/${encodeURIComponent(agentId)}/run`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          accept: "text/event-stream",
        },
        body: JSON.stringify({
          threadId,
          runId: crypto.randomUUID(),
          messages,
          tools: TOOL_DEFINITIONS,
          context: [],
          state: {},
          forwardedProps: {},
        }),
        signal: AbortSignal.timeout(15 * 60 * 1000),
      },
    );
    if (!response.ok || !response.body) {
      throw new Error(`The run answered ${response.status}.`);
    }
    const decoder = new TextDecoder();
    let buffer = "";
    let text = "";
    const calls: Array<{ id: string; name: string; arguments: string }> = [];
    for await (const chunk of response.body) {
      buffer += decoder.decode(chunk as Uint8Array, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";
      for (const line of lines) {
        if (!line.startsWith("data:")) continue;
        let event: {
          type?: string;
          delta?: string;
          message?: string;
          toolCallId?: string;
          toolCallName?: string;
        };
        try {
          event = JSON.parse(line.slice(5));
        } catch {
          continue;
        }
        if (event.type === "TEXT_MESSAGE_CONTENT" && event.delta) {
          text += event.delta;
        } else if (
          event.type === "TOOL_CALL_START" &&
          event.toolCallId &&
          event.toolCallName &&
          TOOL_DEFINITIONS.some((t) => t.name === event.toolCallName)
        ) {
          calls.push({
            id: event.toolCallId,
            name: event.toolCallName,
            arguments: "",
          });
        } else if (event.type === "TOOL_CALL_ARGS") {
          const call = calls.find((c) => c.id === event.toolCallId);
          if (call && event.delta) call.arguments += event.delta;
        } else if (event.type === "RUN_ERROR") {
          throw new Error(event.message ?? "The run reported an error.");
        }
      }
    }
    return { text, calls };
  }

  /** The scheduler: once a minute, fire what is due. Returns a stop function. */
  function start(): () => void {
    let stopped = false;
    const tick = async () => {
      if (stopped) return;
      const now = new Date();
      try {
        const all = await list();
        for (const trigger of all) {
          if (
            trigger.enabled &&
            trigger.kind === "cron" &&
            trigger.schedule &&
            matches(trigger.schedule, now) &&
            !inFlight.has(trigger.id)
          ) {
            void fire(trigger, "cron").catch(() => {});
          }
        }
      } catch {
        // A failed sweep fires nothing; the next minute tries again.
      }
    };
    // Align to the top of the minute so a `* * * * *` schedule fires once per minute, not per boot.
    const msToMinute = 60_000 - (Date.now() % 60_000);
    let interval: ReturnType<typeof setInterval> | undefined;
    const first = setTimeout(() => {
      void tick();
      interval = setInterval(() => void tick(), 60_000);
    }, msToMinute);
    return () => {
      stopped = true;
      clearTimeout(first);
      if (interval) clearInterval(interval);
    };
  }

  return { list, get, create, update, remove, verifyWebhook, fire, start };
}

export type TriggerEngine = ReturnType<typeof createTriggerEngine>;
