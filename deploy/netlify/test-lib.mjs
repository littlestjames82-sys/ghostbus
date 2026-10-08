/**
 * Serverless lib test — in-memory KV, real Web Request/Response objects.
 * Run: node deploy/netlify/test-lib.mjs  (exit 0 = pass)
 * This verifies the exact logic the Netlify function runs; only the KV
 * backend differs (Blobs in production).
 */
import assert from 'node:assert';
import { createHostedCore } from './functions/lib.mjs';

const map = new Map();
const kv = { get: async (k) => map.get(k) ?? null, set: async (k, v) => { map.set(k, v); }, delete: async (k) => { map.delete(k); } };
const handle = createHostedCore({ kv, adminKey: 'admin-test-key' });
const call = (method, path, { key, body } = {}) => handle(new Request(`http://test${path}`, {
  method,
  headers: { 'content-type': 'application/json', ...(key ? { 'x-bus-key': key } : {}) },
  body: body ? JSON.stringify(body) : undefined,
}));
let pass = 0;
const check = async (name, fn) => { try { await fn(); pass++; console.log('  ok', name); } catch (e) { console.log('  FAIL', name + ':', e.message); process.exitCode = 1; } };

await check('health + admin gate', async () => {
  assert.equal((await call('GET', '/health')).status, 200);
  assert.equal((await call('POST', '/api/workspaces', { body: { id: 'one' } })).status, 401);
});
let keyOne;
await check('create two workspaces, keys differ', async () => {
  const r1 = await call('POST', '/api/workspaces', { key: 'admin-test-key', body: { id: 'one', name: 'One' } });
  assert.equal(r1.status, 201); keyOne = (await r1.json()).key;
  const r2 = await call('POST', '/api/workspaces', { key: 'admin-test-key', body: { id: 'two' } });
  assert.equal(r2.status, 201);
  assert.notEqual(keyOne, (await r2.json()).key);
});
await check('key isolation across workspaces', async () => {
  assert.equal((await call('GET', '/w/one/api/status', { key: keyOne })).status, 200);
  const reg = await call('POST', '/w/one/api/agents', { key: keyOne, body: { agent: 'solo' } });
  assert.equal(reg.status, 200);
  // workspace one's key must not open workspace two
  assert.equal((await call('GET', '/w/two/api/agents', { key: keyOne })).status, 401);
  const oneAgents = await (await call('GET', '/w/one/api/agents', { key: keyOne })).json();
  assert.equal(oneAgents.agents.length, 1);
});
await check('state persists across fresh handler calls (stateless invocations)', async () => {
  const t = await call('POST', '/w/one/api/tasks', { key: keyOne, body: { agent: 'solo', title: 'Persisted task' } });
  assert.equal(t.status, 200);
  const probe = await (await call('GET', '/w/one/probe')).json();
  assert.equal(probe.queued, 1);
  const sync = await (await call('GET', '/w/one/api/sync?sinceSeq=0', { key: keyOne })).json();
  assert.ok(sync.headSeq >= 2);
});
await check('MCP tools/call inside workspace', async () => {
  const r = await call('POST', '/w/one/mcp', { key: keyOne, body: { jsonrpc: '2.0', id: 7, method: 'tools/call', params: { name: 'bus_status', arguments: {} } } });
  const j = await r.json();
  assert.match(j.result.content[0].text, /ghostbus/);
});
await check('delete workspace removes it', async () => {
  assert.equal((await call('DELETE', '/api/workspaces/two', { key: 'admin-test-key' })).status, 200);
  assert.equal((await call('GET', '/w/two/probe')).status, 404);
});
console.log(`serverless lib: ${pass} checks passed`);
