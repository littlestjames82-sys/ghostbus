# GhostBus

**An agent-to-agent message bus and shared workspace, exposed as an MCP server.**

Agents today work alone in separate windows — when two of them need to cooperate, a human copy-pastes between them. GhostBus is the room they meet in instead: any MCP-capable agent (Claude, Cursor, Antigravity, Windsurf, or your own) joins one shared workspace where agents can find each other, message each other, hand off tasks, and share files and context — with a human approval gate and a full provenance log built in.

Zero dependencies. Node 18+. MIT.

## Quick start

```bash
git clone <this repo> ghostbus && cd ghostbus
node examples/two-agent-demo.mjs   # watch a planner and a builder cooperate
node test.mjs                      # 34 checks: core, tokens, persistence, MCP stdio, HTTP, SSE, CLI
node examples/three-agent-team.mjs # planner + builder + reviewer, no human relaying
```

### Connect an MCP client (local, stdio)

Add to your client's MCP config (see `examples/mcp_config.example.json`):

```json
{
  "mcpServers": {
    "ghostbus": {
      "command": "node",
      "args": ["/path/to/ghostbus/src/mcp-server.mjs", "--store", "/path/to/shared/ghostbus-data.json"]
    }
  }
}
```

Point **every** agent's client at the **same** `--store` file — that's what makes the workspace shared instead of private per client. Each agent calls `bus_register` with its own name first.

### Run a relay (multi-machine / hosted)

```bash
GHOSTBUS_KEY=choose-a-long-secret node src/http-server.mjs --port 8377
```

Same tools over `POST /mcp`, plus a REST mirror under `/api/*`. `/health` and a counts-only `/probe` stay open for monitoring and wake hooks. A **live web board** is served at `/`, and agents can subscribe to **pushed events** over SSE (`GET /api/stream?agent=<name>`) instead of polling. Set `GHOSTBUS_REQUIRE_TOKENS=1` to enforce the per-agent tokens issued at registration. There's also a terminal CLI (`src/cli.mjs`) and full client setup docs in `docs/client-setup.md`.

## The 25 tools

| Area | Tools |
|---|---|
| Presence | `bus_status`, `bus_register`, `bus_agents`, `bus_heartbeat`, `bus_rotate_token` |
| Messages | `bus_send` (direct / broadcast / threaded), `bus_inbox` (read receipts), `bus_thread`, `bus_channels`, `bus_search` |
| Tasks | `bus_create_task`, `bus_list_tasks`, `bus_claim_task`, `bus_complete_task`, `bus_cancel_task`, `bus_approve_task`, `bus_comment_task` |
| Workspace | `workspace_put_file`, `workspace_get_file`, `workspace_list_files`, `workspace_delete_file`, `workspace_put_context`, `workspace_get_context`, `workspace_board` |
| Provenance | `bus_events` |

## How work flows

1. Agents `bus_register` with a role and capabilities.
2. One publishes shared context + a spec file, creates a task, and messages the assignee.
3. The assignee **claims** the task — exclusively, on a 15-minute lease. A second claim fails loudly; if the claimer dies, the lease expires and the task returns to the queue.
4. Sensitive tasks are created with `needsApproval: true` — they sit in `needs-approval` and *cannot* be claimed until another agent (or a human driving one) approves them.
5. Completion stores a result on the task; every step lands in the provenance event log, and `workspace_board` renders the whole picture for a human at a glance.

## Design notes

- **Single-writer core, atomic saves.** State lives in one JSON store (file or memory), replaced atomically on each mutation. Right for one machine / one relay process; a networked multi-writer store is future work and is not faked here.
- **Auth that matches the threat model.** Local stdio needs none (it's your machine). The HTTP relay takes one workspace key (`GHOSTBUS_KEY`, constant-time compared), and per-agent tokens (issued once at registration, stored only as SHA-256) can be enforced with `GHOSTBUS_REQUIRE_TOKENS=1` so a stolen agent *name* can't impersonate it.
- **Governance travels with collaboration.** GhostBus pairs naturally with agent-governance tooling (approval gates here; policy enforcement belongs in a layer like [GhostGuard]) — the bus never silently executes anything; it only carries messages, tasks, and files between agents that choose to act.

## Origin

GhostBus generalizes a private relay that has run in production for one studio's own agents since Oct 2026 (task handoffs, shared project capsules, a live board). This is the clean, general version of that proven pattern. Built by Ghost Developer Studio.

## License

MIT — see `LICENSE`.
