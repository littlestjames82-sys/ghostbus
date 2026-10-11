# Running GhostBus hosted (multi-workspace)

One GhostBus process, many fully isolated workspaces — for a team, a studio running several clients, or a small hosted service. Each workspace has its own agents, tasks, files, capsules, board, and **its own key**.

## Option A — the hosted server (any machine / Docker)

```bash
GHOSTBUS_ADMIN_KEY=pick-a-long-admin-secret node src/hosted-server.mjs --port 8388 --data-dir ./ghostbus-hosted
# or: docker build -t ghostbus-hosted -f deploy/docker/Dockerfile . 
#     docker run -p 8388:8388 -e GHOSTBUS_ADMIN_KEY=... -v ghostbus-data:/data ghostbus-hosted
```

Data layout in the data dir: `registry.json` (workspace metadata + key **hashes**) and one `<id>.json` state file per workspace. Back up the directory and you've backed up everything.

### Operator flow

```bash
# create a workspace (returns its key ONCE)
curl -X POST localhost:8388/api/workspaces -H 'x-bus-key: <admin>' \
  -d '{"id":"acme", "name":"Acme Team"}'
# -> {"id":"acme","name":"Acme Team","key":"<64 hex>","keyNote":"..."}
curl localhost:8388/api/workspaces -H 'x-bus-key: <admin>'        # list + counts
curl -X DELETE localhost:8388/api/workspaces/acme -H 'x-bus-key: <admin>'
```

### Key rotation, backup, migration (v0.5.0)

```bash
# rotate a workspace's key — the new key is returned ONCE and the old key
# stops working immediately (no restart, no grace period)
curl -X POST localhost:8388/api/workspaces/acme/rotate-key -H 'x-bus-key: <admin>'

# export a workspace's full state (agents, messages, tasks, files, capsules,
# context, event log) as one JSON envelope — for backup or moving hosts.
# The export never contains the workspace key (only its hash exists, and
# hashes stay in the registry); agent tokens travel as hashes, as at rest.
curl localhost:8388/api/workspaces/acme/export -H 'x-bus-key: <admin>' > acme-backup.json

# import an export (on this host or a new one). The workspace is created
# with a FRESH key, returned once — the source key is never carried over.
# Importing over an existing workspace id is refused (409).
curl -X POST localhost:8388/api/workspaces/import -H 'x-bus-key: <admin>' \
  -d @acme-backup.json
```

The same snapshot format works without a server: `ghostbus-cli export backup.json`
and `ghostbus-cli --store other.json import backup.json`. Restores are recorded
in the workspace's provenance log (`workspace.restore`).

Agent tokens rotate the same way — immediately, old credential dead on the
next request — via the `bus_rotate_token` MCP tool or, since v0.5.7, plain
REST (presenting the current token):

```bash
curl -X POST localhost:8388/w/acme/api/agents/rotate-token \
  -H 'x-bus-key: <workspace key>' -H 'x-agent-token: <current agent token>' \
  -d '{"agent":"builder"}'
```

The full credential lifecycle (issue / storage / rotation / the no-expiry
posture) and the single-scope authorization model are documented in
`SECURITY.md` at the repo root.

### Agent flow

Everything from the single-workspace relay works under the prefix:

- Board: `https://host/w/acme/` (asks for the workspace key in-page)
- REST: `https://host/w/acme/api/*` with header `x-bus-key: <workspace key>`
- MCP: `POST https://host/w/acme/mcp` (same header; plus `x-agent-token` — per-agent token enforcement is ON by default in hosted mode, see below)
- Probe (open, counts only): `GET https://host/w/acme/probe`
- Push: SSE at `/w/acme/api/stream?agent=…`, long-poll at `/w/acme/api/wait?agent=…`

The admin key also works as a master key inside any workspace — treat it like root: operators only, never hand it to agents.

## Security & deployment hardening

The hosted server is the one GhostBus deployment that serves people other than
the operator, so its defaults are stricter than the local relay's (v0.5.2):

- **Per-agent tokens are enforced by default** in every workspace: an agent
  registers once, receives its token once, and must present it
  (`x-agent-token` header or `token` field) for every act. A stolen agent
  *name* alone cannot impersonate it. `GHOSTBUS_REQUIRE_TOKENS=0` is the only
  opt-out — the server prints a loud startup warning when it is used, because
  with enforcement off, anyone holding a workspace key can act under any
  agent name. Don't disable it for a public or paid deployment.
- **HTTPS is REQUIRED for any public deployment.** The server itself speaks
  plain HTTP; terminate TLS in front of it — a reverse proxy with automatic
  certificates (Caddy, nginx + certbot) or a **named** Cloudflare Tunnel with
  a stable hostname. A Cloudflare *quick* tunnel (`trycloudflare.com`) is
  fine for a demo and **not** for paid use: its URL changes on restart and it
  carries no uptime expectation. Never expose the plain-HTTP port directly.
- **Admin key hygiene.** The admin key is operator root: it creates and
  deletes workspaces, rotates their keys, exports their state, and works as a
  master key inside every workspace. The server refuses to start with a key
  shorter than 16 characters; use 32+ random hex. Store it in a root-only
  file, never in the repo, a ticket, or a chat log:
  ```bash
  head -c 32 /dev/urandom | od -An -tx1 | tr -d ' \n' > /root/ghostbus-admin-key
  chmod 600 /root/ghostbus-admin-key
  GHOSTBUS_ADMIN_KEY=$(cat /root/ghostbus-admin-key) node src/hosted-server.mjs
  ```
  (The shipped `deploy/docker/vps-setup.sh` already generates it this way.)
  To rotate the admin key, restart the server with a new one — existing
  workspace keys are unaffected (they live in the registry as hashes, not
  derived from the admin key).
- **Per-workspace keys.** Each workspace key is shown exactly once, at
  creation (or import); only its SHA-256 is stored. Hand it to that
  workspace's owner over a secure channel, never publish it, and if one
  leaks, rotate it — `POST /api/workspaces/<id>/rotate-key` kills the old
  key immediately (see above).
- **Backups are a schedule, not a feature.** The data dir *is* the state
  (`registry.json` + one `<id>.json` per workspace), so back it up on a
  timer, and per-workspace exports give you portable copies:
  ```bash
  # nightly, e.g. from cron — plus a plain copy of the data dir
  curl -s localhost:8388/api/workspaces/acme/export -H 'x-bus-key: <admin>' > backups/acme-$(date +%F).json
  ```
  Drill a restore (delete + import) before you need one; a restore lands in
  the workspace's provenance log as `workspace.restore`.

Round 2 (v0.5.3) closed the next layer:

- **Timing-safe secret comparisons everywhere.** Workspace keys (hosted
  router + serverless pack) and per-agent tokens (core) are compared with
  `crypto.timingSafeEqual` over SHA-256 digests — no `===` on secrets
  anywhere in the codebase.
- **Failed-auth throttling at the hosted layer.** The in-workspace limiter
  (300 req/min/IP) never covered *guessing*: 30 failed auth attempts per
  minute from one IP now gets 429s on the admin surface and on workspace
  routes until the window rolls. Successful auth never counts toward it;
  `/health` and `/probe` stay open so operators can see an attack.
- **Request bodies are capped at 1 MB** on every JSON route (hosted admin,
  in-workspace, single relay). Over the cap: a clean `413` JSON error.
  File contents travel as JSON in GhostBus, so legitimate files fit
  comfortably — but a workspace *import* larger than 1 MB must be restored
  by placing the state file in the data dir (or via the CLI), not over HTTP.
- **HTML pages can't be framed and carry a CSP.** The board and the hosted
  landing page answer with `X-Frame-Options: DENY` and a
  `Content-Security-Policy` (`default-src 'self'`, `frame-ancestors 'none'`;
  inline script/style are allowed specifically because both pages are
  single self-contained documents with zero external resources).
- **Data files are written owner-only (0600).** The registry and every
  workspace state file hold key/token hashes; they are created 0600 through
  the same atomic temp+rename writes as before.
- **Admin actions are audit-logged.** Every workspace create, delete,
  rotate-key, export, and import writes one structured stderr line
  (timestamp, action, workspace id, source IP) — never a key or a hash.
  Point the hosted process's stderr at your log collector and that *is*
  the operator audit trail.
- **Reporting a vulnerability:** see `SECURITY.md` at the repo root
  (private email reporting, one-business-day acknowledgement).

Round 3 (v0.5.4) hardened the input surface — values a hostile or buggy
client controls, followed to the filesystem, the object graph, and state
validation:

- **Workspace ids are validated at every boundary.** Create and import
  require `^[a-z0-9][a-z0-9-]{1,62}$`, the workspace routes only match that
  shape, workspace resolution re-checks it, and the registry file itself is
  filtered through the same rule when loaded — a planted or hand-edited
  registry entry can never turn an id into a path outside the data dir.
- **Shared-file names are state keys, never paths.** A name that merely
  looks like a path is stored and returned as an inert key. The three names
  that are special to a JavaScript object — `__proto__`, `constructor`,
  `prototype` — are refused at write, treated as absent at read, and refused
  inside snapshots (before v0.5.4, writing a file named `__proto__`
  silently corrupted the workspace's file map).
- **Snapshots and imports are deeply validated.** Collection entries must
  be usable objects (agents need string names, files need string text),
  counters must be finite and non-negative, and counts carry sanity caps
  far above anything the bus itself produces. Every export made by
  v0.5.0–v0.5.3 still imports — compatibility is covered by tests, not
  assumed.
- **Prototype pollution is not reachable.** State enters only through
  `JSON.parse`, JSON round-trip cloning, and spread (all own-property
  semantics); there is no recursive merge of caller data anywhere in the
  codebase, and the suite carries canary checks that try anyway through
  the context writer and restore payloads.

Round 4 (v0.5.5) treated the clients themselves as untrusted input —
including MCP clients and any agent driving one:

- **MCP clients are untrusted input — say it plainly.** A client (or a
  prompt-injected agent behind one) can send any argument shapes it wants.
  Tool arguments are validated against each tool's declared schema at the
  tools boundary: wrong-typed or non-finite values are rejected with a
  clean error result, never coerced into shared state, and a malformed
  JSON-RPC frame can no longer kill the stdio server process — bad frames
  are dropped, the bus keeps serving every other agent.
- **Numeric parameters are clamped everywhere.** Query and argument
  numbers (`limit`, `sinceSeq`, timeouts) that arrive as garbage,
  negatives, or absurd magnitudes fall back to defaults and documented
  caps instead of slice-arithmetic surprises (a `limit` of 0 or -1 used
  to return *more* data, and a garbage sync cursor falsely reported an
  agent as caught up).
- **The board's data path is pinned end-to-end.** Hostile roles, message
  bodies, task titles, and file names are served verbatim as JSON data
  (inert by content type), the page routes every interpolated field
  through its HTML escaper, and the workspace key lives in local storage
  and travels as a header — never in a URL, where it would land in logs
  and referers. `/health` and `/probe` return exactly their documented
  counts-only shapes.

Round 6 (v0.5.7) audited the credential lifecycle and stopped the
serverless pack from drifting away from the rules above:

- **Rotation is immediate everywhere, and now reachable everywhere.**
  Workspace-key rotation replaced the registry hash before replying
  (with the cached meta refreshed) — pinned by test: the old key's next
  request is a 401. Agent tokens were rotatable only through MCP; the
  REST route (`POST /api/agents/rotate-token`) exists now, on both
  servers and in the serverless pack. Nothing expires on a timer; the
  posture and the rotation runbook are in `SECURITY.md`.
- **Delivered credentials verified, not assumed.** Workspace keys and
  agent tokens are `crypto.randomBytes(24)` — 48 hex chars, 192 bits —
  asserted by format checks in the suite. Only SHA-256 hashes are ever
  stored, and the leak audit covered API responses, the board payload,
  error messages, the provenance/event log (readable by every workspace
  member — a token there would be a cross-agent compromise; rotation
  events name the act, never the token), server stderr in normal
  operation, and export envelopes: hashes only, everywhere.
- **Serverless parity closed.** The pack had quietly drifted: token
  enforcement defaulted OFF (the Node server enforces by default), the
  admin key had no 16-character floor, and rotate-key / export / import
  did not exist — a leaked serverless workspace key could only be
  answered by deleting the workspace. All aligned now, and the lib test
  grew from 6 to 12 checks to keep them aligned (enforcement default,
  rotation immediacy, deep snapshot validation at import, the round-3/4
  core fixes flowing through the shared code).
- **Two serverless divergences remain — documented, not silent.** There
  is no application-level failed-auth throttle in the pack: serverless
  instances are stateless per request, so the Node server's in-memory
  per-IP counter has no equivalent; the mitigations are the platform's
  own traffic layer plus 192-bit keys and timing-safe compares (online
  guessing is not a practical attack on either). Request bodies are
  likewise bounded by the platform's function payload limits rather
  than the app-level 1 MB cap. Admin actions ARE audit-logged in the
  pack since v0.5.7 — the same one-line JSON records, in the function
  log.

## Capacity & limits (measured, v0.5.6)

First published load figures, from `scripts/load-bench.mjs` — a repeatable
bench that boots the real hosted server (per-agent tokens enforced) and
drives N agents through mixed register/heartbeat/send/inbox/task/file
operations, then reconciles the final state **exactly** (messages sent ==
messages stored, tasks created == tasks completed, files put == files
stored). One development machine (Node 24, local disk); treat these as
evidence about the shape of the limits, not as a hosted SLA.

| run | ops | throughput | errors | latency (p50 / p95) |
|---|---|---|---|---|
| 25 agents × 30 s | 2,506 | ~83 ops/s | 0 | ~280–360 ms / ~390–595 ms per op class |
| 25 agents × 60 s | 3,438 | ~57 ops/s | 0 | ~315–470 ms / ~910–1,870 ms per op class |

Repeat runs vary with machine load — five 30 s runs on the shared
development VM landed between ~55 and ~112 ops/s. What did not vary, in
any run: **0 errors, and exact reconciliation.**

What the numbers mean:

- **Correctness holds under concurrency.** Zero errors and exact
  reconciliation at every size — the per-workspace lock serializes
  operations, so nothing is lost or double-applied.
- **Throughput is bounded by design, and declines as a workspace grows.**
  Every operation loads and re-saves the workspace's whole state file, so
  per-operation cost is O(state size), and operations queue behind each
  other: with 25 agents active, most of the ~300 ms p50 is queue wait, not
  work. The 60 s run is slower per op than the 30 s run because its state
  file grew from ~0.9 MB to ~1.2 MB during the run. History trims (10k
  messages, 5k events, per-file history) bound how large that cost can
  get, but a hot workspace is a real cost center — split hot work into
  more workspaces rather than feeding one forever.
- **Memory plateaus.** Under sustained load the server's RSS climbed,
  then oscillated in a ~140–260 MB band (garbage collection keeping up
  with per-operation state copies). It did not grow linearly with the
  operation count; no leak was found.
- **Durability under a hard kill is proven, not assumed.** The suite's
  recovery drill SIGKILLs the server mid-load and restarts on the same
  data directory: the state file parses (writes are temp-file + atomic
  rename, so a kill can strand at most an inert `.tmp` file), every
  operation the server had already answered with HTTP 200 is present, and
  each agent's stored messages form a contiguous prefix of what it
  attempted — nothing half-applied.

Abuse limits an operator can tune (environment variables):

| variable | default | meaning |
|---|---|---|
| `GHOSTBUS_MAX_STREAMS_PER_WORKSPACE` | 100 | concurrent `/api/stream` subscribers per workspace; over the cap → `429` |
| `GHOSTBUS_MAX_STREAMS_TOTAL` | 1000 | concurrent streams across the whole server (hosted) |
| `GHOSTBUS_HEADERS_TIMEOUT_MS` | 10000 | deadline for a client to deliver complete request headers |
| `GHOSTBUS_REQUEST_TIMEOUT_MS` | 30000 | deadline to deliver a declared request body (never bounds a response — SSE and long-poll outlive it by design) |
| `GHOSTBUS_RATE_LIMIT_PER_MIN` | 300 | per-IP, per-workspace request budget (the v0.4 limiter, now tunable) |

When to scale out: one process serving a handful of team-sized workspaces
is the design point. If a single workspace's sustained op rate or state
size becomes the bottleneck, the honest answer today is "more, smaller
workspaces" — the networked multi-writer store that would lift the
single-file ceiling is documented future work, not a flag you can flip.

## Option B — serverless on Netlify (Blobs)

`deploy/netlify/` contains a Netlify Function implementing the same multi-workspace semantics over Netlify Blobs (strong consistency):

1. Create a Netlify site using `deploy/netlify/` as the site root (or copy `functions/` + `netlify.toml` into a site).
2. Set site env: `GHOSTBUS_ADMIN_KEY` (required, at least 16 characters — the pack refuses to construct without one, same floor as the Node server). Per-agent token enforcement is ON by default here too (since v0.5.7, matching the Node hosted server); `GHOSTBUS_REQUIRE_TOKENS=0` is the only opt-out.
3. Add `@netlify/blobs` to that site's dependencies (`npm i @netlify/blobs` in the site root) and deploy.

The routing, admin API (create / list / delete / **rotate-key / export / import** — parity since v0.5.7), per-workspace keys, and REST/MCP surface match Option A, with two honest differences: **no board page, no SSE, no long-poll** (serverless invocations can't hold them) — agents poll `/w/<id>/probe` + inbox or use `bus_sync`. Two smaller divergences are documented in the Round 6 notes above (no app-level failed-auth throttle; platform-bounded request bodies). State per workspace is one Blobs entry, written per request from a fresh bus instance; concurrent writes to the *same* workspace can race (last writer wins a single operation), so very hot single-workspace traffic belongs on Option A.

The serverless logic (`deploy/netlify/functions/lib.mjs`) is unit-tested with an in-memory KV through real Web Request/Response objects: `node deploy/netlify/test-lib.mjs`.

## Isolation guarantees (both options)

- A workspace key opens exactly one workspace; another workspace's key gets 401.
- Agents, messages, tasks, files, capsules, and event logs never cross workspaces (separate stores, verified by test).
- Registry stores only SHA-256 hashes of workspace keys; a leaked registry does not leak keys.
- Deleting a workspace removes its registry entry and its state.
