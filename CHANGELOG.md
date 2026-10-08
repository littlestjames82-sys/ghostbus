# Changelog

## 0.3.0 — 2026-10-07

The collaboration-depth release:

- **Capsules** — structured project memory as a first-class object (`workspace_get_capsule` / `workspace_update_capsule`): State / Decisions (locked) / Next / Session log, section updates that preserve the rest, session-log appends stamped by agent. The pattern that made Ghost Bridge's capsules the shared brain between two agents, generalized.
- **Task dependencies** — `blockedBy` on task creation; claiming a task whose blockers aren't done/cancelled fails with `BLOCKED`. Unknown blockers are rejected at creation.
- **Sync** — `bus_sync` returns every event after a sequence cursor (`headSeq` included): an agent that was offline replays exactly what it missed.
- **Shared store that actually shares** — file-backed buses now re-read the store on every call, so multiple processes (several stdio servers, the CLI, a relay) on one workspace file see each other's writes, with atomic per-operation replace. Proven by a two-instance test and a live CLI→relay wake-hook run.
- **Long-poll** — `GET /api/wait?agent=…` for agents that can't hold SSE: returns immediately on backlog, otherwise holds until a relevant event lands.
- **Wake-hook example** — `examples/wake-hook/` (fingerprint + 20-minute stale re-wake, the production Ghost Bridge pattern), verified live.
- **File history** — every shared file keeps its last 10 versions (`workspace_file_history`); `workspace_get_file` stays lean.
- **Relay hygiene** — per-IP rate limit (300/min), `nosniff`/`referrer-policy` headers.
- 40 automated checks (was 34). The suite caught three real bugs this round: a silently-missed dependency check, capsule listing semantics, and long-poll firing on backlog instead of new events — all fixed and re-verified.

## 0.2.0 — 2026-10-07 (first public release)

Everything in 0.1.0, plus the hardening a public bus needs:

- **Per-agent tokens** — registration issues a token once (only its SHA-256 is stored). With `GHOSTBUS_REQUIRE_TOKENS=1`, acting under a registered name requires its token; rotation supported (`bus_rotate_token`). Caught in testing: recipient/assignee existence checks never demand the *other* agent's token.
- **Live push (SSE)** — `GET /api/stream?agent=<name>` pushes events (with a message excerpt) to subscribers instead of polling; workspace-wide task/file events go to everyone, direct messages only to their parties.
- **Web board** — the relay serves a live board UI at `/` (agents + presence, open tasks, files, activity; asks for the workspace key in-page).
- **Search** — `bus_search` / `GET /api/search` across messages, tasks, and files.
- **Task comments** — discussion lives on the task (`bus_comment_task`).
- **Presence** — `bus_heartbeat`, online/away on agent listings; token hashes never exposed.
- **Terminal CLI** — `ghostbus-cli` drives any workspace from the shell (status, register, send, inbox, tasks, claim/complete, board, search, files).
- **Channels list**, **file delete**, docs (`docs/client-setup.md`: Claude/Cursor/Antigravity/Windsurf setup, token mode, wake-hook pattern), a three-agent team demo, and GitHub Actions CI (Node 20 + 22) and an npm Trusted-Publishing workflow.
- 34 automated checks: core, token enforcement, persistence, MCP stdio E2E, HTTP auth, board UI, SSE delivery, CLI.

## 0.1.0 — 2026-10-07 (M0, pre-release)

Core bus: agent registry, direct/broadcast/threaded messages with read receipts, claimable tasks (exclusive 15-minute leases, assignee guard, needs-approval gate), shared files/context, rendered board, provenance event log. 19 MCP tools over stdio; HTTP relay (REST + `/mcp`) with optional workspace key and a counts-only `/probe`. Zero dependencies.
