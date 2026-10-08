#!/usr/bin/env bash
# GhostBus wake hook — poll a relay's /probe and run a command when the
# actionable set CHANGES (new queued task, or a task lands in needs-approval).
# The same fingerprint pattern Ghost Bridge ran in production:
#   - unchanged set     -> silent, exit 0
#   - same set >20 min  -> re-wake once (crash safety: a worker may have died)
#   - changed set       -> run $WAKE_CMD with $GHOSTBUS_ACTIONABLE ids in env
#
# Usage (cron every 2 min, or a loop):
#   GHOSTBUS_RELAY=http://127.0.0.1:8377 WAKE_CMD="./on-work.sh" ./wake.sh
# State: ~/.ghostbus-wake-state (fingerprint + timestamp). Stdout is for logs.
set -euo pipefail
RELAY="${GHOSTBUS_RELAY:-http://127.0.0.1:8377}"
STATE="${GHOSTBUS_WAKE_STATE:-$HOME/.ghostbus-wake-state}"
NOW=$(date +%s)

PROBE=$(curl -fsS --max-time 10 "$RELAY/probe") || { echo "probe failed — relay down?"; exit 0; }
QUEUED=$(echo "$PROBE" | python3 -c "import json,sys; print(json.load(sys.stdin)['queued'])")
APPROVAL=$(echo "$PROBE" | python3 -c "import json,sys; print(json.load(sys.stdin)['needsApproval'])")
FPRINT="q${QUEUED}_a${APPROVAL}"

PREV=""; PREV_AT=0
[ -f "$STATE" ] && { read -r PREV PREV_AT < "$STATE" || true; }

if [ "$FPRINT" = "$PREV" ]; then
  AGE=$(( NOW - ${PREV_AT:-0} ))
  if [ "$QUEUED" -eq 0 ] && [ "$APPROVAL" -eq 0 ]; then exit 0; fi
  if [ "$AGE" -lt 1200 ]; then exit 0; fi
  echo "re-wake: same actionable set for ${AGE}s (crash safety)"
else
  echo "wake: actionable set changed ($PREV -> $FPRINT)"
fi

echo "$FPRINT $NOW" > "$STATE"
if [ -n "${WAKE_CMD:-}" ]; then
  GHOSTBUS_QUEUED="$QUEUED" GHOSTBUS_NEEDS_APPROVAL="$APPROVAL" bash -c "$WAKE_CMD"
else
  echo "WAKE_CMD not set — would wake now (queued=$QUEUED needsApproval=$APPROVAL)"
fi
