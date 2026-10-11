# Security Policy

## Supported versions

Only the **latest release** of GhostBus is supported with security fixes.
If you are running an older version, upgrade first — the fix will land on
the newest release, not on backports.

## Reporting a vulnerability

Email **gdev6145@gmail.com** with:

- what you found and where (file, endpoint, or hosted route),
- the version you tested,
- steps to reproduce, if you have them.

Please do not open a public issue for a security report, and give us a
chance to fix it before disclosing publicly.

**What to expect:** an acknowledgement within **one business day**, and a
plain-language answer about whether we can reproduce it and what happens
next. GhostBus is built by Ghost Developer Studio — a one-person studio —
so fixes are prioritized by real-world impact, but every report gets read
by the person who wrote the code.

## Credential lifecycle

GhostBus has three credential classes. None of them expires on a timer —
the lifecycle is *issue once, store hashed, rotate on suspicion* — and
this section is the honest description of that posture:

| credential | issued | stored | entropy |
|---|---|---|---|
| admin key | operator-chosen at startup | process env only | operator's choice; the hosted server and the serverless pack both refuse to start with one under 16 characters (use 32+ random hex) |
| workspace key | once, at workspace create / import / rotate | SHA-256 hash in the registry | 192 bits (`crypto.randomBytes(24)`) |
| agent token | once, at agent registration / rotation | SHA-256 hash in the workspace state | 192 bits (`crypto.randomBytes(24)`) |

**Rotation is immediate, and it is the incident response.** There is no
grace period and no second valid credential:

- *Workspace key:* `POST /api/workspaces/<id>/rotate-key` (admin key) —
  the registry hash is replaced before the call returns (on the
  serverless pack, before the next request), so the old key's very next
  use fails. Agents keep working; only the workspace key they present
  changes.
- *Agent token:* the `bus_rotate_token` MCP tool, or
  `POST /w/<id>/api/agents/rotate-token` over REST with the current token
  (header or body) — the hash in state is replaced before the reply, the
  old token is dead immediately, and the rotation is recorded in the
  provenance log (the log names the event; it never contains a token).
  Rotation requires the current token on an enforced bus, so a leaked
  token can be rotated away by its owner but a stranger who knows only
  the agent's *name* cannot lock the owner out.
- *Admin key:* restart the server with a new one. Workspace keys and
  agent tokens are unaffected — they are stored as hashes, not derived
  from the admin key.

Because nothing expires, a credential that leaks and is never rotated
stays valid — that is the trade-off of this design, stated plainly.
Mitigations are the hashes at rest (a leaked state file or registry
exposes no usable credential, and an export envelope carries the same
hashes only — SHA-256 of a 192-bit random token is not a practical
offline brute-force target), timing-safe comparisons, failed-auth
throttling on the Node hosted server, and the rotation paths above.
If you suspect a leak: rotate first, then figure out how it happened.

## Authorization model (single scope, by design)

There is exactly one scope per credential, and this is a deliberate
pilot-stage design decision, not an oversight we plan to paper over:

- A **workspace key** is full access to its one workspace: read, write,
  minting and rotating agent tokens included. It cannot reach any other
  workspace (verified by test).
- An **agent token** proves "I am this agent" inside that workspace;
  everything that agent may do, its token may do.
- The **admin key** is operator root: every workspace, plus create /
  delete / rotate / export / import.

There are **no read-only keys** and no per-tool or per-agent scopes. For
the deployments GhostBus targets today — one operator handing a key to
one workspace's owner, whose agents are all theirs — a scope system
would be machinery without a customer. If you need a party to *observe*
a workspace without being able to act in it, the honest options today
are the counts-only `/probe`, or a periodic export they can read
offline. A scoped/read-only credential is a known future feature, not a
current claim.

## Scope notes

- Self-hosted deployments are operated by whoever runs them; the operator
  guidance for the hosted server (keys, HTTPS, throttling, backups) lives
  in [`docs/hosted.md`](docs/hosted.md), in the "Security & deployment
  hardening" section.
- Workspace keys and agent tokens are only ever stored as SHA-256 hashes;
  a report based on reading your own data files is your deployment working
  as designed, not a leak.
- The counts-only `/probe` and `/health` endpoints are intentionally
  unauthenticated for monitoring; they expose no message, task, or file
  content.
