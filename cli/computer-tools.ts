/**
 * The computer tools, as the terminal offers them.
 *
 * In the web app these are frontend tools: the page declares them on every run, the model calls
 * one, the run ends, the page executes it against `/api/computers/:bot/...` and starts the next run
 * with the result. The CLI is another surface doing exactly that. It offers the same names with
 * the same parameters, executes them against the same routes — so the gateway, the policy and the
 * audit row are exactly where they were — and the Bot cannot tell which surface it is on.
 *
 * Two tools the page has are not offered here: `computer_request_help` and
 * `computer_request_secret` hand the browser to a person, which needs a screen. A Bot without them
 * says what it needs instead of asking for a takeover nobody can answer.
 *
 * The descriptions are the web app's, verbatim, because they are what the Bots were tuned against.
 * Keep them in step with app/src/lib/copilot/computer-tools.tsx.
 */

export type ToolDefinition = {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
};

type Route = { method: "GET" | "POST"; path: string };

const string = (description: string) => ({ type: "string", description });
const number = (description: string) => ({ type: "number", description });
const boolean = (description: string) => ({ type: "boolean", description });

function schema(
  properties: Record<string, unknown>,
  required: string[] = [],
): Record<string, unknown> {
  return { type: "object", properties, required, additionalProperties: false };
}

const TOOLS: Array<ToolDefinition & { route: Route }> = [
  {
    name: "computer_navigate",
    description:
      "Open a web page on your own computer so the person can watch. Use this when asked to look " +
      "at, visit, open or check a website. Returns the page title and its readable text, so answer " +
      "from what comes back rather than telling the person to go and look.",
    parameters: schema(
      { url: string("Full web address to open, including https://") },
      ["url"],
    ),
    route: { method: "POST", path: "/navigate" },
  },
  {
    name: "computer_read",
    description:
      "Read the page currently open on your computer, without opening anything. Use this after you " +
      "click something that changes the page, such as submitting a form, to find out what it now says.",
    parameters: schema({}),
    route: { method: "GET", path: "/read" },
  },
  {
    name: "computer_snapshot",
    description:
      "List the things on the current page you can act on: fields, buttons, links and checkboxes, " +
      "each with a ref, its label and its current value. Call this BEFORE clicking or typing, and " +
      "use the refs it returns. Always send back the snapshotId it gives you. If an action reports " +
      "that your refs are stale, the page changed: call this again and use the new refs.",
    parameters: schema({}),
    route: { method: "POST", path: "/snapshot" },
  },
  {
    name: "computer_type",
    description:
      "Enter text into a field on the page. Give the ref of the field from your most recent " +
      "snapshot and the snapshotId it came from. This replaces whatever the field already contains. " +
      "Set submit to true to press Enter afterwards.",
    parameters: schema(
      {
        ref: string("Ref of the field, from your most recent snapshot"),
        snapshotId: number("The snapshotId that ref came from"),
        text: string("The text to enter"),
        submit: boolean(
          "Press Enter after typing, to submit a single-field form",
        ),
      },
      ["ref", "snapshotId", "text"],
    ),
    route: { method: "POST", path: "/type" },
  },
  {
    name: "computer_click",
    description:
      "Click something on the page: a button, a link, a checkbox or a radio option. Give the ref " +
      "from your most recent snapshot and the snapshotId it came from.",
    parameters: schema(
      {
        ref: string(
          "Ref of the element to click, from your most recent snapshot",
        ),
        snapshotId: number("The snapshotId that ref came from"),
      },
      ["ref", "snapshotId"],
    ),
    route: { method: "POST", path: "/click" },
  },
  {
    name: "computer_key",
    description:
      "Press a key, such as Enter, Tab or Escape. Give a ref to press it while a particular field " +
      "is focused, or omit the ref to press it on the page.",
    parameters: schema(
      {
        key: string("Key name, such as Enter, Tab or Escape"),
        ref: string("Optional ref to press the key on"),
        snapshotId: number(
          "The snapshotId the ref came from, required if ref is given",
        ),
      },
      ["key"],
    ),
    route: { method: "POST", path: "/key" },
  },
  {
    name: "computer_scroll",
    description:
      "Scroll the page down, or up with a negative amount, to bring more of a long page into view.",
    parameters: schema({
      deltaY: number("Pixels to scroll; positive is down. Defaults to 600."),
    }),
    route: { method: "POST", path: "/scroll" },
  },
  {
    name: "computer_list_files",
    description:
      "List what is in your workspace: every file and folder you have saved, with sizes. Call this " +
      "FIRST when you are asked what files you have, or before reading a file whose exact name you " +
      "are not sure of. Never guess a filename.",
    parameters: schema({
      path: string("Optional folder to list. Omit for the whole workspace."),
    }),
    route: { method: "POST", path: "/files/list" },
  },
  {
    name: "computer_read_file",
    description:
      "Read a file you saved earlier in your own workspace. Paths are relative to your workspace, " +
      "such as notes.md or reports/august.csv. Your workspace survives between conversations, so use " +
      "this to pick up notes you made before.",
    parameters: schema(
      { path: string("Path relative to your workspace, such as notes.md") },
      ["path"],
    ),
    route: { method: "POST", path: "/files/read" },
  },
  {
    name: "computer_write_file",
    description:
      "Save a file in your own workspace so you still have it later. Paths are relative to your " +
      "workspace and folders are created as needed. Set append to true to add to the end of an " +
      "existing file rather than replacing it. Text only.",
    parameters: schema(
      {
        path: string(
          "Path relative to your workspace, such as reports/august.csv",
        ),
        contents: string("The text to save"),
        append: boolean("Add to the end of the file instead of replacing it"),
      },
      ["path", "contents"],
    ),
    route: { method: "POST", path: "/files/write" },
  },
  {
    name: "computer_run_command",
    description:
      "Run a shell command on your own computer. Use this for anything the browser cannot do: " +
      "installing a tool you need, processing a file you saved, running a script. The working " +
      "directory is your workspace, so paths are relative to it and files you write here are the " +
      "same ones the file tools see. Commands run in bash, so pipes and && work. Long output is " +
      "truncated from the start, and a command that runs too long is stopped. " +
      "You are not the root user, so anything that writes outside your workspace needs sudo, " +
      "which asks for no password: installing a package is " +
      "`sudo apt-get update && sudo apt-get install -y <package>`. If sudo is refused, this " +
      "computer does not grant it, so say so rather than retrying.",
    parameters: schema(
      {
        command: string(
          "The command to run, such as: sudo apt-get install -y jq",
        ),
      },
      ["command"],
    ),
    route: { method: "POST", path: "/exec" },
  },
];

export const TOOL_DEFINITIONS: ToolDefinition[] = TOOLS.map(
  ({ name, description, parameters }) => ({ name, description, parameters }),
);

/** One line for the terminal about what a call did. */
export function describeCall(name: string, args: Record<string, unknown>) {
  switch (name) {
    case "computer_navigate":
      return `open ${args.url}`;
    case "computer_snapshot":
      return "read the page";
    case "computer_read":
      return "read the page text";
    case "computer_click":
      return `click ${args.ref}`;
    case "computer_type":
      return `type into ${args.ref}`;
    case "computer_key":
      return `press ${args.key}`;
    case "computer_scroll":
      return "scroll";
    case "computer_list_files":
      return `list ${args.path ?? "workspace"}`;
    case "computer_read_file":
      return `read ${args.path}`;
    case "computer_write_file":
      return `write ${args.path}`;
    case "computer_run_command":
      return `$ ${args.command}`;
    default:
      return name;
  }
}

/**
 * Execute one tool call against the server, exactly as the page would. The result is whatever the
 * gateway answered — allowed, refused with the rule named, or failed — serialised for the model.
 */
export async function executeTool(
  api: string,
  botId: string,
  name: string,
  args: Record<string, unknown>,
): Promise<unknown> {
  const tool = TOOLS.find((candidate) => candidate.name === name);
  if (!tool) {
    return {
      ok: false,
      reason: `The terminal does not offer a tool named ${name}.`,
    };
  }
  try {
    const response = await fetch(
      `${api}/api/computers/${encodeURIComponent(botId)}${tool.route.path}`,
      {
        method: tool.route.method,
        headers:
          tool.route.method === "POST"
            ? { "content-type": "application/json" }
            : {},
        body: tool.route.method === "POST" ? JSON.stringify(args) : undefined,
      },
    );
    const body = await response.json().catch(() => null);
    if (body !== null) return body;
    return { ok: response.ok, status: response.status };
  } catch (error) {
    return {
      ok: false,
      reason: `The computer could not be reached: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}
