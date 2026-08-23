import { Hono } from "hono";
import type { AuditStore } from "../audit";
import { recordAuditEvent } from "../audit";
import {
  type ActionPolicy,
  evaluateActionPolicy,
  type PolicyContext,
} from "../computer/policy";

/**
 * The gateway for a managed harness's own tools.
 *
 * Claude Code inside a computer wants to run a shell command, edit a file, read one. Before it
 * does, its PreToolUse hook posts the intended call here; this evaluates the deployment's
 * boundaries over the same CEL context the browser tools use — `tool.name` is
 * `harness_<Tool>`, `command` and `file` are filled from the call — writes the audit row, and
 * answers. The hook refuses on anything but an explicit yes, so the path from a harness to an
 * action still runs through one decision and one record.
 *
 * Authenticated by the computer token: only a computer holds it, and a computer says which Bot
 * it is. That is the same trust the browser tools carry on the way back.
 */

const HARNESS_TOOL = /^[A-Za-z][A-Za-z0-9_]{0,60}$/;

export function createHarnessRoutes(input: {
  computerToken: string | undefined;
  policy: () => ActionPolicy;
  audit: AuditStore;
}) {
  const app = new Hono();

  app.post("/harness/:botId/decide", async (context) => {
    const offered = context.req.header("x-openbot-computer-token") ?? "";
    if (!input.computerToken || offered !== input.computerToken) {
      return context.json({ allowed: false, reason: "Not a computer." }, 401);
    }
    const botId = context.req.param("botId");
    const body = (await context.req.json().catch(() => null)) as {
      tool_name?: unknown;
      tool_input?: unknown;
      session_id?: unknown;
    } | null;
    const toolName =
      typeof body?.tool_name === "string" && HARNESS_TOOL.test(body.tool_name)
        ? body.tool_name
        : "";
    if (!toolName) {
      return context.json(
        { allowed: false, reason: "The call named no recognisable tool." },
        400,
      );
    }
    const toolInput =
      typeof body?.tool_input === "object" && body.tool_input !== null
        ? (body.tool_input as Record<string, unknown>)
        : {};
    const command =
      typeof toolInput.command === "string" ? toolInput.command : "";
    const filePath =
      typeof toolInput.file_path === "string"
        ? toolInput.file_path
        : typeof toolInput.path === "string"
          ? toolInput.path
          : typeof toolInput.notebook_path === "string"
            ? toolInput.notebook_path
            : "";

    const policyContext: PolicyContext = {
      tool: { name: `harness_${toolName}` },
      bot: { id: botId },
      actor: { id: `harness:${botId}` },
      page: { url: "", host: "" },
      intent: intentOf(toolName),
      key: "",
      element: { ref: "", role: "", name: "", type: "" },
      file: describeFile(filePath),
      command,
    };
    const decision = evaluateActionPolicy(input.policy(), policyContext);
    await recordAuditEvent(input.audit, {
      eventType: decision.allowed
        ? "computer.action_allowed"
        : "computer.action_refused",
      targetType: "computer",
      targetId: botId,
      payload: {
        action: `harness_${toolName}`,
        bot: botId,
        actor: policyContext.actor.id,
        harness: "claude-code",
        run: context.req.header("x-openbot-run-id") ?? null,
        session: typeof body?.session_id === "string" ? body.session_id : null,
        command: command || null,
        file: filePath || null,
        decision: {
          allowed: decision.allowed,
          mode: decision.mode,
          matched: decision.matched,
          source: decision.source,
        },
      },
    });
    return context.json({
      allowed: decision.allowed,
      reason: decision.allowed
        ? null
        : decision.matched
          ? `${decision.reason} (rule: ${decision.matched})`
          : decision.reason,
    });
  });

  return app;
}

function intentOf(toolName: string): PolicyContext["intent"] {
  switch (toolName) {
    case "Bash":
      return "run_command";
    case "Read":
    case "Glob":
    case "Grep":
    case "NotebookRead":
      return "read_file";
    case "Write":
    case "Edit":
    case "MultiEdit":
    case "NotebookEdit":
      return "write_file";
    case "WebFetch":
    case "WebSearch":
      return "navigate";
    default:
      return undefined;
  }
}

function describeFile(path: string): {
  path: string;
  name: string;
  extension: string;
} {
  if (!path) return { path: "", name: "", extension: "" };
  const name = path.split("/").pop() ?? "";
  const dot = name.lastIndexOf(".");
  return {
    path,
    name,
    extension: dot > 0 ? name.slice(dot + 1).toLowerCase() : "",
  };
}
