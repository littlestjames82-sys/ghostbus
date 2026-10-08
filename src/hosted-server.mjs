#!/usr/bin/env node
/**
 * GhostBus HOSTED server — many isolated workspaces, one process.
 *
 *   GHOSTBUS_ADMIN_KEY=<long secret> node src/hosted-server.mjs [--port 8388] [--data-dir ./ghostbus-hosted]
 *
 * - Each workspace lives under /w/<id>/… (board at /w/<id>/, REST at
 *   /w/<id>/api/*, MCP at /w/<id>/mcp, probe at /w/<id>/probe).
 * - Workspaces are fully isolated: separate stores, agents, tasks, files.
 * - Every workspace gets its OWN key at creation (returned once; only its
 *   SHA-256 is kept in the registry). The admin key manages workspaces and
 *   also works as a master key inside any workspace.
 * - Admin API (x-bus-key: <admin key>):
 *     POST   /api/workspaces {id?, name}   -> {id, name, key (once)}
 *     GET    /api/workspaces               -> [{id, name, createdAt, agents, queued}]
 *     DELETE /api/workspaces/<id>          -> removes registry entry + data file
 * - Registry + one data file per workspace live in the data dir.
 *   Set GHOSTBUS_REQUIRE_TOKENS=1 to enforce per-agent tokens in all workspaces.
 */
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { createBus, FileStore, GHOSTBUS_VERSION } from './core.mjs';
import { createBusHandler, keyMatches } from './handler.mjs';

const argv = process.argv.slice(2);
const argVal = (flag) => { const i = argv.indexOf(flag); return i >= 0 ? argv[i + 1] : null; };
const port = Number(argVal('--port') || process.env.GHOSTBUS_PORT || 8388);
const dataDir = argVal('--data-dir') || process.env.GHOSTBUS_DATA_DIR || './ghostbus-hosted';
const ADMIN_KEY = process.env.GHOSTBUS_ADMIN_KEY || '';
const REQUIRE_TOKENS = process.env.GHOSTBUS_REQUIRE_TOKENS === '1';

if (!ADMIN_KEY) {
  process.stderr.write('GHOSTBUS_ADMIN_KEY is required for the hosted server (workspace creation must not be open).\n');
  process.exit(2);
}

fs.mkdirSync(dataDir, { recursive: true });
const registryPath = path.join(dataDir, 'registry.json');
const loadRegistry = () => { try { return JSON.parse(fs.readFileSync(registryPath, 'utf8')); } catch { return { workspaces: {} }; } };
const saveRegistry = (reg) => {
  const tmp = registryPath + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(reg, null, 2));
  fs.renameSync(tmp, registryPath);
};
const sha256 = (s) => crypto.createHash('sha256').update(String(s)).digest('hex');
const validId = (id) => /^[a-z0-9][a-z0-9-]{1,62}$/.test(String(id || ''));

const buses = new Map(); // id -> {bus, handle}
async function getWorkspace(id) {
  if (buses.has(id)) return buses.get(id);
  const reg = loadRegistry();
  const meta = reg.workspaces[id];
  if (!meta) return null;
  const bus = await createBus(new FileStore(path.join(dataDir, `${id}.json`)), { id, name: meta.name }, { requireTokens: REQUIRE_TOKENS });
  const entry = { bus, meta };
  buses.set(id, entry);
  return entry;
}

// Per-workspace handler cache with hash-based key check: we build the core
// handler with key '' (open) and gate in the router using the stored hash.
const handlers = new Map();
function handlerFor(id, bus) {
  if (!handlers.has(id)) handlers.set(id, createBusHandler({ id, bus, key: '' }));
  return handlers.get(id);
}

const isAdmin = (req) => keyMatches(req.headers['x-bus-key'] || String(req.headers.authorization || '').replace(/^Bearer\s+/i, ''), ADMIN_KEY);
const wsKeyOk = (req, meta) => {
  const given = req.headers['x-bus-key'] || String(req.headers.authorization || '').replace(/^Bearer\s+/i, '');
  if (!given) return false;
  if (keyMatches(given, ADMIN_KEY)) return true; // master key
  return sha256(given) === meta.keyHash;
};

const LANDING = `<!doctype html><html><head><meta charset="utf-8"><title>GhostBus Hosted</title>
<style>body{font-family:system-ui;background:#0e0c14;color:#ece8f5;margin:0;padding:40px}h1{font-size:22px}code{background:#17131f;padding:2px 7px;border-radius:6px;color:#c9b8ff}p{color:#9b8fb5;max-width:640px;line-height:1.55}</style></head>
<body><h1>👻 GhostBus Hosted</h1>
<p>Multi-workspace agent message bus. Each workspace lives at <code>/w/&lt;id&gt;/</code> with its own board, REST API, MCP endpoint, and key. Workspace data is never shown here — open your workspace board with its key.</p>
<p>Operators: see <code>POST /api/workspaces</code> (admin key) and the repo's <code>docs/hosted.md</code>.</p>
<p style="font-size:13px">GhostBus v${GHOSTBUS_VERSION} · Ghost Developer Studio</p></body></html>`;

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  const send = (status, obj, type = 'application/json') => {
    const b = type === 'application/json' ? JSON.stringify(obj) : String(obj);
    res.writeHead(status, { 'content-type': type }); res.end(b);
  };
  res.setHeader('x-content-type-options', 'nosniff');
  res.setHeader('referrer-policy', 'no-referrer');
  const readBody = () => new Promise((resolve) => {
    let data = ''; req.on('data', c => { data += c; if (data.length > 5_000_000) req.destroy(); });
    req.on('end', () => { try { resolve(data ? JSON.parse(data) : {}); } catch { resolve(null); } });
  });

  try {
    if (req.method === 'GET' && url.pathname === '/') { res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }); return res.end(LANDING); }
    if (req.method === 'GET' && url.pathname === '/health') return send(200, { ok: true, server: 'ghostbus-hosted', version: GHOSTBUS_VERSION, workspaces: Object.keys(loadRegistry().workspaces).length });

    // ---- admin ----
    if (url.pathname === '/api/workspaces' && req.method === 'POST') {
      if (!isAdmin(req)) return send(401, { error: 'admin key required' });
      const body = await readBody();
      if (!body) return send(400, { error: 'invalid JSON body' });
      const reg = loadRegistry();
      const id = body.id || `ws-${crypto.randomBytes(4).toString('hex')}`;
      if (!validId(id)) return send(400, { error: 'workspace id: lowercase letters, digits, - (2-63 chars)' });
      if (reg.workspaces[id]) return send(409, { error: `workspace already exists: ${id}` });
      const key = crypto.randomBytes(24).toString('hex');
      reg.workspaces[id] = { name: String(body.name || id).slice(0, 120), keyHash: sha256(key), createdAt: new Date().toISOString() };
      saveRegistry(reg);
      return send(201, { id, name: reg.workspaces[id].name, key, keyNote: 'Workspace key — shown ONCE, only its hash is stored. Agents use it as x-bus-key (or Bearer) under /w/' + id + '/.', board: `/w/${id}/` });
    }
    if (url.pathname === '/api/workspaces' && req.method === 'GET') {
      if (!isAdmin(req)) return send(401, { error: 'admin key required' });
      const reg = loadRegistry();
      const out = [];
      for (const [id, meta] of Object.entries(reg.workspaces)) {
        const w = await getWorkspace(id);
        const s = await w.bus.status();
        out.push({ id, name: meta.name, createdAt: meta.createdAt, agents: s.agents, queued: s.tasks.queued, needsApproval: s.tasks.needsApproval, messages: s.messages });
      }
      return send(200, { workspaces: out });
    }
    const delMatch = url.pathname.match(/^\/api\/workspaces\/([a-z0-9-]+)$/);
    if (req.method === 'DELETE' && delMatch) {
      if (!isAdmin(req)) return send(401, { error: 'admin key required' });
      const reg = loadRegistry();
      const id = delMatch[1];
      if (!reg.workspaces[id]) return send(404, { error: `no such workspace: ${id}` });
      delete reg.workspaces[id];
      saveRegistry(reg);
      buses.delete(id); handlers.delete(id);
      try { fs.unlinkSync(path.join(dataDir, `${id}.json`)); } catch {}
      return send(200, { id, deleted: true });
    }

    // ---- workspace traffic ----
    const wMatch = url.pathname.match(/^\/w\/([a-z0-9-]+)(\/.*)?$/);
    if (wMatch) {
      const id = wMatch[1];
      const w = await getWorkspace(id);
      if (!w) return send(404, { error: `no such workspace: ${id}` });
      const sub = new URL(url.toString());
      sub.pathname = wMatch[2] || '/';
      // Open surfaces mirror the single relay: board page, health, probe.
      const open = sub.pathname === '/' || sub.pathname === '/health' || sub.pathname === '/probe';
      if (!open && !wsKeyOk(req, w.meta)) return send(401, { error: 'missing or wrong workspace key' });
      return handlerFor(id, w.bus)(req, res, sub);
    }

    return send(404, { error: 'not found' });
  } catch (e) {
    return send(500, { error: e.message });
  }
});

server.listen(port, () => {
  process.stderr.write(`ghostbus HOSTED v${GHOSTBUS_VERSION} · http://127.0.0.1:${port} · data=${dataDir} · workspaces=${Object.keys(loadRegistry().workspaces).length} · agentTokens=${REQUIRE_TOKENS ? 'enforced' : 'issued, not enforced'}\n`);
});
