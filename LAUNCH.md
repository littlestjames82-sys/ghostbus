# GhostBus — Launch Pack

**Live:** https://github.com/littlestjames82-sys/ghostbus — latest release: v0.5.0 (operator release: workspace key rotation, export/import, core snapshot/restore, race regression test; 44/44 + 6/6, CI green). Hosted relay is NOT deployed to a public host yet — Ryan chose Docker-on-VPS Oct 8; the one-shot setup is `deploy/docker/vps-setup.sh`, waiting on his VPS pick.
**One-liner:** Agents work alone in separate windows. GhostBus is the room they meet in — an agent-to-agent message bus + shared workspace that any MCP client can join.

## npm — Ryan's one remaining tap (one-time, ~3 minutes)
The npm name `ghostbus` was verified **available** Oct 7, 2026. Two routes, pick one:

**Route A — Trusted Publishing (recommended, matches ghost-seatbelt on PyPI, token-free forever):**
npm Trusted Publishing requires the package to exist first, so:
1. On Ryan's machine: `git clone https://github.com/littlestjames82-sys/ghostbus && cd ghostbus && npm login && npm publish --access public` (first and only manual publish).
2. On npmjs.com → package `ghostbus` → Settings → Trusted Publisher → GitHub Actions: owner `littlestjames82-sys`, repo `ghostbus`, workflow `publish-npm.yml`, environment `npm`.
3. After that, every GitHub release auto-publishes to npm via `.github/workflows/publish-npm.yml` — no tokens stored anywhere.

**Route B — skip npm for now.** GitHub is the launch; `npm pack` output is verified (ghostbus-0.2.0.tgz, 22.4 kB, 15 files) so the package is ready whenever.

## Release notes (v0.2.0 — used on the GitHub release)
See CHANGELOG.md 0.2.0 entry; headline: first public release — 25 MCP tools, per-agent tokens, SSE push, live web board, CLI, 34 tests, zero dependencies.

## Announcement copy (draft — posts only on Ryan's approval, per his rule)
**Short post (TikTok/FB/IG caption shape):**
> I got tired of copy-pasting between my AI agents, so I built them a room.
> GhostBus v0.2.0 is live — an agent-to-agent message bus + shared workspace over MCP. Agents register, message each other, claim tasks (exclusively, on a lease), share files and context, and anything sensitive sits behind an approval gate. 25 tools, zero dependencies, 34 tests.
> It's the third piece next to Agent Seatbelt and GhostGuard: one stops agents doing damage, one governs them — this one lets them work together.
> github.com/littlestjames82-sys/ghostbus

**Build in Public episode angle:** Episode 4 — "I Built My Agents a Room" — lead with the real three-agent demo (planner → builder → reviewer, deploy gate), then the board UI live. Follows Ryan's editorial rule: show what's built, name no gaps.

## Still Ryan's taps (batched)
- npm Route A step 1–2 above (only if he wants npm now).
- GitHub repo social-preview image + profile pin for ghostbus (web-UI only, same as before).
- Optional: point his own Muse ↔ Antigravity traffic at GhostBus later — Ghost Bridge still works; no rush, no migration pushed.
