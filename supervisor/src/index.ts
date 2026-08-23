import { serve } from "bun";
import type { Context } from "hono";
import { Hono } from "hono";
import * as apple from "./apple";
import {
  AppleContainerUnavailableError,
  ComputerNotFoundError as AppleComputerNotFoundError,
} from "./apple";
import * as dockerBackend from "./docker";
import {
  ComputerNotAnsweringError,
  ComputerNotFoundError,
  DockerUnavailableError,
  NameHeldError,
} from "./docker";
import { registerEntry } from "./identity";
import { namesFor } from "./names";
import { exportBundle, importBundle } from "./transfer";
import {
  admit,
  budgetFromEnvironment,
  capacity,
  countsAgainstBudget,
  reservationFromEnvironment,
  SliceExhaustedError,
} from "./slice";

/**
 * The container supervisor: the only thing here that holds the Docker socket.
 *
 * Giving a Bot its own container requires something to create containers. Access to the Docker
 * socket is root-equivalent on the host because a container can be started with the host filesystem
 * bound into it. Putting that in the API server would mean every bug in a request handler, every
 * injection through a Bot's own output and every dependency in a large tree sits one mistake away
 * from owning the machine.
 *
 * So the socket lives behind four verbs, expressed in Bots rather than in Docker: ensure a computer
 * for this Bot, stop it, reset it, list them. There is no passthrough and no way to name a container
 * directly, names are derived from the Bot id, which is validated first. A compromised API server
 * can ask for a Bot's computer to be restarted. It cannot ask for anything else, because nothing
 * else is expressible.
 *
 * The shared secret is not the boundary; the vocabulary is. `SUPERVISOR_TOKEN` keeps other
 * processes on the same network from driving it, but even with the token the worst available action
 * is cycling a computer that already belongs to a Bot.
 *
 * Refusing to start without it matches the computer. This process holds the Docker socket, which is
 * root on the host, so missing authentication is a deployment failure.
 */

const port = Number.parseInt(process.env.PORT ?? "4300", 10);
const token = process.env.SUPERVISOR_TOKEN?.trim();
if (!token) {
  console.error(
    "SUPERVISOR_TOKEN is not set. This process holds the Docker socket and will not start without the secret its caller must present.",
  );
  process.exit(1);
}
/**
 * Which runtime makes computers: `docker` (containers, optionally gVisor) or `apple` (one
 * lightweight VM per computer via Apple's `container` CLI, macOS on Apple silicon). The verbs are
 * identical; nothing above this line knows which is running.
 */
const backendName = (process.env.COMPUTER_BACKEND ?? "docker").trim();
if (backendName !== "docker" && backendName !== "apple") {
  console.error(
    `COMPUTER_BACKEND must be "docker" or "apple", not "${backendName}".`,
  );
  process.exit(1);
}
const backend =
  backendName === "apple"
    ? {
        ensure: apple.ensure,
        stop: apple.stop,
        reset: apple.reset,
        listOwned: apple.listOwned,
        reachable: apple.reachable,
        exec: apple.exec,
      }
    : {
        ensure: dockerBackend.ensure,
        stop: dockerBackend.stop,
        reset: dockerBackend.reset,
        listOwned: dockerBackend.listOwned,
        reachable: dockerBackend.reachable,
        exec: dockerBackend.exec,
      };
const { ensure, stop, reset, listOwned, reachable, exec } = backend;

const image = process.env.COMPUTER_IMAGE ?? "openbot-agent-computer:latest";
/** Where computers' ports are published. A mesh node sets its tailnet address here. */
const publishHost = process.env.COMPUTER_PUBLISH_HOST?.trim() || undefined;
const network = process.env.COMPUTER_NETWORK;
const runtime = process.env.COMPUTER_RUNTIME;
/**
 * The slice this machine's owner dedicated, and what each computer reserves from it.
 *
 * Read once at boot and refused loudly when malformed: a supervisor that misread its budget into
 * "unlimited" would be enforcing nothing while reporting success.
 */
const sliceBudget = budgetFromEnvironment(process.env);
const perComputer = reservationFromEnvironment(process.env);
const spireSocketVolume = process.env.SPIRE_AGENT_SOCKET_VOLUME;

/**
 * What a computer is told about itself.
 *
 * The egress variables come through so a Bot's traffic still leaves by the route configured for it;
 * everything else a computer needs it already has. Nothing here is caller-supplied: a request says
 * which Bot, never what to run or what to set.
 */
function environmentFor(botId: string): string[] {
  const passthrough = Object.entries(process.env).filter(([key]) =>
    key.startsWith("EGRESS_PROXY"),
  );
  /*
   * The secret the computer demands of its callers. Handed to every container this creates, from
   * this process's own environment, so the server and the computers share one secret and nothing else
   * can drive a Bot's browser. Never caller-supplied: a request says which Bot, never what
   * to set.
   */
  const computerToken = process.env.COMPUTER_TOKEN;
  return [
    // Which Bot this container is. Read by the computer as the Bot to assume when a request does not
    // name one. It is normally named per request, so this is the fallback, and for a container that
    // exists to be one Bot's the fallback must be that Bot rather than the shared default.
    `COMPUTER_BOT_ID=${botId}`,
    // Without this the computer refuses to start; it must never answer an unauthenticated caller.
    ...(computerToken ? [`COMPUTER_TOKEN=${computerToken}`] : []),
    // Where to ask what it is. Absent, the computer reports no identity and carries on.
    ...(spireSocketVolume
      ? ["SPIFFE_ENDPOINT_SOCKET=/tmp/spire-agent/public/api.sock"]
      : []),
    ...passthrough.map(([key, value]) => `${key}=${value ?? ""}`),
  ];
}

const app = new Hono();

app.use("*", async (context, next) => {
  // Health is open so an orchestrator can check it without holding the token.
  if (context.req.path === "/health" || context.req.path === "/v1/health") {
    return next();
  }
  if (context.req.header("authorization") !== `Bearer ${token}`) {
    return context.json({ error: "Unauthorized." }, 401);
  }
  return next();
});

/** The 503 every verb answers with when the runtime is not there; anything else is a bug. */
function unavailable(context: Context, error: unknown) {
  if (
    error instanceof DockerUnavailableError ||
    error instanceof AppleContainerUnavailableError ||
    error instanceof ComputerNotAnsweringError
  ) {
    return context.json({ error: error.message }, 503);
  }
  if (error instanceof NameHeldError) {
    return context.json({ error: error.message }, 409);
  }
  if (
    error instanceof ComputerNotFoundError ||
    error instanceof AppleComputerNotFoundError
  ) {
    return context.json({ error: error.message }, 404);
  }
  throw error;
}

const health = async (context: Context) =>
  context.json({
    status: "ok",
    backend: backendName,
    docker: await reachable(),
    // The contract this supervisor speaks. A server that needs a capability asks this, not the
    // version of the package.
    contract: "v1",
  });
app.get("/health", health);
app.get("/v1/health", health);
/**
 * The computer verbs, once, mounted at both the root (the paths the fork inherited) and /v1 (the
 * versioned contract). Same handlers, same token, so "no behaviour change" is a route table fact.
 */
const computers = new Hono();

/**
 * The slice, live. What the owner dedicated, what running computers hold, what is left.
 */
const reportCapacity = async (context: Context) => {
  try {
    const owned = await listOwned();
    const running = owned.filter((computer) =>
      countsAgainstBudget(computer.status),
    );
    return context.json({
      ...capacity(
        sliceBudget,
        running.map((computer) => computer.reservation ?? perComputer),
      ),
      perComputer,
      computers: running.map((computer) => ({
        botId: computer.botId,
        status: computer.status,
        reservation: computer.reservation ?? perComputer,
      })),
    });
  } catch (error) {
    if (error instanceof DockerUnavailableError) {
      return context.json({ error: error.message }, 503);
    }
    throw error;
  }
};
computers.get("/capacity", reportCapacity);

/** The Bot id in the path, validated before it becomes any kind of name. */
function resolve(raw: string) {
  return namesFor(raw);
}

computers.post("/computers/:botId/ensure", async (context) => {
  const parsed = resolve(context.req.param("botId"));
  if (!parsed.ok) return context.json({ error: parsed.reason }, 400);

  try {
    /*
     * Admission, before anything is created. The count is taken from the containers that exist
     * right now — never from supervisor memory — so a restart forgets nothing and a computer this
     * Bot already holds is not double-counted against it.
     */
    const owned = await listOwned();
    const held = owned.some(
      (computer) =>
        computer.botId === parsed.names.botId &&
        countsAgainstBudget(computer.status),
    );
    if (!held) {
      admit(
        sliceBudget,
        owned
          .filter((computer) => countsAgainstBudget(computer.status))
          .map((computer) => computer.reservation ?? perComputer),
        perComputer,
      );
    }

    // Registered before the computer is handed out, so it can prove which Bot it is from its first
    // request.
    const identity = await registerEntry(parsed.names);

    const state = await ensure(parsed.names, {
      image,
      environment: environmentFor(parsed.names.botId),
      ...(network ? { network } : {}),
      ...(runtime ? { runtime } : {}),
      memoryBytes: perComputer.memoryBytes,
      cpus: perComputer.cpus,
      ...(publishHost ? { publishHost } : {}),
      ...(spireSocketVolume ? { spireSocketVolume } : {}),
    });
    return context.json({
      ...state,
      ...(identity.registered
        ? { spiffeId: identity.spiffeId }
        : { identity: identity.reason }),
    });
  } catch (error) {
    // A held name is not an outage. 409 says the conflict is with something already there, so an
    // operator reads the message rather than going to look at a daemon that is working.
    if (error instanceof NameHeldError) {
      return context.json({ error: error.message }, 409);
    }
    // A full slice is not an outage: the machine is healthy and doing exactly what its owner said.
    // 429 with Retry-After tells the placer to wait or to place elsewhere.
    if (error instanceof SliceExhaustedError) {
      context.header("Retry-After", String(error.retryAfterSeconds));
      return context.json({ error: error.message }, 429);
    }
    // Not ready is a 503 like an outage is, because the caller's next move is the same: wait and
    // ask again. The message is what differs, and it is the part an operator acts on.
    if (
      error instanceof DockerUnavailableError ||
      error instanceof AppleContainerUnavailableError ||
      error instanceof ComputerNotAnsweringError
    ) {
      return context.json({ error: error.message }, 503);
    }
    throw error;
  }
});

computers.post("/computers/:botId/stop", async (context) => {
  const parsed = resolve(context.req.param("botId"));
  if (!parsed.ok) return context.json({ error: parsed.reason }, 400);
  try {
    const stopped = await stop(parsed.names);
    return context.json({ stopped });
  } catch (error) {
    if (
      error instanceof DockerUnavailableError ||
      error instanceof AppleContainerUnavailableError
    ) {
      return context.json({ error: error.message }, 503);
    }
    throw error;
  }
});

computers.post("/computers/:botId/reset", async (context) => {
  const parsed = resolve(context.req.param("botId"));
  if (!parsed.ok) return context.json({ error: parsed.reason }, 400);
  try {
    const wasThere = await reset(parsed.names);
    return context.json({ reset: wasThere });
  } catch (error) {
    if (
      error instanceof DockerUnavailableError ||
      error instanceof AppleContainerUnavailableError
    ) {
      return context.json({ error: error.message }, 503);
    }
    throw error;
  }
});

/**
 * The supervisor's own command channel into a computer. Token-guarded like every verb; not the
 * path a Bot's commands take, which is the gateway.
 */
computers.post("/computers/:botId/exec", async (context) => {
  const parsed = resolve(context.req.param("botId"));
  if (!parsed.ok) return context.json({ error: parsed.reason }, 400);
  const body = (await context.req.json().catch(() => null)) as {
    argv?: unknown;
    stdin?: unknown;
  } | null;
  const argv = Array.isArray(body?.argv)
    ? body.argv.filter((entry): entry is string => typeof entry === "string")
    : [];
  if (argv.length === 0) {
    return context.json({ error: "argv must be a non-empty array." }, 400);
  }
  try {
    const result = await exec(
      parsed.names,
      argv,
      typeof body?.stdin === "string"
        ? new TextEncoder().encode(body.stdin)
        : undefined,
    );
    return context.json({
      exitCode: result.exitCode,
      stdout: new TextDecoder().decode(result.stdout),
      stderr: result.stderr,
    });
  } catch (error) {
    return unavailable(context, error);
  }
});

/** The computer's workspace and browser profile, as one archive. The migration primitive. */
computers.get("/computers/:botId/bundle", async (context) => {
  const parsed = resolve(context.req.param("botId"));
  if (!parsed.ok) return context.json({ error: parsed.reason }, 400);
  try {
    const bundle = await exportBundle(exec, parsed.names);
    const body = bundle.buffer.slice(
      bundle.byteOffset,
      bundle.byteOffset + bundle.byteLength,
    ) as ArrayBuffer;
    return new Response(body, {
      headers: {
        "content-type": "application/x-tar",
        "content-disposition": `attachment; filename="${parsed.names.botId}.bundle.tar"`,
      },
    });
  } catch (error) {
    return unavailable(context, error);
  }
});

/** Restore a bundle into an existing computer. Its files land where they were on the source. */
computers.post("/computers/:botId/bundle", async (context) => {
  const parsed = resolve(context.req.param("botId"));
  if (!parsed.ok) return context.json({ error: parsed.reason }, 400);
  try {
    const bundle = new Uint8Array(await context.req.arrayBuffer());
    await importBundle(exec, parsed.names, bundle);
    return context.json({ restored: true, bytes: bundle.byteLength });
  } catch (error) {
    return unavailable(context, error);
  }
});

computers.get("/computers", async (context) => {
  try {
    return context.json({ computers: await listOwned() });
  } catch (error) {
    if (
      error instanceof DockerUnavailableError ||
      error instanceof AppleContainerUnavailableError
    ) {
      return context.json({ error: error.message }, 503);
    }
    throw error;
  }
});

app.route("/", computers);
app.route("/v1", computers);

serve({ port, fetch: app.fetch, idleTimeout: 120 });

console.info(
  `Supervisor listening on http://localhost:${port} (image ${image}${runtime ? `, runtime ${runtime}` : ""})`,
);
