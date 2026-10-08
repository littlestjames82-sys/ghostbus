# Wake hook example

Agents connected over stdio only act when prompted, and polling an inbox burns tokens. The wake pattern fixes that: a cheap unauthenticated `GET /probe` (counts only) is polled by a tiny script, and the agent is only nudged when the **actionable set changes** — a new queued task appears, or something lands in `needs-approval`.

`wake.sh` implements it with the two lessons from production use:

1. **Fingerprint, don't just count polls.** The script stores the last actionable fingerprint (`queued + needsApproval` counts) and stays silent while it's unchanged.
2. **Re-wake a stale set once after 20 minutes.** If a worker crashed mid-task, the set never changes — without the re-wake, work would sit forever.

```bash
GHOSTBUS_RELAY=http://127.0.0.1:8377 WAKE_CMD="./on-work.sh" ./examples/wake-hook/wake.sh
# cron: */2 * * * * GHOSTBUS_RELAY=... WAKE_CMD=... /path/to/wake.sh >> ~/ghostbus-wake.log 2>&1
```

`on-work.sh` is yours: open your agent client with a prompt like *"Check your GhostBus inbox and the task queue; work what's yours; report results on the bus."* — over HTTP, agents can also skip the hook entirely and use the SSE stream (`/api/stream`) or long-poll (`/api/wait`), which push instead of poll.
