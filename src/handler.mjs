/**
 * GhostBus HTTP request handler — transport logic shared by the single-workspace
 * relay (http-server.mjs) and the hosted multi-workspace server (hosted-server.mjs).
 *
 * createBusHandler({ id, bus, key }) -> async (req, res, url)
 * - `url` is a URL whose pathname is the path WITHIN the workspace (any
 *   /w/<id> prefix already stripped by the caller).
 * - `key` is the workspace key ('' = open). /health, /probe and the board page
 *   stay open; everything else needs the key when one is set.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import { GHOSTBUS_VERSION } from './core.mjs';
import { TOOLS, callTool } from './tools.mjs';

export const BOARD_HTML = fs.readFileSync(new URL('./board.html', import.meta.url), 'utf8');

const agentTokenOf = (req, body = {}, q = {}) =>
  body.token || q.token || req.headers['x-agent-token'] || null;

const hashEq = (given, expected) => {
  const a = Buffer.from(crypto.createHash('sha256').update(String(given)).digest('hex'));
  const b = Buffer.from(crypto.createHash('sha256').update(String(expected)).digest('hex'));
  return a.length === b.length && crypto.timingSafeEqual(a, b);
};
export const keyMatches = (given, expected) => !!expected && !!given && hashEq(given, expected);

export function createBusHandler({ id = 'default', bus, key = '' }) {
  const buckets = new Map();
  const rateOk = (req) => {
    const ip = (req.socket && req.socket.remoteAddress) || 'unknown';
    const t = Date.now();
    let b = buckets.get(ip);
    if (!b || t - b.start > 60_000) { b = { start: t, count: 0 }; buckets.set(ip, b); }
    b.count += 1;
    return b.count <= 300;
  };
  const keyOk = (req) => {
    if (!key) return true;
    const given = req.headers['x-bus-key'] || String(req.headers.authorization || '').replace(/^Bearer\s+/i, '');
    return keyMatches(given, key);
  };

  return async function handle(req, res, url) {
    res.setHeader('x-content-type-options', 'nosniff');
    res.setHeader('referrer-policy', 'no-referrer');
    const send = (status, obj, type = 'application/json') => {
      const body = type === 'application/json' ? JSON.stringify(obj) : String(obj);
      res.writeHead(status, { 'content-type': type }); res.end(body);
    };
    if (!rateOk(req) && url.pathname !== '/health' && url.pathname !== '/probe') {
      return send(429, { error: 'rate limit: 300 requests/min per IP per workspace' });
    }
    const readBody = () => new Promise((resolve) => {
      let data = ''; req.on('data', c => { data += c; if (data.length > 5_000_000) req.destroy(); });
      req.on('end', () => { try { resolve(data ? JSON.parse(data) : {}); } catch { resolve(null); } });
    });

    try {
      if (req.method === 'GET' && url.pathname === '/') { res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }); return res.end(BOARD_HTML); }
      if (req.method === 'GET' && url.pathname === '/health') return send(200, { ok: true, server: 'ghostbus', workspace: id, version: GHOSTBUS_VERSION });
      if (req.method === 'GET' && url.pathname === '/probe') {
        const s = await bus.status();
        return send(200, { workspace: id, queued: s.tasks.queued, needsApproval: s.tasks.needsApproval, agents: s.agents, version: GHOSTBUS_VERSION });
      }
      if (!keyOk(req)) return send(401, { error: 'missing or wrong bus key' });

      if (req.method === 'GET' && url.pathname === '/api/stream') {
        const agent = url.searchParams.get('agent');
        if (!agent) return send(400, { error: 'agent query param required' });
        res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' });
        res.write(`event: ready\ndata: ${JSON.stringify({ agent, workspace: id, version: GHOSTBUS_VERSION })}\n\n`);
        const off = bus.onEvent((ev) => {
          const forMe = ev.type === 'message.send' ? (ev.to === agent || ev.to === '*' || ev.actor === agent) : true;
          if (!forMe) return;
          res.write(`event: ${ev.type}\ndata: ${JSON.stringify(ev)}\n\n`);
        });
        const ping = setInterval(() => res.write(': ping\n\n'), 25000);
        req.on('close', () => { clearInterval(ping); off(); });
        return;
      }

      if (req.method === 'GET' && url.pathname === '/api/wait') {
        const agent = url.searchParams.get('agent');
        if (!agent) return send(400, { error: 'agent query param required' });
        const timeout = Math.min(Number(url.searchParams.get('timeout') || 25), 55) * 1000;
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

      const body = ['POST', 'PUT', 'DELETE'].includes(req.method) ? await readBody().catch(() => ({})) : {};
      const safeBody = body && typeof body === 'object' ? body : {};
      const q = Object.fromEntries(url.searchParams);

      if (req.method === 'GET' && url.pathname === '/api/status') return send(200, await bus.status());
      if (req.method === 'GET' && url.pathname === '/api/agents') return send(200, { agents: await bus.listAgents() });
      if (req.method === 'POST' && url.pathname === '/api/agents') return send(200, await bus.registerAgent({ name: safeBody.agent, role: safeBody.role, capabilities: safeBody.capabilities, token: agentTokenOf(req, safeBody) }));
      if (req.method === 'POST' && url.pathname === '/api/messages') return send(200, await bus.sendMessage({ from: safeBody.agent, to: safeBody.to ?? '*', body: safeBody.body, channel: safeBody.channel ?? 'general', threadId: safeBody.threadId ?? null, token: agentTokenOf(req, safeBody) }));
      if (req.method === 'GET' && url.pathname === '/api/inbox') return send(200, { messages: await bus.inbox(q.agent, { unreadOnly: q.unread === '1', limit: Number(q.limit || 50), token: agentTokenOf(req, {}, q) }) });
      if (req.method === 'POST' && url.pathname === '/api/heartbeat') return send(200, await bus.heartbeat({ name: safeBody.agent, token: agentTokenOf(req, safeBody) }));
      if (req.method === 'GET' && url.pathname === '/api/search') return send(200, await bus.search(q.q || '', { limit: Number(q.limit || 20) }));
      if (req.method === 'GET' && url.pathname === '/api/channels') return send(200, { channels: await bus.listChannels() });
      if (req.method === 'POST' && url.pathname === '/api/tasks') return send(200, await bus.createTask({ from: safeBody.agent, title: safeBody.title, body: safeBody.body ?? '', assignee: safeBody.assignee ?? null, priority: safeBody.priority ?? 'normal', needsApproval: !!safeBody.needsApproval, blockedBy: safeBody.blockedBy ?? [], token: agentTokenOf(req, safeBody) }));
      if (req.method === 'GET' && url.pathname === '/api/tasks') return send(200, { tasks: await bus.listTasks({ status: q.status || null, assignee: q.assignee || null }) });
      const taskAction = url.pathname.match(/^\/api\/tasks\/(\d+)\/(approve|claim|complete|cancel)$/);
      if (req.method === 'POST' && taskAction) {
        const [, tid, action] = taskAction;
        const tk = agentTokenOf(req, safeBody);
        if (action === 'approve') return send(200, await bus.approveTask(tid, { by: safeBody.agent, token: tk }));
        if (action === 'claim') return send(200, await bus.claimTask(tid, { by: safeBody.agent, token: tk }));
        if (action === 'complete') return send(200, await bus.completeTask(tid, { by: safeBody.agent, result: safeBody.result ?? '', token: tk }));
        if (action === 'cancel') return send(200, await bus.cancelTask(tid, { by: safeBody.agent, token: tk }));
      }
      const taskComment = url.pathname.match(/^\/api\/tasks\/(\d+)\/comment$/);
      if (req.method === 'POST' && taskComment) return send(200, await bus.addTaskComment(taskComment[1], { by: safeBody.agent, body: safeBody.body, token: agentTokenOf(req, safeBody) }));
      if (req.method === 'PUT' && url.pathname === '/api/files') return send(200, await bus.putFile({ by: safeBody.agent, path: safeBody.path, text: safeBody.text, token: agentTokenOf(req, safeBody) }));
      if (req.method === 'DELETE' && url.pathname === '/api/files') return send(200, await bus.deleteFile({ by: q.agent || safeBody.agent, path: q.path || safeBody.path, token: agentTokenOf(req, safeBody, q) }));
      if (req.method === 'GET' && url.pathname === '/api/files') return send(200, await bus.getFile(q.path));
      if (req.method === 'GET' && url.pathname === '/api/files/list') return send(200, { files: await bus.listFiles() });
      if (req.method === 'GET' && url.pathname === '/api/files/history') return send(200, await bus.fileHistory(q.path));
      if (req.method === 'PUT' && url.pathname === '/api/context') return send(200, await bus.putContext({ by: safeBody.agent, context: safeBody.context, token: agentTokenOf(req, safeBody) }));
      if (req.method === 'GET' && url.pathname === '/api/context') return send(200, await bus.getContext());
      if (req.method === 'GET' && url.pathname === '/api/board') return send(200, { board: await bus.board() });
      if (req.method === 'GET' && url.pathname === '/api/events') return send(200, { events: await bus.events({ limit: Number(q.limit || 50) }) });
      if (req.method === 'GET' && url.pathname === '/api/sync') return send(200, await bus.sync({ sinceSeq: Number(q.sinceSeq || 0), limit: Number(q.limit || 500) }));
      if (req.method === 'GET' && url.pathname === '/api/capsules') return send(200, { capsules: await bus.listCapsules() });
      const capsuleGet = url.pathname.match(/^\/api\/capsules\/([a-z0-9-]+)$/);
      if (req.method === 'GET' && capsuleGet) return send(200, await bus.getCapsule(capsuleGet[1], { create: q.create === '1', by: q.agent || null }));
      const capsulePut = url.pathname.match(/^\/api\/capsules\/([a-z0-9-]+)\/section$/);
      if (req.method === 'POST' && capsulePut) return send(200, await bus.updateCapsule(capsulePut[1], { by: safeBody.agent, section: safeBody.section, text: safeBody.text, token: agentTokenOf(req, safeBody) }));

      return send(404, { error: 'not found' });
    } catch (e) {
      return send(400, { error: e.message, code: e.code || undefined });
    }
  };
}
