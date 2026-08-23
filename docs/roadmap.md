# Slice — implementation roadmap

Grounded against the upstream tree at the point of fork (OpenBot v0.0.4, `6826e11`).
The PRD is in [prd.md](prd.md). This document says what the code actually needs, in order.

## Deployment shapes (the three the product must serve)

| Shape | Where the server runs | Where computers run | UI |
|---|---|---|---|
| **Local** | this Mac (loopback, `OPENBOT_SINGLE_USER=true`) | this Mac via Apple `container` VMs | web app optional — `slice` CLI covers create / run / attach / audit |
| **Server** | a Linux box on the tailnet | Docker + gVisor on that box | web app required (it *is* the control plane) |
| **Mesh** | one server, many nodes | any enrolled node | web app required; Mac nodes also expose the CLI |

Design consequence: the server must be able to run **embedded** (one `bun` process, embedded Postgres, loopback supervisor, no auth) for the local shape, and **detached** (systemd, tailnet bind, Better Auth + Google) for the server shape. Same binary, different `slice.toml`.

## What upstream already gives us

- Hono API server, React/Vite app, Drizzle + Postgres + pgvector, 14 migrations.
- Gateway: CEL boundaries (fail closed), audit rows, write-only credentials, redaction, take-the-wheel. All kept.
- `supervisor/`: a Hono service with `ensure/stop/reset/list/health` over Docker, token-guarded, SPIRE identity per computer. **This is the seed of the Supervisor Contract.**
- `CopilotRuntime` v2 has an `AgentRunner` abstraction (`run/connect/isRunning/stop` + optional `LocalThreadEndpointRunner` for thread listing). Upstream hard-wires `IntelligenceAgentRunner`; `CopilotSseRuntime` accepts any runner.
- The web app talks only to `/api/copilotkit` — it has no direct Intelligence dependency.

## M0 — Sovereign fork

1. **`PostgresAgentRunner`** (`server/src/runtime/postgres-runner.ts`) implementing `LocalThreadEndpointRunner`:
   tables `thread`, `thread_message`, `thread_event`, `thread_state`, `agent_memory` (pgvector). Run = proxy the AG-UI
   event stream from the agent, persist events as they pass, fan out to `connect()` subscribers (in-process
   `Subject` per thread; Postgres `LISTEN/NOTIFY` later for multi-instance).
2. Switch `copilot.ts` from `CopilotRuntime` (Intelligence mode) to `CopilotSseRuntime({ runner })`. Delete
   `intelligence-client.ts`; `config.ts` drops `INTELLIGENCE_*` and the licence-token gate.
3. Thread routes (`channels/thread-routes.ts`, `thread-status.ts`, `turn-watchdog.ts`, `stall-guard.ts`) re-pointed from
   the Intelligence client to the runner's local thread endpoints.
4. Memory: `agent_memory(profile_id, user_id, text, embedding vector(1536), created_at)`; recall = top-k by cosine,
   injected as a system-message prefix. Embedding model is a provider credential like any other.
5. Auth: keep Better Auth + Google. Add `slice.toml` / env rule: `OPENBOT_SINGLE_USER=true` refused unless bind address
   is loopback. Passkey/local account is P1.
6. Rename: package names `@slice/*`, env prefix `SLICE_` (accept `OPENBOT_` as alias for one release), README/NOTICE
   with MIT attribution to CopilotKit.
7. Licence audit: `bunx license-checker` over the lockfile; strip `@copilotkit/aimock` and any Intelligence-only deps.

**Exit:** `docker compose up` (or embedded) → channel chat, browser task, audit, boundaries all work with only a model key.
Tests: existing `thread-*`, `channel-*`, `copilot.test.ts` rewritten against the Postgres runner; CI has no Intelligence secrets.

## M1 — Supervisor Contract

Formalize `supervisor/` as a versioned API (`/v1`) with a backend interface:

```
interface ComputerBackend {
  health(): Promise<BackendHealth>
  capacity(): Promise<{ total: Slice; used: Slice; computers: ComputerSummary[] }>
  ensure(names, spec: ComputerSpec): Promise<ComputerState>   // idempotent create+start
  stop(names): Promise<boolean>
  destroy(names): Promise<boolean>
  exec(names, argv, opts): Promise<ExecResult>
  screenEndpoint(names): Promise<{ url: string }>              // CDP / stream address the gateway dials
  attachWorkspace(names, bundle): Promise<void>                 // M1-P1 snapshot/restore
  exportWorkspace(names): Promise<ReadableStream>               // M1-P1
}
```

- `DockerBackend` = today's `docker.ts`, plus cgroup limits per computer and a pool budget from `SLICE_CORES/RAM/DISK`.
- Queue-or-refuse on exhaustion (`429` with `retryAfter`), utilization on `/v1/capacity`, surfaced in the UI.
- Server side: `server/src/computer/supervisor-client.ts` speaks `/v1`; contract tests run against any backend.

**Exit:** stock stack with the new supervisor, zero behaviour change; slice limits enforced and visible.

## M2 — Two runtimes

- `AppleContainerBackend` shelling out to `container` (brew `container` 1.2.2 is available on this Mac, macOS 26.6):
  `container run --cpus N --memory M --volume workspace:/workspace --volume chromium:/home/agent/.config/chromium`.
  Same OCI `agent-computer` image. Persistent volumes via `container volume`.
- `slice` CLI (`cli/`): `slice init` (pick slice: cores/RAM/disk/schedule), `slice up` (embedded server + supervisor,
  launchd agent), `slice agent create|run|attach|logs`, `slice audit tail`, `slice vault add`. This is the **no-web** path.
- Linux installer `scripts/install-server.sh`: Docker + gVisor, systemd units, tailnet bind, nightly `pg_dump`.
- Menu-bar app (P1) is a thin SwiftUI shell over the supervisor's `/v1/capacity`.

## M3 — Mesh

- Tables `node`, `node_enrollment_token`, `placement`, `slice_share`, `invite`.
- Node = supervisor instance registered with the server; server keeps a `SupervisorClient` per node.
- Placement resolver: profile prefs (`always-on | burst | pinned:<node>`) × node capacity × share grants.
- Roaming = `exportWorkspace` on A → `attachWorkspace` on B → re-`ensure` → channel resumes (threads live in Postgres, so
  nothing else moves).
- Guest agents evaluate node-owner boundaries *and* their own (deny-first union).

## M4 — Control plane

- `provider`, `model_route`, `budget` tables; egress proxy injects provider keys (extends the existing egress path).
- Harness adapter: a thin AG-UI server inside the computer image wrapping `claude` / `opencode` streams.
- `artifact` + `artifact_version` tables; profile references; diff/rollback in UI; `slice sync` projects into `~/.claude`.

## Open decisions taken for now

- Tailscale first (it's already on this machine); Headscale documented later.
- Embedding model for memory: whichever provider the deployment already has a key for; `text-embedding-3-small` default.
- Multi-instance server fan-out deferred — one server process per deployment in v1.
