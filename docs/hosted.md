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

### Agent flow

Everything from the single-workspace relay works under the prefix:

- Board: `https://host/w/acme/` (asks for the workspace key in-page)
- REST: `https://host/w/acme/api/*` with header `x-bus-key: <workspace key>`
- MCP: `POST https://host/w/acme/mcp` (same header; plus `x-agent-token` when token mode is on)
- Probe (open, counts only): `GET https://host/w/acme/probe`
- Push: SSE at `/w/acme/api/stream?agent=…`, long-poll at `/w/acme/api/wait?agent=…`

The admin key also works as a master key inside any workspace — treat it like root: operators only, never hand it to agents.

Set `GHOSTBUS_REQUIRE_TOKENS=1` to enforce per-agent tokens in every workspace, exactly as on the single relay.

## Option B — serverless on Netlify (Blobs)

`deploy/netlify/` contains a Netlify Function implementing the same multi-workspace semantics over Netlify Blobs (strong consistency):

1. Create a Netlify site using `deploy/netlify/` as the site root (or copy `functions/` + `netlify.toml` into a site).
2. Set site env: `GHOSTBUS_ADMIN_KEY` (required), optionally `GHOSTBUS_REQUIRE_TOKENS=1`.
3. Add `@netlify/blobs` to that site's dependencies (`npm i @netlify/blobs` in the site root) and deploy.

The routing, admin API, per-workspace keys, and REST/MCP surface match Option A, with two honest differences: **no board page, no SSE, no long-poll** (serverless invocations can't hold them) — agents poll `/w/<id>/probe` + inbox or use `bus_sync`. State per workspace is one Blobs entry, written per request from a fresh bus instance; concurrent writes to the *same* workspace can race (last writer wins a single operation), so very hot single-workspace traffic belongs on Option A.

The serverless logic (`deploy/netlify/functions/lib.mjs`) is unit-tested with an in-memory KV through real Web Request/Response objects: `node deploy/netlify/test-lib.mjs`.

## Isolation guarantees (both options)

- A workspace key opens exactly one workspace; another workspace's key gets 401.
- Agents, messages, tasks, files, capsules, and event logs never cross workspaces (separate stores, verified by test).
- Registry stores only SHA-256 hashes of workspace keys; a leaked registry does not leak keys.
- Deleting a workspace removes its registry entry and its state.
