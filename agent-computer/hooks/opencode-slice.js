/**
 * OpenCode plugin: ask the deployment before any tool runs.
 *
 * Same contract as the Claude Code hook and the Pi extension: the intended call goes to the
 * server's gateway; anything but an explicit yes throws, which OpenCode treats as the tool being
 * refused and reports to the model. Fails closed.
 *
 * Referenced from the per-run OpenCode config (`plugin: ["/opt/slice/opencode-slice.js"]`).
 */
export const SlicePolicy = async () => ({
  "tool.execute.before": async (input, output) => {
    const server = process.env.SLICE_SERVER_URL;
    const bot = process.env.SLICE_BOT_ID;
    if (!server || !bot) {
      throw new Error(
        "Refused by Slice: this computer has no route to the deployment's policy, so no tool may run.",
      );
    }
    const args = output?.args ?? {};
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
            tool_name: canonical(input.tool),
            tool_input: {
              ...args,
              ...(typeof args.filePath === "string"
                ? { file_path: args.filePath }
                : {}),
            },
            session_id: input.sessionID,
            harness: "opencode",
          }),
          signal: AbortSignal.timeout(15_000),
        },
      );
      answer = await response.json();
    } catch (error) {
      throw new Error(
        `Refused by Slice: the deployment's policy could not be reached (${error?.message ?? error}), so the action was not allowed.`,
      );
    }
    if (answer && answer.allowed === true) return;
    throw new Error(
      `Refused by Slice policy: ${answer?.reason ?? answer?.error ?? "Refused by policy."}`,
    );
  },
});

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
    case "glob":
    case "list":
      return "Glob";
    case "webfetch":
      return "WebFetch";
    default:
      return name.charAt(0).toUpperCase() + name.slice(1);
  }
}
