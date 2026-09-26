#!/bin/sh
# Fires the sample onboarding ticket at a Cadre trigger, as a PSA or RMM would.
# CADRE_HOOK_URL:   the trigger's webhook, e.g. http://127.0.0.1:3001/api/hooks/<trigger-id>
# CADRE_HOOK_TOKEN: the trigger's token (shown once when the trigger is created)
: "${CADRE_HOOK_URL:?set CADRE_HOOK_URL}" "${CADRE_HOOK_TOKEN:?set CADRE_HOOK_TOKEN}"
curl -s -X POST "$CADRE_HOOK_URL" \
  -H "X-Cadre-Token: $CADRE_HOOK_TOKEN" \
  -H "content-type: application/json" \
  --data @"$(dirname "$0")/onboarding-mock-ticket.json"
echo
