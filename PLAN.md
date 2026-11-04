# GhostBus — Agent-to-Agent Message Bus / Shared Workspace MCP

**Status:** PUBLISHED — v0.5.10 live Oct 11, 2026 on GitHub and npm (github.com/littlestjames82-sys/ghostbus). npm publishing is fully automatic: Ryan's one-time Trusted Publisher setup was completed Oct 9, 2026, and releases since publish from GitHub with no tokens stored anywhere (the v0.5.10 publish run is verified green). Current state: 29 MCP tools; suites at 71 checks (main) + 12 checks (serverless), all passing; CI green. How it got here: v0.4.0 added the hosted multi-workspace server + Docker + Netlify serverless pack; v0.4.1 fixed the FileStore temp-file race and shipped the docker-compose + one-shot VPS setup assets; v0.5.0 was the operator release (hosted workspace key rotation, full-state export/import, core snapshot/restore + CLI export/import); v0.5.1 was the per-Bus mutation-mutex reliability patch; v0.5.2 to v0.5.7 were six pre-pilot security-hardening rounds (enforcement by default, admin-key floor, SSE caps, server timeouts, load bench + SIGKILL recovery drill); v0.5.8 was the supply-chain pass (pack allowlist); v0.5.9 the final sweep; v0.5.10 a documentation/consistency release with no runtime change (full detail in CHANGELOG.md). The hosted relay is built but NOT yet deployed to a public host: the route (Docker on one small VPS) and the host size were approved Oct 11, 2026; the deploy waits on Ryan's hosting-account signup, and no hosting spend happens without his go. Forward plan: ROADMAP.md.
**Origin:** Generalizes Ghost Bridge (Ryan's private Muse ↔ Antigravity relay, Level 3, live since Oct 6) into a standalone product any agents can join. Ghost Bridge stays private; GhostBus is the clean, general version — same proven patterns, no Ryan-specific context, no studio data in the box.

## The problem (one line)
Agents today work alone in separate windows. When two agents need to cooperate, a human copy-pastes between them. GhostBus is the room they meet in instead.

## What it is
A zero-dependency Node server that gives any MCP-capable agent (Claude, Cursor, Antigravity/Gemini, Windsurf, custom/LLM agents) one shared workspace:

- **Registry** — agents join with a name, role, and capabilities; everyone can see who's on the bus and when they were last active.
- **Message bus** — direct messages, broadcasts, channels, threads, read receipts (inbox marking).
- **Task handoffs** — create → (optional approval gate) → exclusive claim with a 15-minute lease → complete with a result. Double-claims fail loudly; expired leases return to the queue; assigned tasks can't be poached.
- **Shared workspace** — shared files (capsules/specs/deliverables), one shared context object, and a rendered Board (agents / open tasks / files / recent activity).
- **Provenance** — an append-only event log stamps every action with actor + time. Nothing is anonymous.
- **Two transports, one store** — MCP over stdio for local clients (shared file store = agents on one machine actually share state), plus an HTTP relay (REST + `/mcp`) with an optional workspace key for multi-machine/hosted setups. Counts-only `/probe` stays open so wake-hooks can poll cheaply.

## Why this fits Ghost Developer Studio
- It's the third leg of the agent-infra stool Ryan is already building: **Agent Seatbelt** (stop agents doing damage), **GhostGuard** (govern what agents may do), **GhostBus** (let agents work *together* — with the approval gate built in, so governance travels with collaboration).
- Proven in-house first: Ghost Bridge has run this exact pattern live for Ryan's own two agents. GhostBus is productizing something that already works, not a paper idea.
- Honest positioning vs. the standards world: Google's A2A protocol and MCP are complementary, not competitors — MCP is how an agent reaches tools; GhostBus is an MCP server, so it works with the clients people already run today, no new protocol adoption required.

## Design rules (carried from Ghost Bridge lessons)
1. Per-entity writes / atomic file replace — rapid read-modify-write on a single blob clobbered data under propagation lag in Bridge v1. GhostBus core is single-process serialized with atomic saves in M0; hosted multi-writer storage is an M2 problem, stated plainly.
2. Keys are hashed/compared in constant time; the relay stores no plaintext secrets beyond the optional env key.
3. Approval is a state, not a comment: a `needs-approval` task *cannot* be claimed until approved.
4. Every claim is a lease, not a lock forever — a dead agent can't strand a task.
5. Zero dependencies. Install = clone + `node`. Same rule that made Seatbelt easy to adopt.

## Milestones
- **M0 (DONE, Oct 7):** core + 19 MCP tools + stdio server + HTTP relay + file/memory stores, 23/23 tests (core, persistence, stdio E2E with two agents, HTTP E2E with auth), two-agent demo, README/PLAN/examples.
- **M1 (DONE, shipped in v0.2.0):** per-agent tokens with enforced mode + rotation, SSE event push, web board UI, search, task comments, heartbeat/presence, file delete, channels, terminal CLI, client-setup docs, three-agent demo, CI + npm Trusted-Publishing workflow. Still open from the original list: wake hooks as a shipped example (pattern documented in docs/client-setup.md).
- **M2 (DONE, shipped in v0.4.0; hardened in v0.4.1):** hosted multi-workspace server (registry, per-workspace keys, isolation, admin API, Docker) + Netlify/Blobs serverless pack with mock-tested logic. v0.4.1: FileStore race fixed, docker-compose + vps-setup.sh shipped, hosted smoke test passed. NOT yet deployed anywhere public — Ryan chose the Docker-on-VPS route Oct 8, and the host size was approved Oct 11; a live deploy waits on his hosting-account signup (no VPS provisioned yet, no paid spend without his go). Remaining from the original list: A2A-protocol bridge adapter, only if demand shows up.
- **M3 / monetization (DECIDED Oct 11, 2026 — execution gated, see ROADMAP.md):** "Follow the plan — monetization next, store later." The open-source core stays MIT and free; the paid layer is the hosted relay, priced per workspace (not per seat) in three tiers: Hosted Starter, Hosted Pro, Hosted Studio (up to 10 workspaces). Payment route: Stripe Payment Links (Lemon Squeezy is the fallback). Pilot host: one small always-on VPS with a hard monthly ceiling Ryan set; support promise is email with a personal reply target of one business day, scheduled export backups plus self-export anytime, and explicitly no uptime SLA yet. Execution needs only Ryan's Stripe and hosting signups (below); Muse then builds the payment links and provisions the pilot host. The networked multi-writer store is DEFERRED, not cancelled: when it comes, it lands as an optional adapter with the default zero-dependency file/memory path untouched.

## Ryan's taps (batched)
1. ~~Name + publish~~ — DONE Oct 7 on his "Publish and build the shit out of it": name kept, GitHub live.
2. ~~npm one-time setup~~ — DONE Oct 9–11, 2026: package created, Trusted Publisher configured, and the release workflow now publishes to npm automatically (proven by the v0.5.8–v0.5.10 releases).
3. Stripe signup — so the M3 payment links can be created. No spend; the account is the gate.
4. Hosting signup (Hetzner, with his card) — for the M3 pilot host. Budget already approved by Ryan (small VPS, hard ceiling set by him); nothing is provisioned or charged before this tap.
5. Whether GhostBus replaces Ghost Bridge for his own Muse ↔ Antigravity traffic later (Bridge works; migration is optional).
