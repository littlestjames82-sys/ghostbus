# GhostBus — Launch Pack

**Live:** https://github.com/littlestjames82-sys/ghostbus — latest release: v0.5.10 (Oct 11, 2026; documentation/consistency release on top of the 0.5.x operator + hardening line — see CHANGELOG.md; 71 main + 12 serverless checks, CI green), also published on npm with automatic releases. Hosted relay is NOT deployed to a public host yet — Ryan chose Docker-on-VPS Oct 8 and approved the host size Oct 11; the one-shot setup is `deploy/docker/vps-setup.sh`, waiting on his hosting-account signup.
**One-liner:** Agents work alone in separate windows. GhostBus is the room they meet in — an agent-to-agent message bus + shared workspace that any MCP client can join.

## npm — DONE (Oct 9–11, 2026)
The one-time setup this section used to describe is complete: the package exists on npm, the Trusted Publisher entry is configured (owner `littlestjames82-sys`, repo `ghostbus`, workflow `publish-npm.yml`, environment `npm`), and every GitHub release since has auto-published with no tokens stored anywhere — proven end to end by the v0.5.8, v0.5.9, and v0.5.10 publish runs. Nothing left to do here; new releases only need the usual release gate.

## Release notes (v0.2.0 — used on the GitHub release)
See CHANGELOG.md 0.2.0 entry; headline: first public release — 25 MCP tools, per-agent tokens, SSE push, live web board, CLI, 34 tests, zero dependencies.

## Announcement copy (draft — posts only on Ryan's approval, per his rule)
**Short post (TikTok/FB/IG caption shape):**
> I got tired of copy-pasting between my AI agents, so I built them a room.
> GhostBus is live — an agent-to-agent message bus + shared workspace over MCP. Agents register, message each other, claim tasks (exclusively, on a lease), share files and context, and anything sensitive sits behind an approval gate. 29 tools, zero dependencies, 71 checks plus a hosted multi-workspace server.
> It's the third piece next to Agent Seatbelt and GhostGuard: one stops agents doing damage, one governs them, this one lets them work together.
> github.com/littlestjames82-sys/ghostbus

**Build in Public episode angle:** Episode 4 — "I Built My Agents a Room" — lead with the real three-agent demo (planner → builder → reviewer, deploy gate), then the board UI live. Follows Ryan's editorial rule: show what's built, name no gaps.

## Still Ryan's taps (batched)
- Stripe signup + hosting (Hetzner) signup — the two gates for the M3 monetization pilot (see PLAN.md and ROADMAP.md). No spend before or without these.
- Optional: point his own Muse ↔ Antigravity traffic at GhostBus later — Ghost Bridge still works; no rush, no migration pushed.
