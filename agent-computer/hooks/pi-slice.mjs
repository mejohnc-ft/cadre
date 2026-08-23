/**
 * Pi extension: ask the deployment before any tool runs.
 *
 * The same contract as the Claude Code hook (slice-hook.sh): the intended call goes to the
 * server's gateway, which evaluates the deployment's boundaries and writes the audit row.
 * Anything but an explicit yes blocks, with the reason handed back to the model. Fails closed.
 *
 * Loaded per run with `pi --extension /opt/slice/pi-slice.mjs`; reads the same SLICE_* variables
 * the harness adapter sets.
 */
export default function slice(pi) {
  pi.on("tool_call", async (event) => {
    const server = process.env.SLICE_SERVER_URL;
    const bot = process.env.SLICE_BOT_ID;
    if (!server || !bot) {
      return {
        block: true,
        reason:
          "Refused by Slice: this computer has no route to the deployment's policy, so no tool may run.",
      };
    }
    let answer;
    try {
      const response = await fetch(
        `${server.replace(/\/$/, "")}/api/harness/${encodeURIComponent(bot)}/decide`,
        {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "x-openbot-computer-token": process.env.SLICE_COMPUTER_TOKEN ?? "",
            "x-openbot-run-id": process.env.SLICE_RUN_ID ?? "",
          },
          body: JSON.stringify({
            // Pi's tool names are lower-case; the gateway sees them as Claude Code's for one
            // set of rules across harnesses: harness_Bash, harness_Edit, harness_Read…
            tool_name: canonical(event.toolName),
            tool_input: inputFor(event.toolName, event.input ?? {}),
            harness: "pi",
          }),
          signal: AbortSignal.timeout(15_000),
        },
      );
      answer = await response.json();
    } catch (error) {
      return {
        block: true,
        reason: `Refused by Slice: the deployment's policy could not be reached (${error?.message ?? error}), so the action was not allowed.`,
      };
    }
    if (answer && answer.allowed === true) return undefined;
    return {
      block: true,
      reason: `Refused by Slice policy: ${answer?.reason ?? answer?.error ?? "Refused by policy."}`,
    };
  });
}

function canonical(name) {
  switch (name) {
    case "bash":
      return "Bash";
    case "read":
      return "Read";
    case "edit":
      return "Edit";
    case "write":
      return "Write";
    case "grep":
      return "Grep";
    case "find":
    case "ls":
      return "Glob";
    default:
      return name.charAt(0).toUpperCase() + name.slice(1);
  }
}

/** Map Pi's inputs onto the field names the gateway reads: `command`, `file_path`. */
function inputFor(_name, input) {
  const out = { ...input };
  if (typeof input.path === "string" && !out.file_path)
    out.file_path = input.path;
  return out;
}
