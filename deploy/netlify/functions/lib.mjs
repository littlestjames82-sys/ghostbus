/**
 * GhostBus hosted logic for serverless (Web Request/Response) runtimes.
 *
 * The KV is injected: anything with async get(key)->string|null,
 * set(key, value), delete(key). Netlify Blobs fits directly; tests use an
 * in-memory KV. State per workspace is one KV entry (`state:<id>`) holding
 * the GhostBus state JSON; the registry is one entry (`registry`).
 *
 * A FRESH bus is created per request from the KV — serverless invocations
 * are stateless, and the core's read-modify-write per call keeps this
 * correct for sequential traffic. Concurrent writes to the SAME workspace
 * can race (last writer wins one operation); that's stated in docs/hosted.md,
 * not hidden. SSE and long-poll are NOT available serverless — agents poll
 * /probe + inbox, or use bus_sync.
 */
import crypto from 'node:crypto';
import { GhostBus, GHOSTBUS_VERSION } from '../../../src/core.mjs';
import { TOOLS, callTool } from '../../../src/tools.mjs';

const sha256 = (s) => crypto.createHash('sha256').update(String(s)).digest('hex');
const json = (status, obj) => new Response(JSON.stringify(obj), { status, headers: { 'content-type': 'application/json', 'x-content-type-options': 'nosniff' } });

class KVStore {
  constructor(kv, key) { this.kv = kv; this.key = key; this.shared = false; }
  async load() { const t = await this.kv.get(this.key); return t ? JSON.parse(t) : null; }
  async save(state) { await this.kv.set(this.key, JSON.stringify(state)); }
}

export function createHostedCore({ kv, adminKey, requireTokens = false }) {
  if (!adminKey) throw new Error('adminKey required');
  const regKey = 'registry';
  const loadReg = async () => { const t = await kv.get(regKey); return t ? JSON.parse(t) : { workspaces: {} }; };
  const saveReg = async (r) => kv.set(regKey, JSON.stringify(r));
  const busFor = async (id, meta) => {
    const bus = new GhostBus(new KVStore(kv, `state:${id}`), { id, name: meta.name }, { requireTokens });
    await bus.init();
    return bus;
  };
  const keyOf = (req) => req.headers.get('x-bus-key') || String(req.headers.get('authorization') || '').replace(/^Bearer\s+/i, '');
  const isAdmin = (req) => { const g = keyOf(req); if (!g) return false; const a = Buffer.from(sha256(g)), b = Buffer.from(sha256(adminKey)); return a.length === b.length && crypto.timingSafeEqual(a, b); };
  const wsKeyOk = (req, meta) => { const g = keyOf(req); if (!g) return false; return sha256(g) === meta.keyHash || isAdmin(req); };

  return async function handle(req) {
    const url = new URL(req.url);
    const parts = url.pathname.split('/').filter(Boolean); // e.g. ['w','alpha','api','tasks']
    try {
      if (req.method === 'GET' && url.pathname === '/health') {
        const reg = await loadReg();
        return json(200, { ok: true, server: 'ghostbus-hosted-serverless', version: GHOSTBUS_VERSION, workspaces: Object.keys(reg.workspaces).length });
      }

      if (parts[0] === 'api' && parts[1] === 'workspaces') {
        if (!isAdmin(req)) return json(401, { error: 'admin key required' });
        const reg = await loadReg();
        if (req.method === 'POST') {
          const body = await req.json().catch(() => null);
          if (!body) return json(400, { error: 'invalid JSON body' });
          const id = body.id || `ws-${crypto.randomBytes(4).toString('hex')}`;
          if (!/^[a-z0-9][a-z0-9-]{1,62}$/.test(id)) return json(400, { error: 'workspace id: lowercase letters, digits, - (2-63 chars)' });
          if (reg.workspaces[id]) return json(409, { error: `workspace already exists: ${id}` });
          const key = crypto.randomBytes(24).toString('hex');
          reg.workspaces[id] = { name: String(body.name || id).slice(0, 120), keyHash: sha256(key), createdAt: new Date().toISOString() };
          await saveReg(reg);
          return json(201, { id, name: reg.workspaces[id].name, key, keyNote: 'Shown ONCE — only its hash is stored.' });
        }
        if (req.method === 'GET') {
          const out = [];
          for (const [id, meta] of Object.entries(reg.workspaces)) {
            const s = await (await busFor(id, meta)).status();
            out.push({ id, name: meta.name, createdAt: meta.createdAt, agents: s.agents, queued: s.tasks.queued, needsApproval: s.tasks.needsApproval, messages: s.messages });
          }
          return json(200, { workspaces: out });
        }
        if (req.method === 'DELETE' && parts[2]) {
          const id = parts[2];
          if (!reg.workspaces[id]) return json(404, { error: `no such workspace: ${id}` });
          delete reg.workspaces[id];
          await saveReg(reg);
          await kv.delete(`state:${id}`);
          return json(200, { id, deleted: true });
        }
      }

      if (parts[0] === 'w' && parts[1]) {
        const id = parts[1];
        const reg = await loadReg();
        const meta = reg.workspaces[id];
        if (!meta) return json(404, { error: `no such workspace: ${id}` });
        const rest = '/' + parts.slice(2).join('/');
        const bus = await busFor(id, meta);
        const q = Object.fromEntries(url.searchParams);

        if (req.method === 'GET' && rest === '/probe') {
          const s = await bus.status();
          return json(200, { workspace: id, queued: s.tasks.queued, needsApproval: s.tasks.needsApproval, agents: s.agents, version: GHOSTBUS_VERSION });
        }
        if (req.method === 'GET' && rest === '/health') return json(200, { ok: true, server: 'ghostbus', workspace: id, version: GHOSTBUS_VERSION });
        if (!wsKeyOk(req, meta)) return json(401, { error: 'missing or wrong workspace key' });

        if (req.method === 'POST' && rest === '/mcp') {
          const msg = await req.json().catch(() => null);
          if (!msg) return json(400, { error: 'invalid JSON body' });
          if (msg.method === 'tools/list') return json(200, { jsonrpc: '2.0', id: msg.id, result: { tools: TOOLS } });
          if (msg.method === 'tools/call') {
            try {
              const argsIn = { ...(msg.params.arguments || {}) };
              const hdr = req.headers.get('x-agent-token');
              if (hdr && !argsIn.token) argsIn.token = hdr;
              const out = await callTool(bus, msg.params.name, argsIn);
              return json(200, { jsonrpc: '2.0', id: msg.id, result: { content: [{ type: 'text', text: JSON.stringify(out, null, 2) }] } });
            } catch (e) { return json(200, { jsonrpc: '2.0', id: msg.id, result: { content: [{ type: 'text', text: `Error: ${e.message}` }], isError: true } }); }
          }
          return json(400, { error: 'unsupported MCP method over serverless relay (use tools/list or tools/call)' });
        }

        const body = ['POST', 'PUT', 'DELETE'].includes(req.method) ? (await req.json().catch(() => ({}))) || {} : {};
        const tk = body.token || q.token || req.headers.get('x-agent-token') || null;
        const R = (p) => rest === p;
        if (req.method === 'GET' && R('/api/status')) return json(200, await bus.status());
        if (req.method === 'GET' && R('/api/agents')) return json(200, { agents: await bus.listAgents() });
        if (req.method === 'POST' && R('/api/agents')) return json(200, await bus.registerAgent({ name: body.agent, role: body.role, capabilities: body.capabilities, token: tk }));
        if (req.method === 'POST' && R('/api/messages')) return json(200, await bus.sendMessage({ from: body.agent, to: body.to ?? '*', body: body.body, channel: body.channel ?? 'general', threadId: body.threadId ?? null, token: tk }));
        if (req.method === 'GET' && R('/api/inbox')) return json(200, { messages: await bus.inbox(q.agent, { unreadOnly: q.unread === '1', limit: Number(q.limit || 50), token: tk }) });
        if (req.method === 'POST' && R('/api/heartbeat')) return json(200, await bus.heartbeat({ name: body.agent, token: tk }));
        if (req.method === 'GET' && R('/api/search')) return json(200, await bus.search(q.q || '', { limit: Number(q.limit || 20) }));
        if (req.method === 'GET' && R('/api/channels')) return json(200, { channels: await bus.listChannels() });
        if (req.method === 'POST' && R('/api/tasks')) return json(200, await bus.createTask({ from: body.agent, title: body.title, body: body.body ?? '', assignee: body.assignee ?? null, priority: body.priority ?? 'normal', needsApproval: !!body.needsApproval, blockedBy: body.blockedBy ?? [], token: tk }));
        if (req.method === 'GET' && R('/api/tasks')) return json(200, { tasks: await bus.listTasks({ status: q.status || null, assignee: q.assignee || null }) });
        const ta = rest.match(/^\/api\/tasks\/(\d+)\/(approve|claim|complete|cancel)$/);
        if (req.method === 'POST' && ta) {
          if (ta[2] === 'approve') return json(200, await bus.approveTask(ta[1], { by: body.agent, token: tk }));
          if (ta[2] === 'claim') return json(200, await bus.claimTask(ta[1], { by: body.agent, token: tk }));
          if (ta[2] === 'complete') return json(200, await bus.completeTask(ta[1], { by: body.agent, result: body.result ?? '', token: tk }));
          if (ta[2] === 'cancel') return json(200, await bus.cancelTask(ta[1], { by: body.agent, token: tk }));
        }
        const tc = rest.match(/^\/api\/tasks\/(\d+)\/comment$/);
        if (req.method === 'POST' && tc) return json(200, await bus.addTaskComment(tc[1], { by: body.agent, body: body.body, token: tk }));
        if (req.method === 'PUT' && R('/api/files')) return json(200, await bus.putFile({ by: body.agent, path: body.path, text: body.text, token: tk }));
        if (req.method === 'DELETE' && R('/api/files')) return json(200, await bus.deleteFile({ by: q.agent || body.agent, path: q.path || body.path, token: tk }));
        if (req.method === 'GET' && R('/api/files')) return json(200, await bus.getFile(q.path));
        if (req.method === 'GET' && R('/api/files/list')) return json(200, { files: await bus.listFiles() });
        if (req.method === 'GET' && R('/api/files/history')) return json(200, await bus.fileHistory(q.path));
        if (req.method === 'PUT' && R('/api/context')) return json(200, await bus.putContext({ by: body.agent, context: body.context, token: tk }));
        if (req.method === 'GET' && R('/api/context')) return json(200, await bus.getContext());
        if (req.method === 'GET' && R('/api/board')) return json(200, { board: await bus.board() });
        if (req.method === 'GET' && R('/api/events')) return json(200, { events: await bus.events({ limit: Number(q.limit || 50) }) });
        if (req.method === 'GET' && R('/api/sync')) return json(200, await bus.sync({ sinceSeq: Number(q.sinceSeq || 0), limit: Number(q.limit || 500) }));
        if (req.method === 'GET' && R('/api/capsules')) return json(200, { capsules: await bus.listCapsules() });
        const cg = rest.match(/^\/api\/capsules\/([a-z0-9-]+)$/);
        if (req.method === 'GET' && cg) return json(200, await bus.getCapsule(cg[1], { create: q.create === '1', by: q.agent || null }));
        const cp = rest.match(/^\/api\/capsules\/([a-z0-9-]+)\/section$/);
        if (req.method === 'POST' && cp) return json(200, await bus.updateCapsule(cp[1], { by: body.agent, section: body.section, text: body.text, token: tk }));
        return json(404, { error: 'not found (note: board page, SSE and long-poll are not available on the serverless relay)' });
      }

      return json(404, { error: 'not found' });
    } catch (e) {
      return json(400, { error: e.message, code: e.code || undefined });
    }
  };
}
