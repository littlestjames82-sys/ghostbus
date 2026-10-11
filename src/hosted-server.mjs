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
 *     POST   /api/workspaces/<id>/rotate-key -> {id, key (once)}; old key dies at once
 *     GET    /api/workspaces/<id>/export   -> full-state export envelope (backup/migrate)
 *     POST   /api/workspaces/import {id?, name?, state|export} -> {id, name, key (once)}
 * - Registry + one data file per workspace live in the data dir.
 * - Per-agent tokens are ENFORCED in all workspaces by default (v0.5.2):
 *   hosted mode serves strangers, so a stolen agent name must not be enough
 *   to act. GHOSTBUS_REQUIRE_TOKENS=0 is the only opt-out and starts with a
 *   loud warning. GHOSTBUS_ADMIN_KEY is required and must be at least 16
 *   characters — it is the operator root key (see docs/hosted.md).
 * - v0.5.3: workspace-key checks are timing-safe, failed auth is throttled
 *   per IP at this layer, JSON bodies are capped at 1 MB (413), registry +
 *   workspace files are written 0600, HTML pages carry CSP/frame headers,
 *   and every admin action is audit-logged to stderr (never keys/hashes).
 * - v0.5.4: workspace ids are validated at EVERY boundary — create, import,
 *   route matching (regex), workspace resolution, and the registry itself
 *   when loaded: ids become file names inside the data dir, so a planted or
 *   hand-edited registry entry must never turn one into a path outside it.
 * - v0.5.7: the credential lifecycle was audited end to end (rotation is
 *   immediate and is now reachable over plain REST for agent tokens, not
 *   just MCP) and the serverless pack was realigned with this server —
 *   enforcement default, admin-key floor, rotate/export/import. See
 *   SECURITY.md ("Credential lifecycle") and docs/hosted.md round 6.
 */
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { createBus, FileStore, GHOSTBUS_VERSION, validateSnapshot } from './core.mjs';
import { createBusHandler, keyMatches, hashMatches, readJsonBody, MAX_BODY_BYTES, HTML_SECURITY_HEADERS, applyServerTimeouts, SERVER_TIMEOUT_DEFAULTS } from './handler.mjs';

const argv = process.argv.slice(2);
const argVal = (flag) => { const i = argv.indexOf(flag); return i >= 0 ? argv[i + 1] : null; };
const port = Number(argVal('--port') || process.env.GHOSTBUS_PORT || 8388);
const dataDir = argVal('--data-dir') || process.env.GHOSTBUS_DATA_DIR || './ghostbus-hosted';
const ADMIN_KEY = process.env.GHOSTBUS_ADMIN_KEY || '';
// v0.5.2: enforcement is the hosted DEFAULT. Only an explicit
// GHOSTBUS_REQUIRE_TOKENS=0 turns it off (anything else, including unset,
// means on) — the hosted server is the one deployment that serves people
// other than the operator, so the safe posture cannot be opt-in.
const REQUIRE_TOKENS = process.env.GHOSTBUS_REQUIRE_TOKENS !== '0';

if (!ADMIN_KEY) {
  process.stderr.write('GHOSTBUS_ADMIN_KEY is required for the hosted server (workspace creation must not be open).\n');
  process.exit(2);
}
if (ADMIN_KEY.length < 16) {
  process.stderr.write('GHOSTBUS_ADMIN_KEY is too short: use at least 16 characters (32+ random hex recommended). The admin key is the operator root key — it creates/deletes workspaces and acts as a master key inside every one of them.\n');
  process.exit(2);
}
if (!REQUIRE_TOKENS) {
  process.stderr.write('WARNING: GHOSTBUS_REQUIRE_TOKENS=0 — per-agent token enforcement is DISABLED in every workspace.\n');
  process.stderr.write('WARNING: anyone holding a workspace key can act under ANY agent name in that workspace (impersonation).\n');
  process.stderr.write('WARNING: hosted mode serves strangers; run with enforcement on unless you have a specific reason not to.\n');
}

fs.mkdirSync(dataDir, { recursive: true });
const registryPath = path.join(dataDir, 'registry.json');
const validId = (id) => /^[a-z0-9][a-z0-9-]{1,62}$/.test(String(id || ''));
const warnedRegistryIds = new Set();
const loadRegistry = () => {
  let reg;
  try { reg = JSON.parse(fs.readFileSync(registryPath, 'utf8')); } catch { return { workspaces: {} }; }
  if (!reg || typeof reg !== 'object' || !reg.workspaces || typeof reg.workspaces !== 'object') return { workspaces: {} };
  // Defense in depth (v0.5.4): create/import validate ids, but the registry
  // is also a file on disk — never let a planted or hand-edited entry turn
  // into a path outside the data dir via getWorkspace's `${id}.json`.
  for (const id of Object.keys(reg.workspaces)) {
    if (!validId(id)) {
      if (!warnedRegistryIds.has(id)) {
        warnedRegistryIds.add(id);
        process.stderr.write(`ghostbus hosted: ignoring registry entry with invalid workspace id ${JSON.stringify(id)} (ids become file names inside the data dir)\n`);
      }
      delete reg.workspaces[id];
    }
  }
  return reg;
};
const saveRegistry = (reg) => {
  // Unique temp per save: two processes sharing this registry must never
  // collide on one fixed '.tmp' name (first rename wins, second throws ENOENT).
  // The registry holds every workspace's key hash — owner-only (0600, v0.5.3).
  const tmp = registryPath + '.tmp.' + process.pid + '.' + Math.random().toString(36).slice(2, 10);
  try {
    fs.writeFileSync(tmp, JSON.stringify(reg, null, 2), { mode: 0o600 });
    try { fs.chmodSync(tmp, 0o600); } catch { /* mode already applied on create */ }
    fs.renameSync(tmp, registryPath);
  } finally {
    try { fs.unlinkSync(tmp); } catch { /* already renamed away */ }
  }
};
const sha256 = (s) => crypto.createHash('sha256').update(String(s)).digest('hex');

const buses = new Map(); // id -> {bus, handle}
async function getWorkspace(id) {
  if (!validId(id)) return null; // an id is a file name inside dataDir — nothing else resolves (v0.5.4)
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
  return hashMatches(given, meta.keyHash); // timing-safe vs the stored hash (v0.5.3)
};

// Failed-auth throttle (v0.5.3): the in-workspace handler limiter (300/min)
// throttles traffic that is already inside a workspace, but nothing slowed
// down *guessing* at the hosted layer — admin keys and workspace keys were
// unthrottled. Track FAILED auth per IP; past the limit, admin + workspace
// routes answer 429 until the window rolls. Successful auth never counts.
const AUTH_FAIL_LIMIT = 30;            // failed auth attempts per window per IP
const AUTH_FAIL_WINDOW_MS = 60_000;    // one-minute window
const authFails = new Map(); // ip -> {start, count}
const clientIp = (req) => (req.socket && req.socket.remoteAddress) || 'unknown';
const authThrottled = (ip) => {
  const b = authFails.get(ip);
  return !!b && Date.now() - b.start <= AUTH_FAIL_WINDOW_MS && b.count >= AUTH_FAIL_LIMIT;
};
const noteAuthFail = (ip) => {
  const t = Date.now();
  // Opportunistic sweep (v0.5.6): one entry per attacking IP per window
  // would otherwise accumulate forever on a long-lived server.
  if (authFails.size > 4096) { for (const [k, v] of authFails) if (t - v.start > AUTH_FAIL_WINDOW_MS) authFails.delete(k); }
  let b = authFails.get(ip);
  if (!b || t - b.start > AUTH_FAIL_WINDOW_MS) { b = { start: t, count: 0 }; authFails.set(ip, b); }
  b.count += 1;
};

// Operator audit trail (v0.5.3): one structured stderr line per admin
// action, so a paid host has a record of who did what to which workspace.
// NEVER log keys or hashes — ids, actions, timestamps, source IPs only.
const audit = (action, id, req) => {
  process.stderr.write(JSON.stringify({ ts: new Date().toISOString(), audit: 'admin', action, workspace: id, ip: clientIp(req) }) + '\n');
};

const TOO_LARGE = Symbol('body-too-large');

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
  const ip = clientIp(req);
  const adminDenied = () => { noteAuthFail(ip); return send(401, { error: 'admin key required' }); };
  const readBody = async () => {
    try { return await readJsonBody(req); }
    catch (e) {
      if (e && e.code === 'BODY_TOO_LARGE') {
        try {
          res.writeHead(413, { 'content-type': 'application/json', connection: 'close' });
          res.end(JSON.stringify({ error: `request body too large (limit ${MAX_BODY_BYTES} bytes)` }), () => { try { req.destroy(); } catch {} });
        } catch {}
        return TOO_LARGE;
      }
      throw e;
    }
  };

  try {
    if (req.method === 'GET' && url.pathname === '/') { res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', ...HTML_SECURITY_HEADERS }); return res.end(LANDING); }
    if (req.method === 'GET' && url.pathname === '/health') return send(200, { ok: true, server: 'ghostbus-hosted', version: GHOSTBUS_VERSION, workspaces: Object.keys(loadRegistry().workspaces).length });

    // ---- admin ----
    // Failed-auth throttle (v0.5.3): sustained key guessing gets 429s on the
    // whole admin surface before any key is even compared.
    if (url.pathname.startsWith('/api/workspaces') && authThrottled(ip)) return send(429, { error: 'too many failed auth attempts — try again shortly' });
    if (url.pathname === '/api/workspaces' && req.method === 'POST') {
      if (!isAdmin(req)) return adminDenied();
      const body = await readBody();
      if (body === TOO_LARGE) return; // 413 already sent
      if (!body) return send(400, { error: 'invalid JSON body' });
      const reg = loadRegistry();
      const id = body.id || `ws-${crypto.randomBytes(4).toString('hex')}`;
      if (!validId(id)) return send(400, { error: 'workspace id: lowercase letters, digits, - (2-63 chars)' });
      if (reg.workspaces[id]) return send(409, { error: `workspace already exists: ${id}` });
      const key = crypto.randomBytes(24).toString('hex');
      reg.workspaces[id] = { name: String(body.name || id).slice(0, 120), keyHash: sha256(key), createdAt: new Date().toISOString() };
      saveRegistry(reg);
      audit('create', id, req);
      return send(201, { id, name: reg.workspaces[id].name, key, keyNote: 'Workspace key — shown ONCE, only its hash is stored. Agents use it as x-bus-key (or Bearer) under /w/' + id + '/.', board: `/w/${id}/` });
    }
    if (url.pathname === '/api/workspaces' && req.method === 'GET') {
      if (!isAdmin(req)) return adminDenied();
      const reg = loadRegistry();
      const out = [];
      for (const [id, meta] of Object.entries(reg.workspaces)) {
        const w = await getWorkspace(id);
        const s = await w.bus.status();
        out.push({ id, name: meta.name, createdAt: meta.createdAt, agents: s.agents, queued: s.tasks.queued, needsApproval: s.tasks.needsApproval, messages: s.messages });
      }
      return send(200, { workspaces: out });
    }
    const rotateMatch = url.pathname.match(/^\/api\/workspaces\/([a-z0-9-]+)\/rotate-key$/);
    if (req.method === 'POST' && rotateMatch) {
      if (!isAdmin(req)) return adminDenied();
      const reg = loadRegistry();
      const id = rotateMatch[1];
      if (!reg.workspaces[id]) return send(404, { error: `no such workspace: ${id}` });
      const key = crypto.randomBytes(24).toString('hex');
      reg.workspaces[id].keyHash = sha256(key);
      reg.workspaces[id].keyRotatedAt = new Date().toISOString();
      saveRegistry(reg);
      // Refresh the cached meta so the old key dies immediately, not on restart.
      const cached = buses.get(id);
      if (cached) cached.meta = reg.workspaces[id];
      audit('rotate-key', id, req);
      return send(200, { id, key, keyNote: 'New workspace key — shown ONCE. The previous key is invalid from this moment.', keyRotatedAt: reg.workspaces[id].keyRotatedAt });
    }
    const exportMatch = url.pathname.match(/^\/api\/workspaces\/([a-z0-9-]+)\/export$/);
    if (req.method === 'GET' && exportMatch) {
      if (!isAdmin(req)) return adminDenied();
      const id = exportMatch[1];
      const w = await getWorkspace(id);
      if (!w) return send(404, { error: `no such workspace: ${id}` });
      const state = await w.bus.snapshot();
      audit('export', id, req);
      return send(200, { ghostbusExport: 1, version: GHOSTBUS_VERSION, exportedAt: new Date().toISOString(), workspace: { id, name: w.meta.name }, state });
    }
    if (url.pathname === '/api/workspaces/import' && req.method === 'POST') {
      if (!isAdmin(req)) return adminDenied();
      const body = await readBody();
      if (body === TOO_LARGE) return; // 413 already sent
      if (!body) return send(400, { error: 'invalid JSON body' });
      // Accept either a full export envelope or a bare {state} / raw state.
      const env = body.ghostbusExport ? body : null;
      const state = env ? env.state : (body.state || body);
      const bad = validateSnapshot(state);
      if (bad) return send(400, { error: `invalid snapshot: ${bad}` });
      const reg = loadRegistry();
      const id = body.id || (env && env.workspace && env.workspace.id) || state.workspace.id || `ws-${crypto.randomBytes(4).toString('hex')}`;
      if (!validId(id)) return send(400, { error: 'workspace id: lowercase letters, digits, - (2-63 chars)' });
      if (reg.workspaces[id]) return send(409, { error: `workspace already exists: ${id} (delete it first, or import under a new id)` });
      const name = String(body.name || (env && env.workspace && env.workspace.name) || state.workspace.name || id).slice(0, 120);
      const key = crypto.randomBytes(24).toString('hex');
      reg.workspaces[id] = { name, keyHash: sha256(key), createdAt: new Date().toISOString(), importedAt: new Date().toISOString() };
      saveRegistry(reg);
      // Write the state file first, then load it through the normal path so
      // the bus sees exactly what a restart would see.
      const file = path.join(dataDir, `${id}.json`);
      const tmp = file + '.tmp.' + process.pid + '.' + Math.random().toString(36).slice(2, 10);
      fs.writeFileSync(tmp, JSON.stringify(state, null, 2), { mode: 0o600 }); // state file: owner-only (v0.5.3)
      try { fs.chmodSync(tmp, 0o600); } catch { /* mode already applied on create */ }
      fs.renameSync(tmp, file);
      audit('import', id, req);
      const w = await getWorkspace(id);
      const status = await w.bus.status();
      return send(201, { id, name, key, keyNote: 'Workspace key — shown ONCE, only its hash is stored. Imported workspaces always get a FRESH key; the source key is not carried over.', agents: status.agents, messages: status.messages, tasks: status.tasks.total, board: `/w/${id}/` });
    }
    const delMatch = url.pathname.match(/^\/api\/workspaces\/([a-z0-9-]+)$/);
    if (req.method === 'DELETE' && delMatch) {
      if (!isAdmin(req)) return adminDenied();
      const reg = loadRegistry();
      const id = delMatch[1];
      if (!reg.workspaces[id]) return send(404, { error: `no such workspace: ${id}` });
      delete reg.workspaces[id];
      saveRegistry(reg);
      buses.delete(id); handlers.delete(id);
      try { fs.unlinkSync(path.join(dataDir, `${id}.json`)); } catch {}
      audit('delete', id, req);
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
      if (!open && authThrottled(ip)) return send(429, { error: 'too many failed auth attempts — try again shortly' });
      if (!open && !wsKeyOk(req, w.meta)) { noteAuthFail(ip); return send(401, { error: 'missing or wrong workspace key' }); }
      return handlerFor(id, w.bus)(req, res, sub);
    }

    return send(404, { error: 'not found' });
  } catch (e) {
    process.stderr.write(`ghostbus hosted: internal error: ${(e && e.stack) || e}\n`);
    return send(500, { error: 'internal error' });
  }
});

// Explicit server timeouts (v0.5.6): slow-loris header/body deadlines, set
// here rather than inherited from Node defaults — see applyServerTimeouts
// in handler.mjs for the scoping (long-lived streams are never bounded).
const timeoutOpt = (envName, def) => { const n = Number(process.env[envName]); return Number.isFinite(n) && n > 0 ? Math.floor(n) : def; };
applyServerTimeouts(server, {
  headersMs: timeoutOpt('GHOSTBUS_HEADERS_TIMEOUT_MS', SERVER_TIMEOUT_DEFAULTS.headersMs),
  requestMs: timeoutOpt('GHOSTBUS_REQUEST_TIMEOUT_MS', SERVER_TIMEOUT_DEFAULTS.requestMs),
});

server.listen(port, () => {
  process.stderr.write(`ghostbus HOSTED v${GHOSTBUS_VERSION} · http://127.0.0.1:${port} · data=${dataDir} · workspaces=${Object.keys(loadRegistry().workspaces).length} · agentTokens=${REQUIRE_TOKENS ? 'enforced' : 'issued, not enforced'}\n`);
});
