# Operating Cadre

The runbook for the deployment on this Mac, and the habits that keep it durable.

## The keeper

```
slice autostart        # once: start at login, restart on crash, back up daily
slice doctor           # any time: is everything green
```

`slice autostart` installs a LaunchAgent that runs `slice guard` — a small
foreground loop launchd keeps alive. Every minute it checks the server and the
supervisor and runs `slice up` when either is down; once a day it takes a
backup and rotates a grown log. The stack survives reboots and crashes without
a human in the loop.

## Backups

```
slice backup                     # now
slice restore <backup.sql.gz>    # after stopping the server
```

A backup is a gzipped `pg_dump` of the slice database — threads, artifacts,
triggers, connections, audit — plus a copy of `~/.slice/slice.env` (tokens).
The newest 14 of each are kept in `~/.slice/backups`.

**The backup does not contain the master key.** Vault and provider secrets are
AES-GCM ciphertext in the dump; the key lives in the macOS keychain (service
`cadre-key-encryption`) and deliberately never travels with the data. A stolen
backup is useless; a restore onto a fresh Mac needs the key exported from
Keychain Access (or secrets re-entered). Keep a copy of the key in a password
manager.

What is *not* backed up, on purpose: workspaces and browser profiles (caches a
coworker rebuilds; logins re-verify with one click on the Connections page) and
the repo (GitHub is the copy).

### Restore drill, from nothing

1. Clone `github.com/mejohnc-ft/cadre`, `slice init`, stop the server.
2. Put the master key back in the keychain (Keychain Access → new generic
   password, service `cadre-key-encryption`) — or accept re-entering secrets.
3. `slice restore <newest backup>` · `slice up` · `slice doctor`.
4. On the Connections page, hit **Verify sign-in** on each web login.

## Migrations

One rule, learned the hard way: **schema changes go through drizzle only.**

```
cd server && DATABASE_URL=postgres://openbot:openbot@127.0.0.1:5433/slice \
  ~/.bun/bin/bun x drizzle-kit generate --name <change> && \
  ~/.bun/bin/bun x drizzle-kit migrate
```

Applying a migration by hand with `psql` leaves the journal behind and the next
`slice up` fails on "already exists". If that ever happens again: drop the
hand-made tables and let `drizzle-kit migrate` own them.

## Pinned versions

- **Bun 1.3.14** (`~/.bun/bin/bun`), not brew's 1.4.x — newer Bun breaks
  `@ag-ui/mcp-apps-middleware` ("require() async module" on eventsource).
  Revisit when that dependency updates.
- Apple `container` CLI 1.2.2. Postgres data inside the VM uses
  `PGDATA=/var/lib/postgresql/data/pgdata` (volume roots carry `lost+found`).

## The second instance (`ai`)

`ai` runs the Linux shape (docker, systemd --user units, tailscale serve). It
has its own database and its own backups (same commands, docker instead of
`container`). Catch it up with:

```
ssh ai "cd ~/cadre && git pull && bun install && bun run db:migrate && systemctl --user restart cadre-server"
```

Until an auto-deploy exists, treat `ai` as follows-main-by-hand and check its
drift when touching it.

## Upstream (CopilotKit/openbot)

This is a hard fork — renamed, ~134 commits diverged. Do not merge upstream
wholesale. When upstream ships a security fix: cherry-pick the commit, run both
suites, note the pick in the commit message. Watch upstream releases
occasionally; nothing here auto-tracks them.

## Common failures

| Symptom | Cause | Fix |
|---|---|---|
| "The slice is full: … 0 of 4 free" | reservations held by stopped/ghost VMs | stop an idle computer, or `container list` and delete strays |
| Server ignores new code | `slice up` skips already-running processes | `pkill -9 -f "src/index.ts"` then `slice up` |
| VM runs old behaviour | image rebuilt but VM not recreated | `container stop/delete slice-computer-<bot>`, next run recreates |
| Harness turn dies instantly on a rebuilt VM | stale session resume | fixed in code (retries fresh); if seen again check `~/.slice` state under `/workspace/.slice/harness-sessions` |
| `slice up` migration failure | schema applied outside drizzle | see Migrations above |

## Audit retention

`AUDIT_RETENTION_DAYS=90` in `~/.slice/slice.env` keeps the audit table from
growing forever. Unset it to keep everything.
