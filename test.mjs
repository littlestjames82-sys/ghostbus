/**
 * GhostBus test suite — core, MCP stdio, and HTTP relay. Zero dependencies.
 * Run: node test.mjs   (exit 0 = all pass)
 */
import assert from 'node:assert';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createBus, MemoryStore, FileStore } from './src/core.mjs';
import { TOOLS, callTool } from './src/tools.mjs';

let pass = 0, fail = 0;
const check = async (name, fn) => {
  try { await fn(); pass++; console.log(`  ok ${name}`); }
  catch (e) { fail++; console.log(`  FAIL ${name}: ${e.message}`); }
};
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ghostbus-test-'));

/* ---------------- core ---------------- */
console.log('core:');
const bus = await createBus(new MemoryStore(), { name: 'Test Workspace' });

await check('register two agents', async () => {
  const a = await bus.registerAgent({ name: 'planner', role: 'planning', capabilities: ['research'] });
  assert.equal(a.rejoined, false);
  await bus.registerAgent({ name: 'builder', role: 'coding', capabilities: ['node', 'tests'] });
  assert.equal((await bus.listAgents()).length, 2);
});
await check('rejoin updates role, no duplicate', async () => {
  const r = await bus.registerAgent({ name: 'planner', role: 'lead planner' });
  assert.equal(r.rejoined, true);
  assert.equal((await bus.listAgents()).length, 2);
  assert.equal((await bus.listAgents()).find(a => a.name === 'planner').role, 'lead planner');
});
await check('bad agent name rejected', async () => {
  await assert.rejects(() => bus.registerAgent({ name: 'bad name!' }), /only/);
});
await check('unregistered sender rejected', async () => {
  await assert.rejects(() => bus.sendMessage({ from: 'ghost', body: 'hi' }), /not registered/);
});
await check('direct message lands only in recipient inbox + sender', async () => {
  await bus.sendMessage({ from: 'planner', to: 'builder', body: 'build the API' });
  const bIn = await bus.inbox('builder', { markRead: false });
  assert.equal(bIn.length, 1); assert.equal(bIn[0].body, 'build the API');
  await bus.registerAgent({ name: 'watcher' });
  assert.equal((await bus.inbox('watcher', { markRead: false })).length, 0);
});
await check('broadcast reaches everyone', async () => {
  await bus.sendMessage({ from: 'builder', to: '*', body: 'API spec posted' });
  assert.equal((await bus.inbox('watcher', { markRead: false })).length, 1);
});
await check('inbox marks read; unreadOnly then empty', async () => {
  await bus.inbox('builder'); // marks the direct + broadcast read
  assert.equal((await bus.inbox('builder', { unreadOnly: true })).length, 0);
});
await check('thread reply grouping', async () => {
  const root = await bus.sendMessage({ from: 'planner', to: 'builder', body: 'question?' });
  await bus.sendMessage({ from: 'builder', to: 'planner', body: 'answer', threadId: root.id });
  const th = await bus.thread(root.id);
  assert.equal(th.length, 2);
});
let task1;
await check('task create + exclusive claim', async () => {
  task1 = await bus.createTask({ from: 'planner', title: 'Implement API', body: 'spec in files', assignee: 'builder' });
  assert.equal(task1.status, 'queued');
  const claimed = await bus.claimTask(task1.id, { by: 'builder' });
  assert.equal(claimed.status, 'claimed'); assert.equal(claimed.claimedBy, 'builder');
  await assert.rejects(() => bus.claimTask(task1.id, { by: 'builder' }), /already claimed/);
});
await check('only claimer can complete; result stored', async () => {
  await assert.rejects(() => bus.completeTask(task1.id, { by: 'planner', result: 'x' }), /claimed by builder/);
  const done = await bus.completeTask(task1.id, { by: 'builder', result: 'API live, 12 tests pass' });
  assert.equal(done.status, 'done'); assert.match(done.result, /12 tests/);
});
await check('assignee guard: other agent cannot claim assigned task', async () => {
  const t = await bus.createTask({ from: 'planner', title: 'Review', assignee: 'builder' });
  await assert.rejects(() => bus.claimTask(t.id, { by: 'watcher' }), /assigned to builder/);
  await bus.cancelTask(t.id, { by: 'planner' });
});
await check('approval gate: needs-approval cannot be claimed until approved', async () => {
  const t = await bus.createTask({ from: 'builder', title: 'Deploy to prod', needsApproval: true });
  assert.equal(t.status, 'needs-approval');
  await assert.rejects(() => bus.claimTask(t.id, { by: 'builder' }), /cannot be claimed/);
  const ap = await bus.approveTask(t.id, { by: 'planner' });
  assert.equal(ap.status, 'queued'); assert.equal(ap.approvedBy, 'planner');
  assert.equal((await bus.claimTask(t.id, { by: 'builder' })).status, 'claimed');
});
await check('expired claim lease returns task to queue', async () => {
  const t = await bus.createTask({ from: 'planner', title: 'Lease test' });
  const c = await bus.claimTask(t.id, { by: 'watcher' });
  assert.equal(c.status, 'claimed');
  // forge an expired lease in state, then the next listing must release it
  bus.state.tasks.find(x => x.id === t.id).claimExpiresAt = new Date(Date.now() - 1000).toISOString();
  const tasks = await bus.listTasks({ status: 'queued' });
  const released = tasks.find(x => x.id === t.id);
  assert.ok(released, 'expired claim was not returned to queue');
  assert.equal(released.claimedBy, null);
});
await check('shared files round-trip + traversal blocked', async () => {
  await bus.putFile({ by: 'planner', path: 'capsules/api.md', text: '# API spec' });
  const f = await bus.getFile('capsules/api.md');
  assert.equal(f.text, '# API spec'); assert.equal(f.updatedBy, 'planner');
  assert.equal((await bus.listFiles()).length, 1);
  await assert.rejects(() => bus.putFile({ by: 'planner', path: '../evil', text: 'x' }), /\.\./);
});
await check('shared context round-trip', async () => {
  await bus.putContext({ by: 'planner', context: { project: 'demo', phase: 'build' } });
  assert.equal((await bus.getContext()).phase, 'build');
});
await check('board renders agents, tasks, files, activity', async () => {
  const board = await bus.board();
  for (const s of ['# Test Workspace', 'planner', 'builder', 'capsules/api.md', 'Recent activity']) assert.ok(board.includes(s), `board missing: ${s}`);
});
await check('provenance log records who did what', async () => {
  const ev = await bus.events({ limit: 100 });
  assert.ok(ev.some(e => e.type === 'task.claim' && e.actor === 'builder'));
  assert.ok(ev.some(e => e.type === 'agent.join' && e.actor === 'planner'));
  assert.ok(ev.every(e => e.seq >= 1 && e.at));
});
await check('status counts are coherent', async () => {
  const s = await bus.status();
  assert.equal(s.agents, 3); assert.equal(s.tasks.done, 1); assert.equal(s.files, 1); assert.equal(s.hasContext, true);
});

await check('task comments live on the task', async () => {
  const t = await bus.createTask({ from: 'planner', title: 'Commentable' });
  const c = await bus.addTaskComment(t.id, { by: 'builder', body: 'on it — ETA 1h' });
  assert.equal(c.comments.length, 1); assert.equal(c.comments[0].by, 'builder');
  await bus.cancelTask(t.id, { by: 'planner' });
});
await check('search finds tasks, messages, files', async () => {
  const r = await bus.search('API spec');
  assert.ok(r.files.some(f => f.path === 'capsules/api.md'));
  const r2 = await bus.search('Implement API');
  assert.ok(r2.tasks.some(t => t.title === 'Implement API'));
  await assert.rejects(() => bus.search('x'), /at least 2/);
});
await check('channels list derived from traffic', async () => {
  const ch = await bus.listChannels();
  assert.ok(ch.some(c => c.channel === 'general' && c.messages >= 2));
});
await check('heartbeat marks agent online; listing hides token hashes', async () => {
  const hb = await bus.heartbeat({ name: 'planner' });
  assert.equal(hb.agent.online, true);
  assert.ok(!('tokenHash' in hb.agent));
  assert.ok((await bus.listAgents()).every(a => !('tokenHash' in a)));
});
await check('registration issues a token once; file delete works', async () => {
  const reg = await bus.registerAgent({ name: 'token-agent' });
  assert.ok(reg.token && reg.token.length >= 32);
  assert.equal(reg.agent.hasToken, true);
  await bus.putFile({ by: 'planner', path: 'tmp.txt', text: 'gone soon' });
  assert.equal((await bus.deleteFile({ by: 'planner', path: 'tmp.txt' })).deleted, true);
  await assert.rejects(() => bus.getFile('tmp.txt'), /not found/);
});

/* ---------------- token-enforced bus ---------------- */
console.log('tokens:');
const secureBus = await createBus(new MemoryStore(), { name: 'Secure' }, { requireTokens: true });
let aliceToken;
await check('enforced bus: acting without token is refused', async () => {
  const reg = await secureBus.registerAgent({ name: 'alice', role: 'lead' });
  aliceToken = reg.token;
  await secureBus.registerAgent({ name: 'bob' });
  await assert.rejects(() => secureBus.sendMessage({ from: 'alice', to: 'bob', body: 'no token' }), /token required or wrong/);
  await assert.rejects(() => secureBus.sendMessage({ from: 'alice', to: 'bob', body: 'wrong', token: 'deadbeef' }), /token required or wrong/);
});
await check('enforced bus: correct token acts; tasks end-to-end', async () => {
  const bobReg = await secureBus.registerAgent({ name: 'carol' });
  await secureBus.sendMessage({ from: 'alice', to: 'carol', body: 'with token', token: aliceToken });
  const t = await secureBus.createTask({ from: 'alice', title: 'Secure task', token: aliceToken });
  await assert.rejects(() => secureBus.claimTask(t.id, { by: 'carol' }), /token required or wrong/);
  assert.equal((await secureBus.claimTask(t.id, { by: 'carol', token: bobReg.token })).status, 'claimed');
});
await check('token rotation invalidates the old token', async () => {
  const rot = await secureBus.rotateAgentToken({ name: 'alice', token: aliceToken });
  assert.ok(rot.token && rot.token !== aliceToken);
  await assert.rejects(() => secureBus.sendMessage({ from: 'alice', to: 'carol', body: 'x', token: aliceToken }), /token required or wrong/);
  await secureBus.sendMessage({ from: 'alice', to: 'carol', body: 'new token works', token: rot.token });
  aliceToken = rot.token;
});

await check('task dependencies: claim refused until blocker done', async () => {
  const blocker = await bus.createTask({ from: 'planner', title: 'Blocker' });
  const dependent = await bus.createTask({ from: 'planner', title: 'Dependent', blockedBy: [blocker.id] });
  await assert.rejects(() => bus.claimTask(dependent.id, { by: 'builder' }), /blocked by unfinished/);
  await bus.claimTask(blocker.id, { by: 'builder' });
  await bus.completeTask(blocker.id, { by: 'builder', result: 'unblocked' });
  assert.equal((await bus.claimTask(dependent.id, { by: 'builder' })).status, 'claimed');
  await assert.rejects(() => bus.createTask({ from: 'planner', title: 'Bad deps', blockedBy: [9999] }), /blocker task not found/);
});
await check('capsules: template, section update preserves others, session log appends', async () => {
  const c0 = await bus.getCapsule('demo-proj', { create: true, by: 'planner', title: 'Demo Proj' });
  for (const h of ['## State', '## Decisions (locked)', '## Next', '## Session log']) assert.ok(c0.text.includes(h), 'missing ' + h);
  await bus.updateCapsule('demo-proj', { by: 'planner', section: 'State', text: 'API half built.' });
  await bus.updateCapsule('demo-proj', { by: 'builder', section: 'Decisions (locked)', text: 'Node only, zero deps.' });
  await bus.updateCapsule('demo-proj', { by: 'builder', section: 'Session log', text: 'Finished endpoints.' });
  await bus.updateCapsule('demo-proj', { by: 'planner', section: 'Session log', text: 'Reviewed.' });
  const c = await bus.getCapsule('demo-proj');
  assert.match(c.text, /API half built/);
  assert.match(c.text, /Node only, zero deps/);
  assert.match(c.text, /Finished endpoints/);
  assert.match(c.text, /Reviewed/);
  assert.ok((c.text.match(/## State/g) || []).length === 1, 'section duplicated');
  assert.ok((await bus.listCapsules()).includes('demo-proj'));
  await assert.rejects(() => bus.updateCapsule('demo-proj', { by: 'planner', section: 'Bogus', text: 'x' }), /section must be one of/);
  await assert.rejects(() => bus.getCapsule('../evil'), /slug/);
});
await check('sync: cursor replays exactly the events after it', async () => {
  const head = (await bus.sync({})).headSeq;
  await bus.sendMessage({ from: 'planner', to: '*', body: 'sync marker msg' });
  const t = await bus.createTask({ from: 'planner', title: 'Sync marker task' });
  await bus.cancelTask(t.id, { by: 'planner' });
  const replay = await bus.sync({ sinceSeq: head });
  assert.equal(replay.events.length, 3);
  assert.ok(replay.events.every(e => e.seq > head));
  assert.equal(replay.headSeq, head + 3);
  assert.equal((await bus.sync({ sinceSeq: replay.headSeq })).events.length, 0);
});
await check('file history: versions kept, getFile stays lean', async () => {
  await bus.putFile({ by: 'planner', path: 'versioned.txt', text: 'v1' });
  await bus.putFile({ by: 'builder', path: 'versioned.txt', text: 'v2' });
  await bus.putFile({ by: 'builder', path: 'versioned.txt', text: 'v3' });
  const f = await bus.getFile('versioned.txt');
  assert.equal(f.text, 'v3'); assert.equal(f.versions, 3); assert.ok(!('history' in f));
  const h = await bus.fileHistory('versioned.txt');
  assert.equal(h.history.length, 2); assert.equal(h.history[0].text, 'v1'); assert.equal(h.history[1].text, 'v2');
  assert.equal(h.current.text, 'v3');
});

/* ---------------- persistence ---------------- */
console.log('persistence:');
await check('FileStore survives a reload (new bus instance, same file)', async () => {
  const file = path.join(tmp, 'data.json');
  const b1 = await createBus(new FileStore(file), { name: 'Persisted' });
  await b1.registerAgent({ name: 'solo' });
  await b1.sendMessage({ from: 'solo', to: '*', body: 'persist me' });
  const b2 = await createBus(new FileStore(file));
  assert.equal((await b2.listAgents()).length, 1);
  assert.equal((await b2.inbox('solo', { markRead: false })).length, 1);
});

await check('two bus instances on one file store see each other (multi-process sharing)', async () => {
  const file = path.join(tmp, 'shared.json');
  const a = await createBus(new FileStore(file), { name: 'Shared' });
  const b = await createBus(new FileStore(file), { name: 'Shared' });
  await a.registerAgent({ name: 'proc-a' });
  await b.registerAgent({ name: 'proc-b' }); // b must not clobber a's registration
  assert.equal((await a.listAgents()).length, 2);
  await a.sendMessage({ from: 'proc-a', to: 'proc-b', body: 'cross-process hello' });
  const inbox = await b.inbox('proc-b', { markRead: false });
  assert.equal(inbox.length, 1); assert.match(inbox[0].body, /cross-process/);
});

await check('concurrent FileStore saves never collide (v0.4.1 race regression)', async () => {
  // Pre-fix, FileStore.save wrote one fixed '<file>.tmp' then renamed it:
  // concurrent writers collided and most saves failed ENOENT (59/60 in the
  // standalone stress proof). Two store instances on one file, 60 saves
  // in flight at once: all must resolve and the file must stay valid JSON.
  const file = path.join(tmp, 'race.json');
  const s1 = new FileStore(file), s2 = new FileStore(file);
  const state = (n) => ({ workspace: { id: 'race', name: 'Race' }, seq: n, msgSeq: 0, taskSeq: 0, agents: [], messages: [], tasks: [], files: {}, context: null, events: [] });
  const jobs = [];
  for (let i = 0; i < 60; i++) jobs.push((i % 2 ? s1 : s2).save(state(i)));
  await Promise.all(jobs); // any ENOENT rejects here and fails the check
  const final = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.equal(typeof final.seq, 'number');
  assert.equal(fs.readdirSync(tmp).filter(f => f.includes('.tmp.')).length, 0, 'temp files left behind');
});

await check('concurrent writers on one bus lose no updates (v0.5.1 mutex regression)', async () => {
  // The operation-level race the per-Bus mutex fixes: every op is a fresh
  // load -> mutate -> save, so 4 writers x 12 rounds in flight at once on ONE
  // bus instance used to interleave their cycles and silently drop writes —
  // the original Ghost Hands probe ended with one writer's file stuck at an
  // early round and another's missing entirely, zero errors. With the mutex,
  // every writer's file must end at its final round, on disk too.
  const file = path.join(tmp, 'mutex.json');
  const mb = await createBus(new FileStore(file), { name: 'Mutex' });
  const writers = ['w-a', 'w-b', 'w-c', 'w-d'];
  for (const w of writers) await mb.registerAgent({ name: w });
  const ROUNDS = 12;
  await Promise.all(writers.map(async (w) => {
    for (let r = 1; r <= ROUNDS; r++) await mb.putFile({ by: w, path: `${w}.txt`, text: `round ${r}` });
  }));
  for (const w of writers) {
    assert.equal((await mb.getFile(`${w}.txt`)).text, `round ${ROUNDS}`, `${w} file is stale`);
  }
  const fresh = await createBus(new FileStore(file));
  assert.equal((await fresh.listFiles()).filter(f => f.path.endsWith('.txt')).length, 4);
  for (const w of writers) {
    assert.equal((await fresh.getFile(`${w}.txt`)).text, `round ${ROUNDS}`, `${w} file stale on disk`);
  }
});

await check('concurrent mixed ops (tasks + messages + files at once) all land', async () => {
  const file = path.join(tmp, 'mutex-mixed.json');
  const mb = await createBus(new FileStore(file), { name: 'Mixed' });
  await mb.registerAgent({ name: 'mixer' });
  const N = 10;
  await Promise.all([
    ...Array.from({ length: N }, (_, i) => mb.createTask({ from: 'mixer', title: `mix-task-${i}` })),
    ...Array.from({ length: N }, (_, i) => mb.sendMessage({ from: 'mixer', to: '*', body: `mix-msg-${i}` })),
    ...Array.from({ length: N }, (_, i) => mb.putFile({ by: 'mixer', path: `mix-${i}.txt`, text: `content ${i}` })),
  ]);
  const s = await mb.status();
  assert.equal(s.tasks.total, N, 'tasks lost under concurrency');
  assert.equal(s.messages, N, 'messages lost under concurrency');
  assert.equal(s.files, N, 'files lost under concurrency');
  const ids = (await mb.listTasks()).map(t => t.id);
  assert.equal(new Set(ids).size, N, 'task ids duplicated under concurrency');
});

await check('a throwing operation releases the mutex (bus never wedges)', async () => {
  const file = path.join(tmp, 'mutex-throw.json');
  const mb = await createBus(new FileStore(file), { name: 'Throw' });
  await mb.registerAgent({ name: 'tosser' });
  const results = await Promise.allSettled([
    mb.putFile({ by: 'tosser', path: 'ok-1.txt', text: 'one' }),
    mb.putFile({ by: 'tosser', path: '../evil', text: 'boom' }),   // throws mid-op
    mb.createTask({ from: 'ghost-agent', title: 'will fail' }),    // unknown agent, throws
    mb.putFile({ by: 'tosser', path: 'ok-2.txt', text: 'two' }),
    mb.sendMessage({ from: 'tosser', to: '*', body: 'still alive' }),
  ]);
  assert.equal(results.filter(r => r.status === 'rejected').length, 2);
  assert.equal(results.filter(r => r.status === 'fulfilled').length, 3);
  // If a throw wedged the chain, every later call would hang — race a timeout.
  const alive = await Promise.race([
    mb.status(),
    new Promise((_, rej) => setTimeout(() => rej(new Error('bus wedged: chain did not release after a throw')), 5000)),
  ]);
  assert.equal(alive.messages, 1);
  assert.equal((await mb.getFile('ok-2.txt')).text, 'two');
});

await check('snapshot -> restore round-trip preserves the workspace; bad snapshot refused', async () => {
  const src = await createBus(new MemoryStore(), { name: 'Snap Source' });
  await src.registerAgent({ name: 'snapper' });
  await src.createTask({ from: 'snapper', title: 'Snapshot me' });
  await src.putFile({ by: 'snapper', path: 'note.md', text: 'in the snapshot' });
  const snap = await src.snapshot();
  assert.ok(!JSON.stringify(snap).includes('"key"'), 'snapshot must not carry workspace keys');
  const dst = await createBus(new MemoryStore(), { name: 'Snap Target' });
  const st = await dst.restore(JSON.parse(JSON.stringify(snap)), { by: 'test' });
  assert.equal(st.agents, 1); assert.equal(st.tasks.total, 1); assert.equal(st.files, 1);
  assert.match((await dst.getFile('note.md')).text, /in the snapshot/);
  const evs = await dst.events({ limit: 5 });
  assert.ok(evs.some(e => e.type === 'workspace.restore'), 'restore is in the provenance log');
  await assert.rejects(() => dst.restore({ nope: true }), /invalid snapshot/);
  await assert.rejects(() => dst.restore(null), /invalid snapshot/);
});

/* ---------------- MCP tools layer ---------------- */
console.log('mcp tools:');
await check('tool list has 29 tools with schemas', async () => {
  assert.equal(TOOLS.length, 29);
  for (const t of TOOLS) { assert.ok(t.name && t.description && t.inputSchema, t.name); }
});
await check('callTool dispatch + unknown tool error', async () => {
  const out = await callTool(bus, 'bus_status', {});
  assert.equal(out.server, 'ghostbus');
  await assert.rejects(() => callTool(bus, 'nope', {}), /unknown tool/);
});

/* ---------------- MCP stdio end-to-end ---------------- */
console.log('mcp stdio:');
await check('stdio server: initialize, tools/list, register+send+inbox across two "agents"', async () => {
  const storeFile = path.join(tmp, 'stdio.json');
  const proc = spawn('node', ['src/mcp-server.mjs', '--store', storeFile], { cwd: new URL('.', import.meta.url).pathname, stdio: ['pipe', 'pipe', 'pipe'] });
  let buf = ''; const pending = new Map(); let seq = 0;
  proc.stdout.on('data', d => {
    buf += d;
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i); buf = buf.slice(i + 1);
      if (!line.trim()) continue;
      const m = JSON.parse(line);
      if (m.id !== undefined && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
    }
  });
  const rpc = (method, params) => new Promise((res) => { const id = ++seq; pending.set(id, res); proc.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n'); });
  const init = await rpc('initialize', {});
  assert.equal(init.result.serverInfo.name, 'ghostbus');
  const list = await rpc('tools/list', {});
  assert.equal(list.result.tools.length, 29);
  const reg = await rpc('tools/call', { name: 'bus_register', arguments: { agent: 'stdio-alice', role: 'tester' } });
  assert.ok(!reg.result.isError, JSON.stringify(reg));
  await rpc('tools/call', { name: 'bus_register', arguments: { agent: 'stdio-bob', role: 'tester' } });
  await rpc('tools/call', { name: 'bus_send', arguments: { agent: 'stdio-alice', to: 'stdio-bob', body: 'hello over stdio' } });
  const inbox = await rpc('tools/call', { name: 'bus_inbox', arguments: { agent: 'stdio-bob' } });
  assert.match(inbox.result.content[0].text, /hello over stdio/);
  const bad = await rpc('tools/call', { name: 'bus_send', arguments: { agent: 'nobody', body: 'x' } });
  assert.equal(bad.result.isError, true);
  proc.stdin.end(); proc.kill();
});

/* ---------------- HTTP relay end-to-end ---------------- */
console.log('http relay:');
await check('http: health open, api works, key auth enforced when set', async () => {
  const storeFile = path.join(tmp, 'http.json');
  const env = { ...process.env, GHOSTBUS_KEY: 'test-key-123456' };
  const proc = spawn('node', ['src/http-server.mjs', '--port', '18377', '--store', storeFile], { cwd: new URL('.', import.meta.url).pathname, env, stdio: ['ignore', 'pipe', 'pipe'] });
  const waitUp = async () => { for (let i = 0; i < 50; i++) { try { const r = await fetch('http://127.0.0.1:18377/health'); if (r.ok) return; } catch {} await new Promise(r => setTimeout(r, 100)); } throw new Error('server did not come up'); };
  try {
    await waitUp();
    const unauth = await fetch('http://127.0.0.1:18377/api/status');
    assert.equal(unauth.status, 401);
    const H = { 'content-type': 'application/json', 'x-bus-key': 'test-key-123456' };
    const reg = await fetch('http://127.0.0.1:18377/api/agents', { method: 'POST', headers: H, body: JSON.stringify({ agent: 'http-agent', role: 'relay test' }) });
    assert.equal(reg.status, 200);
    const mcp = await fetch('http://127.0.0.1:18377/mcp', { method: 'POST', headers: H, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'bus_status', arguments: {} } }) });
    const mcpJson = await mcp.json();
    assert.match(mcpJson.result.content[0].text, /ghostbus/);
    const probe = await fetch('http://127.0.0.1:18377/probe');
    assert.equal(probe.status, 200); // counts-only probe stays open
  } finally { proc.kill(); }
});

await check('http: board UI served at / and search endpoint works', async () => {
  const storeFile = path.join(tmp, 'ui.json');
  const proc = spawn('node', ['src/http-server.mjs', '--port', '18378', '--store', storeFile], { cwd: new URL('.', import.meta.url).pathname, stdio: ['ignore', 'pipe', 'pipe'] });
  try {
    for (let i = 0; i < 50; i++) { try { const r = await fetch('http://127.0.0.1:18378/health'); if (r.ok) break; } catch {} await new Promise(r => setTimeout(r, 100)); }
    const home = await fetch('http://127.0.0.1:18378/');
    assert.equal(home.status, 200);
    assert.match(await home.text(), /GhostBus Board/);
    await fetch('http://127.0.0.1:18378/api/agents', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ agent: 'ui-agent' }) });
    await fetch('http://127.0.0.1:18378/api/messages', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ agent: 'ui-agent', to: '*', body: 'findable zebra message' }) });
    const sr = await (await fetch('http://127.0.0.1:18378/api/search?q=zebra')).json();
    assert.equal(sr.messages.length, 1);
  } finally { proc.kill(); }
});
await check('http SSE: subscriber is pushed a direct message event', async () => {
  const storeFile = path.join(tmp, 'sse.json');
  const proc = spawn('node', ['src/http-server.mjs', '--port', '18379', '--store', storeFile], { cwd: new URL('.', import.meta.url).pathname, stdio: ['ignore', 'pipe', 'pipe'] });
  try {
    for (let i = 0; i < 50; i++) { try { const r = await fetch('http://127.0.0.1:18379/health'); if (r.ok) break; } catch {} await new Promise(r => setTimeout(r, 100)); }
    const H = { 'content-type': 'application/json' };
    await fetch('http://127.0.0.1:18379/api/agents', { method: 'POST', headers: H, body: JSON.stringify({ agent: 'sse-sender' }) });
    await fetch('http://127.0.0.1:18379/api/agents', { method: 'POST', headers: H, body: JSON.stringify({ agent: 'sse-recv' }) });
    const ctrl = new AbortController();
    const resp = await fetch('http://127.0.0.1:18379/api/stream?agent=sse-recv', { signal: ctrl.signal });
    assert.match(resp.headers.get('content-type'), /text\/event-stream/);
    const reader = resp.body.getReader();
    const readUntil = async (needle, tries = 40) => {
      let buf = '';
      for (let i = 0; i < tries; i++) {
        const { value, done } = await Promise.race([reader.read(), new Promise(r => setTimeout(() => r({ done: true }), 250))]);
        if (done) break;
        buf += new TextDecoder().decode(value);
        if (buf.includes(needle)) return buf;
      }
      return buf;
    };
    assert.ok((await readUntil('ready')).includes('ready'));
    await fetch('http://127.0.0.1:18379/api/messages', { method: 'POST', headers: H, body: JSON.stringify({ agent: 'sse-sender', to: 'sse-recv', body: 'pushed hello' }) });
    const got = await readUntil('pushed hello');
    assert.ok(got.includes('message.send') && got.includes('pushed hello'), 'SSE did not deliver: ' + got.slice(0, 200));
    ctrl.abort();
  } finally { proc.kill(); }
});
await check('cli: register/send/board from the shell', async () => {
  const { execFile } = await import('node:child_process');
  const { promisify } = await import('node:util');
  const run = promisify(execFile);
  const storeFile = path.join(tmp, 'cli.json');
  const cwd = new URL('.', import.meta.url).pathname;
  await run('node', ['src/cli.mjs', '--store', storeFile, 'register', 'cli-alice', '--role', 'tester'], { cwd });
  await run('node', ['src/cli.mjs', '--store', storeFile, 'register', 'cli-bob'], { cwd });
  await run('node', ['src/cli.mjs', '--store', storeFile, 'send', 'cli-alice', 'cli-bob', 'hello from cli'], { cwd });
  const { stdout } = await run('node', ['src/cli.mjs', '--store', storeFile, 'board'], { cwd });
  assert.match(stdout, /cli-alice/);
});

await check('http: long-poll /api/wait delivers, capsules + sync over REST, security headers', async () => {
  const storeFile = path.join(tmp, 'wait.json');
  const proc = spawn('node', ['src/http-server.mjs', '--port', '18380', '--store', storeFile], { cwd: new URL('.', import.meta.url).pathname, stdio: ['ignore', 'pipe', 'pipe'] });
  const H = { 'content-type': 'application/json' };
  try {
    for (let i = 0; i < 50; i++) { try { const r = await fetch('http://127.0.0.1:18380/health'); if (r.ok) { assert.equal(r.headers.get('x-content-type-options'), 'nosniff'); break; } } catch {} await new Promise(r => setTimeout(r, 100)); }
    await fetch('http://127.0.0.1:18380/api/agents', { method: 'POST', headers: H, body: JSON.stringify({ agent: 'waiter' }) });
    await fetch('http://127.0.0.1:18380/api/agents', { method: 'POST', headers: H, body: JSON.stringify({ agent: 'sender2' }) });
    const waitP = fetch('http://127.0.0.1:18380/api/wait?agent=waiter&timeout=10').then(r => r.json());
    await new Promise(r => setTimeout(r, 300));
    await fetch('http://127.0.0.1:18380/api/messages', { method: 'POST', headers: H, body: JSON.stringify({ agent: 'sender2', to: 'waiter', body: 'long-poll hello' }) });
    const waited = await waitP;
    assert.equal(waited.waited, true);
    assert.ok(waited.events.some(e => e.type === 'message.send'));
    const quick = await (await fetch('http://127.0.0.1:18380/api/wait?agent=waiter&timeout=1&sinceSeq=0')).json();
    assert.ok(quick.events.length >= 1 && quick.waited === false);
    await fetch('http://127.0.0.1:18380/api/capsules/rest-proj/section', { method: 'POST', headers: H, body: JSON.stringify({ agent: 'sender2', section: 'Next', text: 'Ship it.' }) });
    const cap = await (await fetch('http://127.0.0.1:18380/api/capsules/rest-proj')).json();
    assert.match(cap.text, /Ship it/);
    const sync = await (await fetch('http://127.0.0.1:18380/api/sync?sinceSeq=0')).json();
    assert.ok(sync.headSeq >= 3 && sync.events.length >= 3);
  } finally { proc.kill(); }
});

/* ---------------- hosted multi-workspace ---------------- */
console.log('hosted:');
await check('hosted: admin-gated creation, per-workspace keys, full isolation, MCP per workspace', async () => {
  const dataDir = path.join(tmp, 'hosted-data');
  const env = { ...process.env, GHOSTBUS_ADMIN_KEY: 'admin-secret-123' };
  const proc = spawn('node', ['src/hosted-server.mjs', '--port', '18382', '--data-dir', dataDir], { cwd: new URL('.', import.meta.url).pathname, env, stdio: ['ignore', 'pipe', 'pipe'] });
  const A = { 'content-type': 'application/json', 'x-bus-key': 'admin-secret-123' };
  const J = (r) => r.json();
  try {
    for (let i = 0; i < 50; i++) { try { const r = await fetch('http://127.0.0.1:18382/health'); if (r.ok) break; } catch {} await new Promise(r => setTimeout(r, 100)); }
    // creation requires admin
    assert.equal((await fetch('http://127.0.0.1:18382/api/workspaces', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ id: 'alpha' }) })).status, 401);
    const c1 = await J(await fetch('http://127.0.0.1:18382/api/workspaces', { method: 'POST', headers: A, body: JSON.stringify({ id: 'alpha', name: 'Alpha Team' }) }));
    assert.ok(c1.key && c1.key.length >= 32);
    const c2 = await J(await fetch('http://127.0.0.1:18382/api/workspaces', { method: 'POST', headers: A, body: JSON.stringify({ id: 'beta', name: 'Beta Team' }) }));
    assert.notEqual(c1.key, c2.key);
    // duplicate id refused
    assert.equal((await fetch('http://127.0.0.1:18382/api/workspaces', { method: 'POST', headers: A, body: JSON.stringify({ id: 'alpha' }) })).status, 409);
    const KA = { 'content-type': 'application/json', 'x-bus-key': c1.key };
    const KB = { 'content-type': 'application/json', 'x-bus-key': c2.key };
    // wrong key / other workspace's key rejected
    assert.equal((await fetch('http://127.0.0.1:18382/w/alpha/api/status', { headers: KB })).status, 401);
    assert.equal((await fetch('http://127.0.0.1:18382/w/alpha/api/status')).status, 401);
    // admin key works as master inside a workspace
    assert.equal((await fetch('http://127.0.0.1:18382/w/alpha/api/status', { headers: A })).status, 200);
    // work in alpha only (v0.5.2: hosted enforces per-agent tokens by
    // default, so the acting agent presents the token issued at register)
    const alphaReg = await J(await fetch('http://127.0.0.1:18382/w/alpha/api/agents', { method: 'POST', headers: KA, body: JSON.stringify({ agent: 'alpha-agent', role: 'a' }) }));
    assert.ok(alphaReg.token, 'registration must return the agent token');
    const KAT = { ...KA, 'x-agent-token': alphaReg.token };
    await fetch('http://127.0.0.1:18382/w/alpha/api/tasks', { method: 'POST', headers: KAT, body: JSON.stringify({ agent: 'alpha-agent', title: 'Alpha-only task' }) });
    const betaAgents = await J(await fetch('http://127.0.0.1:18382/w/beta/api/agents', { headers: KB }));
    assert.equal(betaAgents.agents.length, 0); // isolation: beta sees none of alpha's agents
    const betaTasks = await J(await fetch('http://127.0.0.1:18382/w/beta/api/tasks', { headers: KB }));
    assert.equal(betaTasks.tasks.length, 0);
    const alphaTasks = await J(await fetch('http://127.0.0.1:18382/w/alpha/api/tasks', { headers: KA }));
    assert.equal(alphaTasks.tasks.length, 1);
    // probe open per workspace + counts only alpha's work
    const probe = await J(await fetch('http://127.0.0.1:18382/w/alpha/probe'));
    assert.equal(probe.queued, 1); assert.equal(probe.workspace, 'alpha');
    // board page under prefix
    const board = await fetch('http://127.0.0.1:18382/w/alpha/');
    assert.equal(board.status, 200); assert.match(await board.text(), /GhostBus Board/);
    // MCP inside a workspace
    const mcp = await J(await fetch('http://127.0.0.1:18382/w/beta/mcp', { method: 'POST', headers: KB, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'bus_register', arguments: { agent: 'beta-agent' } } }) }));
    assert.ok(!mcp.result.isError, JSON.stringify(mcp));
    const betaAgents2 = await J(await fetch('http://127.0.0.1:18382/w/beta/api/agents', { headers: KB }));
    assert.equal(betaAgents2.agents.length, 1);
    // admin listing + delete
    const list = await J(await fetch('http://127.0.0.1:18382/api/workspaces', { headers: A }));
    assert.equal(list.workspaces.length, 2);
    assert.equal((await fetch('http://127.0.0.1:18382/api/workspaces/beta', { method: 'DELETE', headers: A })).status, 200);
    assert.equal((await fetch('http://127.0.0.1:18382/w/beta/api/status', { headers: KB })).status, 404);
    // unknown workspace 404
    assert.equal((await fetch('http://127.0.0.1:18382/w/nope/probe')).status, 404);
  } finally { proc.kill(); }
});

await check('hosted operator: rotate-key kills the old key; export -> delete -> import restores with a fresh key', async () => {
  const dataDir = path.join(tmp, 'hosted-ops');
  const env = { ...process.env, GHOSTBUS_ADMIN_KEY: 'ops-admin-secret-456' };
  const proc = spawn('node', ['src/hosted-server.mjs', '--port', '18383', '--data-dir', dataDir], { cwd: new URL('.', import.meta.url).pathname, env, stdio: ['ignore', 'pipe', 'pipe'] });
  const A = { 'content-type': 'application/json', 'x-bus-key': 'ops-admin-secret-456' };
  const J = (r) => r.json();
  try {
    for (let i = 0; i < 50; i++) { try { const r = await fetch('http://127.0.0.1:18383/health'); if (r.ok) break; } catch {} await new Promise(r => setTimeout(r, 100)); }
    const c = await J(await fetch('http://127.0.0.1:18383/api/workspaces', { method: 'POST', headers: A, body: JSON.stringify({ id: 'ops', name: 'Ops Team' }) }));
    const K1 = { 'content-type': 'application/json', 'x-bus-key': c.key };
    const opsReg = await J(await fetch('http://127.0.0.1:18383/w/ops/api/agents', { method: 'POST', headers: K1, body: JSON.stringify({ agent: 'ops-agent', role: 'o' }) }));
    const K1T = { ...K1, 'x-agent-token': opsReg.token };
    await fetch('http://127.0.0.1:18383/w/ops/api/tasks', { method: 'POST', headers: K1T, body: JSON.stringify({ agent: 'ops-agent', title: 'Ops task' }) });
    // rotate: admin-only, old key dies immediately, new key works
    assert.equal((await fetch('http://127.0.0.1:18383/api/workspaces/ops/rotate-key', { method: 'POST', headers: K1, body: '{}' })).status, 401);
    const rot = await J(await fetch('http://127.0.0.1:18383/api/workspaces/ops/rotate-key', { method: 'POST', headers: A, body: '{}' }));
    assert.ok(rot.key && rot.key !== c.key);
    assert.equal((await fetch('http://127.0.0.1:18383/w/ops/api/status', { headers: K1 })).status, 401);
    const K2 = { 'content-type': 'application/json', 'x-bus-key': rot.key };
    assert.equal((await fetch('http://127.0.0.1:18383/w/ops/api/status', { headers: K2 })).status, 200);
    // export: admin-only, envelope carries state but never a workspace key
    assert.equal((await fetch('http://127.0.0.1:18383/api/workspaces/ops/export', { headers: K2 })).status, 401);
    const exp = await J(await fetch('http://127.0.0.1:18383/api/workspaces/ops/export', { headers: A }));
    assert.equal(exp.ghostbusExport, 1);
    assert.equal(exp.state.tasks.length, 1);
    assert.ok(!('key' in exp) && !('keyHash' in exp.state), 'export must not contain the workspace key');
    // delete, then import the export under the same id: data back, FRESH key
    assert.equal((await fetch('http://127.0.0.1:18383/api/workspaces/ops', { method: 'DELETE', headers: A })).status, 200);
    const imp = await J(await fetch('http://127.0.0.1:18383/api/workspaces/import', { method: 'POST', headers: A, body: JSON.stringify(exp) }));
    assert.ok(imp.key && imp.key !== rot.key && imp.key !== c.key);
    assert.equal(imp.tasks, 1); assert.equal(imp.agents, 1);
    const K3 = { 'content-type': 'application/json', 'x-bus-key': imp.key };
    const tasks = await J(await fetch('http://127.0.0.1:18383/w/ops/api/tasks', { headers: K3 }));
    assert.equal(tasks.tasks.length, 1); assert.equal(tasks.tasks[0].title, 'Ops task');
    // importing over an existing id is refused; garbage snapshots refused
    assert.equal((await fetch('http://127.0.0.1:18383/api/workspaces/import', { method: 'POST', headers: A, body: JSON.stringify(exp) })).status, 409);
    assert.equal((await fetch('http://127.0.0.1:18383/api/workspaces/import', { method: 'POST', headers: A, body: JSON.stringify({ id: 'junk', state: { nope: 1 } }) })).status, 400);
  } finally { proc.kill(); }
});

await check('hosted security (v0.5.2): per-agent tokens enforced BY DEFAULT — no env set; tokenless action rejected, issued token works', async () => {
  const dataDir = path.join(tmp, 'hosted-secure');
  const env = { ...process.env, GHOSTBUS_ADMIN_KEY: 'default-on-admin-789' };
  delete env.GHOSTBUS_REQUIRE_TOKENS; // the whole point: enforcement must not need the opt-in anymore
  const proc = spawn('node', ['src/hosted-server.mjs', '--port', '18384', '--data-dir', dataDir], { cwd: new URL('.', import.meta.url).pathname, env, stdio: ['ignore', 'pipe', 'pipe'] });
  const A = { 'content-type': 'application/json', 'x-bus-key': 'default-on-admin-789' };
  const J = (r) => r.json();
  try {
    for (let i = 0; i < 50; i++) { try { const r = await fetch('http://127.0.0.1:18384/health'); if (r.ok) break; } catch {} await new Promise(r => setTimeout(r, 100)); }
    // admin routes refuse a missing admin key (list as well as create)
    assert.equal((await fetch('http://127.0.0.1:18384/api/workspaces')).status, 401);
    const c = await J(await fetch('http://127.0.0.1:18384/api/workspaces', { method: 'POST', headers: A, body: JSON.stringify({ id: 'secure', name: 'Secure Team' }) }));
    const K = { 'content-type': 'application/json', 'x-bus-key': c.key };
    const reg = await J(await fetch('http://127.0.0.1:18384/w/secure/api/agents', { method: 'POST', headers: K, body: JSON.stringify({ agent: 'sec-agent', role: 's' }) }));
    assert.ok(reg.token, 'registration issues the agent token');
    // acting with NO per-agent token is rejected under the default
    const noTok = await fetch('http://127.0.0.1:18384/w/secure/api/messages', { method: 'POST', headers: K, body: JSON.stringify({ agent: 'sec-agent', to: '*', body: 'tokenless' }) });
    assert.equal(noTok.status, 400);
    assert.match((await J(noTok)).error, /token required or wrong/);
    // a WRONG token is rejected too
    const badTok = await fetch('http://127.0.0.1:18384/w/secure/api/messages', { method: 'POST', headers: { ...K, 'x-agent-token': 'deadbeefdeadbeef' }, body: JSON.stringify({ agent: 'sec-agent', to: '*', body: 'wrong token' }) });
    assert.equal(badTok.status, 400);
    // the ISSUED token works, as header and as body field
    const okMsg = await fetch('http://127.0.0.1:18384/w/secure/api/messages', { method: 'POST', headers: { ...K, 'x-agent-token': reg.token }, body: JSON.stringify({ agent: 'sec-agent', to: '*', body: 'with token' }) });
    assert.equal(okMsg.status, 200);
    const okTask = await fetch('http://127.0.0.1:18384/w/secure/api/tasks', { method: 'POST', headers: K, body: JSON.stringify({ agent: 'sec-agent', title: 'Token task', token: reg.token }) });
    assert.equal(okTask.status, 200);
  } finally { proc.kill(); }
});

await check('hosted security (v0.5.2): GHOSTBUS_REQUIRE_TOKENS=0 is the only opt-out — and it starts with a loud warning', async () => {
  const dataDir = path.join(tmp, 'hosted-optout');
  const env = { ...process.env, GHOSTBUS_ADMIN_KEY: 'optout-admin-0000', GHOSTBUS_REQUIRE_TOKENS: '0' };
  const proc = spawn('node', ['src/hosted-server.mjs', '--port', '18385', '--data-dir', dataDir], { cwd: new URL('.', import.meta.url).pathname, env, stdio: ['ignore', 'pipe', 'pipe'] });
  let err = '';
  proc.stderr.on('data', d => { err += d; });
  const A = { 'content-type': 'application/json', 'x-bus-key': 'optout-admin-0000' };
  const J = (r) => r.json();
  try {
    for (let i = 0; i < 50; i++) { try { const r = await fetch('http://127.0.0.1:18385/health'); if (r.ok) break; } catch {} await new Promise(r => setTimeout(r, 100)); }
    assert.match(err, /WARNING/);
    assert.match(err, /GHOSTBUS_REQUIRE_TOKENS=0/);
    const c = await J(await fetch('http://127.0.0.1:18385/api/workspaces', { method: 'POST', headers: A, body: JSON.stringify({ id: 'open-ws', name: 'Opted Out' }) }));
    const K = { 'content-type': 'application/json', 'x-bus-key': c.key };
    await fetch('http://127.0.0.1:18385/w/open-ws/api/agents', { method: 'POST', headers: K, body: JSON.stringify({ agent: 'free-agent' }) });
    const msg = await fetch('http://127.0.0.1:18385/w/open-ws/api/messages', { method: 'POST', headers: K, body: JSON.stringify({ agent: 'free-agent', to: '*', body: 'no token needed here' }) });
    assert.equal(msg.status, 200); // enforcement really is off
  } finally { proc.kill(); }
});

await check('hosted security (v0.5.2): a short admin key is refused at startup', async () => {
  const dataDir = path.join(tmp, 'hosted-shortkey');
  const env = { ...process.env, GHOSTBUS_ADMIN_KEY: 'short' };
  const proc = spawn('node', ['src/hosted-server.mjs', '--port', '18386', '--data-dir', dataDir], { cwd: new URL('.', import.meta.url).pathname, env, stdio: ['ignore', 'pipe', 'pipe'] });
  let err = '';
  proc.stderr.on('data', d => { err += d; });
  try {
    const code = await new Promise((resolve) => {
      const t = setTimeout(() => resolve(null), 3000);
      proc.on('exit', (c) => { clearTimeout(t); resolve(c); });
    });
    assert.notEqual(code, null, 'server with a 5-char admin key must exit, not start');
    assert.equal(code, 2);
    assert.match(err, /at least 16 characters/);
  } finally { proc.kill(); }
});

await check('http relay (v0.5.2): no GHOSTBUS_KEY -> loud warning that it listens on all network interfaces', async () => {
  const storeFile = path.join(tmp, 'relay-warn.json');
  const env = { ...process.env };
  delete env.GHOSTBUS_KEY;
  const proc = spawn('node', ['src/http-server.mjs', '--port', '18387', '--store', storeFile], { cwd: new URL('.', import.meta.url).pathname, env, stdio: ['ignore', 'pipe', 'pipe'] });
  let err = '';
  proc.stderr.on('data', d => { err += d; });
  try {
    for (let i = 0; i < 50; i++) { try { const r = await fetch('http://127.0.0.1:18387/health'); if (r.ok) break; } catch {} await new Promise(r => setTimeout(r, 100)); }
    assert.match(err, /WARNING/);
    assert.match(err, /all network interfaces/);
    assert.match(err, /GHOSTBUS_KEY/);
  } finally { proc.kill(); }
});

await check('hosted hardening (v0.5.3): HTML pages carry CSP/frame headers, data files are 0600, admin actions are audit-logged', async () => {
  const dataDir = path.join(tmp, 'hosted-hardening');
  const env = { ...process.env, GHOSTBUS_ADMIN_KEY: 'vault-admin-secret-1' };
  const proc = spawn('node', ['src/hosted-server.mjs', '--port', '18388', '--data-dir', dataDir], { cwd: new URL('.', import.meta.url).pathname, env, stdio: ['ignore', 'pipe', 'pipe'] });
  let err = '';
  proc.stderr.on('data', d => { err += d; });
  const A = { 'content-type': 'application/json', 'x-bus-key': 'vault-admin-secret-1' };
  const J = (r) => r.json();
  try {
    for (let i = 0; i < 50; i++) { try { const r = await fetch('http://127.0.0.1:18388/health'); if (r.ok) break; } catch {} await new Promise(r => setTimeout(r, 100)); }
    // landing page: frame + CSP headers
    const landing = await fetch('http://127.0.0.1:18388/');
    assert.equal(landing.status, 200);
    assert.equal(landing.headers.get('x-frame-options'), 'DENY');
    assert.match(landing.headers.get('content-security-policy') || '', /frame-ancestors 'none'/);
    await landing.text();
    // create + use a workspace so its state file exists
    const c = await J(await fetch('http://127.0.0.1:18388/api/workspaces', { method: 'POST', headers: A, body: JSON.stringify({ id: 'vault', name: 'Vault Team' }) }));
    const K = { 'content-type': 'application/json', 'x-bus-key': c.key };
    // workspace board carries the same headers and still renders
    const board = await fetch('http://127.0.0.1:18388/w/vault/');
    assert.equal(board.status, 200);
    assert.equal(board.headers.get('x-frame-options'), 'DENY');
    assert.match(board.headers.get('content-security-policy') || '', /default-src 'self'/);
    assert.match(await board.text(), /GhostBus Board/);
    // right key works / wrong key refused on the timing-safe compare
    assert.equal((await fetch('http://127.0.0.1:18388/w/vault/api/status', { headers: K })).status, 200);
    assert.equal((await fetch('http://127.0.0.1:18388/w/vault/api/status', { headers: { 'x-bus-key': 'not-the-vault-key' } })).status, 401);
    const reg = await J(await fetch('http://127.0.0.1:18388/w/vault/api/agents', { method: 'POST', headers: K, body: JSON.stringify({ agent: 'vault-agent' }) }));
    await fetch('http://127.0.0.1:18388/w/vault/api/messages', { method: 'POST', headers: { ...K, 'x-agent-token': reg.token }, body: JSON.stringify({ agent: 'vault-agent', to: '*', body: 'perms probe' }) });
    // registry + workspace state files are owner-only
    for (const f of ['registry.json', 'vault.json']) {
      const mode = fs.statSync(path.join(dataDir, f)).mode & 0o777;
      assert.equal(mode, 0o600, `${f} must be 0600, got ${mode.toString(8)}`);
    }
    // rotate + delete, then the audit trail must name all three actions
    await fetch('http://127.0.0.1:18388/api/workspaces/vault/rotate-key', { method: 'POST', headers: A, body: '{}' });
    await fetch('http://127.0.0.1:18388/api/workspaces/vault', { method: 'DELETE', headers: A });
    await new Promise(r => setTimeout(r, 150)); // let stderr flush
    for (const action of ['create', 'rotate-key', 'delete']) {
      assert.match(err, new RegExp(`"audit":"admin","action":"${action}","workspace":"vault"`), `missing audit line for ${action}`);
    }
    // ... and never a key, hash, or secret
    assert.ok(!err.includes(c.key), 'audit log must not contain the workspace key');
    assert.ok(!err.includes('vault-admin-secret-1'), 'audit log must not contain the admin key');
  } finally { proc.kill(); }
});

await check('hardening (v0.5.3): JSON bodies over 1 MB -> 413 on hosted admin, in-workspace, and single-relay routes', async () => {
  const dataDir = path.join(tmp, 'hosted-bigbody');
  const env = { ...process.env, GHOSTBUS_ADMIN_KEY: 'bigbody-admin-secret' };
  const proc = spawn('node', ['src/hosted-server.mjs', '--port', '18389', '--data-dir', dataDir], { cwd: new URL('.', import.meta.url).pathname, env, stdio: ['ignore', 'pipe', 'pipe'] });
  const relay = spawn('node', ['src/http-server.mjs', '--port', '18390', '--store', ':memory:'], { cwd: new URL('.', import.meta.url).pathname, env: { ...process.env }, stdio: ['ignore', 'pipe', 'pipe'] });
  const A = { 'content-type': 'application/json', 'x-bus-key': 'bigbody-admin-secret' };
  const J = (r) => r.json();
  const big = 'x'.repeat(1_100_000);
  try {
    for (let i = 0; i < 50; i++) { try { const r = await fetch('http://127.0.0.1:18389/health'); if (r.ok) break; } catch {} await new Promise(r => setTimeout(r, 100)); }
    for (let i = 0; i < 50; i++) { try { const r = await fetch('http://127.0.0.1:18390/health'); if (r.ok) break; } catch {} await new Promise(r => setTimeout(r, 100)); }
    // hosted admin route
    const h = await fetch('http://127.0.0.1:18389/api/workspaces', { method: 'POST', headers: A, body: JSON.stringify({ id: 'big', name: big }) });
    assert.equal(h.status, 413);
    assert.match((await J(h)).error, /too large/);
    // in-workspace route (shared handler)
    const c = await J(await fetch('http://127.0.0.1:18389/api/workspaces', { method: 'POST', headers: A, body: JSON.stringify({ id: 'bigws' }) }));
    const K = { 'content-type': 'application/json', 'x-bus-key': c.key };
    const w = await fetch('http://127.0.0.1:18389/w/bigws/api/files', { method: 'PUT', headers: K, body: JSON.stringify({ agent: 'a', path: 'big.txt', text: big }) });
    assert.equal(w.status, 413);
    // single relay route (same handler, other server)
    const r = await fetch('http://127.0.0.1:18390/api/files', { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ agent: 'a', path: 'big.txt', text: big }) });
    assert.equal(r.status, 413);
    assert.match((await J(r)).error, /too large/);
    // a normal small body still works everywhere afterwards
    assert.equal((await fetch('http://127.0.0.1:18389/w/bigws/api/status', { headers: K })).status, 200);
  } finally { proc.kill(); relay.kill(); }
});

await check('hosted hardening (v0.5.3): failed-auth throttle — 30 bad auths/min from one IP -> 429 on admin + workspace routes', async () => {
  const dataDir = path.join(tmp, 'hosted-throttle');
  const env = { ...process.env, GHOSTBUS_ADMIN_KEY: 'throttle-admin-secret' };
  const proc = spawn('node', ['src/hosted-server.mjs', '--port', '18391', '--data-dir', dataDir], { cwd: new URL('.', import.meta.url).pathname, env, stdio: ['ignore', 'pipe', 'pipe'] });
  const A = { 'content-type': 'application/json', 'x-bus-key': 'throttle-admin-secret' };
  const J = (r) => r.json();
  try {
    for (let i = 0; i < 50; i++) { try { const r = await fetch('http://127.0.0.1:18391/health'); if (r.ok) break; } catch {} await new Promise(r => setTimeout(r, 100)); }
    const c = await J(await fetch('http://127.0.0.1:18391/api/workspaces', { method: 'POST', headers: A, body: JSON.stringify({ id: 'throttle' }) }));
    const BAD = { 'x-bus-key': 'guessed-key-000000' };
    // 30 failed workspace auths: all plain 401s, none throttled yet
    for (let i = 0; i < 30; i++) {
      assert.equal((await fetch('http://127.0.0.1:18391/w/throttle/api/status', { headers: BAD })).status, 401, `attempt ${i + 1}`);
    }
    // the throttle is now tripped for this IP: even the CORRECT key gets 429
    assert.equal((await fetch('http://127.0.0.1:18391/w/throttle/api/status', { headers: { 'x-bus-key': c.key } })).status, 429);
    // ... and so does the admin surface
    assert.equal((await fetch('http://127.0.0.1:18391/api/workspaces', { headers: A })).status, 429);
    // open surfaces stay open (health is how operators notice an attack)
    assert.equal((await fetch('http://127.0.0.1:18391/health')).status, 200);
  } finally { proc.kill(); }
});

console.log(`\n${pass} passed, ${fail} failed`);
fs.rmSync(tmp, { recursive: true, force: true });
process.exit(fail ? 1 : 0);
