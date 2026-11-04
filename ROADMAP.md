# GhostBus Roadmap

Where GhostBus is, and what happens next, in order. The core is finished
and published; everything below is about the hosted layer and the
ecosystem links around it. Dates are not promised — each phase starts
when its gate opens, and the gates are named honestly.

**Standing rules for every phase:** the core stays MIT and free, zero
dependencies stays zero dependencies, the default file/memory store
stays the default, and no hosting or payment spend happens without
Ryan's explicit go.

## Shipped — the core (M0–M2, v0.5.10)

- Agent registry, message bus, task handoffs with approval gate and
  15-minute claim leases, shared files + context, provenance log,
  rendered Board.
- 29 MCP tools; local stdio server, HTTP relay, and a hosted
  multi-workspace server with per-workspace keys, per-agent token
  enforcement by default, key rotation, export/import, and an admin API.
- Six pre-pilot security-hardening rounds, a load bench with exact
  reconciliation, and a SIGKILL recovery drill in the suite:
  71 main checks + 12 serverless checks, CI green.
- Published on GitHub and npm; releases publish to npm automatically
  (Trusted Publishing, no stored tokens).

## Phase 1 — Pilot hosted relay (next)

Deploy the hosted multi-workspace server to one small VPS using the
shipped Docker assets (`deploy/docker/vps-setup.sh`), behind HTTPS,
with one pilot workspace, the documented admin-key handling, and
scheduled export backups running from day one.

- **Gate:** Ryan's hosting-account signup. The route (Docker on a
  small VPS) and the host size are already approved; nothing is
  provisioned or charged before the signup.
- **Done when:** the pilot workspace answers on a public HTTPS URL,
  a backup export exists off the box, and the recovery drill from
  the suite passes against the deployed shape.

## Phase 2 — Payments

Sell the hosted relay per workspace (not per seat) in three tiers:
Hosted Starter, Hosted Pro, Hosted Studio (up to 10 workspaces).
Checkout via Stripe Payment Links — no custom billing code; a paid
link provisions a workspace by the operator runbook in `docs/hosted.md`.
Support promise, stated up front: email support with a personal reply
target of one business day, scheduled export backups plus self-export
anytime, and explicitly no uptime SLA yet.

- **Gate:** Ryan's Stripe signup, so the payment links can be created.
- **Done when:** a test purchase creates a real, working workspace
  end to end, and the refund/cancel path is written down and tried once.

## Phase 3 — Hosted beta

Invite a small cohort (3–5 friendly workspaces) onto the pilot host,
run it for two weeks, and fix what actually hurts: onboarding friction,
docs gaps, and any limit a real user hits. Load numbers from the bench
are the capacity yardstick; the single-file store's documented limits
decide when this phase is full.

- **Gate:** Phase 2 done, plus Ryan's go on the invite list.
- **Done when:** two weeks of real traffic with no lost data, and the
  top three beta pains are fixed or written down as accepted limits.

## Phase 4 — GhostIDE link

GhostBus inside GhostIDE (item E21 of the GhostIDE ecosystem roadmap):
a Bus panel showing post/claim/proof trails, and agent subtask handoff
between two GhostIDE instances over a bus workspace. The governance
rules that already apply to GhostIDE agents apply to bus traffic too.
Local-first: two IDEs on one machine or LAN work with no hosted relay;
the hosted pilot from Phase 1 is the path for anything wider.

- **Gate:** separate Ryan go, as part of the GhostIDE ecosystem work.

## Later — deliberately deferred, not cancelled

- **Networked multi-writer store.** Ryan's call (Oct 11, 2026):
  monetization first, store later. When it comes, it lands as an
  optional adapter; the zero-dependency file/memory default does
  not change.
- **A2A-protocol bridge adapter.** Only if real demand shows up;
  MCP already covers the clients people run today.
- **Wake hooks as a shipped example.** The pattern is documented in
  `docs/client-setup.md`; a runnable example can pull forward into
  any phase if a user asks for it.
