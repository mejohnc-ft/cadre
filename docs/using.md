# Using Cadre on this Mac (today's shape)

This is the M0 "stock stack": Docker for the database and the Bots' computers, Bun on the host for
the API and the app. The Apple `container` runtime and the `slice` CLI (M2) replace the Docker half
later; nothing you do here is thrown away.

## Start

```sh
cd ~/slice-dev/slice
export PATH=$HOME/.bun/bin:$PATH        # Bun 1.3.14 — the repo pins it; 1.4 breaks an import
ONE_COMPUTER_EACH=true bash scripts/start.sh
```

Then open <http://localhost:3010>. No sign-in: `.env` has `OPENBOT_SINGLE_USER=true`, which is why
the server only listens on loopback.

What the launcher brings up:

| Thing | Where | Notes |
|---|---|---|
| App | `:3010` | Vite dev server |
| API | `:3001` | `server/src/index.ts`, loopback only |
| Postgres | `:5432` (Docker) | threads, audit, vault — the crown jewels |
| Supervisor | `:4500` (Docker) | makes one computer container per Bot on first use |
| Bots | `:4200`, `:4201` (Docker) | the hand-written Bot and the LangGraph Bot |

## Stop

```sh
docker compose down                                  # database, supervisor, Bots
docker rm -f $(docker ps -q --filter label=openbot.supervisor=true)   # per-Bot computers
kill $(lsof -t -iTCP:3001 -iTCP:3010)                # API and app
```

Workspaces and browser profiles are Docker volumes and survive all of the above.

## Model

The built-in Bots use the model in `examples/fintech/model.yaml` (`glm-5.3`) through the endpoint in
`OPENAI_COMPATIBLE_BASE_URL`. The key is read from the **vault first**, then `OPENAI_API_KEY`.
To retire the key from `.env`: Admin → Credentials → add a model credential with id `openai-api-key`,
then delete the line from `.env` and restart the API.

## Things to try

1. `/bot` → "Open news.ycombinator.com and tell me the top story." Watch the live screen.
2. `/admin/audit` — every navigate, click and screenshot is a row, decided before it happened.
3. `/admin/boundaries` — add `deny: ["page.host == 'news.ycombinator.com'"]`, ask again, read the refusal.
4. `/agents` — create a coworker; it is configuration, not code.

## Smoke test

With the stack up: `OPENBOT_SMOKE=1 bun test tests/smoke` drives navigate → screenshot → audit →
deny rule → refusal against the real deployment.

## The Apple-VM shape (no Docker, no web app)

Every computer — and PostgreSQL — runs in its own lightweight VM via Apple `container`
(macOS 26, Apple silicon). The web app is optional.

```sh
export PATH="$HOME/slice-dev/slice/bin:$PATH"
slice init --cpus 4 --memory-gb 8   # dedicate a slice of this Mac; writes ~/.slice/slice.env
# put a model key in ~/.slice/slice.env, then:
slice up
slice chat general-assistant "hello"
slice status                        # includes live slice utilization
slice audit
slice down                          # volumes (workspaces, browser profiles, database) survive
```

The supervisor is the same one Docker uses, started with `COMPUTER_BACKEND=apple`. First run needs
the computer image in the VM runtime: `docker save openbot-agent-computer:latest | container image load -i -`
(or build it there). The web UI works on top of this stack too — start `bun run dev` in `app/`.

Known limit: `slice chat` covers text and server-side tools; browser tasks still need the web
surface, whose pages execute the computer tools. Teaching the CLI to execute them is on the list.

## The mesh: more than one machine

A deployment is one server and any number of nodes. A node is a machine running a supervisor
(`slice up` starts one) that the server can reach over the tailnet.

```sh
# On the server (this Mac, today):
slice node token                     # prints a single-use token, valid 30 minutes
slice nodes                          # every node with live capacity

# On a Linux machine joining (Ubuntu/Debian with Docker; rsync the repo there first):
scripts/install-node.sh --computer-token <COMPUTER_TOKEN from the server's ~/.slice/slice.env> --cpus 8 --memory-gb 32
# It builds the computer image, writes ~/.slice/node.env, and runs the supervisor as a
# `systemd --user` unit bound to the machine's tailnet address only. It prints the join command.

# Enrol it — from the node (it POSTs to the server), or from the server on its behalf:
slice node join http://127.0.0.1:3001 <token> --id ai --supervisor-url http://<its tailnet ip>:4600 \
  --supervisor-token '<SUPERVISOR_TOKEN from the node's ~/.slice/node.env>' --backend docker

# Back on the server: carry a Bot's computer — workspace and browser profile — to a node.
slice move general-assistant <node-id>
slice move general-assistant local
```

A move exports the bundle from the source, ensures a computer on the target, restores it, stops
the source, and only then records the placement — so a failure part-way leaves the Bot where it
was. The channel, its history and the audit trail never move; they were never on a node.

The same is available to the web app at `/api/admin/nodes`, `/api/admin/nodes/enrollment-tokens`
and `/api/admin/computers/:bot/move`.

## A server of its own (Linux, always on)

`scripts/install-server.sh` turns an Ubuntu/Debian machine on the tailnet into a complete
deployment: PostgreSQL (pgvector, Docker, loopback, persistent volume), the API with the built web
app on loopback, a supervisor for its computers, `systemd --user` units for all three, a nightly
`pg_dump` timer, and `tailscale serve` publishing the app to the tailnet only.

```sh
rsync -az --exclude node_modules --exclude .git --exclude .env ~/slice-dev/slice/ ai:slice/
ssh ai 'cd slice && scripts/install-server.sh --model-key <key> --model-base-url https://api.z.ai/api/coding/paas/v4 --cpus 8 --memory-gb 32'
# → http://<machine>.<tailnet>.ts.net:8081
```

It runs single-user: every visitor on the tailnet is the administrator, which is right for a
private tailnet of one person's devices and wrong for anything shared — set `GOOGLE_OAUTH_*` in
`~/.slice/server.env` before inviting anyone. State: `~/.slice/{server.env,server-supervisor.env,
backups,logs}` on the machine and the `slice-server-pgdata` Docker volume. Re-running the script
upgrades in place. Restore: `docker exec -i slice-server-postgres pg_restore -U slice -d slice -c < dump`.

## Claude Code as a coworker (managed harness)

The **Claude Code** coworker runs Claude Code headless inside its own computer. It is declared in
the tenant package as `type: harness` / `harness: claude-code`; there is no endpoint to run —
the server finds the Bot's computer wherever the mesh placed it and calls `/harness/run` there.

- Each turn is one `claude -p` in `/workspace`, resumed from the thread's session (kept in the
  workspace, so it survives a move). The profile's standing message is appended as system prompt.
- **Every tool Claude Code wants — Bash, Edit, Write, Read, WebFetch… — asks the server first.**
  A PreToolUse hook in the image posts the call to `/api/harness/:bot/decide`; the deployment's
  boundaries evaluate it with `tool.name == "harness_<Tool>"`, `command` and `file` filled in;
  the answer is audited as `computer.action_allowed` / `computer.action_refused`; a refusal
  names the rule to the model. No server, no answer, no tool: it fails closed.
- Model access: `HARNESS_ANTHROPIC_BASE_URL` / the model key on the supervisor
  (Z.ai's coding plan: `https://api.z.ai/api/anthropic`). Today the key reaches the computer's
  environment; moving it behind the egress proxy (PRD §7.7) is the next hardening step.

```sh
slice chat claude-code "Create notes.md with hello, then run ls -la"
slice chat --thread <id> claude-code "What did you create earlier?"    # resumes the session
# Boundaries apply: deny ["tool.name == \"harness_Bash\""] and the shell is refused, audited.
```

## Artifacts: a coworker's instructions, written once

An **artifact** is a versioned unit of context — an instructions file, a skill — held once and
attached to profiles. An instructions artifact is projected into a harness's workspace at run
start as the file that engine reads on its own: `CLAUDE.md` for Claude Code, `AGENTS.md` for Pi and
OpenCode. Write the role once; every engine honours it.

```sh
# Create an instructions artifact and attach it to a coworker:
curl -s localhost:3001/api/admin/artifacts -H 'content-type: application/json' \
  -d '{"kind":"instructions","name":"House style","content":"Always cite sources."}'
curl -s localhost:3001/api/admin/agents/claude-code/artifacts -H 'content-type: application/json' \
  -d '{"artifactId":"<id>"}'
# Editing appends a version (POST .../versions); a profile follows latest or pins a version.

# Project a coworker's artifacts into a local project (config-sprawl fix):
slice sync claude-code                 # writes ./AGENTS.md and ./skills/
slice sync claude-code --claude        # also ~/.claude/CLAUDE.md (backs up an existing one first)
```

## Model routing: providers as data

Providers live in the database with their keys encrypted (write-only); one is the deployment
default and a coworker can route to a different provider/model:

```sh
curl -s -X PUT localhost:3001/api/admin/providers/zai -H 'content-type: application/json' \
  -d '{"kind":"openai-compatible","baseUrl":"https://api.z.ai/api/coding/paas/v4","defaultModel":"glm-5.3","isDefault":true,"key":"<key>"}'
curl -s -X PUT localhost:3001/api/admin/agents/pi/model-route -H 'content-type: application/json' \
  -d '{"providerId":"zai","model":"glm-4.7"}'          # pi now runs glm-4.7; others stay on the default
curl -s localhost:3001/api/admin/usage                  # spend per coworker, last 30 days
```

Kinds: `anthropic`, `openai`, `anthropic-compatible`, `openai-compatible`. On first boot with no
providers, one is seeded from the environment so existing deployments keep working. Built-in Bots
use the default openai-shaped provider; harness coworkers follow their route (Claude Code speaks
anthropic-shaped endpoints, Pi/OpenCode openai-shaped).

## Secrets never enter the sandbox: the egress proxy

By default a harness reaches its model through the server's egress proxy, not directly. The
computer is pointed at `http://<server>/api/egress/<provider>` and authenticates with the
**computer token** — a secret it already holds that opens nothing but the proxy. The server swaps
that for the provider's real key (held encrypted in the provider table), forwards the model call,
and streams the answer back. A prompt-injected agent that dumps its environment finds no provider
key to steal — verified: `HARNESS_ANTHROPIC_AUTH_TOKEN` is absent from a running harness VM.

Only model API paths are forwarded (`/v1/messages`, `/chat/completions`), so the proxy is a model
wire, not a tunnel. Set `HARNESS_EGRESS=direct` on the server to hand the key into the computer
instead (the pre-proxy behaviour), e.g. for a provider the proxy cannot yet translate.
