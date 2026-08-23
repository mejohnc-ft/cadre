import {
  ComputerNotAnsweringError,
  type ComputerState,
  type EnsureOptions,
  reservationOf,
} from "./docker";
import {
  BOT_LABEL,
  type ComputerNames,
  NAMESPACE,
  NAMESPACE_LABEL,
  OWNER_LABEL,
} from "./names";

/**
 * The Apple runtime: one lightweight virtual machine per computer.
 *
 * Backed by Apple's `container` CLI (Containerization.framework). The same OCI image the Docker
 * backend runs becomes a VM with its own kernel, which is the isolation story the Docker path
 * approximates with gVisor. The seam is the same verbs the Docker module exports — ensure, stop,
 * reset, list, reachable — so the HTTP layer chooses a backend and changes nothing else.
 *
 * Shelling out rather than a daemon socket, because that is the product surface Apple ships. Every
 * name that reaches a command line came out of `namesFor`, which is the same derivation the Docker
 * path trusts, and everything acted on is first checked to carry the supervisor's labels — `stop`
 * on a name somebody else owns refuses exactly as the Docker path does.
 *
 * Ports: a VM's computer answers on 4100 inside; a loopback host port is published at creation so
 * the server reaches it exactly as it reaches a Docker computer. The port is chosen free at bind
 * time and then read back from the runtime's listing, never remembered — a supervisor restart must
 * rediscover, not assume.
 */

export class ComputerNotFoundError extends Error {
  constructor(container: string) {
    super(
      `${container} is not a running computer of this supervisor. Ensure it first.`,
    );
    this.name = "ComputerNotFoundError";
  }
}

export class AppleContainerUnavailableError extends Error {
  constructor(cause: string) {
    super(
      `The supervisor could not use Apple container services (${cause}). Run \`container system start\` on this Mac.`,
    );
    this.name = "AppleContainerUnavailableError";
  }
}

type RunResult = { code: number; stdout: string; stderr: string };

async function run(args: string[]): Promise<RunResult> {
  const proc = Bun.spawn(["container", ...args], {
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

async function runOrThrow(args: string[]): Promise<string> {
  const result = await run(args);
  if (result.code !== 0) {
    throw new AppleContainerUnavailableError(
      `\`container ${args.slice(0, 2).join(" ")}\` failed: ${result.stderr.trim() || result.stdout.trim()}`,
    );
  }
  return result.stdout;
}

/** The listing entry shape this module reads. Only the fields acted on are typed. */
type ListedVm = {
  configuration?: {
    id?: string;
    labels?: Record<string, string>;
    publishedPorts?: Array<{
      containerPort?: number;
      hostAddress?: string;
      hostPort?: number;
    }>;
    resources?: { cpus?: number; memoryInBytes?: number };
  };
  status?: { state?: string; startedDate?: string };
};

function ours(labels: Record<string, string> | undefined): boolean {
  if (labels?.[OWNER_LABEL] !== "true") return false;
  return (labels[NAMESPACE_LABEL] ?? NAMESPACE) === NAMESPACE;
}

function portOf(vm: ListedVm): number | undefined {
  const published = vm.configuration?.publishedPorts?.find(
    (port) => port.containerPort === 4100,
  );
  return published?.hostPort;
}

function publishHostOf(vm: ListedVm): string {
  const published = vm.configuration?.publishedPorts?.find(
    (port) => port.containerPort === 4100,
  );
  const host = published?.hostAddress;
  return host && host !== "0.0.0.0" ? host : "127.0.0.1";
}

function stateOf(vm: ListedVm): ComputerState {
  const labels = vm.configuration?.labels;
  const port = portOf(vm);
  const reservation = reservationOf(labels);
  return {
    botId: labels?.[BOT_LABEL] ?? "unknown",
    container: vm.configuration?.id ?? "unknown",
    status: vm.status?.state ?? "unknown",
    ...(reservation ? { reservation } : {}),
    ...(port ? { port, url: `http://${publishHostOf(vm)}:${port}` } : {}),
    ...(vm.status?.startedDate ? { startedAt: vm.status.startedDate } : {}),
  };
}

async function listAll(): Promise<ListedVm[]> {
  const stdout = await runOrThrow(["list", "--all", "--format", "json"]);
  try {
    return JSON.parse(stdout) as ListedVm[];
  } catch {
    throw new AppleContainerUnavailableError(
      "`container list` returned something that is not JSON",
    );
  }
}

export async function reachable(): Promise<boolean> {
  return (await run(["system", "status"])).code === 0;
}

/** Every computer VM this supervisor owns, and only those. */
export async function listOwned(): Promise<ComputerState[]> {
  return (await listAll())
    .filter((vm) => ours(vm.configuration?.labels))
    .map(stateOf);
}

async function findOwned(names: ComputerNames): Promise<ListedVm | undefined> {
  return (await listAll()).find(
    (vm) =>
      vm.configuration?.id === names.container &&
      ours(vm.configuration?.labels),
  );
}

/**
 * A free loopback port, chosen by binding it. Released before use, which is a race on paper; the
 * window is milliseconds on a machine whose other port users are this supervisor's own computers.
 */
function freePort(): number {
  const listener = Bun.listen({
    hostname: "127.0.0.1",
    port: 0,
    socket: { data() {} },
  });
  const port = listener.port;
  listener.stop(true);
  return port;
}

async function waitUntilAnswering(
  port: number,
  timeoutMs: number,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/health`, {
        signal: AbortSignal.timeout(2_000),
      });
      if (response.ok) return;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new ComputerNotAnsweringError(`VM on port ${port}`, timeoutMs);
}

async function ensureVolume(name: string): Promise<void> {
  const result = await run(["volume", "create", name]);
  // Existing volume is the desired state, not an error. Anything else is.
  if (result.code !== 0 && !/exists/i.test(result.stderr + result.stdout)) {
    throw new AppleContainerUnavailableError(
      `volume create ${name} failed: ${result.stderr.trim()}`,
    );
  }
}

/** VM boot plus a cold Chromium is slower than a warm Docker container; give it more room. */
const DEFAULT_READY_TIMEOUT_MS = 120_000;

export async function ensure(
  names: ComputerNames,
  options: EnsureOptions,
): Promise<ComputerState> {
  const readyTimeoutMs = options.readyTimeoutMs ?? DEFAULT_READY_TIMEOUT_MS;
  const existing = await findOwned(names);

  if (existing && existing.status?.state === "running") {
    const state = stateOf(existing);
    if (state.port) {
      await waitUntilAnswering(state.port, readyTimeoutMs);
      return state;
    }
    // Running with no published port is unreachable by construction; rebuild it.
    await run(["stop", names.container]);
    await run(["delete", names.container]);
  } else if (existing) {
    // A stopped VM's published port is remembered in its configuration; starting it back up
    // republished nothing in testing, so the reliable path is a fresh create over the same volumes.
    await run(["delete", names.container]);
  }

  await ensureVolume(names.workspaceVolume);
  await ensureVolume(names.profileVolume);

  const port = freePort();
  const memoryMi = Math.max(
    256,
    Math.round((options.memoryBytes ?? 2 * 1024 ** 3) / 1024 ** 2),
  );
  const cpus = Math.max(1, Math.ceil(options.cpus ?? 1));

  const labels: Record<string, string> = {
    [OWNER_LABEL]: "true",
    [BOT_LABEL]: names.botId,
    [NAMESPACE_LABEL]: NAMESPACE,
    ...(options.cpus ? { "openbot.cpus": String(options.cpus) } : {}),
    ...(options.memoryBytes
      ? { "openbot.memory-bytes": String(options.memoryBytes) }
      : {}),
  };

  const args = [
    "run",
    "--detach",
    "--name",
    names.container,
    "--cpus",
    String(cpus),
    "--memory",
    `${memoryMi}M`,
    ...Object.entries(labels).flatMap(([key, value]) => [
      "--label",
      `${key}=${value}`,
    ]),
    "--volume",
    `${names.workspaceVolume}:/workspace`,
    "--volume",
    `${names.profileVolume}:/profiles`,
    "--publish",
    `${options.publishHost ?? "127.0.0.1"}:${port}:4100`,
    ...options.environment.flatMap((entry) => ["--env", entry]),
    options.image,
  ];
  await runOrThrow(args);
  await waitUntilAnswering(port, readyTimeoutMs);

  const created = await findOwned(names);
  return created
    ? stateOf(created)
    : {
        botId: names.botId,
        container: names.container,
        status: "running",
        port,
        url: `http://127.0.0.1:${port}`,
      };
}

export async function stop(names: ComputerNames): Promise<boolean> {
  const existing = await findOwned(names);
  if (existing?.status?.state !== "running") return false;
  await runOrThrow(["stop", names.container]);
  return true;
}

/** Remove the VM and the browser profile; keep the workspace, exactly as the Docker path does. */
export async function reset(names: ComputerNames): Promise<boolean> {
  const existing = await findOwned(names);
  if (existing) {
    await run(["stop", names.container]);
    await run(["delete", names.container]);
  }
  const volume = await run(["volume", "delete", names.profileVolume]);
  return existing !== undefined || volume.code === 0;
}

/** Run a command in a computer VM as the supervisor. See the Docker module's `exec` for the role. */
export async function exec(
  names: ComputerNames,
  argv: string[],
  stdin?: Uint8Array,
): Promise<{ exitCode: number; stdout: Uint8Array; stderr: string }> {
  const existing = await findOwned(names);
  if (existing?.status?.state !== "running") {
    throw new ComputerNotFoundError(names.container);
  }
  const proc = Bun.spawn(
    [
      "container",
      "exec",
      ...(stdin !== undefined ? ["--interactive"] : []),
      names.container,
      ...argv,
    ],
    {
      stdin: stdin !== undefined ? "pipe" : "ignore",
      stdout: "pipe",
      stderr: "pipe",
    },
  );
  if (stdin !== undefined && proc.stdin) {
    proc.stdin.write(stdin);
    proc.stdin.end();
  }
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).arrayBuffer(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { exitCode, stdout: new Uint8Array(stdout), stderr };
}
