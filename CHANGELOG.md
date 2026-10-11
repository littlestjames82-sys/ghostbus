# Changelog

## 0.5.3 — 2026-10-11

Security hardening, round 2 — the layer under the v0.5.2 defaults. v0.5.2 made enforcement the default; this round removes the sharp edges an attacker could still lean on: non-timing-safe secret compares, unthrottled key guessing at the hosted layer, unbounded request bodies, framable HTML pages, world-readable data files, and internal error text leaking to clients.

- **Timing-safe secret comparisons everywhere** — the hosted router compared workspace keys with `sha256(given) === meta.keyHash` (plain `===` on a digest), and the core compared agent-token hashes the same way. Both now use `crypto.timingSafeEqual` over the digests (new exported `hashMatches` in `src/handler.mjs`, shared by the router, the core token check, and the serverless pack, whose `wsKeyOk` had the same plain compare). A full-codebase audit found no other secret comparisons.
- **Failed-auth throttle at the hosted layer** (`src/hosted-server.mjs`) — the handler's 300 req/min limiter only throttles traffic already inside a workspace; nothing slowed down guessing admin or workspace keys. Now: 30 failed auth attempts per minute per IP → `429` on the admin surface and on workspace routes until the window rolls. Successful auth never counts; `/health` and `/probe` stay open so an operator can watch an attack happen.
- **Request bodies capped at 1 MB** (`readJsonBody` in `src/handler.mjs`) — both body readers accumulated without a cap (past a 5 MB socket-destroy with no useful response). One shared reader now enforces a commented `MAX_BODY_BYTES = 1_000_000` on hosted admin routes, in-workspace routes, and the single relay; over the cap the client gets a clean `413` JSON error and the socket is dropped after the response. File contents travel as JSON in GhostBus, so legitimate traffic fits comfortably; a workspace *import* over 1 MB must be restored from a state file / the CLI instead of over HTTP (stated in `docs/hosted.md`).
- **HTML pages carry frame/CSP protection** — the board (`src/handler.mjs`) and the hosted landing page are served with `X-Frame-Options: DENY` and a `Content-Security-Policy`: `default-src 'self'`, `frame-ancestors 'none'`, `object-src 'none'`. Both pages are single self-contained documents (inline script/style, same-origin fetches, zero external resources), so the CSP allows `'unsafe-inline'` for script/style specifically — no eval, no external origins.
- **Data files are written 0600** — the registry and workspace state files hold every key/token hash; `FileStore.save` (core, so the single relay benefits too) and `saveRegistry` plus the hosted import write now create their temp files with mode 0600 (plus a chmod before the atomic rename), and the mode rides through the rename. Existing files tighten on their next save.
- **Error hygiene** — the single relay and the hosted server returned raw `e.message` in 500s. Both now log the real error (with stack) to stderr and answer a generic `{ error: 'internal error' }`. The handler's 400s are unchanged on purpose: those are deliberate, client-facing validation/auth errors thrown by the core, not internal faults.
- **Admin audit log** (`src/hosted-server.mjs`) — every admin action (workspace create, delete, rotate-key, export, import) emits one structured stderr line: timestamp, action, workspace id, source IP. Never a key, never a hash. On a paid host, that stderr stream is the operator's audit trail.
- **SECURITY.md** — new at the repo root: latest-release-only support, private reporting to gdev6145@gmail.com, one-business-day acknowledgement (the studio's stated support posture), and scope notes.
- **Tests** — three new checks (54 in the main suite, was 51): HTML headers + 0600 file modes + audit lines (create/rotate/delete, asserting no key material appears in stderr); the 1 MB cap returning 413 on hosted-admin, in-workspace, and single-relay routes; and the failed-auth throttle (30 bad keys → 401 each, then even the correct key → 429, admin too, health still 200). All three fail against the 0.5.2 servers (51 passed, 3 failed, each for its intended reason) and pass with the change; serverless stays 6/6 and both demos green. The timing-safe change is covered functionally by the existing right-key/wrong-key checks at every layer — a timing side channel is not observable from a functional test, so that one is verified by the audit above rather than a red/green run.
- **Scope boundary, honestly** — what did NOT change: no API or behavior change for legitimate clients; storage format and locations; the local stdio/CLI trust model; the serverless pack's opt-in token posture (only its key compare was aligned); the deferred networked multi-writer store is still future work. One judgment call to know about: throttling is per-IP and in-memory — behind a shared NAT, one guesser can 429 a whole office's *unauthenticated* attempts for a minute; authenticated traffic with a valid key is only blocked while the throttle is tripped, and the window is short by design.

## 0.5.2 — 2026-10-11

Security hardening — the pre-pilot pass. A cold source review scored GhostBus 7.4/10 with security maturity its lowest mark (5.5/10, "authentication enforcement and deployment hardening need attention"). That was the right call to answer before any hosted workspace carries a stranger's work — or their money:

- **Hosted: per-agent token enforcement is now the DEFAULT** (`src/hosted-server.mjs`) — every workspace bus is created with enforcement on, no env var needed. The only opt-out is an explicit `GHOSTBUS_REQUIRE_TOKENS=0`, and using it prints a loud three-line stderr warning at startup (with enforcement off, anyone holding a workspace key can act under any agent name). Header comment updated to match.
- **Hosted: admin-key floor** — the hosted server already refused to start without `GHOSTBUS_ADMIN_KEY`; it now also refuses keys shorter than 16 characters (exit 2). The admin key is operator root (creates/deletes workspaces, master key inside all of them) and gets a floor to match. Storage/rotation guidance (root-only file, chmod 600, rotate by restart) is documented in `docs/hosted.md`.
- **Single relay: exposure is never silent** (`src/http-server.mjs`) — Node's `listen()` binds all network interfaces, not just loopback. Starting the relay without `GHOSTBUS_KEY` now prints a loud warning saying exactly that; with a key but token enforcement off, a one-line warning names the impersonation trade-off. Semantics unchanged: local trust is still the relay's default model.
- **Docs** — new "Security & deployment hardening" section in `docs/hosted.md`: enforcement default + opt-out, HTTPS REQUIRED for any public deployment (reverse proxy or a *named* Cloudflare Tunnel; a quick tunnel is explicitly not for paid use), admin-key storage/rotation, per-workspace key handling, scheduled export backups. README hosted section points at it.
- **Tests** — the two existing hosted checks now present the tokens issued at registration (they exercise the enforced path, as real clients now must), and four new checks cover the pass: default-on enforcement over real HTTP (no token → 400, wrong token → 400, issued token → 200, header and body forms), the `=0` opt-out + its startup warning, the short-admin-key refusal, and the relay's no-key warning. All four fail against the 0.5.1 servers (47 passed, 4 failed) and pass with the change.
- **Scope boundary, honestly** — what did NOT change: core bus behavior, the local stdio/CLI trust model (tokens stay opt-in there via `GHOSTBUS_REQUIRE_TOKENS=1`), the single relay's opt-in posture beyond the new warnings, storage (memory/JSON file; a networked multi-writer store is still future work, not faked here), and the serverless pack (its `GHOSTBUS_REQUIRE_TOKENS` env remains opt-in). The hosted `open` surfaces — board page, `/health`, `/probe` — were audited, not changed: every workspace is always created with a key and no data route bypasses it; the three open paths serve the static board shell, liveness, and counts-only probe data, the same posture as the single relay, and are documented as such.
- 51 checks in the main suite (was 47) + 6 serverless, all passing; both demos green.

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
