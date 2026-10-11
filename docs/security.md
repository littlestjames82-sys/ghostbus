# GhostBus security posture

This document is the consolidated security posture of GhostBus as of
**v0.5.10**: the architecture and its trust boundaries, the controls in
place (grouped by family, with the hardening round that introduced
each), the measured load evidence with its honest ceiling, and the
known limitations — stated, not hidden.

It is the *posture and evidence* document. The *policy* — how to report
a vulnerability, supported versions, the credential rotation runbook,
the authorization model — lives in [`SECURITY.md`](../SECURITY.md) at
the repo root, and operator deployment guidance lives in
[`docs/hosted.md`](hosted.md). Where this document and those disagree,
tell us; they are maintained to agree.

## Architecture & trust boundaries

GhostBus is one transport-agnostic core (`src/core.mjs`) — agents,
messages, tasks, shared files, context, capsules, and an append-only
provenance event log over a pluggable store — behind four transports
that share the core and, where applicable, the same request handler:

| surface | process | intended exposure |
|---|---|---|
| MCP over stdio (`src/mcp-server.mjs`) | one per client machine | local only — the operator's machine is the boundary |
| HTTP relay (`src/http-server.mjs`) | single workspace | one team's workspace, key-protected |
| Hosted server (`src/hosted-server.mjs`) | many isolated workspaces | the public/paid surface; strictest defaults |
| Serverless pack (`deploy/netlify/`) | per-request functions over a KV | same hosted semantics on Netlify Blobs |

Three credential classes mark the boundaries (full lifecycle in
`SECURITY.md`): the **admin key** (operator root, hosted surfaces
only), one **workspace key** per workspace (full access to that one
workspace, nothing else), and **per-agent tokens** (prove "I am this
agent" inside a workspace). Keys and tokens exist at rest only as
SHA-256 hashes.

Intentionally open, on every HTTP surface: `/health`, a counts-only
`/probe` (workspace id, queue/agent counts, version — no content), and
the static board page shell (the page itself fetches data with the
workspace key). Everything else requires the workspace key; the hosted
admin API additionally requires the admin key.

## Controls, by family

Eight hardening rounds ran between v0.5.2 and v0.5.9. The CHANGELOG
carries the per-round detail; this is the same ground grouped the way
an evaluator reads it.

### Authentication & authorization

- Per-agent token enforcement is the **default** on the hosted server
  and the serverless pack (v0.5.2/v0.5.7); opting out requires an
  explicit env var and prints a loud startup warning. The admin key has
  a 16-character startup floor on both hosted surfaces.
- All secret comparisons are timing-safe (`crypto.timingSafeEqual`
  over SHA-256 digests) — workspace keys, agent tokens, admin key, on
  every surface including the serverless pack (v0.5.3).
- Rotation is immediate and is the incident response: workspace-key
  rotation replaces the registry hash before the call returns (the old
  key's next request fails — pinned by test on both hosted surfaces);
  agent tokens rotate via MCP or plain REST with the current token as
  the authorizer (v0.5.7). Nothing expires on a timer — the trade-off
  and mitigations are stated in `SECURITY.md`.
- Authorization is single-scope by design: a workspace key is full
  access to its one workspace, an agent token is that agent, the admin
  key is root. There are no read-only keys. The reasoning — and the
  honest alternatives (`/probe`, offline exports) — is in `SECURITY.md`.
- Workspaces are isolated by construction (separate stores, separate
  keys) and the isolation is tested, including cross-workspace key
  refusal over real HTTP.

### Input validation

- Workspace ids are validated at every boundary — create, import,
  route matching, workspace resolution, and the registry file itself
  when loaded — because an id becomes a file name inside the data dir;
  a planted or hand-edited registry entry cannot turn one into a path
  outside it (v0.5.4).
- Shared-file names are state keys, never filesystem paths. The three
  names that are special to a JavaScript object (`__proto__`,
  `constructor`, `prototype`) are refused at write, treated as absent
  at read, and refused inside snapshots (v0.5.4).
- Snapshots/imports are deeply validated before they land: collection
  entries must be usable objects, agents need string names, files need
  string text, counters finite and non-negative, counts sanity-capped.
  A state that would crash the bus on first use is refused at the
  door; every export produced by v0.5.0–v0.5.3 still imports (v0.5.4).
- Prototype pollution is not reachable: state enters only through
  `JSON.parse`, JSON round-trip cloning, and object spread (all
  own-property semantics); there is no recursive merge and no
  `Object.assign` of caller data anywhere in the codebase. Canary tests
  attempt it anyway, through the context writer, restore payloads, and
  tool arguments (v0.5.4/v0.5.5).
- MCP tool arguments are validated against each tool's declared schema
  at the tools boundary: wrong-typed values are rejected with a clean
  error result, never coerced into shared state (an object message
  body was previously stored as the literal `"[object Object]"`), and
  malformed JSON-RPC frames can never kill the stdio server process
  (v0.5.5).
- Numeric parameters are clamped in the core: garbage, negative, or
  absurd `limit`/`sinceSeq`/timeout values fall back to defaults and
  documented caps instead of slice-arithmetic surprises — `limit=0`
  once returned *everything*, and a garbage sync cursor once reported
  an agent as caught up while replaying nothing (v0.5.5).

### Transport & headers

- HTML pages (board, hosted landing) answer with `X-Frame-Options:
  DENY` and a Content-Security-Policy (`default-src 'self'`,
  `frame-ancestors 'none'`, `object-src 'none'`); JSON answers carry
  `nosniff` and `Referrer-Policy: no-referrer` (v0.5.3).
- The board page escapes every interpolated value, keeps the workspace
  key in local storage, and sends it only as a header — never in a
  URL, where it would land in logs and referers (v0.5.5).
- The servers speak plain HTTP; **HTTPS is required for any public
  deployment**, terminated in front (reverse proxy or a *named* tunnel
  with a stable hostname). A quick tunnel is explicitly not for paid
  use. See `docs/hosted.md`.

### Resource limits & abuse resistance

- JSON request bodies are capped at 1 MB on every Node HTTP route;
  over the cap is a clean `413` (v0.5.3). (The serverless pack relies
  on platform payload limits instead — documented divergence, below.)
- Failed authentication is throttled at the hosted layer: 30 failed
  attempts per minute per IP gets `429`s on the admin surface and
  workspace routes; successful auth never counts (v0.5.3). A per-IP,
  per-workspace request limiter (300/min, tunable) covers traffic
  inside a workspace.
- Both Node servers enforce explicit connection deadlines (headers
  10 s, declared body 30 s, keep-alive 5 s; env-tunable) via a guard
  that only destroys genuinely incomplete requests — long-lived SSE
  streams and long-polls are never bounded by them (v0.5.6).
- SSE subscriptions are capped (100 per workspace, 1000 per server,
  clean `429`), with idempotent cleanup so churned clients leak
  neither listeners nor cap slots (v0.5.6).
- Error hygiene: the servers log the real error to stderr and answer a
  generic `internal error`; deliberate validation/auth errors (400s)
  are client-facing by design (v0.5.3). Admin actions on the hosted
  surfaces write one structured audit line (timestamp, action,
  workspace id, source IP — never a key or hash) (v0.5.3/v0.5.7).
- Data files (registry, workspace state) are written owner-only
  (0600) through atomic temp-file + rename writes (v0.5.3).

### Durability & state integrity

- Every mutation runs inside a per-instance serialized
  load → mutate → save cycle (`_serialized`, v0.5.1), so concurrent
  operations on one bus cannot silently lose each other's updates;
  the suite proves it with concurrent-writer reconciliation.
- The kill drill is a suite check, not a claim: the hosted server is
  SIGKILLed mid-load and restarted on the same data directory — the
  state file parses (atomic rename), every HTTP-200-acknowledged
  operation is present, and each agent's stored messages form a
  contiguous prefix of its attempts (v0.5.6).
- History trims bound state growth (10k messages, 5k events, 10
  versions per file), and exports/imports give portable, hash-only
  backups (v0.5.0).

### Load evidence (summary)

`scripts/load-bench.mjs` boots the real hosted server with token
enforcement and drives concurrent agents through mixed operations,
then reconciles the final state **exactly** (sent == stored, created
== completed, put == stored). On the development machine (Node 24):
25 agents × 30 s → 2,506 ops, ~83 ops/s, **0 errors**, exact
reconciliation; 25 agents × 60 s → 3,438 ops, ~57 ops/s, 0 errors.
The full table, the memory behavior, and the reading of the numbers
live in `docs/hosted.md` ("Capacity & limits"). These are
one-machine figures about the *shape* of the limits, not an SLA.

### Supply chain

- **Zero runtime dependencies** — there is no dependency tree to
  compromise; `npm audit` reports 0 vulnerabilities across 0
  dependencies (v0.5.8).
- Releases publish from GitHub Actions via npm **Trusted Publishing**
  (OIDC): no stored npm token exists anywhere to steal; the workflow
  holds least-privilege permissions (`contents: read`,
  `id-token: write`) in the protected `npm` environment (v0.5.8).
- The third-party actions used are **pinned to full commit SHAs**
  (v0.5.8). Releases carry **SLSA provenance attestations** and
  registry signatures — verify an installed copy with
  `npm audit signatures`.
- The published tarball is allowlisted and gated: `scripts/check-pack.mjs`
  asserts its exact shape in the suite and in the publish workflow;
  tests, deploy kits, dev scripts, CI config, and runtime state are
  forbidden from shipping (v0.5.8). This document and `SECURITY.md`
  both ship in the tarball.

### Serverless parity

The Netlify pack shares the core but keeps its own routing layer, so
parity is a maintained property, not an assumption: enforcement
default, the admin-key floor, rotate/export/import, REST agent-token
rotation, timing-safe compares, and the shared core's validation and
clamps were audited and aligned in v0.5.7, and the lib test (12
checks) holds the line. Two divergences remain, documented rather
than silent: no application-level failed-auth throttle (stateless
per request; the platform traffic layer, 192-bit keys, and
timing-safe compares carry it) and platform-bounded request bodies
instead of the app-level 1 MB cap.

### The final sweep (v0.5.9)

Round 8 re-audited the whole surface fresh and re-ran the accumulated
hostile-input battery against the current code on all five surfaces —
a 71-probe run covering, among others: no-key/wrong-key/cross-workspace
refusals on relay, hosted, and serverless; traversal ids at create,
import, route, and in a planted registry file; reserved file names and
path-like file reads; `__proto__` payloads through the context writer,
snapshots, and imports, with `Object.prototype` canaries; `agents:
[null]` and `workspace: null` import refusals; MCP hostile frames
(null/string/number/array/missing-params) and wrong-typed arguments on
stdio and HTTP; limit/cursor/timeout edge values; the 1 MB body cap;
rotation immediacy for workspace keys and agent tokens on both hosted
surfaces; and the short-admin-key startup refusal. **Outcome: no new
vulnerability found and no code change required** — every probe landed
as the earlier rounds designed (one probe's own expectation was
corrected in the run: a `tools/call` frame without `params` over HTTP
answers a clean JSON-RPC `isError` result, the codebase's convention,
rather than an HTTP 400). The round's code-adjacent work was
documentation: this posture document, and three stale claims corrected
(the README's install version, a key-length example in
`docs/hosted.md`, on top of round 7's `engines` correction).

## Known limitations — stated, not hidden

- **Single-file JSON store.** State is one JSON document per
  workspace, fully loaded and re-saved per operation: per-operation
  cost is O(state size), throughput declines as a workspace grows
  (measured above), and concurrent writers coordinate at
  single-operation granularity (last writer wins a colliding op).
  Integrity within that model is proven (atomic rename, kill drill,
  exact reconciliation under load); it is not a transactional,
  multi-writer database. The networked store is **future work by the
  owner's decision** — deferred, designed as an optional adapter, not
  a current claim and not faked anywhere in the code or these docs.
- **Single process, no high availability.** The hosted server is one
  Node process. If it dies, workspaces are unavailable until it
  restarts (state on disk is intact). There is no clustering,
  failover, or replication.
- **No credential expiry.** Keys and tokens do not expire on a timer;
  rotation is the revocation mechanism. A leaked credential that is
  never rotated stays valid. The posture, runbook, and mitigations
  are in `SECURITY.md` ("Credential lifecycle").
- **Single-scope authorization.** No read-only or per-tool scoped
  credentials exist (see above and `SECURITY.md`).
- **No uptime SLA in the pilot.** The hosted pilot is honestly run by
  a one-person studio: scheduled export backups and self-export
  anytime, data never locked in, and no SLA yet. That wording is the
  offer, not fine print.
- **Serverless divergences.** The two documented above (no app-level
  failed-auth throttle; platform-bounded bodies), plus the functional
  ones: no board page, no SSE, no long-poll on the serverless pack,
  and per-request fresh-bus semantics where concurrent writes to the
  same workspace can race at single-operation granularity.

## The five steps, mapped

An external review (ChatGPT, source inspection, Oct 11 2026 — 7.4/10
overall, security maturity 5.5) named five steps toward 9/10. The
hardening loop's honest accounting:

| # | Step | Status after 8 rounds | Evidence |
|---|---|---|---|
| 1 | Harden the security model | **Done** — enforcement defaults, timing-safe compares, throttles, caps, deep input validation, MCP boundary validation, token lifecycle + rotation, serverless parity, supply-chain pinning; final sweep clean | This document; CHANGELOG v0.5.2–v0.5.9; suites 71 + 12 checks |
| 2 | Upgrade persistence to a transactional DB | **Deferred by owner decision** — not built; the JSON store's integrity properties are proven and its ceiling is measured and documented, but it is not transactional and not multi-writer | "Known limitations" above; `docs/hosted.md` capacity section |
| 3 | Intelligent orchestration | **Not a hardening-loop item** — the bus's existing gates (approval-required tasks, `blockedBy` dependencies, exclusive claim leases) are product features that predate the loop; no orchestration claim is made or implied by these rounds | README "How work flows"; PLAN.md |
| 4 | Connect the coding lifecycle | **Not addressed** — product roadmap, outside the security loop's scope; nothing in these rounds should be read as progress on it | PLAN.md |
| 5 | Prove it under load | **Done** — repeatable bench, 0 errors and exact reconciliation at 25 concurrent agents, timeout/SSE abuse limits, SIGKILL recovery drill in the suite | `docs/hosted.md` "Capacity & limits"; CHANGELOG v0.5.6 |

Steps 1 and 5 were the loop's to close and are closed with evidence.
Step 2 is a recorded owner decision. Steps 3 and 4 were never security
work and are listed so the mapping doesn't quietly claim them.
