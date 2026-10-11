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
// Timing-safe check of a presented secret against a STORED sha256 hex digest
// (v0.5.3) — the hosted router and the core token check compare against
// hashes at rest, never against raw keys.
export const hashMatches = (given, storedHashHex) => {
  if (!given || !storedHashHex) return false;
  const a = Buffer.from(crypto.createHash('sha256').update(String(given)).digest('hex'));
  const b = Buffer.from(String(storedHashHex));
  return a.length === b.length && crypto.timingSafeEqual(a, b);
};

// JSON request-body cap (v0.5.3): file contents travel inside JSON bodies in
// this codebase, so 1 MB is generous for messages/tasks/files while keeping
// a single request from exhausting memory. Over the cap the reader rejects
// with code BODY_TOO_LARGE and the route answers 413.
export const MAX_BODY_BYTES = 1_000_000;
export function readJsonBody(req, limit = MAX_BODY_BYTES) {
  return new Promise((resolve, reject) => {
    let size = 0; let done = false;
    const chunks = [];
    req.on('data', (c) => {
      if (done) return;
      size += c.length;
      if (size > limit) {
        done = true;
        req.pause(); // stop reading; the route answers 413 and drops the socket
        reject(Object.assign(new Error(`request body too large (limit ${limit} bytes)`), { code: 'BODY_TOO_LARGE' }));
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => {
      if (done) return; done = true;
      const data = Buffer.concat(chunks).toString('utf8');
      try { resolve(data ? JSON.parse(data) : {}); } catch { resolve(null); }
    });
    req.on('error', () => { if (!done) { done = true; resolve(null); } });
  });
}

// Headers for the HTML pages (board + hosted landing), v0.5.3. Both pages are
// single self-contained documents: inline <script>/<style> and same-origin
// fetches only, zero external resources — so the CSP allows 'unsafe-inline'
// for script/style specifically (no eval, no external origins, no plugins)
// and forbids framing outright.
export const HTML_SECURITY_HEADERS = {
  'x-frame-options': 'DENY',
  'content-security-policy': "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'self'; object-src 'none'",
};

const TOO_LARGE = Symbol('body-too-large');

// Per-IP request limiter (per workspace — one handler serves one workspace).
// The default (300/min) is unchanged since v0.3; GHOSTBUS_RATE_LIMIT_PER_MIN
// is an operator knob for two legitimate cases: many agents behind one NAT
// address sharing a single source IP, and load benchmarking, where the
// limiter — not the bus — would otherwise be the first ceiling (v0.5.6).
const rateLimitPerMin = () => {
  const n = Number(process.env.GHOSTBUS_RATE_LIMIT_PER_MIN);
  return Number.isFinite(n) && n >= 1 ? Math.floor(n) : 300;
};

// Server timeouts (v0.5.6). Three different clocks, three different jobs:
// - headersMs bounds how long a client may take to deliver complete request
//   HEADERS (the classic slow-loris drip).
// - requestMs bounds how long it may take to deliver the request BODY after
//   that. It must never bound a response: /api/stream and /api/wait are
//   long-lived BY DESIGN.
// - keepAliveMs is Node's own idle keep-alive lifetime.
// Why this is not just "set the three Node properties": Node's own
// enforcement of both knobs was probed on Node 24 before this design was
// chosen, and neither is a deterministic drop-in for the deadlines above.
// - server.headersTimeout IS set (it only governs the header phase), but
//   its enforcement rides on Node's socket-timeout machinery: with the
//   default server.timeout of 0, a partial-headers socket was probed to
//   survive 15 s at headersTimeout=1000.
// - server.requestTimeout is pinned to 0: its semantics proved impossible
//   to reason about safely for long-lived responses (a handler that
//   writes constantly masks its clock entirely), and the deadline it is
//   documented for — receiving the request — is exactly the one the
//   guard below enforces deterministically instead.
// The guard: arm the header deadline on connect, clear it when headers
// land, bound a *declared* body from there, re-arm while the socket sits
// between keep-alive requests. server.timeout stays 0 on purpose — socket
// *inactivity* is not a deadline here, because a long-poll legitimately
// idles for up to 55 s and an SSE stream between events for longer.
export const SERVER_TIMEOUT_DEFAULTS = { headersMs: 10_000, requestMs: 30_000, keepAliveMs: 5_000 };
export function applyServerTimeouts(server, opts = {}) {
  const headersMs = opts.headersMs ?? SERVER_TIMEOUT_DEFAULTS.headersMs;
  const requestMs = opts.requestMs ?? SERVER_TIMEOUT_DEFAULTS.requestMs;
  const keepAliveMs = opts.keepAliveMs ?? SERVER_TIMEOUT_DEFAULTS.keepAliveMs;
  server.headersTimeout = headersMs;
  server.requestTimeout = 0; // see above — Node's clock kills live streams; the guard owns this deadline
  server.keepAliveTimeout = keepAliveMs;
  server.timeout = 0; // see above — inactivity is not the deadline
  server.on('connection', (socket) => {
    const armHeaderDeadline = () => {
      clearTimeout(socket._gbHeaderTimer);
      socket._gbHeaderTimer = setTimeout(() => socket.destroy(), headersMs);
      socket._gbHeaderTimer.unref?.();
    };
    socket._gbArmHeaderDeadline = armHeaderDeadline;
    armHeaderDeadline();
    socket.on('close', () => clearTimeout(socket._gbHeaderTimer));
  });
  server.on('request', (req, res) => {
    const socket = req.socket;
    clearTimeout(socket._gbHeaderTimer); // headers are in — that deadline is met
    clearTimeout(socket._gbBodyTimer);
    // Bound the body ONLY when one was declared. req.complete cannot be
    // the trigger: for a bodyless GET whose stream nobody reads (exactly
    // the /api/stream and /api/wait shape) it stays false indefinitely, so
    // a timer armed on it would destroy healthy long-lived exchanges —
    // the first cut of this guard did precisely that to SSE streams.
    const declaresBody = Number(req.headers['content-length'] || 0) > 0 || 'transfer-encoding' in req.headers;
    if (declaresBody && !req.complete) {
      socket._gbBodyTimer = setTimeout(() => socket.destroy(), requestMs);
      socket._gbBodyTimer.unref?.();
      const clear = () => clearTimeout(socket._gbBodyTimer);
      req.on('end', clear);
      req.on('close', clear);
      res.on('finish', clear);
      res.on('close', clear);
    }
    // Between keep-alive requests the socket owes us a fresh set of
    // headers: re-arm the header deadline when this exchange finishes so a
    // stalled *next* request is bounded too. A still-open response (SSE)
    // never emits 'finish', and its request completed on arrival, so no
    // timer is ever pending against a live stream or long-poll.
    res.on('finish', () => { if (!socket.destroyed && socket._gbArmHeaderDeadline) socket._gbArmHeaderDeadline(); });
    res.on('close', () => clearTimeout(socket._gbHeaderTimer));
  });
  return server;
}

// SSE stream caps (v0.5.6): before this round a workspace's /api/stream
// subscribers were bounded by nothing but the request limiter — each one
// holds a bus listener, a socket, and a 25 s ping interval, forever, and a
// buggy client reconnect-looping could pile them up without limit. Caps are
// generous against real teams (an agent holds at most a stream or two) and
// refuse cleanly with 429 past them. The per-process total spans every
// handler in the process, which is what protects the hosted server.
const streamCap = (envName, def) => {
  const n = Number(process.env[envName]);
  return Number.isFinite(n) && n >= 1 ? Math.floor(n) : def;
};
let activeStreamsTotal = 0;

export function createBusHandler({ id = 'default', bus, key = '' }) {
  const buckets = new Map();
  const rateLimit = rateLimitPerMin();
  const rateOk = (req) => {
    const ip = (req.socket && req.socket.remoteAddress) || 'unknown';
    const t = Date.now();
    // Opportunistic sweep: one bucket per source IP per minute would
    // otherwise accumulate forever on a long-lived server (v0.5.6).
    if (buckets.size > 4096) { for (const [k, v] of buckets) if (t - v.start > 60_000) buckets.delete(k); }
    let b = buckets.get(ip);
    if (!b || t - b.start > 60_000) { b = { start: t, count: 0 }; buckets.set(ip, b); }
    b.count += 1;
    return b.count <= rateLimit;
  };
  let activeStreams = 0; // this workspace's live /api/stream subscribers
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
      return send(429, { error: `rate limit: ${rateLimit} requests/min per IP per workspace` });
    }
    const send413 = () => {
      try {
        res.writeHead(413, { 'content-type': 'application/json', connection: 'close' });
        res.end(JSON.stringify({ error: `request body too large (limit ${MAX_BODY_BYTES} bytes)` }), () => { try { req.destroy(); } catch {} });
      } catch {}
    };
    const readBody = async () => {
      try { return await readJsonBody(req); }
      catch (e) { if (e && e.code === 'BODY_TOO_LARGE') { send413(); return TOO_LARGE; } throw e; }
    };

    try {
      if (req.method === 'GET' && url.pathname === '/') { res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', ...HTML_SECURITY_HEADERS }); return res.end(BOARD_HTML); }
      if (req.method === 'GET' && url.pathname === '/health') return send(200, { ok: true, server: 'ghostbus', workspace: id, version: GHOSTBUS_VERSION });
      if (req.method === 'GET' && url.pathname === '/probe') {
        const s = await bus.status();
        return send(200, { workspace: id, queued: s.tasks.queued, needsApproval: s.tasks.needsApproval, agents: s.agents, version: GHOSTBUS_VERSION });
      }
      if (!keyOk(req)) return send(401, { error: 'missing or wrong bus key' });

      if (req.method === 'GET' && url.pathname === '/api/stream') {
        const agent = url.searchParams.get('agent');
        if (!agent) return send(400, { error: 'agent query param required' });
        // Stream caps (v0.5.6): refuse BEFORE opening the stream — a 429 the
        // client can back off from, not a socket that dies later.
        const maxPerWorkspace = streamCap('GHOSTBUS_MAX_STREAMS_PER_WORKSPACE', 100);
        const maxTotal = streamCap('GHOSTBUS_MAX_STREAMS_TOTAL', 1000);
        if (activeStreams >= maxPerWorkspace) return send(429, { error: `too many event streams for this workspace (limit ${maxPerWorkspace})` });
        if (activeStreamsTotal >= maxTotal) return send(429, { error: `too many event streams on this server (limit ${maxTotal})` });
        activeStreams += 1; activeStreamsTotal += 1;
        res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' });
        res.write(`event: ready\ndata: ${JSON.stringify({ agent, workspace: id, version: GHOSTBUS_VERSION })}\n\n`);
        let cleaned = false;
        const off = bus.onEvent((ev) => {
          const forMe = ev.type === 'message.send' ? (ev.to === agent || ev.to === '*' || ev.actor === agent) : true;
          if (!forMe) return;
          try { res.write(`event: ${ev.type}\ndata: ${JSON.stringify(ev)}\n\n`); } catch { cleanup(); }
        });
        const ping = setInterval(() => { try { res.write(': ping\n\n'); } catch { cleanup(); } }, 25000);
        // Reaping (v0.5.6): whichever side of the connection dies first —
        // request close, response close, or a write into a dead socket —
        // the listener, the ping, and both cap slots are released exactly
        // once, so churn can neither leak listeners nor strand cap slots.
        function cleanup() {
          if (cleaned) return; cleaned = true;
          clearInterval(ping); off();
          activeStreams -= 1; activeStreamsTotal -= 1;
        }
        req.on('close', cleanup);
        res.on('close', cleanup);
        res.on('error', cleanup);
        return;
      }

      if (req.method === 'GET' && url.pathname === '/api/wait') {
        const agent = url.searchParams.get('agent');
        if (!agent) return send(400, { error: 'agent query param required' });
        // Garbage timeouts (timeout=abc -> NaN -> an instant empty reply;
        // negative -> the same) fall back to the 25s default; real values
        // clamp into [0, 55]s (v0.5.5).
        const tParam = Number(url.searchParams.get('timeout') || 25);
        const timeout = (Number.isFinite(tParam) ? Math.min(Math.max(tParam, 0), 55) : 25) * 1000;
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
        if (msg === TOO_LARGE) return; // 413 already sent
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
      if (body === TOO_LARGE) return; // 413 already sent
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
