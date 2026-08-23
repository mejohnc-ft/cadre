#!/bin/sh
#
# Claude Code PreToolUse hook: ask the deployment before the harness touches anything.
#
# Claude Code hands the intended tool call on stdin. This posts it to the server's gateway, which
# evaluates the deployment's boundaries and writes the audit row, and answers allow or refuse.
# Exit 2 refuses and hands the reason to the model; anything that is not an explicit yes — a
# refusal, a server that cannot be reached, a malformed answer — refuses. Fail closed.
#
# Environment (set by the harness adapter for every run):
#   SLICE_SERVER_URL       where the server is reached from inside this computer
#   SLICE_BOT_ID           which Bot this computer is
#   SLICE_COMPUTER_TOKEN   the shared computer secret, proving this call comes from a computer
#   SLICE_RUN_ID           the run, for the audit row
set -u
input="$(cat)"

if [ -z "${SLICE_SERVER_URL:-}" ]; then
  echo "Refused by Slice: this computer has no route to the deployment's policy, so no tool may run." >&2
  exit 2
fi

answer="$(printf '%s' "$input" | curl -sS --max-time 15 \
  -X POST "$SLICE_SERVER_URL/api/harness/$SLICE_BOT_ID/decide" \
  -H "content-type: application/json" \
  -H "x-openbot-computer-token: $SLICE_COMPUTER_TOKEN" \
  -H "x-openbot-run-id: ${SLICE_RUN_ID:-}" \
  --data-binary @- 2>/dev/null)" || {
  echo "Refused by Slice: the deployment's policy could not be reached, so the action was not allowed." >&2
  exit 2
}

verdict="$(printf '%s' "$answer" | python3 -c '
import json, sys
try:
    body = json.load(sys.stdin)
except Exception:
    print("refuse\tThe policy answer could not be read."); sys.exit(0)
if body.get("allowed") is True:
    print("allow\t")
else:
    print("refuse\t" + str(body.get("reason") or body.get("error") or "Refused by policy."))
')"

case "$verdict" in
  allow*) exit 0 ;;
  *)
    printf '%s\n' "Refused by Slice policy: ${verdict#refuse	}" >&2
    exit 2
    ;;
esac
