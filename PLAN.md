# GhostBus — Agent-to-Agent Message Bus / Shared Workspace MCP

**Status:** PUBLISHED — v0.4.1 live Oct 8, 2026 (github.com/littlestjames82-sys/ghostbus). v0.4.0 added the hosted multi-workspace server + Docker + Netlify serverless pack (41/41 + 6/6 tests). v0.4.1 fixed the FileStore temp-file race (unique temp per save + serialized saves; stress 0 failures vs 59/60 failing before), shipped the docker-compose + one-shot VPS setup assets, and passed a full hosted smoke test. Still not deployed to a public host — that waits on Ryan's VPS choice. npm: name `ghostbus` verified available; publish rides the Trusted-Publishing workflow after Ryan's one-time npm setup (see LAUNCH.md).
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
- **M2 (DONE, shipped in v0.4.0; hardened in v0.4.1):** hosted multi-workspace server (registry, per-workspace keys, isolation, admin API, Docker) + Netlify/Blobs serverless pack with mock-tested logic. v0.4.1: FileStore race fixed, docker-compose + vps-setup.sh shipped, hosted smoke test passed. NOT yet deployed anywhere public — Ryan chose the Docker-on-VPS route Oct 8; a live deploy waits on his VPS pick (no VPS provisioned yet, no paid spend without his go). Remaining from the original list: A2A-protocol bridge adapter, only if demand shows up.
- **M3 / monetization (draft only):** open-source core stays MIT; paid hosted relay (per-workspace) is the GhostGuard/Seatbelt-shaped play. No pricing set — Ryan's call.

## Ryan's taps (batched)
1. ~~Name + publish~~ — DONE Oct 7 on his "Publish and build the shit out of it": name kept, GitHub live.
2. npm one-time setup (his only remaining tap): first manual `npm publish` from his machine *or* create the package + Trusted Publisher on npmjs.com (steps in LAUNCH.md) — then releases publish automatically from GitHub, token-free, exactly like ghost-seatbelt on PyPI.
3. Whether GhostBus replaces Ghost Bridge for his own Muse ↔ Antigravity traffic later (Bridge works; migration is optional).
