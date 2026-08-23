/**
 * The harness registry: one adapter per engine, all reduced to the same three questions.
 *
 * A managed harness is a coding agent driven headless in the computer. An adapter answers: how to
 * invoke it for a turn (argv + files it needs written), how to turn its output stream into the AG-UI
 * events the channel understands, and how it is governed — the mechanism by which every tool it
 * wants to use is decided by the deployment first. The mechanism differs (Claude Code's PreToolUse
 * hook, Pi's extension, OpenCode's plugin) but the destination is one route: the server's
 * /api/harness/:bot/decide.
 *
 * The adapter never talks to the network and never decides anything itself. It shapes a process and
 * parses its bytes; harness.ts runs it and the /decide route rules.
 */

export type Emit = (event: Record<string, unknown>) => void;

export type InvokeContext = {
  prompt: string;
  standing: string;
  resume: string | undefined;
  workspaceDir: string;
  stateDir: string;
  /** Absolute paths to the governance files the image ships, for adapters that reference them. */
  hooks: {
    claudeSettings: string; // written per run
    piExtension: string; // /opt/slice/pi-slice.mjs
    opencodeConfig: string; // written per run
  };
  /** The model this run uses, and where it lives (for the OpenAI-compatible harnesses). */
  model: {
    id: string;
    /** Provider name the config registers this endpoint under. */
    provider: string;
  };
};

export type Invocation = {
  argv: string[];
  /** Extra environment for the child, merged over the harness's own. */
  env?: Record<string, string>;
};

export type Adapter = {
  id: string;
  /** The binary, for the availability check. */
  binary: string;
  /**
   * True when the engine has no reliable terminal event in its stream, so a clean process exit is
   * the run's end. OpenCode is like this; harness.ts emits RUN_FINISHED on exit 0 for these.
   */
  finishOnExit?: boolean;
  /** How a run is started. */
  invoke: (context: InvokeContext) => Invocation;
  /**
   * Turn one line of the harness's stdout into AG-UI events. `remember` records a session id when
   * the line carries one, so the next turn can resume. Returns true once the run's terminal event
   * has been emitted, so harness.ts knows not to synthesise an error on exit.
   */
  parse: (
    line: string,
    emit: Emit,
    remember: (sessionId: string) => void,
  ) => boolean;
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

function textMessage(emit: Emit, text: string) {
  const messageId = crypto.randomUUID();
  emit({ type: "TEXT_MESSAGE_START", messageId, role: "assistant" });
  emit({ type: "TEXT_MESSAGE_CONTENT", messageId, delta: text });
  emit({ type: "TEXT_MESSAGE_END", messageId });
}

function toolCall(emit: Emit, name: string, id: string, input: unknown) {
  emit({
    type: "TOOL_CALL_START",
    toolCallId: id,
    toolCallName: `harness_${name}`,
  });
  emit({
    type: "TOOL_CALL_ARGS",
    toolCallId: id,
    delta: JSON.stringify(input ?? {}),
  });
  emit({ type: "TOOL_CALL_END", toolCallId: id });
}

function toolResult(emit: Emit, id: string, content: unknown) {
  emit({
    type: "TOOL_CALL_RESULT",
    messageId: crypto.randomUUID(),
    toolCallId: id,
    content: textOf(content) || JSON.stringify(content ?? ""),
    role: "tool",
  });
}

function usage(emit: Emit, value: Record<string, unknown>) {
  emit({ type: "CUSTOM", name: "harness_usage", value });
}

// ---- Claude Code -------------------------------------------------------------------------------

const claudeCode: Adapter = {
  id: "claude-code",
  binary: "claude",
  invoke: ({ prompt, standing, resume, hooks }) => ({
    argv: [
      "-p",
      prompt,
      "--output-format",
      "stream-json",
      "--verbose",
      "--dangerously-skip-permissions",
      "--settings",
      hooks.claudeSettings,
      ...(resume ? ["--resume", resume] : []),
      ...(standing ? ["--append-system-prompt", standing] : []),
    ],
    env: { IS_SANDBOX: "1" },
  }),
  parse: (line, emit, remember) => {
    let event: Record<string, unknown>;
    try {
      event = JSON.parse(line);
    } catch {
      return false;
    }
    if (event.type === "system" && event.subtype === "init") {
      if (typeof event.session_id === "string") remember(event.session_id);
      return false;
    }
    if (event.type === "assistant" || event.type === "user") {
      const message = event.message as { content?: unknown[] } | undefined;
      for (const block of message?.content ?? []) {
        const part = block as Record<string, unknown>;
        if (part.type === "text" && typeof part.text === "string") {
          textMessage(emit, part.text);
        } else if (part.type === "tool_use") {
          toolCall(
            emit,
            String(part.name ?? "tool"),
            String(part.id ?? crypto.randomUUID()),
            part.input,
          );
        } else if (part.type === "tool_result") {
          toolResult(emit, String(part.tool_use_id ?? ""), part.content);
        }
      }
      return false;
    }
    if (event.type === "result") {
      if (event.is_error) {
        emit({
          type: "RUN_ERROR",
          message: String(event.result ?? "The harness reported an error."),
        });
      } else {
        usage(emit, {
          costUsd: event.total_cost_usd ?? null,
          turns: event.num_turns ?? null,
          durationMs: event.duration_ms ?? null,
        });
        emit({ type: "RUN_FINISHED" });
      }
      return true;
    }
    return false;
  },
};

// ---- Pi ----------------------------------------------------------------------------------------

const pi: Adapter = {
  id: "pi",
  binary: "pi",
  invoke: ({ prompt, standing, resume, hooks, model }) => ({
    argv: [
      "-p",
      "--mode",
      "json",
      "--extension",
      hooks.piExtension,
      "--provider",
      model.provider,
      "--model",
      model.id,
      ...(resume ? ["--session", resume] : []),
      ...(standing ? ["--append-system-prompt", standing] : []),
      prompt,
    ],
  }),
  parse: (line, emit, remember) => {
    let event: Record<string, unknown>;
    try {
      event = JSON.parse(line);
    } catch {
      return false;
    }
    if (event.type === "session" && typeof event.id === "string") {
      remember(event.id);
      return false;
    }
    if (event.type === "message_end") {
      const message = event.message as
        | { role?: string; content?: unknown[] }
        | undefined;
      if (message?.role === "assistant") {
        for (const block of message.content ?? []) {
          const part = block as Record<string, unknown>;
          if (part.type === "text" && typeof part.text === "string") {
            textMessage(emit, part.text);
          } else if (part.type === "toolCall") {
            toolCall(
              emit,
              String(part.name ?? "tool"),
              String(part.id ?? crypto.randomUUID()),
              part.arguments,
            );
          }
        }
      } else if (message?.role === "toolResult") {
        toolResult(
          emit,
          String((message as { toolCallId?: unknown }).toolCallId ?? ""),
          message.content,
        );
      }
      return false;
    }
    if (event.type === "agent_end") {
      const u = event.usage as Record<string, unknown> | undefined;
      usage(emit, { totalTokens: u?.totalTokens ?? null });
      emit({ type: "RUN_FINISHED" });
      return true;
    }
    if (event.type === "error") {
      emit({
        type: "RUN_ERROR",
        message: String(event.message ?? "The harness reported an error."),
      });
      return true;
    }
    return false;
  },
};

// ---- OpenCode ----------------------------------------------------------------------------------

const opencode: Adapter = {
  id: "opencode",
  binary: "opencode",
  finishOnExit: true,
  invoke: ({ prompt, resume, model }) => ({
    // The standing message rides in the prompt: opencode run has no system-prompt flag, and the
    // profile's role is short. Session continuity is by id.
    argv: [
      "run",
      "--format",
      "json",
      "-m",
      `${model.provider}/${model.id}`,
      ...(resume ? ["--session", resume] : []),
      prompt,
    ],
  }),
  parse: (line, emit, remember) => {
    let event: Record<string, unknown>;
    try {
      event = JSON.parse(line);
    } catch {
      return false;
    }
    const sessionID = event.sessionID;
    if (typeof sessionID === "string") remember(sessionID);
    const part = event.part as Record<string, unknown> | undefined;
    if (event.type === "text" && part && typeof part.text === "string") {
      textMessage(emit, part.text);
      return false;
    }
    if (event.type === "tool_use" && part) {
      const state = part.state as Record<string, unknown> | undefined;
      const id = String(part.callID ?? crypto.randomUUID());
      toolCall(emit, String(part.tool ?? "tool"), id, state?.input ?? {});
      if (state?.output !== undefined) toolResult(emit, id, state.output);
      return false;
    }
    if (event.type === "error" || event.type === "session_error") {
      emit({
        type: "RUN_ERROR",
        message: String(
          (part as { error?: unknown } | undefined)?.error ??
            "The harness reported an error.",
        ),
      });
      return true;
    }
    return false;
  },
};

const ADAPTERS: Record<string, Adapter> = {
  "claude-code": claudeCode,
  pi,
  opencode,
};

export function adapterFor(id: string): Adapter | undefined {
  return ADAPTERS[id];
}

export function adapterIds(): string[] {
  return Object.keys(ADAPTERS);
}
