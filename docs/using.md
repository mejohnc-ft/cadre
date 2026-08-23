# Using Slice on this Mac (today's shape)

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
