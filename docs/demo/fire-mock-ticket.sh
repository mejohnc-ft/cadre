#!/bin/sh
# Fires the seeded CentrexAI onboarding ticket at Incident Buddy.
curl -s -X POST "http://127.0.0.1:3001/api/hooks/trg-06929397-9ee" \
  -H "X-Cadre-Token: cadre-hook-6CPFbyRCEM4BGA6XBZzMP7eC" \
  -H "content-type: application/json" \
  --data @"$(dirname "$0")/centrexai-mock-ticket.json"
echo
