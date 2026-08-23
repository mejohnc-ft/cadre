#!/usr/bin/env bash
#
# Make this Linux machine a Slice node: a supervisor that makes computers here, reachable by the
# deployment's server over the tailnet and by nothing else.
#
# Run from a checkout of the repo on the node:
#
#   scripts/install-node.sh --computer-token <the deployment's COMPUTER_TOKEN> [--cpus N] [--memory-gb N]
#
# What it does, in order: checks Docker and bun, builds the computer image, writes
# ~/.slice/node.env with a fresh SUPERVISOR_TOKEN, installs a user systemd unit for the
# supervisor bound to this machine's tailnet address, enables linger so it survives logout, and
# prints the `slice node join` command to run on the server.
#
# The computer token is the deployment's, not this node's: the server drives every computer with
# one secret, wherever the computer is. It comes from the server's ~/.slice/slice.env.
#
# Idempotent. Re-running rebuilds the image, keeps the existing supervisor token, restarts the unit.
set -euo pipefail

CPUS=""
MEMORY_GB=""
COMPUTER_TOKEN=""
PORT=4600
while [ $# -gt 0 ]; do
  case "$1" in
    --computer-token) COMPUTER_TOKEN="$2"; shift 2 ;;
    --cpus) CPUS="$2"; shift 2 ;;
    --memory-gb) MEMORY_GB="$2"; shift 2 ;;
    --port) PORT="$2"; shift 2 ;;
    *) echo "unknown option: $1" >&2; exit 2 ;;
  esac
done

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
STATE="$HOME/.slice"
ENV_FILE="$STATE/node.env"
mkdir -p "$STATE/logs"

info() { printf '\033[2m%s\033[0m\n' "$1"; }
fail() { printf '\033[31m%s\033[0m\n' "$1" >&2; exit 1; }

info "1/5 prerequisites"
command -v docker >/dev/null || fail "Docker is required. https://docs.docker.com/engine/install/"
docker ps >/dev/null 2>&1 || fail "Docker is installed but this user cannot use it. Add yourself to the docker group and log in again."
if ! command -v bun >/dev/null; then
  info "  installing bun"
  curl -fsSL https://bun.sh/install | bash >/dev/null
  export PATH="$HOME/.bun/bin:$PATH"
fi
BUN="$(command -v bun)"
TAILNET_IP="$(tailscale ip -4 2>/dev/null | head -1 || true)"
[ -n "$TAILNET_IP" ] || fail "This machine has no tailnet address. Install Tailscale and join the tailnet first."
[ -n "$COMPUTER_TOKEN" ] || [ -f "$ENV_FILE" ] || fail "--computer-token is required the first time: the deployment's COMPUTER_TOKEN from the server's ~/.slice/slice.env"
if command -v runsc >/dev/null; then RUNTIME="runsc"; else RUNTIME=""; fi

info "2/5 computer image"
docker build -q -f "$ROOT/agent-computer/Dockerfile" -t openbot-agent-computer:latest "$ROOT" >/dev/null
(cd "$ROOT/supervisor" && "$BUN" install --frozen-lockfile >/dev/null)

info "3/5 node configuration → $ENV_FILE"
if [ -f "$ENV_FILE" ]; then
  EXISTING_SUPERVISOR_TOKEN="$(grep -E '^SUPERVISOR_TOKEN=' "$ENV_FILE" | cut -d= -f2- || true)"
  EXISTING_COMPUTER_TOKEN="$(grep -E '^COMPUTER_TOKEN=' "$ENV_FILE" | cut -d= -f2- || true)"
  EXISTING_CPUS="$(grep -E '^SLICE_CPUS=' "$ENV_FILE" | cut -d= -f2- || true)"
  EXISTING_MEM="$(grep -E '^SLICE_MEMORY_BYTES=' "$ENV_FILE" | cut -d= -f2- || true)"
fi
SUPERVISOR_TOKEN="${EXISTING_SUPERVISOR_TOKEN:-$(openssl rand -base64 32)}"
COMPUTER_TOKEN="${COMPUTER_TOKEN:-${EXISTING_COMPUTER_TOKEN:-}}"
if [ -n "$CPUS" ]; then SLICE_CPUS="$CPUS"; else SLICE_CPUS="${EXISTING_CPUS:-$(( $(nproc) / 2 ))}"; fi
if [ -n "$MEMORY_GB" ]; then SLICE_MEMORY_BYTES=$(( MEMORY_GB * 1024 * 1024 * 1024 ));
else SLICE_MEMORY_BYTES="${EXISTING_MEM:-$(( $(free -g | awk '/^Mem:/{print $2}') / 2 * 1024 * 1024 * 1024 ))}"; fi
umask 077
cat > "$ENV_FILE" <<EOF
# Written by scripts/install-node.sh. This machine's slice and the secrets its supervisor holds.
PORT=$PORT
HOST=$TAILNET_IP
COMPUTER_BACKEND=docker
COMPUTER_PUBLISH_HOST=$TAILNET_IP
COMPUTER_NAMESPACE=slice
COMPUTER_IMAGE=openbot-agent-computer:latest
COMPUTER_RUNTIME=$RUNTIME
SUPERVISOR_TOKEN=$SUPERVISOR_TOKEN
COMPUTER_TOKEN=$COMPUTER_TOKEN
SLICE_CPUS=$SLICE_CPUS
SLICE_MEMORY_BYTES=$SLICE_MEMORY_BYTES
EOF

info "4/5 supervisor service (systemd --user)"
UNIT_DIR="$HOME/.config/systemd/user"
mkdir -p "$UNIT_DIR"
cat > "$UNIT_DIR/slice-supervisor.service" <<EOF
[Unit]
Description=Slice supervisor: one computer per agent, on this machine's slice
After=network-online.target docker.service

[Service]
EnvironmentFile=$ENV_FILE
WorkingDirectory=$ROOT/supervisor
ExecStart=$BUN $ROOT/supervisor/src/index.ts
Restart=always
RestartSec=3
StandardOutput=append:$STATE/logs/supervisor.log
StandardError=append:$STATE/logs/supervisor.log

[Install]
WantedBy=default.target
EOF
systemctl --user daemon-reload
systemctl --user enable --now slice-supervisor.service >/dev/null
systemctl --user restart slice-supervisor.service
loginctl enable-linger "$USER" 2>/dev/null || sudo -n loginctl enable-linger "$USER" 2>/dev/null || true

info "5/5 health"
for _ in $(seq 1 40); do
  if curl -fsS "http://$TAILNET_IP:$PORT/v1/health" >/dev/null 2>&1; then break; fi
  sleep 0.5
done
curl -fsS "http://$TAILNET_IP:$PORT/v1/health" >/dev/null 2>&1 || fail "The supervisor did not answer on $TAILNET_IP:$PORT. Log: $STATE/logs/supervisor.log"

echo
echo "This machine is a Slice node. Supervisor: http://$TAILNET_IP:$PORT (tailnet only)."
echo "Slice: $SLICE_CPUS cores / $(( SLICE_MEMORY_BYTES / 1024 / 1024 / 1024 )) GiB."
echo
echo "On the server, mint a token and enroll this node:"
echo "  slice node token"
echo "  slice node join http://127.0.0.1:3001 <token> --id $(hostname -s | tr 'A-Z' 'a-z') \\"
echo "    --supervisor-url http://$TAILNET_IP:$PORT --supervisor-token '$SUPERVISOR_TOKEN' --backend docker"
