#!/usr/bin/env bun
/**
 * `slice` — the local Mac shape, no web app and no Docker required.
 *
 * One machine, everything in Apple `container` VMs except the server itself: PostgreSQL in a VM
 * with a persistent volume, the supervisor on the host driving the Apple backend, the API server
 * on the host bound to loopback. The web app is optional; `slice chat` talks to the same API the
 * browser would.
 *
 * State lives in ~/.slice: the generated secrets, logs, and nothing else. The database is a
 * container volume; the computers' workspaces are container volumes; deleting ~/.slice loses only
 * configuration.
 *
 * Commands:
 *   slice init                 write ~/.slice/slice.env with generated secrets and the slice budget
 *   slice up                   start postgres VM, migrations, supervisor, server
 *   slice down                 stop them
 *   slice status               what is running, and the slice's capacity
 *   slice agents               the coworkers this deployment has
 *   slice chat <bot> <text>    one governed turn, streamed to the terminal
 *   slice audit [n]            the latest audit rows
 */

import { parseArgs } from "node:util";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { describeCall, executeTool, TOOL_DEFINITIONS } from "./computer-tools";

const HOME = join(homedir(), ".slice");
const ENV_FILE = join(HOME, "slice.env");
const LOGS = join(HOME, "logs");
const REPO = resolve(import.meta.dir, "..");

const SERVER_PORT = 3001;
const SUPERVISOR_PORT = 4600;
const POSTGRES_PORT = 5433;
const POSTGRES_VM = "slice-postgres";
const POSTGRES_VOLUME = "slice-pgdata";
const POSTGRES_IMAGE = "docker.io/pgvector/pgvector:pg17";
const DATABASE_URL = `postgres://slice:slice@127.0.0.1:${POSTGRES_PORT}/slice`;

function fail(message: string): never {
  console.error(`\x1b[31m${message}\x1b[0m`);
  process.exit(1);
}

function info(message: string) {
  console.log(`\x1b[2m${message}\x1b[0m`);
}

async function sh(
  cmd: string[],
  opts: { env?: Record<string, string>; cwd?: string } = {},
): Promise<{ code: number; stdout: string; stderr: string }> {
  const proc = Bun.spawn(cmd, {
    cwd: opts.cwd ?? REPO,
    env: { ...process.env, ...opts.env },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { code, stdout, stderr };
}

function loadEnv(): Record<string, string> {
  if (!existsSync(ENV_FILE)) {
    fail(`No ${ENV_FILE}. Run \`slice init\` first.`);
  }
  const env: Record<string, string> = {};
  for (const line of readFileSync(ENV_FILE, "utf8").split("\n")) {
    const match = line.match(/^([A-Z0-9_]+)=(.*)$/);
    if (match?.[1] && match[2] !== undefined) env[match[1]] = match[2];
  }
  return env;
}

async function answering(url: string): Promise<boolean> {
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(2_000) });
    return response.ok;
  } catch {
    return false;
  }
}

async function waitFor(url: string, what: string, seconds = 60): Promise<void> {
  for (let i = 0; i < seconds * 2; i++) {
    if (await answering(url)) {
      info(`  ${what} ready`);
      return;
    }
    await Bun.sleep(500);
  }
  fail(`${what} never became ready at ${url}. Logs: ${LOGS}`);
}

function randomSecret(): string {
  return Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString(
    "base64",
  );
}

// ---------------------------------------------------------------- commands --

async function init(args: string[]) {
  const { values } = parseArgs({
    args,
    options: {
      cpus: { type: "string", default: "4" },
      "memory-gb": { type: "string", default: "8" },
      force: { type: "boolean", default: false },
    },
  });
  if (existsSync(ENV_FILE) && !values.force) {
    fail(`${ENV_FILE} already exists. Pass --force to regenerate secrets.`);
  }
  mkdirSync(LOGS, { recursive: true });
  const cpus = Number(values.cpus);
  const memoryGb = Number(values["memory-gb"]);
  if (!Number.isFinite(cpus) || cpus <= 0) fail("--cpus must be positive");
  if (!Number.isFinite(memoryGb) || memoryGb <= 0) {
    fail("--memory-gb must be positive");
  }

  const lines = [
    "# Written by `slice init`. Secrets are local to this machine.",
    `SLICE_CPUS=${cpus}`,
    `SLICE_MEMORY_BYTES=${memoryGb * 1024 ** 3}`,
    `SUPERVISOR_TOKEN=${randomSecret()}`,
    `COMPUTER_TOKEN=${randomSecret()}`,
    `KEY_ENCRYPTION_KEY=${randomSecret()}`,
    `MANAGED_AGENT_TOKEN=${randomSecret()}`,
    "OPENBOT_SINGLE_USER=true",
    "COMPUTER_NAMESPACE=slice",
    `DATABASE_URL=${DATABASE_URL}`,
    "TENANT_PACKAGE_DIR=../examples/fintech",
    "# Model access. Either set a key here or add one in the vault later.",
    "OPENAI_API_KEY=",
    "# For OpenAI-compatible providers (Z.ai, OpenRouter, vLLM, Ollama):",
    "OPENAI_COMPATIBLE_BASE_URL=",
    "OPENAI_BASE_URL=",
    "# The managed harness (Claude Code) reaches its model through an Anthropic-compatible endpoint.",
    "# Z.ai's coding plan: https://api.z.ai/api/anthropic. Leave empty for Anthropic itself.",
    "HARNESS_ANTHROPIC_BASE_URL=",
    "",
  ];
  writeFileSync(ENV_FILE, lines.join("\n"), { mode: 0o600 });
  console.log(`Wrote ${ENV_FILE}`);
  console.log(
    `Slice: ${cpus} cores / ${memoryGb} GiB dedicated to agents on this Mac.`,
  );
  console.log("Add a model key to that file (or the vault), then: slice up");
}

async function ensurePostgres(_env: Record<string, string>) {
  const list = await sh(["container", "list", "--all", "--format", "json"]);
  const vms = JSON.parse(list.stdout || "[]") as Array<{
    configuration?: { id?: string };
    status?: { state?: string };
  }>;
  const existing = vms.find((vm) => vm.configuration?.id === POSTGRES_VM);
  if (existing?.status?.state === "running") {
    info("  postgres already running");
    return;
  }
  if (existing) await sh(["container", "delete", POSTGRES_VM]);
  await sh(["container", "volume", "create", POSTGRES_VOLUME]);
  const run = await sh([
    "container",
    "run",
    "--detach",
    "--name",
    POSTGRES_VM,
    "--cpus",
    "1",
    "--memory",
    "1024M",
    "--volume",
    `${POSTGRES_VOLUME}:/var/lib/postgresql/data`,
    "--publish",
    `127.0.0.1:${POSTGRES_PORT}:5432`,
    "--env",
    "POSTGRES_USER=slice",
    "--env",
    "POSTGRES_PASSWORD=slice",
    "--env",
    "POSTGRES_DB=slice",
    // A container volume mounts with a lost+found, and initdb refuses a non-empty mount point.
    "--env",
    "PGDATA=/var/lib/postgresql/data/pgdata",
    POSTGRES_IMAGE,
  ]);
  if (run.code !== 0) {
    fail(`postgres VM failed to start: ${run.stderr.trim()}`);
  }
  // Postgres has no HTTP health; wait for the TCP port to accept.
  for (let i = 0; i < 120; i++) {
    const probe = await sh([
      "container",
      "exec",
      POSTGRES_VM,
      "pg_isready",
      "-U",
      "slice",
    ]);
    if (probe.code === 0) {
      info("  postgres ready");
      return;
    }
    await Bun.sleep(500);
  }
  fail("postgres VM never became ready");
}

async function up() {
  const env = loadEnv();
  mkdirSync(LOGS, { recursive: true });

  info("1/4 container services");
  const status = await sh(["container", "system", "status"]);
  if (status.code !== 0) {
    const started = await sh(["container", "system", "start"]);
    if (started.code !== 0) fail("`container system start` failed");
  }

  info("2/4 postgres");
  await ensurePostgres();
  const migrate = await sh(["bun", "run", "db:migrate"], {
    cwd: join(REPO, "server"),
    env: { DATABASE_URL: env.DATABASE_URL ?? DATABASE_URL },
  });
  if (migrate.code !== 0) {
    fail(`migrations failed:\n${migrate.stderr.slice(-800)}`);
  }
  info("  migrations applied");

  info("3/4 supervisor (apple backend)");
  if (!(await answering(`http://127.0.0.1:${SUPERVISOR_PORT}/health`))) {
    Bun.spawn(["bun", join(REPO, "supervisor/src/index.ts")], {
      cwd: join(REPO, "supervisor"),
      env: {
        ...process.env,
        ...env,
        PORT: String(SUPERVISOR_PORT),
        COMPUTER_BACKEND: "apple",
        // Computers reach this server on the VM bridge; the harness reaches its model as the
        // deployment configured, never from anything baked into the image.
        COMPUTER_SERVER_URL: `http://192.168.64.1:${SERVER_PORT}`,
        ...(env.OPENAI_API_KEY
          ? { HARNESS_ANTHROPIC_AUTH_TOKEN: env.OPENAI_API_KEY }
          : {}),
        ...(env.HARNESS_ANTHROPIC_BASE_URL
          ? { HARNESS_ANTHROPIC_BASE_URL: env.HARNESS_ANTHROPIC_BASE_URL }
          : {}),
        ...(env.HARNESS_OPENAI_BASE_URL
          ? { HARNESS_OPENAI_BASE_URL: env.HARNESS_OPENAI_BASE_URL }
          : {}),
      },
      stdout: Bun.file(join(LOGS, "supervisor.log")),
      stderr: Bun.file(join(LOGS, "supervisor.log")),
    }).unref();
  }
  await waitFor(`http://127.0.0.1:${SUPERVISOR_PORT}/health`, "supervisor");

  info("4/4 server");
  if (!(await answering(`http://127.0.0.1:${SERVER_PORT}/api/capabilities`))) {
    Bun.spawn(["bun", join(REPO, "server/src/index.ts")], {
      cwd: join(REPO, "server"),
      env: {
        ...process.env,
        ...env,
        PORT: String(SERVER_PORT),
        COMPUTER_SUPERVISOR_URL: `http://127.0.0.1:${SUPERVISOR_PORT}`,
        // The Apple VM bridge, so the harness policy hook inside a computer can ask this server.
        OPENBOT_COMPUTER_BIND: "192.168.64.1",
      },
      stdout: Bun.file(join(LOGS, "server.log")),
      stderr: Bun.file(join(LOGS, "server.log")),
    }).unref();
  }
  await waitFor(
    `http://127.0.0.1:${SERVER_PORT}/api/capabilities`,
    "server",
    90,
  );

  console.log("\nSlice is up.");
  console.log(`  API      http://127.0.0.1:${SERVER_PORT}  (loopback only)`);
  console.log(`  chat     slice chat general-assistant "hello"`);
  console.log(`  audit    slice audit`);
  console.log(`  logs     ${LOGS}`);
}

async function down() {
  await sh(["pkill", "-f", "supervisor/src/index.ts"]);
  await sh(["pkill", "-f", "server/src/index.ts"]);
  await sh(["container", "stop", POSTGRES_VM]);
  const list = await sh(["container", "list", "--format", "json"]);
  const vms = JSON.parse(list.stdout || "[]") as Array<{
    configuration?: { id?: string; labels?: Record<string, string> };
  }>;
  for (const vm of vms) {
    if (vm.configuration?.labels?.["openbot.supervisor"] === "true") {
      const id = vm.configuration?.id;
      if (id) await sh(["container", "stop", id]);
    }
  }
  console.log(
    "Stopped. Workspaces, browser profiles and the database are volumes and survive.",
  );
}

async function statusCmd() {
  const env = loadEnv();
  const parts: Array<[string, string, boolean]> = [
    ["server", `http://127.0.0.1:${SERVER_PORT}/api/capabilities`, false],
    ["supervisor", `http://127.0.0.1:${SUPERVISOR_PORT}/health`, false],
  ];
  for (const part of parts) part[2] = await answering(part[1]);
  const pg = await sh(["container", "exec", POSTGRES_VM, "pg_isready"]);
  console.log(`postgres    ${pg.code === 0 ? "up" : "down"}`);
  for (const [name, , ok] of parts) {
    console.log(`${name.padEnd(11)} ${ok ? "up" : "down"}`);
  }
  if (parts[1]?.[2]) {
    const capacity = await fetch(
      `http://127.0.0.1:${SUPERVISOR_PORT}/v1/capacity`,
      { headers: { authorization: `Bearer ${env.SUPERVISOR_TOKEN}` } },
    ).then((r) => r.json() as Promise<Record<string, unknown>>);
    const used = capacity.used as
      | { cpus: number; memoryBytes: number }
      | undefined;
    const budget = capacity.budget as
      | { cpus?: number; memoryBytes?: number }
      | undefined;
    if (!used || !budget) {
      console.log(
        `slice       unavailable (${(capacity.error as string) ?? "no capacity report"})`,
      );
    } else {
      console.log(
        `slice       ${used.cpus}/${budget.cpus ?? "∞"} cores, ${(
          used.memoryBytes / 1024 ** 3
        ).toFixed(1)}/${
          budget.memoryBytes ? (budget.memoryBytes / 1024 ** 3).toFixed(0) : "∞"
        } GiB, ${((capacity.computers as unknown[]) ?? []).length} computer(s)`,
      );
    }
  }
}

async function agents() {
  const info_ = await fetch(
    `http://127.0.0.1:${SERVER_PORT}/api/copilotkit/info`,
  ).then((r) => r.json() as Promise<{ agents: Record<string, unknown> }>);
  for (const id of Object.keys(info_.agents)) console.log(id);
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

type PendingCall = { id: string; name: string; arguments: string };

/**
 * One run: stream the Bot's events to the terminal and collect the tool calls it made. Returns the
 * assistant text and the calls, so the caller can execute them and start the next run — the same
 * loop the web page runs, which is what makes the terminal a surface rather than a shortcut.
 */
async function runOnce(
  api: string,
  bot: string,
  threadId: string,
  messages: Message[],
): Promise<{ text: string; calls: PendingCall[] }> {
  const response = await fetch(
    `${api}/api/copilotkit/agent/${encodeURIComponent(bot)}/run`,
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
    },
  );
  if (!response.ok || !response.body) {
    fail(`run failed: ${response.status} ${await response.text()}`);
  }
  const decoder = new TextDecoder();
  let buffer = "";
  let text = "";
  const calls: PendingCall[] = [];
  for await (const chunk of response.body) {
    buffer += decoder.decode(chunk, { stream: true });
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
      switch (event.type) {
        case "TEXT_MESSAGE_CONTENT":
          if (event.delta) {
            text += event.delta;
            process.stdout.write(event.delta);
          }
          break;
        case "TOOL_CALL_START":
          if (event.toolCallId && event.toolCallName) {
            // Only the tools this terminal offers are its to execute. Anything else — a managed
            // harness's own Bash or Edit, a server-side MCP tool — is activity to show, not a
            // call to answer.
            if (
              TOOL_DEFINITIONS.some((tool) => tool.name === event.toolCallName)
            ) {
              calls.push({
                id: event.toolCallId,
                name: event.toolCallName,
                arguments: "",
              });
            } else {
              process.stdout.write(
                `\x1b[2m  · ${event.toolCallName.replace(/^harness_/, "")}\x1b[0m\n`,
              );
            }
          }
          break;
        case "TOOL_CALL_ARGS": {
          const call = calls.find((c) => c.id === event.toolCallId);
          if (call && event.delta) call.arguments += event.delta;
          break;
        }
        case "RUN_ERROR":
          fail(`\nrun error: ${event.message}`);
      }
    }
  }
  return { text, calls };
}

async function chat(args: string[]) {
  const { values, positionals } = parseArgs({
    args,
    allowPositionals: true,
    options: { thread: { type: "string" } },
  });
  const [bot, ...rest] = positionals;
  const text = rest.join(" ");
  if (!bot || !text) fail('Usage: slice chat [--thread <id>] <bot> "message"');
  const api = `http://127.0.0.1:${SERVER_PORT}`;
  // A thread is a conversation. Without --thread each command starts a new one; with it, the Bot
  // picks up where that thread left off, exactly as a channel does in the web app.
  const mint = values.thread
    ? { threadId: values.thread }
    : await fetch(`${api}/api/threads/mint`, { method: "POST" }).then(
        (r) => r.json() as Promise<{ threadId: string }>,
      );
  const messages: Message[] = [
    { id: crypto.randomUUID(), role: "user", content: text },
  ];

  // The tool loop: a run that ends in tool calls is followed by one carrying their results, until
  // the Bot answers in words. Capped so a Bot going in circles is a bounded cost.
  for (let turn = 0; turn < 25; turn++) {
    const result = await runOnce(api, bot, mint.threadId, messages);
    if (result.calls.length === 0) break;
    if (result.text) process.stdout.write("\n");
    messages.push({
      id: crypto.randomUUID(),
      role: "assistant",
      content: result.text,
      toolCalls: result.calls.map((call) => ({
        id: call.id,
        type: "function",
        function: { name: call.name, arguments: call.arguments || "{}" },
      })),
    });
    for (const call of result.calls) {
      let parsed: Record<string, unknown> = {};
      try {
        parsed = JSON.parse(call.arguments || "{}");
      } catch {}
      process.stdout.write(
        `\x1b[2m  → ${describeCall(call.name, parsed)}\x1b[0m`,
      );
      const outcome = await executeTool(api, bot, call.name, parsed);
      const refused =
        typeof outcome === "object" &&
        outcome !== null &&
        (outcome as { refused?: boolean }).refused === true;
      process.stdout.write(refused ? "  \x1b[31mrefused\x1b[0m\n" : "\n");
      messages.push({
        id: crypto.randomUUID(),
        role: "tool",
        toolCallId: call.id,
        content: JSON.stringify(outcome),
      });
    }
  }
  process.stdout.write("\n");
  process.stderr.write(`\x1b[2mthread ${mint.threadId}\x1b[0m\n`);
}

async function audit(args: string[]) {
  const limit = Number(args[0] ?? "15");
  const rows = await fetch(
    `http://127.0.0.1:${SERVER_PORT}/api/admin/audit-events?limit=${limit}`,
  ).then(
    (r) =>
      r.json() as Promise<{
        events: Array<{
          createdAt: string;
          eventType: string;
          targetId: string | null;
          payload?: Record<string, unknown>;
        }>;
      }>,
  );
  for (const event of rows.events ?? []) {
    console.log(
      `${event.createdAt}  ${event.eventType.padEnd(28)} ${event.targetId ?? ""}`,
    );
  }
}

// ---------------------------------------------------------------- the mesh --

async function nodesCmd() {
  const report = await fetch(
    `http://127.0.0.1:${SERVER_PORT}/api/admin/nodes`,
  ).then(
    (r) =>
      r.json() as Promise<{
        nodes: Array<{
          id: string;
          name: string;
          backend: string;
          reachable: boolean;
          placementEnabled: boolean;
          capacity: {
            used?: { cpus: number; memoryBytes: number };
            budget?: { cpus?: number; memoryBytes?: number };
            computers?: unknown[];
          } | null;
          error?: string;
        }>;
      }>,
  );
  for (const node of report.nodes) {
    const used = node.capacity?.used;
    const budget = node.capacity?.budget;
    const use = used
      ? `${used.cpus}/${budget?.cpus ?? "∞"} cores, ${(used.memoryBytes / 1024 ** 3).toFixed(1)}/${budget?.memoryBytes ? (budget.memoryBytes / 1024 ** 3).toFixed(0) : "∞"} GiB, ${node.capacity?.computers?.length ?? 0} computer(s)`
      : node.reachable
        ? "no capacity report"
        : `unreachable: ${node.error ?? ""}`;
    console.log(
      `${node.id.padEnd(14)} ${node.name.padEnd(22)} ${node.backend.padEnd(18)} ${node.placementEnabled ? "open  " : "closed"} ${use}`,
    );
  }
}

/** Mint a one-time enrollment token here, for `slice node join` on the machine joining. */
async function nodeToken() {
  const minted = await fetch(
    `http://127.0.0.1:${SERVER_PORT}/api/admin/nodes/enrollment-tokens`,
    { method: "POST" },
  ).then((r) => r.json() as Promise<{ token: string; expiresAt: string }>);
  console.log(minted.token);
  console.error(
    `\x1b[2mValid until ${minted.expiresAt}, single use. On the node:\n  slice node join <server-url> ${minted.token} --supervisor-url http://<tailnet-ip>:4600\x1b[0m`,
  );
}

/**
 * Join this machine to a deployment elsewhere. Runs on the node: its supervisor must already be up
 * (`slice up` starts one) and reachable from the server at --supervisor-url.
 */
async function nodeJoin(args: string[]) {
  const { values, positionals } = parseArgs({
    args,
    allowPositionals: true,
    options: {
      "supervisor-url": { type: "string" },
      id: { type: "string" },
      name: { type: "string" },
      backend: { type: "string", default: "apple" },
      "supervisor-token": { type: "string" },
    },
  });
  const [server, token] = positionals;
  if (!server || !token) {
    fail(
      "Usage: slice node join <server-url> <token> --supervisor-url <url> [--id slug] [--name text] [--backend apple|docker]",
    );
  }
  // Run on the node, the supervisor token is this machine's own; run from the server on a node's
  // behalf, it is passed in. Either way it goes to the server once and is stored encrypted there.
  const supervisorToken =
    values["supervisor-token"] ??
    (existsSync(ENV_FILE) ? loadEnv().SUPERVISOR_TOKEN : undefined);
  if (!supervisorToken) {
    fail(
      "--supervisor-token is required when this machine has no ~/.slice/slice.env.",
    );
  }
  const supervisorUrl = values["supervisor-url"];
  if (!supervisorUrl)
    fail(
      "--supervisor-url is required: where the server reaches this node's supervisor.",
    );
  const id =
    values.id ??
    (await sh(["hostname", "-s"])).stdout
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9-]/g, "-")
      .slice(0, 40);
  const response = await fetch(
    `${server.replace(/\/$/, "")}/api/nodes/enroll`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        token,
        id,
        name: values.name ?? id,
        supervisorUrl,
        supervisorToken,
        backend: values.backend,
      }),
    },
  );
  const body = (await response.json().catch(() => ({}))) as {
    error?: string;
    node?: { id: string };
  };
  if (!response.ok) fail(`enrolment refused: ${body.error ?? response.status}`);
  console.log(`Joined ${server} as node "${body.node?.id ?? id}".`);
}

async function moveCmd(args: string[]) {
  const [bot, node] = args;
  if (!bot || !node) fail("Usage: slice move <bot> <node-id|local>");
  const response = await fetch(
    `http://127.0.0.1:${SERVER_PORT}/api/admin/computers/${encodeURIComponent(bot)}/move`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ nodeId: node }),
    },
  );
  const body = (await response.json().catch(() => ({}))) as {
    error?: string;
    from?: string;
    to?: string;
    bytes?: number;
  };
  if (!response.ok) fail(`move refused: ${body.error ?? response.status}`);
  console.log(
    `Moved ${bot}: ${body.from} → ${body.to} (${body.bytes} bytes of workspace and browser profile).`,
  );
}

// -------------------------------------------------------------------- main --

const [command, ...rest] = process.argv.slice(2);
switch (command) {
  case "init":
    await init(rest);
    break;
  case "up":
    await up();
    break;
  case "down":
    await down();
    break;
  case "status":
    await statusCmd();
    break;
  case "agents":
    await agents();
    break;
  case "chat":
    await chat(rest);
    break;
  case "audit":
    await audit(rest);
    break;
  case "nodes":
    await nodesCmd();
    break;
  case "node":
    if (rest[0] === "token") await nodeToken();
    else if (rest[0] === "join") await nodeJoin(rest.slice(1));
    else
      fail(
        "Usage: slice node token | slice node join <server-url> <token> --supervisor-url <url>",
      );
    break;
  case "move":
    await moveCmd(rest);
    break;
  default:
    console.log(`slice — a personal agent control plane, on this Mac

  slice init [--cpus 4] [--memory-gb 8]   dedicate a slice of this Mac to agents
  slice up                                start everything (VMs for postgres and computers)
  slice down                              stop everything; volumes survive
  slice status                            what is running, and the slice's use
  slice agents                            list coworkers
  slice chat [--thread id] <bot> "..."    one governed turn; --thread continues a conversation
  slice audit [n]                         the latest audit rows
  slice nodes                             every machine in the mesh, with capacity
  slice node token                        mint a one-time enrollment token (run here)
  slice node join <server> <token> ...    join this machine to a deployment (run on the node)
  slice move <bot> <node|local>           carry a Bot's computer to another node`);
    process.exit(command ? 1 : 0);
}
