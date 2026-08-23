import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/**
 * A managed harness inside the computer: Claude Code, driven headless, speaking AG-UI out.
 *
 * The server sees an AG-UI endpoint like any other Bot's. Behind it, each run is one
 * `claude -p` process in this computer's workspace, resumed from the session the thread had
 * last time, with the profile's standing message as an appended system prompt. Its stream-json
 * output becomes AG-UI events: text blocks are messages, tool uses and their results are tool
 * calls, the final result closes the run.
 *
 * Governance does not move: every tool the harness wants to use passes through a PreToolUse hook
 * that asks the server's gateway first (see hooks/slice-hook.sh) and refuses on anything but a
 * yes. The harness runs with permissions "skipped" only in the sense that Claude Code's own
 * prompts are off; the deployment's policy is on, and it fails closed.
 *
 * Session ids live in the workspace, so a thread survives a computer being replaced or moved.
 */

export type HarnessOptions = {
  workspaceDir: string;
  /** Where the server is reached from inside this computer, for the policy hook. */
  serverUrl?: string;
  computerToken: string;
  /** The claude binary. */
  binary?: string;
};

type AgUiMessage = { id?: string; role?: string; content?: unknown };
type RunInput = {
  threadId: string;
  runId: string;
  messages?: AgUiMessage[];
  forwardedProps?: Record<string, unknown>;
};

function textOf(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((part) =>
        typeof part === "string"
          ? part
          : typeof (part as { text?: unknown })?.text === "string"
            ? ((part as { text: string }).text as string)
            : "",
      )
      .join("");
  }
  return "";
}

export function createHarness(options: HarnessOptions) {
  const binary = options.binary ?? "claude";
  const stateDir = join(options.workspaceDir, ".slice");
  const sessionsDir = join(stateDir, "harness-sessions");
  mkdirSync(sessionsDir, { recursive: true });

  function sessionFor(threadId: string): string | undefined {
    try {
      return readFileSync(join(sessionsDir, safe(threadId)), "utf8").trim();
    } catch {
      return undefined;
    }
  }

  function remember(threadId: string, sessionId: string) {
    writeFileSync(join(sessionsDir, safe(threadId)), sessionId);
  }

  /** Claude Code's settings for this computer: every tool goes through the policy hook. */
  function settingsFile(): string {
    const path = join(stateDir, "harness-settings.json");
    writeFileSync(
      path,
      JSON.stringify(
        {
          hooks: {
            PreToolUse: [
              {
                matcher: "",
                hooks: [{ type: "command", command: "/opt/slice/hook.sh" }],
              },
            ],
          },
        },
        null,
        2,
      ),
    );
    return path;
  }

  function run(botId: string, input: RunInput): Response {
    const messages = input.messages ?? [];
    const lastUser = [...messages].reverse().find((m) => m.role === "user");
    const prompt = textOf(lastUser?.content).trim();
    const standing = messages
      .filter((m) => m.role === "system")
      .map((m) => textOf(m.content))
      .join("\n\n")
      .trim();
    const resume = sessionFor(input.threadId);

    const encoder = new TextEncoder();
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        const send = (event: Record<string, unknown>) =>
          controller.enqueue(
            encoder.encode(`data: ${JSON.stringify(event)}\n\n`),
          );
        const finish = () => controller.close();

        send({
          type: "RUN_STARTED",
          threadId: input.threadId,
          runId: input.runId,
        });
        if (!prompt) {
          send({
            type: "RUN_ERROR",
            message: "The run carried no user message.",
          });
          finish();
          return;
        }

        const args = [
          "-p",
          prompt,
          "--output-format",
          "stream-json",
          "--verbose",
          "--dangerously-skip-permissions",
          "--settings",
          settingsFile(),
          ...(resume ? ["--resume", resume] : []),
          ...(standing ? ["--append-system-prompt", standing] : []),
        ];
        const proc = Bun.spawn([binary, ...args], {
          cwd: options.workspaceDir,
          env: {
            ...process.env,
            IS_SANDBOX: "1",
            HOME: process.env.HOME ?? "/root",
            SLICE_BOT_ID: botId,
            SLICE_RUN_ID: input.runId,
            SLICE_COMPUTER_TOKEN: options.computerToken,
            ...(options.serverUrl
              ? { SLICE_SERVER_URL: options.serverUrl }
              : {}),
            // The model, from the deployment's provider settings, not from this image.
            ...(process.env.HARNESS_ANTHROPIC_BASE_URL
              ? { ANTHROPIC_BASE_URL: process.env.HARNESS_ANTHROPIC_BASE_URL }
              : {}),
            ...(process.env.HARNESS_ANTHROPIC_AUTH_TOKEN
              ? {
                  ANTHROPIC_AUTH_TOKEN:
                    process.env.HARNESS_ANTHROPIC_AUTH_TOKEN,
                }
              : {}),
            ...(process.env.HARNESS_MODEL
              ? { ANTHROPIC_MODEL: process.env.HARNESS_MODEL }
              : {}),
          },
          stdin: "ignore",
          stdout: "pipe",
          stderr: "pipe",
        });

        let finished = false;
        let buffer = "";
        const decoder = new TextDecoder();
        const pending = new Map<string, string>(); // tool_use id → name

        const handle = (line: string) => {
          let event: Record<string, unknown>;
          try {
            event = JSON.parse(line);
          } catch {
            return;
          }
          const type = event.type;
          if (type === "system" && event.subtype === "init") {
            if (typeof event.session_id === "string") {
              remember(input.threadId, event.session_id);
            }
            return;
          }
          if (type === "assistant" || type === "user") {
            const message = event.message as
              | { content?: unknown[] }
              | undefined;
            for (const block of message?.content ?? []) {
              const part = block as Record<string, unknown>;
              if (part.type === "text" && typeof part.text === "string") {
                const messageId = crypto.randomUUID();
                send({
                  type: "TEXT_MESSAGE_START",
                  messageId,
                  role: "assistant",
                });
                send({
                  type: "TEXT_MESSAGE_CONTENT",
                  messageId,
                  delta: part.text,
                });
                send({ type: "TEXT_MESSAGE_END", messageId });
              } else if (part.type === "tool_use") {
                const toolCallId = String(part.id ?? crypto.randomUUID());
                const toolCallName = `harness_${String(part.name ?? "tool")}`;
                pending.set(toolCallId, toolCallName);
                send({ type: "TOOL_CALL_START", toolCallId, toolCallName });
                send({
                  type: "TOOL_CALL_ARGS",
                  toolCallId,
                  delta: JSON.stringify(part.input ?? {}),
                });
                send({ type: "TOOL_CALL_END", toolCallId });
              } else if (part.type === "tool_result") {
                const toolCallId = String(part.tool_use_id ?? "");
                send({
                  type: "TOOL_CALL_RESULT",
                  messageId: crypto.randomUUID(),
                  toolCallId,
                  content:
                    textOf(part.content) || JSON.stringify(part.content ?? ""),
                  role: "tool",
                });
                pending.delete(toolCallId);
              }
            }
            return;
          }
          if (type === "result") {
            finished = true;
            if (event.is_error) {
              send({
                type: "RUN_ERROR",
                message: String(
                  event.result ?? "The harness reported an error.",
                ),
              });
            } else {
              send({
                type: "CUSTOM",
                name: "harness_usage",
                value: {
                  costUsd: event.total_cost_usd ?? null,
                  turns: event.num_turns ?? null,
                  durationMs: event.duration_ms ?? null,
                },
              });
              send({
                type: "RUN_FINISHED",
                threadId: input.threadId,
                runId: input.runId,
              });
            }
          }
        };

        // Stderr is drained as it comes, keeping the tail: a pipe nobody reads fills, and a
        // process writing to a full pipe stops — which is a run that never ends.
        let stderrTail = "";
        const drainStderr = (async () => {
          const reader = proc.stderr.getReader();
          try {
            for (;;) {
              const { done, value } = await reader.read();
              if (done) break;
              stderrTail = (stderrTail + decoder.decode(value)).slice(-4000);
            }
          } catch {}
        })();

        (async () => {
          const reader = proc.stdout.getReader();
          try {
            for (;;) {
              const { done, value } = await reader.read();
              if (done) break;
              buffer += decoder.decode(value, { stream: true });
              const lines = buffer.split("\n");
              buffer = lines.pop() ?? "";
              for (const line of lines) if (line.trim()) handle(line);
            }
            if (buffer.trim()) handle(buffer);
          } catch {}
          const code = await proc.exited;
          await drainStderr;
          if (!finished) {
            send({
              type: "RUN_ERROR",
              message: `The harness exited with code ${code}${stderrTail.trim() ? `: ${stderrTail.trim().slice(-400)}` : ""}.`,
            });
          }
          finish();
        })();
      },
    });

    return new Response(stream, {
      headers: {
        "content-type": "text/event-stream",
        "cache-control": "no-cache",
        connection: "keep-alive",
      },
    });
  }

  async function available(): Promise<{ ok: boolean; version?: string }> {
    try {
      const proc = Bun.spawn([binary, "--version"], { stdout: "pipe" });
      const version = (await new Response(proc.stdout).text()).trim();
      return (await proc.exited) === 0 ? { ok: true, version } : { ok: false };
    } catch {
      return { ok: false };
    }
  }

  return { run, available };
}

function safe(threadId: string): string {
  return threadId.replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 120);
}
