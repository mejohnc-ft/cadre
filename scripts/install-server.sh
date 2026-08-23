#!/usr/bin/env bash
#
# Make this Linux machine a Slice deployment: PostgreSQL, the API with the built web app, and a
# supervisor for its computers — reachable from the tailnet and from nowhere else.
#
# Run from a checkout of the repo on the machine:
#
#   scripts/install-server.sh --model-key <key> [--model-base-url <openai-compatible url>] \
#     [--port 3101] [--serve-port 8081] [--supervisor-port 4601] [--cpus N] [--memory-gb N]
#
# What it does: writes ~/.slice/server.env and ~/.slice/server-supervisor.env with fresh secrets,
# runs PostgreSQL (pgvector) in Docker on loopback with a persistent volume, applies migrations,
# builds the web app, installs three `systemd --user` units (supervisor, API, nightly pg_dump
# timer), and publishes the API on the tailnet with `tailscale serve`. The API itself listens on
# loopback only; the tailnet proxy is the sole way in.
#
# Sign-in: this instance runs single-user (every visitor on the tailnet is the administrator).
# That is right for a private tailnet of one person's own devices and wrong for anything shared —
# configure GOOGLE_OAUTH_* in server.env before inviting anybody.
#
# Idempotent: re-running keeps secrets and data, rebuilds the app and image, restarts the units.
set -euo pipefail

PORT=3101
SERVE_PORT=8081
SUPERVISOR_PORT=4601
PG_PORT=5432
CPUS=""
MEMORY_GB=""
MODEL_KEY=""
MODEL_BASE_URL=""
while [ $# -gt 0 ]; do
  case "$1" in
    --model-key) MODEL_KEY="$2"; shift 2 ;;
    --model-base-url) MODEL_BASE_URL="$2"; shift 2 ;;
    --port) PORT="$2"; shift 2 ;;
    --serve-port) SERVE_PORT="$2"; shift 2 ;;
    --supervisor-port) SUPERVISOR_PORT="$2"; shift 2 ;;
    --pg-port) PG_PORT="$2"; shift 2 ;;
    --cpus) CPUS="$2"; shift 2 ;;
    --memory-gb) MEMORY_GB="$2"; shift 2 ;;
    *) echo "unknown option: $1" >&2; exit 2 ;;
  esac
done

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
STATE="$HOME/.slice"
SERVER_ENV="$STATE/server.env"
SUPERVISOR_ENV="$STATE/server-supervisor.env"
mkdir -p "$STATE/logs" "$STATE/backups"

info() { printf '\033[2m%s\033[0m\n' "$1"; }
fail() { printf '\033[31m%s\033[0m\n' "$1" >&2; exit 1; }
existing() { [ -f "$2" ] && grep -E "^$1=" "$2" | cut -d= -f2- || true; }

info "1/7 prerequisites"
command -v docker >/dev/null || fail "Docker is required."
docker ps >/dev/null 2>&1 || fail "This user cannot use Docker. Add yourself to the docker group."
command -v tailscale >/dev/null || fail "Tailscale is required."
if ! command -v bun >/dev/null; then
  curl -fsSL https://bun.sh/install | bash >/dev/null
  export PATH="$HOME/.bun/bin:$PATH"
fi
BUN="$(command -v bun)"
TAILNET_IP="$(tailscale ip -4 | head -1)"
MAGIC_NAME="$(tailscale status --json | python3 -c 'import json,sys; print(json.load(sys.stdin)["Self"]["DNSName"].rstrip("."))')"
[ -n "$TAILNET_IP" ] || fail "No tailnet address."
PUBLIC_URL="http://$MAGIC_NAME:$SERVE_PORT"
[ -n "$MODEL_KEY" ] || [ -f "$SERVER_ENV" ] || fail "--model-key is required the first time."

info "2/7 secrets and configuration → $SERVER_ENV"
umask 077
KEY_ENCRYPTION_KEY="$(existing KEY_ENCRYPTION_KEY "$SERVER_ENV")"; KEY_ENCRYPTION_KEY="${KEY_ENCRYPTION_KEY:-$(openssl rand -base64 32)}"
COMPUTER_TOKEN="$(existing COMPUTER_TOKEN "$SERVER_ENV")"; COMPUTER_TOKEN="${COMPUTER_TOKEN:-$(openssl rand -base64 32)}"
SUPERVISOR_TOKEN="$(existing SUPERVISOR_TOKEN "$SERVER_ENV")"; SUPERVISOR_TOKEN="${SUPERVISOR_TOKEN:-$(openssl rand -base64 32)}"
MANAGED_AGENT_TOKEN="$(existing MANAGED_AGENT_TOKEN "$SERVER_ENV")"; MANAGED_AGENT_TOKEN="${MANAGED_AGENT_TOKEN:-$(openssl rand -base64 32)}"
PG_PASSWORD="$(existing PG_PASSWORD "$SERVER_ENV")"; PG_PASSWORD="${PG_PASSWORD:-$(openssl rand -hex 16)}"
MODEL_KEY="${MODEL_KEY:-$(existing OPENAI_API_KEY "$SERVER_ENV")}"
MODEL_BASE_URL="${MODEL_BASE_URL:-$(existing OPENAI_COMPATIBLE_BASE_URL "$SERVER_ENV")}"
cat > "$SERVER_ENV" <<EOF
# Written by scripts/install-server.sh. This deployment's secrets. Back up with the database.
PORT=$PORT
HOST=127.0.0.1
OPENBOT_SINGLE_USER=true
DATABASE_URL=postgres://slice:$PG_PASSWORD@127.0.0.1:$PG_PORT/slice
PG_PASSWORD=$PG_PASSWORD
KEY_ENCRYPTION_KEY=$KEY_ENCRYPTION_KEY
COMPUTER_TOKEN=$COMPUTER_TOKEN
SUPERVISOR_TOKEN=$SUPERVISOR_TOKEN
COMPUTER_SUPERVISOR_URL=http://127.0.0.1:$SUPERVISOR_PORT
MANAGED_AGENT_TOKEN=$MANAGED_AGENT_TOKEN
TENANT_PACKAGE_DIR=../examples/fintech
APP_DIST_DIR=$ROOT/app/dist
TRUSTED_ORIGINS=$PUBLIC_URL
OPENBOT_PUBLIC_URL=$PUBLIC_URL
OPENAI_API_KEY=$MODEL_KEY
OPENAI_BASE_URL=$MODEL_BASE_URL
OPENAI_COMPATIBLE_BASE_URL=$MODEL_BASE_URL
NODE_ENV=production
EOF
SLICE_CPUS="${CPUS:-$(existing SLICE_CPUS "$SUPERVISOR_ENV")}"; SLICE_CPUS="${SLICE_CPUS:-$(( $(nproc) / 4 ))}"
if [ -n "$MEMORY_GB" ]; then SLICE_MEMORY_BYTES=$(( MEMORY_GB * 1024 * 1024 * 1024 ));
else SLICE_MEMORY_BYTES="$(existing SLICE_MEMORY_BYTES "$SUPERVISOR_ENV")"; SLICE_MEMORY_BYTES="${SLICE_MEMORY_BYTES:-$(( $(free -g | awk '/^Mem:/{print $2}') / 4 * 1024 * 1024 * 1024 ))}"; fi
if command -v runsc >/dev/null; then RUNTIME="runsc"; else RUNTIME=""; fi
cat > "$SUPERVISOR_ENV" <<EOF
PORT=$SUPERVISOR_PORT
HOST=127.0.0.1
COMPUTER_BACKEND=docker
COMPUTER_PUBLISH_HOST=127.0.0.1
COMPUTER_NAMESPACE=slice-server
COMPUTER_IMAGE=openbot-agent-computer:latest
COMPUTER_RUNTIME=$RUNTIME
SUPERVISOR_TOKEN=$SUPERVISOR_TOKEN
COMPUTER_TOKEN=$COMPUTER_TOKEN
SLICE_CPUS=$SLICE_CPUS
SLICE_MEMORY_BYTES=$SLICE_MEMORY_BYTES
EOF
# The app build and the migration tool read the repo's .env; point it at the real one.
ln -sfn "$SERVER_ENV" "$ROOT/.env"

info "3/7 postgres (docker, loopback, persistent volume)"
if ! docker ps --format '{{.Names}}' | grep -qx slice-server-postgres; then
  docker rm -f slice-server-postgres >/dev/null 2>&1 || true
  docker run -d --name slice-server-postgres --restart unless-stopped \
    -p "127.0.0.1:$PG_PORT:5432" -v slice-server-pgdata:/var/lib/postgresql/data \
    -e POSTGRES_USER=slice -e "POSTGRES_PASSWORD=$PG_PASSWORD" -e POSTGRES_DB=slice \
    pgvector/pgvector:pg17 >/dev/null
fi
for _ in $(seq 1 60); do
  docker exec slice-server-postgres pg_isready -U slice >/dev/null 2>&1 && break
  sleep 1
done
docker exec slice-server-postgres pg_isready -U slice >/dev/null 2>&1 || fail "PostgreSQL did not come up."

info "4/7 dependencies, migrations, web app, computer image"
(cd "$ROOT" && "$BUN" install --frozen-lockfile >/dev/null 2>&1)
(cd "$ROOT/supervisor" && "$BUN" install --frozen-lockfile >/dev/null 2>&1)
(cd "$ROOT/server" && DATABASE_URL="postgres://slice:$PG_PASSWORD@127.0.0.1:$PG_PORT/slice" "$BUN" run db:migrate >"$STATE/logs/migrate.log" 2>&1) || fail "Migrations failed. Log: $STATE/logs/migrate.log"
(cd "$ROOT" && "$BUN" run generate:app-config >/dev/null 2>&1 && cd app && "$BUN" run build >"$STATE/logs/app-build.log" 2>&1) || fail "The web app did not build. Log: $STATE/logs/app-build.log"
docker build -q -f "$ROOT/agent-computer/Dockerfile" -t openbot-agent-computer:latest "$ROOT" >/dev/null

info "5/7 services (systemd --user)"
UNIT_DIR="$HOME/.config/systemd/user"
mkdir -p "$UNIT_DIR"
cat > "$UNIT_DIR/slice-server-supervisor.service" <<EOF
[Unit]
Description=Slice supervisor for this deployment's own computers
After=network-online.target docker.service
[Service]
EnvironmentFile=$SUPERVISOR_ENV
WorkingDirectory=$ROOT/supervisor
ExecStart=$BUN $ROOT/supervisor/src/index.ts
Restart=always
RestartSec=3
StandardOutput=append:$STATE/logs/server-supervisor.log
StandardError=append:$STATE/logs/server-supervisor.log
[Install]
WantedBy=default.target
EOF
cat > "$UNIT_DIR/slice-server.service" <<EOF
[Unit]
Description=Slice API and web app
After=network-online.target slice-server-supervisor.service
Wants=slice-server-supervisor.service
[Service]
EnvironmentFile=$SERVER_ENV
WorkingDirectory=$ROOT/server
ExecStart=$BUN $ROOT/server/src/index.ts
Restart=always
RestartSec=3
StandardOutput=append:$STATE/logs/server.log
StandardError=append:$STATE/logs/server.log
[Install]
WantedBy=default.target
EOF
cat > "$UNIT_DIR/slice-backup.service" <<EOF
[Unit]
Description=Slice nightly PostgreSQL dump
[Service]
Type=oneshot
ExecStart=/bin/sh -c 'docker exec slice-server-postgres pg_dump -U slice -Fc slice > $STATE/backups/slice-\$(date +%%Y%%m%%d).dump && ls -1t $STATE/backups/slice-*.dump | tail -n +15 | xargs -r rm --'
EOF
cat > "$UNIT_DIR/slice-backup.timer" <<EOF
[Unit]
Description=Slice nightly PostgreSQL dump
[Timer]
OnCalendar=*-*-* 03:15:00
Persistent=true
[Install]
WantedBy=timers.target
EOF
systemctl --user daemon-reload
systemctl --user enable slice-server-supervisor.service slice-server.service slice-backup.timer >/dev/null 2>&1
systemctl --user restart slice-server-supervisor.service
systemctl --user restart slice-server.service
systemctl --user start slice-backup.timer
loginctl enable-linger "$USER" 2>/dev/null || sudo -n loginctl enable-linger "$USER" 2>/dev/null || true

info "6/7 health"
for _ in $(seq 1 90); do
  curl -fsS "http://127.0.0.1:$PORT/api/capabilities" >/dev/null 2>&1 && break
  sleep 1
done
curl -fsS "http://127.0.0.1:$PORT/api/capabilities" >/dev/null 2>&1 || fail "The API did not answer. Log: $STATE/logs/server.log"

info "7/7 tailnet (tailscale serve)"
if ! sudo -n tailscale serve --bg "--http=$SERVE_PORT" "http://127.0.0.1:$PORT" >/dev/null 2>&1; then
  tailscale serve --bg "--http=$SERVE_PORT" "http://127.0.0.1:$PORT" >/dev/null 2>&1 || fail "tailscale serve failed; run it by hand: tailscale serve --bg --http=$SERVE_PORT http://127.0.0.1:$PORT"
fi

echo
echo "Slice is deployed on this machine."
echo "  Open        $PUBLIC_URL   (tailnet only; single-user — every tailnet visitor is admin)"
echo "  API         http://127.0.0.1:$PORT (loopback)"
echo "  Supervisor  http://127.0.0.1:$SUPERVISOR_PORT, slice $SLICE_CPUS cores / $(( SLICE_MEMORY_BYTES / 1024 / 1024 / 1024 )) GiB"
echo "  Database    docker slice-server-postgres, volume slice-server-pgdata, dumps in $STATE/backups nightly 03:15"
echo "  Logs        $STATE/logs"
echo "  Units       systemctl --user status slice-server slice-server-supervisor slice-backup.timer"
