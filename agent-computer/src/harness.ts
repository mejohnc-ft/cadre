import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  type Adapter,
  adapterFor,
  adapterIds,
  type Emit,
} from "./harness-adapters";

/**
 * A managed harness inside the computer: a coding agent — Claude Code, Pi, OpenCode — driven
 * headless, speaking AG-UI out.
 *
 * The server sees an AG-UI endpoint like any other Bot's. Behind it, each run is one headless
 * process in this computer's workspace, resumed from the session the thread had last time, with the
 * profile's standing message as its system prompt. Its output stream is turned into AG-UI events by
 * the harness's adapter (harness-adapters.ts); this file runs the process and does not know one
 * engine from another.
 *
 * Governance does not move: every tool the harness wants to use passes through the harness's own
 * interception mechanism to the server's gateway (/api/harness/:bot/decide), which decides and
 * records it, and refuses on anything but a yes. Claude Code uses a PreToolUse hook, Pi an
 * extension, OpenCode a plugin — all three call the same route with the same secret.
 *
 * Which engine a Bot runs is chosen per request (the server sets it from the profile); absent, the
 * deployment default. Session ids live in the workspace, so a thread survives a computer being
 * replaced or moved.
 */

export type HarnessOptions = {
  workspaceDir: string;
  serverUrl?: string;
  computerToken: string;
  defaultHarness?: string;
};

type AgUiMessage = { id?: string; role?: string; content?: unknown };
type Artifact = { kind: string; name: string; content: string };
type RunModel = {
  kind?: string;
  baseUrl?: string | null;
  model?: string;
  key?: string;
};
type RunInput = {
  threadId: string;
  runId: string;
  harness?: string;
  messages?: AgUiMessage[];
  artifacts?: Artifact[];
  model?: RunModel;
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
  const stateDir = join(options.workspaceDir, ".slice");
  const sessionsDir = join(stateDir, "harness-sessions");
  mkdirSync(sessionsDir, { recursive: true });

  const key = (threadId: string, harness: string) =>
    safe(`${harness}-${threadId}`);

  function sessionFor(threadId: string, harness: string): string | undefined {
    try {
      return readFileSync(
        join(sessionsDir, key(threadId, harness)),
        "utf8",
      ).trim();
    } catch {
      return undefined;
    }
  }

  function remember(threadId: string, harness: string, sessionId: string) {
    writeFileSync(join(sessionsDir, key(threadId, harness)), sessionId);
  }

  function claudeSettingsFile(): string {
    const path = join(stateDir, "harness-claude-settings.json");
    writeFileSync(
      path,
      JSON.stringify({
        hooks: {
          PreToolUse: [
            {
              matcher: "",
              hooks: [{ type: "command", command: "/opt/slice/hook.sh" }],
            },
          ],
        },
      }),
    );
    return path;
  }

  // Where a run's model lives: the route the server sent, else the deployment environment. The
  // image carries none of it.
  const provider = "slice";

  function modelSettings(run?: RunModel) {
    return {
      modelId: run?.model || process.env.HARNESS_MODEL || "glm-5.3",
      openaiBase:
        (run?.kind?.startsWith("openai") ? run.baseUrl : undefined) ||
        process.env.HARNESS_OPENAI_BASE_URL ||
        "",
      anthropicBase:
        (run?.kind?.startsWith("anthropic") ? run.baseUrl : undefined) ||
        process.env.HARNESS_ANTHROPIC_BASE_URL ||
        "",
      apiKey: run?.key || process.env.HARNESS_ANTHROPIC_AUTH_TOKEN || "",
    };
  }

  function opencodeConfigFile(
    settings: ReturnType<typeof modelSettings>,
  ): string {
    const path = join(stateDir, "harness-opencode.json");
    writeFileSync(
      path,
      JSON.stringify({
        $schema: "https://opencode.ai/config.json",
        plugin: ["/opt/slice/opencode-slice.js"],
        permission: { edit: "allow", bash: "allow", webfetch: "allow" },
        provider: {
          [provider]: {
            npm: "@ai-sdk/openai-compatible",
            name: "Slice",
            options: { baseURL: settings.openaiBase, apiKey: settings.apiKey },
            models: { [settings.modelId]: { name: settings.modelId } },
          },
        },
      }),
    );
    return path;
  }

  function piModelsFile(settings: ReturnType<typeof modelSettings>): void {
    const dir = join(process.env.HOME ?? "/root", ".pi", "agent");
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, "models.json"),
      JSON.stringify({
        providers: {
          [provider]: {
            baseUrl: settings.openaiBase,
            api: "openai-completions",
            apiKey: settings.apiKey,
            models: [
              {
                id: settings.modelId,
                name: settings.modelId,
                reasoning: true,
                input: ["text"],
                contextWindow: 200000,
                maxTokens: 16000,
              },
            ],
          },
        },
      }),
    );
  }

  function run(botId: string, input: RunInput): Response {
    const harnessId = input.harness || options.defaultHarness || "claude-code";
    const adapter = adapterFor(harnessId);
    const messages = input.messages ?? [];
    const lastUser = [...messages].reverse().find((m) => m.role === "user");
    const prompt = textOf(lastUser?.content).trim();
    const standing = messages
      .filter((m) => m.role === "system")
      .map((m) => textOf(m.content))
      .join("\n\n")
      .trim();

    const encoder = new TextEncoder();
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        const send: Emit = (event) =>
          controller.enqueue(
            encoder.encode(`data: ${JSON.stringify(event)}\n\n`),
          );
        const stamped = (event: Record<string, unknown>) =>
          send({ ...event, threadId: input.threadId, runId: input.runId });
        const finish = () => controller.close();

        stamped({ type: "RUN_STARTED" });
        if (!adapter) {
          stamped({
            type: "RUN_ERROR",
            message: `This computer has no harness named "${harnessId}". It has: ${adapterIds().join(", ")}.`,
          });
          finish();
          return;
        }
        if (!prompt) {
          stamped({
            type: "RUN_ERROR",
            message: "The run carried no user message.",
          });
          finish();
          return;
        }

        const settings = modelSettings(input.model);
        if (adapter.id === "pi") piModelsFile(settings);
        projectArtifacts(
          options.workspaceDir,
          adapter.id,
          input.artifacts ?? [],
        );

        const invocation = adapter.invoke({
          prompt,
          standing,
          resume: sessionFor(input.threadId, adapter.id),
          workspaceDir: options.workspaceDir,
          stateDir,
          hooks: {
            claudeSettings: claudeSettingsFile(),
            piExtension: "/opt/slice/pi-slice.mjs",
            opencodeConfig: opencodeConfigFile(settings),
          },
          model: { id: settings.modelId, provider },
        });

        const proc = Bun.spawn([adapter.binary, ...invocation.argv], {
          cwd: options.workspaceDir,
          env: {
            ...process.env,
            HOME: process.env.HOME ?? "/root",
            SLICE_BOT_ID: botId,
            SLICE_RUN_ID: input.runId,
            SLICE_COMPUTER_TOKEN: options.computerToken,
            ...(options.serverUrl
              ? { SLICE_SERVER_URL: options.serverUrl }
              : {}),
            ...(harnessId === "opencode"
              ? { OPENCODE_CONFIG: opencodeConfigFile(settings) }
              : {}),
            ...harnessModelEnv(harnessId, settings),
            ...invocation.env,
          },
          stdin: "ignore",
          stdout: "pipe",
          stderr: "pipe",
        });

        let finished = false;
        let buffer = "";
        const decoder = new TextDecoder();

        const onLine = (line: string) => {
          if (
            adapter.parse(line, stamped, (id) =>
              remember(input.threadId, adapter.id, id),
            )
          ) {
            finished = true;
          }
        };

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
              for (const line of lines) if (line.trim()) onLine(line);
            }
            if (buffer.trim()) onLine(buffer);
          } catch {}
          const code = await proc.exited;
          await drainStderr;
          if (!finished) {
            if (adapter.finishOnExit && code === 0) {
              stamped({ type: "RUN_FINISHED" });
            } else {
              stamped({
                type: "RUN_ERROR",
                message: `The harness exited with code ${code}${stderrTail.trim() ? `: ${stderrTail.trim().slice(-400)}` : ""}.`,
              });
            }
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

  async function available(): Promise<{
    ok: boolean;
    harnesses: Array<{ id: string; version: string | null }>;
  }> {
    const harnesses: Array<{ id: string; version: string | null }> = [];
    for (const id of adapterIds()) {
      const adapter = adapterFor(id) as Adapter;
      harnesses.push({ id, version: await versionOf(adapter.binary) });
    }
    return { ok: harnesses.some((h) => h.version !== null), harnesses };
  }

  return { run, available };
}

function harnessModelEnv(
  harnessId: string,
  settings: { anthropicBase: string; apiKey: string; modelId: string },
): Record<string, string> {
  const env: Record<string, string> = {};
  if (settings.anthropicBase) env.ANTHROPIC_BASE_URL = settings.anthropicBase;
  if (settings.apiKey) {
    env.ANTHROPIC_AUTH_TOKEN = settings.apiKey;
    env.OPENAI_API_KEY = settings.apiKey;
  }
  if (settings.modelId && harnessId === "claude-code") {
    env.ANTHROPIC_MODEL = settings.modelId;
  }
  if (harnessId === "claude-code") env.IS_SANDBOX = "1";
  return env;
}

async function versionOf(binary: string): Promise<string | null> {
  try {
    const proc = Bun.spawn([binary, "--version"], {
      stdout: "pipe",
      stderr: "pipe",
    });
    const version = (await new Response(proc.stdout).text()).trim();
    return (await proc.exited) === 0 ? version : null;
  } catch {
    return null;
  }
}

/**
 * Write a profile's artifacts into the computer's workspace before the engine starts.
 *
 * One instructions artifact projects to the file the engine reads on its own — CLAUDE.md for
 * Claude Code, AGENTS.md for Pi and OpenCode — so a coworker's role is written once and honoured by
 * whichever harness runs it. Skills land under .slice/skills; harness settings and mcp configs are
 * left to the per-run config the adapters already write. Overwritten each run, so editing an
 * artifact takes effect on the next turn.
 */
function projectArtifacts(
  workspaceDir: string,
  harnessId: string,
  artifacts: Artifact[],
): void {
  const instructionsFile =
    harnessId === "claude-code" ? "CLAUDE.md" : "AGENTS.md";
  const skillsDir = join(workspaceDir, ".slice", "skills");
  for (const artifact of artifacts) {
    try {
      if (artifact.kind === "instructions") {
        writeFileSync(join(workspaceDir, instructionsFile), artifact.content);
      } else if (artifact.kind === "skill") {
        mkdirSync(skillsDir, { recursive: true });
        writeFileSync(
          join(skillsDir, `${safe(artifact.name)}.md`),
          artifact.content,
        );
      }
    } catch {
      // A single unwritable artifact should not fail the run.
    }
  }
}

function safe(value: string): string {
  return value.replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 120);
}
