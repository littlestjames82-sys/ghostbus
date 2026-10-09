# Changelog

## 0.5.1 — 2026-10-09

Reliability fix — the operation-level race above the v0.4.1 FileStore fix:

- **Per-Bus mutation mutex** — every public operation on a `GhostBus` (register/heartbeat, message send, task create/claim/complete/comment, file put/delete, capsule/context writes, token ops, snapshot restore, and reads) now runs its whole load → mutate → save cycle inside a per-instance promise-chain mutex (`_serialized` in src/core.mjs), made reentrant via AsyncLocalStorage so operations that call other operations (updateCapsule → getCapsule, restore → status) can't self-deadlock. Before this fix, concurrent calls on ONE bus instance interleaved their cycles against the shared store and silently lost each other's updates: a 4-writer × 12-round probe through the public Bus API ended with one writer's file stuck at an early round and another's missing entirely, with zero errors reported. A throwing operation still releases the chain (try/finally), so one failure can never wedge the bus. Public API and behavior are unchanged.
- **Scope boundary, honestly** — the mutex serializes operations within one Bus instance in one process. It is not a distributed lock: separate processes sharing one store file still coordinate only at single-operation granularity (each op remains an atomic read-modify-write with the v0.4.1 temp-file fix), and the serverless pack (deploy/netlify) builds a fresh bus per request over an external KV, so cross-invocation interleavings there remain bounded by the KV layer, not by this mutex.
- **Regression tests in the main suite** — three new checks: concurrent writers lose no updates (4 writers × 12 rounds, verified on disk via a fresh instance), concurrent mixed ops (tasks + messages + files at once) all land with unique task ids, and a throwing operation releases the mutex (with a wedge timeout). All three fail on the pre-fix core (44 passed, 3 failed) and pass with the fix.
- 47 checks in the main suite (was 44) + 6 serverless, all passing; both demos green.

## 0.5.0 — 2026-10-08

The operator release — running a hosted bus day-to-day:

- **Workspace key rotation** (hosted, admin) — `POST /api/workspaces/<id>/rotate-key` returns a fresh key once and invalidates the old key *immediately* (the cached workspace meta is refreshed in-process; no restart, no grace period). `keyRotatedAt` is stamped in the registry.
- **Workspace export / import** (hosted, admin) — `GET /api/workspaces/<id>/export` returns the full workspace state (agents, messages, tasks, files, capsules, context, provenance log) as one versioned envelope; `POST /api/workspaces/import` recreates it on any host under the same or a new id, always with a **fresh** key. The export can never leak a workspace key: keys exist only as hashes in the registry, which is not part of the state, and agent tokens travel as the hashes already at rest. Existing ids are refused (409); malformed snapshots are refused (400) by the new shared `validateSnapshot`.
- **Core snapshot/restore** — `bus.snapshot()` (deep-cloned state) and `bus.restore(state)` (shape-validated, workspace identity preserved, restore recorded as a `workspace.restore` provenance event) power the hosted endpoints and the new CLI commands: `ghostbus-cli export <file>` / `ghostbus-cli import <file>` for server-free backup and migration between store files.
- **Race regression in the main suite** — the v0.4.1 FileStore fix now has a permanent test: 60 concurrent saves across two store instances on one file must all resolve, leave valid JSON, and leave no temp files behind. (The standalone cross-process stress proof remains in the repo history.)
- 44 checks in the main suite (was 41) + 6 serverless, all passing; both demos green.

## 0.4.1 — 2026-10-08

Reliability + deploy-assets release:

- **FileStore race fixed** — `FileStore.save()` (src/core.mjs) and `saveRegistry()` (src/hosted-server.mjs) both wrote to one fixed `<file>.tmp` then renamed; concurrent writers collided (first rename wins, the rest failed ENOENT, seen live as HTTP 400s during a Ghost Hands bus demo). Fix: unique temp name per save (pid + random suffix), saves serialized per FileStore instance via a promise chain, temp cleaned up in a finally block. Stress proof: original code failed 59/60 concurrent in-process saves and 39–40/40 in each of two cross-process runs; fixed code: 0 failures in all runs, final file valid JSON.
- **Docker deploy assets shipped** — `deploy/docker/docker-compose.yml` (hosted server with persistent volume + restart policy, admin key via env) and `deploy/docker/vps-setup.sh` (one-shot Ubuntu setup: installs Docker, clones the repo, generates a root-only admin key, builds + runs, prints the first-workspace command).
- **Hosted smoke verified** — the exact hosted runtime config (admin key + data dir) exercised end to end: health, workspace creation (one-time key), two agents registering, task create → claim → complete, probe counts, cross-workspace key isolation (401), board 200, state files persisted.
- Suites: 41/41 main + 6/6 serverless, unchanged and green.

## 0.4.0 — 2026-10-07

M2 — hosted, multi-workspace:

- **Hosted server** (`src/hosted-server.mjs`) — one process, many isolated workspaces under `/w/<id>/` (board, REST, MCP, SSE, long-poll, probe). Admin API creates/lists/deletes workspaces; creation returns a per-workspace key **once** (only its SHA-256 is kept in the registry); the admin key doubles as an operator master key. Isolation is tested: another workspace's key gets 401, and no agents/tasks/files cross over.
- **Shared handler** — the relay's HTTP logic was extracted to `src/handler.mjs` and now powers both the single-workspace relay and the hosted server; the full pre-existing suite (40 checks) stayed green through the refactor.
- **Serverless pack** (`deploy/netlify/`) — the same multi-workspace semantics as a Netlify Function over Blobs (strong consistency), logic in a KV-injected `lib.mjs` unit-tested with an in-memory KV through real Web Request/Response objects (6 checks). Board/SSE/long-poll are documented as unavailable serverless rather than faked.
- **Docker** — `deploy/docker/Dockerfile` for the hosted server; operator guide in `docs/hosted.md`.
- 41 checks in the main suite (+1 hosted end-to-end) and 6 serverless checks, all passing locally and in CI.

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
