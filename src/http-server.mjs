#!/usr/bin/env node
/**
 * GhostBus HTTP relay — zero dependencies.
 * Same core + same MCP tools over HTTP, for hosted/multi-machine setups:
 * agents that can't share a local file connect to one relay instead.
 *
 *   node src/http-server.mjs [--port 8377] [--store ./ghostbus-data.json]
 * Env: GHOSTBUS_PORT, GHOSTBUS_STORE, GHOSTBUS_WORKSPACE_NAME,
 *      GHOSTBUS_KEY — if set, every /api and /mcp call needs header
 *      `x-bus-key: <key>` or `Authorization: Bearer <key>`. /health and
 *      /probe (counts only) stay open.
 */
import http from 'node:http';
import crypto from 'node:crypto';
import fs from 'node:fs';
import { createBus, MemoryStore, FileStore, GHOSTBUS_VERSION } from './core.mjs';
import { TOOLS, callTool } from './tools.mjs';

const argv = process.argv.slice(2);
const argVal = (flag) => { const i = argv.indexOf(flag); return i >= 0 ? argv[i + 1] : null; };
const port = Number(argVal('--port') || process.env.GHOSTBUS_PORT || 8377);
const storePath = argVal('--store') || process.env.GHOSTBUS_STORE || './ghostbus-data.json';
const wsName = argVal('--name') || process.env.GHOSTBUS_WORKSPACE_NAME || 'GhostBus Workspace';
const KEY = process.env.GHOSTBUS_KEY || '';

const store = storePath === ':memory:' ? new MemoryStore() : new FileStore(storePath);
const REQUIRE_TOKENS = process.env.GHOSTBUS_REQUIRE_TOKENS === '1';
const bus = await createBus(store, { name: wsName }, { requireTokens: REQUIRE_TOKENS });
const BOARD_HTML = fs.readFileSync(new URL('./board.html', import.meta.url), 'utf8');
const agentTokenOf = (req, body = {}, q = {}) =>
  body.token || q.token || req.headers['x-agent-token'] || null;

// Lightweight per-IP token bucket (relay hygiene, not a WAF): 300 req/min/IP.
const buckets = new Map();
const rateOk = (req) => {
  const ip = req.socket.remoteAddress || 'unknown';
  const t = Date.now();
  let b = buckets.get(ip);
  if (!b || t - b.start > 60_000) { b = { start: t, count: 0 }; buckets.set(ip, b); }
  b.count += 1;
  return b.count <= 300;
};

const keyOk = (req) => {
  if (!KEY) return true;
  const given = req.headers['x-bus-key'] || String(req.headers.authorization || '').replace(/^Bearer\s+/i, '');
  const a = Buffer.from(crypto.createHash('sha256').update(String(given)).digest('hex'));
  const b = Buffer.from(crypto.createHash('sha256').update(KEY).digest('hex'));
  return a.length === b.length && crypto.timingSafeEqual(a, b);
};

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  res.setHeader('x-content-type-options', 'nosniff');
  res.setHeader('referrer-policy', 'no-referrer');
  if (!rateOk(req) && url.pathname !== '/health' && url.pathname !== '/probe') return (() => { res.writeHead(429, { 'content-type': 'application/json' }); res.end(JSON.stringify({ error: 'rate limit: 300 requests/min per IP' })); })();
  const send = (status, obj, type = 'application/json') => {
    const body = type === 'application/json' ? JSON.stringify(obj) : String(obj);
    res.writeHead(status, { 'content-type': type }); res.end(body);
  };
  const readBody = () => new Promise((resolve) => {
    let data = ''; req.on('data', c => { data += c; if (data.length > 5_000_000) req.destroy(); });
    req.on('end', () => { try { resolve(data ? JSON.parse(data) : {}); } catch { resolve(null); } });
  });

  try {
    if (req.method === 'GET' && url.pathname === '/') { res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }); return res.end(BOARD_HTML); }
    if (req.method === 'GET' && url.pathname === '/health') return send(200, { ok: true, server: 'ghostbus', version: GHOSTBUS_VERSION });
    if (req.method === 'GET' && url.pathname === '/probe') {
      const s = await bus.status();
      return send(200, { queued: s.tasks.queued, needsApproval: s.tasks.needsApproval, agents: s.agents, version: GHOSTBUS_VERSION });
    }
    if (!keyOk(req)) return send(401, { error: 'missing or wrong bus key' });

    // Live event stream (SSE): an agent subscribes once and gets pushed the
    // events addressed to it (direct messages) plus workspace-wide task/file events.
    if (req.method === 'GET' && url.pathname === '/api/stream') {
      const agent = url.searchParams.get('agent');
      if (!agent) return send(400, { error: 'agent query param required' });
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' });
      res.write(`event: ready\ndata: ${JSON.stringify({ agent, version: GHOSTBUS_VERSION })}\n\n`);
      const off = bus.onEvent((ev) => {
        const forMe = ev.type === 'message.send' ? (ev.to === agent || ev.to === '*' || ev.actor === agent) : true;
        if (!forMe) return;
        res.write(`event: ${ev.type}\ndata: ${JSON.stringify(ev)}\n\n`);
      });
      const ping = setInterval(() => res.write(': ping\n\n'), 25000);
      req.on('close', () => { clearInterval(ping); off(); });
      return;
    }

    // Long-poll: hold the request until an event relevant to this agent lands
    // (or timeout). For agents that can't hold an SSE stream open.
    if (req.method === 'GET' && url.pathname === '/api/wait') {
      const agent = url.searchParams.get('agent');
      if (!agent) return send(400, { error: 'agent query param required' });
      const timeout = Math.min(Number(url.searchParams.get('timeout') || 25), 55) * 1000;
      // No cursor given = "wake me for NEW events": start from the current head.
      const sinceSeq = url.searchParams.has('sinceSeq') ? Number(url.searchParams.get('sinceSeq')) : (await bus.sync({})).headSeq;
      const immediate = await bus.sync({ sinceSeq, limit: 100 });
      const relevantNow = immediate.events.filter(ev => ev.type !== 'message.send' || ev.to === agent || ev.to === '*' || ev.actor === agent);
      if (relevantNow.length) return send(200, { events: relevantNow, headSeq: immediate.headSeq, waited: false });
      return await new Promise((resolve) => {
        let done = false;
        const finish = (events) => { if (done) return; done = true; off(); clearTimeout(timer); resolve(send(200, { events, headSeq: events.length ? events[events.length - 1].seq : sinceSeq, waited: true })); };
        const off = bus.onEvent((ev) => {
          if (ev.seq <= sinceSeq) return;
          if (ev.type === 'message.send' && !(ev.to === agent || ev.to === '*' || ev.actor === agent)) return;
          finish([ev]);
        });
        const timer = setTimeout(() => finish([]), timeout);
        req.on('close', () => { if (!done) { done = true; off(); clearTimeout(timer); resolve(); } });
      });
    }

    // MCP over HTTP (single JSON-RPC endpoint, same tools as stdio)
    if (req.method === 'POST' && url.pathname === '/mcp') {
      const msg = await readBody();
      if (!msg) return send(400, { error: 'invalid JSON body' });
      if (msg.method === 'tools/list') return send(200, { jsonrpc: '2.0', id: msg.id, result: { tools: TOOLS } });
      if (msg.method === 'tools/call') {
        try {
          const argsIn = { ...(msg.params.arguments || {}) };
          const hdrToken = req.headers['x-agent-token'];
          if (hdrToken && !argsIn.token) argsIn.token = hdrToken;
          const out = await callTool(bus, msg.params.name, argsIn);
          return send(200, { jsonrpc: '2.0', id: msg.id, result: { content: [{ type: 'text', text: JSON.stringify(out, null, 2) }] } });
        } catch (e) { return send(200, { jsonrpc: '2.0', id: msg.id, result: { content: [{ type: 'text', text: `Error: ${e.message}` }], isError: true } }); }
      }
      return send(400, { error: `unsupported MCP method over HTTP relay: ${msg.method} (use tools/list or tools/call)` });
    }

    // REST mirror
    const body = ['POST', 'PUT'].includes(req.method) ? await readBody() : {};
    if (body === null) return send(400, { error: 'invalid JSON body' });
    const q = Object.fromEntries(url.searchParams);

    if (req.method === 'GET' && url.pathname === '/api/status') return send(200, await bus.status());
    if (req.method === 'GET' && url.pathname === '/api/agents') return send(200, { agents: await bus.listAgents() });
    if (req.method === 'POST' && url.pathname === '/api/agents') return send(200, await bus.registerAgent({ name: body.agent, role: body.role, capabilities: body.capabilities, token: agentTokenOf(req, body) }));
    if (req.method === 'POST' && url.pathname === '/api/messages') return send(200, await bus.sendMessage({ from: body.agent, to: body.to ?? '*', body: body.body, channel: body.channel ?? 'general', threadId: body.threadId ?? null, token: agentTokenOf(req, body) }));
    if (req.method === 'GET' && url.pathname === '/api/inbox') return send(200, { messages: await bus.inbox(q.agent, { unreadOnly: q.unread === '1', limit: Number(q.limit || 50), token: agentTokenOf(req, {}, q) }) });
    if (req.method === 'POST' && url.pathname === '/api/heartbeat') return send(200, await bus.heartbeat({ name: body.agent, token: agentTokenOf(req, body) }));
    if (req.method === 'GET' && url.pathname === '/api/search') return send(200, await bus.search(q.q || '', { limit: Number(q.limit || 20) }));
    if (req.method === 'GET' && url.pathname === '/api/channels') return send(200, { channels: await bus.listChannels() });
    if (req.method === 'POST' && url.pathname === '/api/tasks') return send(200, await bus.createTask({ from: body.agent, title: body.title, body: body.body ?? '', assignee: body.assignee ?? null, priority: body.priority ?? 'normal', needsApproval: !!body.needsApproval, blockedBy: body.blockedBy ?? [], token: agentTokenOf(req, body) }));
    if (req.method === 'GET' && url.pathname === '/api/tasks') return send(200, { tasks: await bus.listTasks({ status: q.status || null, assignee: q.assignee || null }) });
    const taskAction = url.pathname.match(/^\/api\/tasks\/(\d+)\/(approve|claim|complete|cancel)$/);
    if (req.method === 'POST' && taskAction) {
      const [, id, action] = taskAction;
      const tk = agentTokenOf(req, body);
      if (action === 'approve') return send(200, await bus.approveTask(id, { by: body.agent, token: tk }));
      if (action === 'claim') return send(200, await bus.claimTask(id, { by: body.agent, token: tk }));
      if (action === 'complete') return send(200, await bus.completeTask(id, { by: body.agent, result: body.result ?? '', token: tk }));
      if (action === 'cancel') return send(200, await bus.cancelTask(id, { by: body.agent, token: tk }));
    }
    const taskComment = url.pathname.match(/^\/api\/tasks\/(\d+)\/comment$/);
    if (req.method === 'POST' && taskComment) return send(200, await bus.addTaskComment(taskComment[1], { by: body.agent, body: body.body, token: agentTokenOf(req, body) }));
    if (req.method === 'PUT' && url.pathname === '/api/files') return send(200, await bus.putFile({ by: body.agent, path: body.path, text: body.text, token: agentTokenOf(req, body) }));
    if (req.method === 'DELETE' && url.pathname === '/api/files') return send(200, await bus.deleteFile({ by: q.agent, path: q.path, token: agentTokenOf(req, {}, q) }));
    if (req.method === 'GET' && url.pathname === '/api/files') return send(200, await bus.getFile(q.path));
    if (req.method === 'GET' && url.pathname === '/api/files/list') return send(200, { files: await bus.listFiles() });
    if (req.method === 'PUT' && url.pathname === '/api/context') return send(200, await bus.putContext({ by: body.agent, context: body.context, token: agentTokenOf(req, body) }));
    if (req.method === 'GET' && url.pathname === '/api/context') return send(200, await bus.getContext());
    if (req.method === 'GET' && url.pathname === '/api/board') return send(200, { board: await bus.board() }, 'application/json');
    if (req.method === 'GET' && url.pathname === '/api/events') return send(200, { events: await bus.events({ limit: Number(q.limit || 50) }) });
    if (req.method === 'GET' && url.pathname === '/api/sync') return send(200, await bus.sync({ sinceSeq: Number(q.sinceSeq || 0), limit: Number(q.limit || 500) }));
    if (req.method === 'GET' && url.pathname === '/api/capsules') return send(200, { capsules: await bus.listCapsules() });
    const capsuleGet = url.pathname.match(/^\/api\/capsules\/([a-z0-9-]+)$/);
    if (req.method === 'GET' && capsuleGet) return send(200, await bus.getCapsule(capsuleGet[1], { create: q.create === '1', by: q.agent || null }));
    const capsulePut = url.pathname.match(/^\/api\/capsules\/([a-z0-9-]+)\/section$/);
    if (req.method === 'POST' && capsulePut) return send(200, await bus.updateCapsule(capsulePut[1], { by: body.agent, section: body.section, text: body.text, token: agentTokenOf(req, body) }));
    if (req.method === 'GET' && url.pathname === '/api/files/history') return send(200, await bus.fileHistory(q.path));

    return send(404, { error: 'not found' });
  } catch (e) {
    return send(e.code === 'UNKNOWN_AGENT' ? 400 : 400, { error: e.message, code: e.code || undefined });
  }
});

server.listen(port, () => {
  process.stderr.write(`ghostbus http relay v${GHOSTBUS_VERSION} · http://127.0.0.1:${port} · store=${storePath} · auth=${KEY ? 'workspace key required' : 'open (set GHOSTBUS_KEY)'} · agentTokens=${REQUIRE_TOKENS ? 'enforced' : 'issued, not enforced'}\n`);
});
