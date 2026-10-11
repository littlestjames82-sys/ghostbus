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

## Supply chain

How the package you install is produced, and how to check it yourself:

- **Zero dependencies.** GhostBus has no runtime dependencies at all —
  there is no dependency tree to compromise, substitute, or audit.
  `npm audit` on an installed copy reports 0 vulnerabilities because
  there is nothing to have one. (The repository carries no lockfile for
  the same reason; `npm audit` needs one, so run it on an installed
  copy, or in a scratch copy with `npm i --package-lock-only` first.)
- **No stored npm token.** Releases publish from GitHub Actions via npm
  Trusted Publishing (OIDC): the workflow proves its identity to npm
  for that one run, and no long-lived publish credential exists
  anywhere to steal. The workflow runs in the protected `npm`
  environment and holds the minimum permissions it needs
  (`contents: read`, `id-token: write`).
- **Actions pinned by commit SHA.** The third-party GitHub Actions the
  workflows use (`actions/checkout`, `actions/setup-node`) are pinned
  to full commit SHAs with the resolved release noted in a comment —
  a retagged or compromised tag cannot change what runs.
- **Provenance attestations.** Every release since v0.5.5 carries an
  SLSA provenance attestation (predicate `https://slsa.dev/provenance/v1`)
  and registry signatures, visible in the registry metadata
  (`dist.attestations`) and as the provenance badge on the npm package
  page. To verify an installed copy: `npm audit signatures`.
- **The tarball is allowlisted.** `scripts/check-pack.mjs` asserts the
  exact shape of what publishes — runtime (`src/`), docs, examples,
  and top-level project files only; tests, deploy kits, dev scripts,
  CI config, and runtime state are forbidden — and it runs both in the
  test suite and as a gate in the publish workflow. `SECURITY.md`
  itself ships in the tarball so this page travels with the code.

The consolidated posture document — architecture and trust
boundaries, every control family with its evidence, measured load
limits, and the known limitations stated plainly — is
[`docs/security.md`](docs/security.md); it ships in the tarball too.

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
