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
const ADMIN = 'admin-test-key-0123456'; // >= 16 chars: the v0.5.7 floor, same as Node
const handle = createHostedCore({ kv, adminKey: ADMIN });
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
let keyOne, soloToken;
await check('create two workspaces, keys differ', async () => {
  const r1 = await call('POST', '/api/workspaces', { key: ADMIN, body: { id: 'one', name: 'One' } });
  assert.equal(r1.status, 201); keyOne = (await r1.json()).key;
  const r2 = await call('POST', '/api/workspaces', { key: ADMIN, body: { id: 'two' } });
  assert.equal(r2.status, 201);
  assert.notEqual(keyOne, (await r2.json()).key);
});
await check('key isolation across workspaces', async () => {
  assert.equal((await call('GET', '/w/one/api/status', { key: keyOne })).status, 200);
  const reg = await call('POST', '/w/one/api/agents', { key: keyOne, body: { agent: 'solo' } });
  assert.equal(reg.status, 200);
  soloToken = (await reg.json()).token;
  assert.ok(soloToken, 'registration issues the agent token');
  // workspace one's key must not open workspace two
  assert.equal((await call('GET', '/w/two/api/agents', { key: keyOne })).status, 401);
  const oneAgents = await (await call('GET', '/w/one/api/agents', { key: keyOne })).json();
  assert.equal(oneAgents.agents.length, 1);
});
await check('state persists across fresh handler calls (stateless invocations)', async () => {
  // enforcement is ON by default in the lib since v0.5.7: the acting agent
  // presents its issued token, exactly like the Node hosted server.
  const t = await call('POST', '/w/one/api/tasks', { key: keyOne, body: { agent: 'solo', title: 'Persisted task', token: soloToken } });
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
  assert.equal((await call('DELETE', '/api/workspaces/two', { key: ADMIN })).status, 200);
  assert.equal((await call('GET', '/w/two/probe')).status, 404);
});

/* -------- parity (v0.5.7): the pack stops drifting from the Node server -------- */
await check('parity: a short admin key is refused at construction (Node floor since v0.5.2)', async () => {
  assert.throws(() => createHostedCore({ kv, adminKey: 'short' }), /at least 16 characters/);
  assert.throws(() => createHostedCore({ kv, adminKey: '' }), /adminKey required/);
});
let soloToken2;
await check('parity: agent token rotates over plain REST — old token dies at once, new one works', async () => {
  const rot = await call('POST', '/w/one/api/agents/rotate-token', { key: keyOne, body: { agent: 'solo', token: soloToken } });
  assert.equal(rot.status, 200);
  soloToken2 = (await rot.json()).token;
  assert.ok(soloToken2 && soloToken2 !== soloToken);
  // the OLD token is refused on the very next request (stateless: the
  // persisted hash was replaced before the rotation replied)
  assert.equal((await call('POST', '/w/one/api/tasks', { key: keyOne, body: { agent: 'solo', title: 'old token', token: soloToken } })).status, 400);
  assert.equal((await call('POST', '/w/one/api/tasks', { key: keyOne, body: { agent: 'solo', title: 'new token', token: soloToken2 } })).status, 200);
});
await check('parity: core hardening flows through the shared code (reserved file names, limit clamps)', async () => {
  // round 3: '__proto__' as a file name is refused, not stored
  assert.equal((await call('PUT', '/w/one/api/files', { key: keyOne, body: { agent: 'solo', path: '__proto__', text: 'x', token: soloToken2 } })).status, 400);
  // round 4: limit=-1 returns none (was all-but-one via slice), garbage -> default page
  await call('POST', '/w/one/api/messages', { key: keyOne, body: { agent: 'solo', to: '*', body: 'parity msg 1', token: soloToken2 } });
  await call('POST', '/w/one/api/messages', { key: keyOne, body: { agent: 'solo', to: '*', body: 'parity msg 2', token: soloToken2 } });
  const neg = await (await call('GET', `/w/one/api/inbox?agent=solo&limit=-1&token=${soloToken2}`, { key: keyOne })).json();
  assert.equal(neg.messages.length, 0);
  const all = await (await call('GET', `/w/one/api/inbox?agent=solo&limit=abc&token=${soloToken2}`, { key: keyOne })).json();
  assert.equal(all.messages.length, 2);
  // secret comparisons are timing-safe here too (functional side: a
  // same-length wrong key and a short wrong key are both plain 401s)
  assert.equal((await call('GET', '/w/one/api/status', { key: 'x'.repeat(48) })).status, 401);
  assert.equal((await call('GET', '/w/one/api/status', { key: 'nope' })).status, 401);
});
await check('parity: rotate-key exists — the old workspace key dies at once, the new one works', async () => {
  const rot = await call('POST', '/api/workspaces/one/rotate-key', { key: ADMIN, body: {} });
  assert.equal(rot.status, 200);
  const newKey = (await rot.json()).key;
  assert.ok(newKey && newKey !== keyOne);
  assert.equal((await call('GET', '/w/one/api/status', { key: keyOne })).status, 401);
  assert.equal((await call('GET', '/w/one/api/status', { key: newKey })).status, 200);
  keyOne = newKey;
});
const map2 = new Map();
const kv2 = { get: async (k) => map2.get(k) ?? null, set: async (k, v) => { map2.set(k, v); }, delete: async (k) => { map2.delete(k); } };
const ADMIN2 = 'second-admin-key-012345';
const handle2 = createHostedCore({ kv: kv2, adminKey: ADMIN2 }); // requireTokens NOT passed — the default is the thing under test
const call2 = (method, path, { key, body } = {}) => handle2(new Request(`http://test${path}`, {
  method,
  headers: { 'content-type': 'application/json', ...(key ? { 'x-bus-key': key } : {}) },
  body: body ? JSON.stringify(body) : undefined,
}));
await check('parity: enforcement is the DEFAULT (no requireTokens passed) — tokenless act refused', async () => {
  const c = await call2('POST', '/api/workspaces', { key: ADMIN2, body: { id: 'fresh', name: 'Fresh' } });
  assert.equal(c.status, 201);
  const k = (await c.json()).key;
  const reg = await call2('POST', '/w/fresh/api/agents', { key: k, body: { agent: 'newbie' } });
  assert.equal(reg.status, 200);
  const tok = (await reg.json()).token;
  assert.equal((await call2('POST', '/w/fresh/api/messages', { key: k, body: { agent: 'newbie', to: '*', body: 'tokenless' } })).status, 400);
  assert.equal((await call2('POST', '/w/fresh/api/messages', { key: k, body: { agent: 'newbie', to: '*', body: 'with token', token: tok } })).status, 200);
});
await check('parity: export -> import across cores — fresh key, hashes only, deep validation shared', async () => {
  const expRes = await call('GET', '/api/workspaces/one/export', { key: ADMIN });
  assert.equal(expRes.status, 200);
  const expText = await expRes.text();
  const exp = JSON.parse(expText);
  assert.equal(exp.ghostbusExport, 1);
  // hashes only: neither the live workspace key nor any raw agent token
  // appears anywhere in the envelope (tokenHashes are fine — they are
  // SHA-256 of 192-bit random tokens, not offline-brute-forceable)
  assert.ok(expText.includes('tokenHash'), 'export should carry agent token hashes (as at rest)');
  assert.ok(!expText.includes(keyOne), 'export must not contain the workspace key');
  assert.ok(!expText.includes(soloToken2), 'export must not contain a raw agent token');
  // round 3's deep snapshot validation is the import gate here too
  const bricking = JSON.parse(expText); bricking.state.agents = [null];
  assert.equal((await call2('POST', '/api/workspaces/import', { key: ADMIN2, body: bricking })).status, 400);
  const imp = await call2('POST', '/api/workspaces/import', { key: ADMIN2, body: exp });
  assert.equal(imp.status, 201);
  const impJ = await imp.json();
  assert.equal(impJ.id, 'one'); assert.equal(impJ.agents, 1);
  assert.ok(impJ.key && impJ.key !== keyOne, 'import must mint a fresh key');
  const agents = await (await call2('GET', '/w/one/api/agents', { key: impJ.key })).json();
  assert.equal(agents.agents.length, 1); assert.equal(agents.agents[0].name, 'solo');
});
console.log(`serverless lib: ${pass} checks passed`);
