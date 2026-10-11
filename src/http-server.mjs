#!/usr/bin/env node
/**
 * GhostBus HTTP relay (single workspace) — zero dependencies.
 * Same core + same MCP tools over HTTP: agents that can't share a local file
 * connect to one relay instead. For many isolated workspaces on one process,
 * use hosted-server.mjs.
 *
 *   node src/http-server.mjs [--port 8377] [--store ./ghostbus-data.json]
 * Env: GHOSTBUS_PORT, GHOSTBUS_STORE, GHOSTBUS_WORKSPACE_NAME,
 *      GHOSTBUS_KEY — if set, every /api and /mcp call needs header
 *      `x-bus-key: <key>` or `Authorization: Bearer <key>`. /health and
 *      /probe (counts only) stay open.
 *      GHOSTBUS_REQUIRE_TOKENS=1 enforces per-agent tokens.
 */
import http from 'node:http';
import { createBus, MemoryStore, FileStore, GHOSTBUS_VERSION } from './core.mjs';
import { createBusHandler, applyServerTimeouts, SERVER_TIMEOUT_DEFAULTS } from './handler.mjs';

const argv = process.argv.slice(2);
const argVal = (flag) => { const i = argv.indexOf(flag); return i >= 0 ? argv[i + 1] : null; };
const port = Number(argVal('--port') || process.env.GHOSTBUS_PORT || 8377);
const storePath = argVal('--store') || process.env.GHOSTBUS_STORE || './ghostbus-data.json';
const wsName = argVal('--name') || process.env.GHOSTBUS_WORKSPACE_NAME || 'GhostBus Workspace';
const KEY = process.env.GHOSTBUS_KEY || '';

const REQUIRE_TOKENS = process.env.GHOSTBUS_REQUIRE_TOKENS === '1';
const store = storePath === ':memory:' ? new MemoryStore() : new FileStore(storePath);
const bus = await createBus(store, { name: wsName }, { requireTokens: REQUIRE_TOKENS });
const handle = createBusHandler({ id: 'default', bus, key: KEY });

const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://localhost');
  handle(req, res, url).catch((e) => { process.stderr.write(`ghostbus relay: internal error: ${(e && e.stack) || e}\n`); try { res.writeHead(500, { 'content-type': 'application/json' }); res.end(JSON.stringify({ error: 'internal error' })); } catch {} });
});
// Explicit server timeouts (v0.5.6): slow-loris header/body deadlines, set
// here rather than inherited from Node defaults — see applyServerTimeouts
// in handler.mjs for the scoping (long-lived streams are never bounded).
const timeoutOpt = (envName, def) => { const n = Number(process.env[envName]); return Number.isFinite(n) && n > 0 ? Math.floor(n) : def; };
applyServerTimeouts(server, {
  headersMs: timeoutOpt('GHOSTBUS_HEADERS_TIMEOUT_MS', SERVER_TIMEOUT_DEFAULTS.headersMs),
  requestMs: timeoutOpt('GHOSTBUS_REQUEST_TIMEOUT_MS', SERVER_TIMEOUT_DEFAULTS.requestMs),
});
server.listen(port, () => {
  process.stderr.write(`ghostbus http relay v${GHOSTBUS_VERSION} · http://127.0.0.1:${port} · store=${storePath} · auth=${KEY ? 'workspace key required' : 'open (set GHOSTBUS_KEY)'}\n`);
  // Node's listen() with no host binds ALL network interfaces, not just
  // loopback — the 127.0.0.1 above is the local URL, not a bind restriction.
  // Local trust is the relay's default model and stays unchanged, but an
  // unkeyed or tokenless relay must never be network-reachable *silently*.
  if (!KEY) {
    process.stderr.write('WARNING: GHOSTBUS_KEY is not set — this relay is OPEN: anyone who can reach this port can read and write the workspace.\n');
    process.stderr.write('WARNING: the relay listens on all network interfaces, not just localhost. Set GHOSTBUS_KEY (a long secret) before exposing it beyond this machine, or firewall the port.\n');
  } else if (!REQUIRE_TOKENS) {
    process.stderr.write('WARNING: per-agent tokens are not enforced (GHOSTBUS_REQUIRE_TOKENS is not 1): anyone holding the workspace key can act under any agent name. The relay listens on all network interfaces — set GHOSTBUS_REQUIRE_TOKENS=1 if untrusted agents share the key.\n');
  }
});
