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
import { createBusHandler } from './handler.mjs';

const argv = process.argv.slice(2);
const argVal = (flag) => { const i = argv.indexOf(flag); return i >= 0 ? argv[i + 1] : null; };
const port = Number(argVal('--port') || process.env.GHOSTBUS_PORT || 8377);
const storePath = argVal('--store') || process.env.GHOSTBUS_STORE || './ghostbus-data.json';
const wsName = argVal('--name') || process.env.GHOSTBUS_WORKSPACE_NAME || 'GhostBus Workspace';
const KEY = process.env.GHOSTBUS_KEY || '';

const store = storePath === ':memory:' ? new MemoryStore() : new FileStore(storePath);
const bus = await createBus(store, { name: wsName }, { requireTokens: process.env.GHOSTBUS_REQUIRE_TOKENS === '1' });
const handle = createBusHandler({ id: 'default', bus, key: KEY });

const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://localhost');
  handle(req, res, url).catch((e) => { try { res.writeHead(500, { 'content-type': 'application/json' }); res.end(JSON.stringify({ error: e.message })); } catch {} });
});
server.listen(port, () => {
  process.stderr.write(`ghostbus http relay v${GHOSTBUS_VERSION} · http://127.0.0.1:${port} · store=${storePath} · auth=${KEY ? 'workspace key required' : 'open (set GHOSTBUS_KEY)'}\n`);
});
