#!/usr/bin/env node
/**
 * GhostBus MCP server (stdio) — zero dependencies.
 * Any MCP client (Claude, Cursor, Antigravity, custom agents) connects here and
 * every connected client shares the SAME workspace store, so agents actually
 * meet each other instead of each holding a private copy.
 *
 *   node src/mcp-server.mjs [--store ./ghostbus-data.json] [--name "My Workspace"]
 *
 * Env: GHOSTBUS_STORE (file path; default ./ghostbus-data.json),
 *      GHOSTBUS_WORKSPACE_NAME.
 * Use ":memory:" as the store for an ephemeral workspace.
 */
import readline from 'node:readline';
import { createBus, MemoryStore, FileStore, GHOSTBUS_VERSION } from './core.mjs';
import { TOOLS, callTool } from './tools.mjs';

const argv = process.argv.slice(2);
const argVal = (flag) => { const i = argv.indexOf(flag); return i >= 0 ? argv[i + 1] : null; };
const storePath = argVal('--store') || process.env.GHOSTBUS_STORE || './ghostbus-data.json';
const wsName = argVal('--name') || process.env.GHOSTBUS_WORKSPACE_NAME || 'GhostBus Workspace';

const store = storePath === ':memory:' ? new MemoryStore() : new FileStore(storePath);
const bus = await createBus(store, { name: wsName }, { requireTokens: process.env.GHOSTBUS_REQUIRE_TOKENS === '1' });

const send = (obj) => process.stdout.write(JSON.stringify(obj) + '\n');
const result = (id, value) => send({ jsonrpc: '2.0', id, result: value });
const error = (id, code, message) => send({ jsonrpc: '2.0', id, error: { code, message } });

async function handle(msg) {
  const { id, method, params } = msg;
  if (method === 'initialize') {
    return result(id, {
      protocolVersion: '2024-11-05',
      capabilities: { tools: {} },
      serverInfo: { name: 'ghostbus', version: GHOSTBUS_VERSION },
    });
  }
  if (method === 'notifications/initialized' || method === 'notifications/cancelled') return; // no id reply
  if (method === 'ping') return result(id, {});
  if (method === 'tools/list') return result(id, { tools: TOOLS });
  if (method === 'tools/call') {
    try {
      const out = await callTool(bus, params.name, params.arguments || {});
      const text = typeof out === 'string' ? out : JSON.stringify(out, null, 2);
      return result(id, { content: [{ type: 'text', text }] });
    } catch (e) {
      return result(id, { content: [{ type: 'text', text: `Error: ${e.message}` }], isError: true });
    }
  }
  if (id !== undefined) return error(id, -32601, `method not found: ${method}`);
}

const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
rl.on('line', async (line) => {
  if (!line.trim()) return;
  let msg;
  try { msg = JSON.parse(line); } catch { return; }
  await handle(msg);
});
process.stderr.write(`ghostbus mcp-server v${GHOSTBUS_VERSION} · store=${storePath} · workspace="${wsName}"\n`);
