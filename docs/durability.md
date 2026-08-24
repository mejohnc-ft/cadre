# Making Cadre durable

A review of what would not survive, and the plan for making it survive. Written 2026-08-24, when
the system was feature-rich and operationally fragile: everything lived on one Mac, nothing
restarted itself, and no byte of state had a second copy.

## The honest inventory

**What exists and works**: two deployments (this Mac; the `ai` Linux server, currently behind and
asleep), 134 commits on a public repo, ~1,000 server tests, journaled Drizzle migrations, the
vault with keychain custody, triggers, artifacts, harnesses, mesh.

**What would not survive:**

| Event | What happens today |
| --- | --- |
| Mac reboots | Nothing comes back. No launchd agent; `slice up` is manual. VMs stay down. |
| Disk dies | Total loss. Postgres (threads, audit, vault ciphertext, triggers, artifacts), workspaces, browser profiles — all in container volumes with **zero backups**. |
| Keychain lost without disk | Vault ciphertext survives but is undecryptable. No key escrow. |
| Server crashes at 3am | Down until a human runs `slice up`. Cron triggers silently stop firing. |
| Bad deploy | No CI gate on our code (upstream's ci.yml doesn't test our surface). Recovery = git revert + manual restart. |
| `ai` server drifts | Already ~10 commits behind; updates are manual ssh sessions. |
| Bun releases 1.5 | We're pinned to 1.3.14 because 1.4 breaks `@ag-ui/mcp-apps-middleware` (eventsource require). Unaddressed, the pin becomes a cage. |
| The one human forgets how it works | No runbook. Recovery knowledge lives in one head and one chat log. |

## The plan

Ordered by expected regret. Each phase is independently shippable.

### Phase 1 — Don't lose data (backup & restore)

- `slice backup`: pg_dump the slice database