/**
 * GhostBus core — transport-agnostic agent-to-agent message bus + shared workspace.
 *
 * One workspace holds: registered agents, direct/broadcast messages, claimable
 * tasks (with leases + an approval gate), shared files, a shared context object,
 * and an append-only provenance event log. Every mutation is stamped with the
 * acting agent and a timestamp — nothing enters the workspace anonymously.
 *
 * Storage: any object with async load() -> state|null and async save(state).
 * Ships with MemoryStore and FileStore (atomic JSON file).
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

export const GHOSTBUS_VERSION = '0.2.0';
const sha256 = (s) => crypto.createHash('sha256').update(String(s)).digest('hex');
export const TASK_STATUSES = ['queued', 'claimed', 'needs-approval', 'done', 'cancelled'];
const CLAIM_LEASE_MS = 15 * 60 * 1000;

const now = () => new Date().toISOString();
const clone = (v) => JSON.parse(JSON.stringify(v));

function emptyState(workspace = {}) {
  return {
    workspace: {
      id: workspace.id || 'default',
      name: workspace.name || 'GhostBus Workspace',
      createdAt: now(),
    },
    seq: 0,          // event sequence
    msgSeq: 0,
    taskSeq: 0,
    agents: [],      // {name, role, capabilities, joinedAt, lastSeenAt}
    messages: [],    // {id, from, to, channel, body, threadId, createdAt, readBy[]}
    tasks: [],       // {id, title, body, from, assignee, status, priority, ...}
    files: {},       // path -> {text, updatedBy, updatedAt}
    context: null,   // arbitrary shared object (must have .projects? no — free-form)
    events: [],      // {seq, type, actor, at, summary}
  };
}

export class MemoryStore {
  constructor() { this.state = null; }
  async load() { return this.state ? clone(this.state) : null; }
  async save(state) { this.state = clone(state); }
}

export class FileStore {
  constructor(file) { this.file = file; }
  async load() {
    try { return JSON.parse(await fs.promises.readFile(this.file, 'utf8')); }
    catch { return null; }
  }
  async save(state) {
    await fs.promises.mkdir(path.dirname(this.file), { recursive: true });
    const tmp = this.file + '.tmp';
    await fs.promises.writeFile(tmp, JSON.stringify(state, null, 2));
    await fs.promises.rename(tmp, this.file); // atomic replace
  }
}

export class GhostBus {
  constructor(store, workspace = {}, opts = {}) {
    this.store = store;
    this.workspaceInfo = workspace;
    this.state = null;
    // When true, every act by an agent that holds a token must present it.
    // Registration issues the token once; only its sha256 is stored.
    this.requireTokens = !!opts.requireTokens;
    this.listeners = new Set(); // live event subscribers (SSE relay)
  }

  /** Subscribe to provenance events as they happen. Returns an unsubscribe fn. */
  onEvent(fn) { this.listeners.add(fn); return () => this.listeners.delete(fn); }

  async init() {
    if (this.state) return this;
    this.state = (await this.store.load()) || emptyState(this.workspaceInfo);
    return this;
  }

  async _save() { await this.store.save(this.state); }

  _event(type, actor, summary, meta = {}) {
    this.state.seq += 1;
    const ev = { seq: this.state.seq, type, actor: actor || 'system', at: now(), summary, ...meta };
    this.state.events.push(ev);
    if (this.state.events.length > 5000) this.state.events.splice(0, this.state.events.length - 5000);
    for (const fn of this.listeners) { try { fn(clone(ev)); } catch { /* a dead listener never breaks the bus */ } }
  }

  _agent(name) { return this.state.agents.find(a => a.name === name) || null; }

  _publicAgent(a) {
    const { tokenHash, ...pub } = a;
    return { ...pub, online: Date.now() - Date.parse(a.lastSeenAt) < 120_000, hasToken: !!tokenHash };
  }

  _existsAgent(name) {
    const a = this._agent(name);
    if (!a) throw Object.assign(new Error(`agent not registered: ${name}`), { code: 'UNKNOWN_AGENT' });
    return a;
  }

  _requireAgent(name, token) {
    const a = this._agent(name);
    if (!a) throw Object.assign(new Error(`agent not registered: ${name}`), { code: 'UNKNOWN_AGENT' });
    if (this.requireTokens && a.tokenHash) {
      if (!token || sha256(token) !== a.tokenHash) {
        throw Object.assign(new Error(`agent token required or wrong for: ${name}`), { code: 'AGENT_AUTH' });
      }
    }
    a.lastSeenAt = now();
    return a;
  }

  // ---------- agents ----------
  async registerAgent({ name, role = '', capabilities = [], token = null }) {
    await this.init();
    if (!name || typeof name !== 'string') throw new Error('agent name required');
    name = name.trim();
    if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/.test(name)) throw new Error('agent name: letters, digits, . _ - only (max 64)');
    const existing = this._agent(name);
    if (existing) {
      // In token mode, changing a registered identity requires its token.
      if (this.requireTokens && existing.tokenHash && (role || (Array.isArray(capabilities) && capabilities.length))) {
        this._requireAgent(name, token);
      }
      existing.role = role || existing.role;
      if (Array.isArray(capabilities) && capabilities.length) existing.capabilities = capabilities.map(String).slice(0, 32);
      existing.lastSeenAt = now();
      this._event('agent.rejoin', name, `${name} rejoined`);
      await this._save();
      return { agent: this._publicAgent(existing), rejoined: true };
    }
    const rawToken = crypto.randomBytes(24).toString('hex');
    const agent = { name, role: String(role).slice(0, 200), capabilities: Array.isArray(capabilities) ? capabilities.map(String).slice(0, 32) : [], joinedAt: now(), lastSeenAt: now(), tokenHash: sha256(rawToken) };
    this.state.agents.push(agent);
    this._event('agent.join', name, `${name} joined (${agent.role || 'no role'})`);
    await this._save();
    // The raw token is returned ONCE, here. Only its hash is ever stored.
    return { agent: this._publicAgent(agent), rejoined: false, token: rawToken, tokenNote: 'Store this token — it is shown once and only its hash is kept. Present it as `token` (tools) or x-agent-token (HTTP) when the bus runs with requireTokens.' };
  }

  async rotateAgentToken({ name, token = null }) {
    await this.init();
    const a = this._requireAgent(name, token);
    const rawToken = crypto.randomBytes(24).toString('hex');
    a.tokenHash = sha256(rawToken);
    this._event('agent.token_rotate', name, `${name} rotated its agent token`);
    await this._save();
    return { agent: this._publicAgent(a), token: rawToken, tokenNote: 'New token — the old one no longer works. Shown once.' };
  }

  async heartbeat({ name, token = null }) {
    await this.init();
    const a = this._requireAgent(name, token);
    return { agent: this._publicAgent(a), agents: await this.listAgents() };
  }

  async listAgents() { await this.init(); return this.state.agents.map(a => this._publicAgent(a)); }

  // ---------- messages ----------
  async sendMessage({ from, to = '*', body, channel = 'general', threadId = null, token = null }) {
    await this.init();
    this._requireAgent(from, token);
    if (to !== '*') this._existsAgent(to);
    if (!body || !String(body).trim()) throw new Error('message body required');
    this.state.msgSeq += 1;
    const msg = {
      id: this.state.msgSeq, from, to, channel: String(channel).slice(0, 64),
      body: String(body), threadId: threadId ? Number(threadId) : null,
      createdAt: now(), readBy: [from],
    };
    this.state.messages.push(msg);
    if (this.state.messages.length > 10000) this.state.messages.splice(0, this.state.messages.length - 10000);
    this._event('message.send', from, `${from} -> ${to} (#${msg.id})`, { to, channel: msg.channel, messageId: msg.id, excerpt: msg.body.slice(0, 280) });
    await this._save();
    return clone(msg);
  }

  /** Messages visible to `agent`: addressed to it, broadcast, or sent by it. Unread-first filtering optional. */
  async inbox(agentName, { unreadOnly = false, limit = 50, markRead = true, token = null } = {}) {
    await this.init();
    this._requireAgent(agentName, token);
    let msgs = this.state.messages.filter(m =>
      m.to === agentName || m.to === '*' || m.from === agentName);
    if (unreadOnly) msgs = msgs.filter(m => !m.readBy.includes(agentName));
    msgs = msgs.slice(-Math.min(limit, 500));
    if (markRead) {
      let changed = false;
      for (const m of msgs) if (!m.readBy.includes(agentName)) { m.readBy.push(agentName); changed = true; }
      if (changed) await this._save();
    }
    return clone(msgs);
  }

  async thread(id) {
    await this.init();
    const root = this.state.messages.find(m => m.id === Number(id));
    if (!root) throw new Error(`message not found: ${id}`);
    return clone(this.state.messages.filter(m => m.id === root.id || m.threadId === root.id));
  }

  // ---------- tasks ----------
  async createTask({ from, title, body = '', assignee = null, priority = 'normal', needsApproval = false, token = null }) {
    await this.init();
    this._requireAgent(from, token);
    if (assignee) this._existsAgent(assignee);
    if (!title || !String(title).trim()) throw new Error('task title required');
    this.state.taskSeq += 1;
    const task = {
      id: this.state.taskSeq, title: String(title).slice(0, 300), body: String(body),
      from, assignee: assignee || null, priority: priority === 'urgent' ? 'urgent' : 'normal',
      status: needsApproval ? 'needs-approval' : 'queued',
      needsApproval: !!needsApproval, approvedBy: null,
      claimedBy: null, claimExpiresAt: null, result: null, comments: [],
      createdAt: now(), updatedAt: now(),
      history: [{ at: now(), by: from, action: needsApproval ? 'created (awaiting approval)' : 'created' }],
    };
    this.state.tasks.push(task);
    this._event('task.create', from, `task #${task.id}: ${task.title}`);
    await this._save();
    return clone(task);
  }

  _expireClaims() {
    const t = Date.now();
    for (const task of this.state.tasks) {
      if (task.status === 'claimed' && task.claimExpiresAt && Date.parse(task.claimExpiresAt) < t) {
        task.status = 'queued'; task.claimedBy = null; task.claimExpiresAt = null; task.updatedAt = now();
        task.history.push({ at: now(), by: 'system', action: 'claim lease expired — returned to queue' });
        this._event('task.claim_expired', 'system', `task #${task.id} claim expired`);
      }
    }
  }

  async listTasks({ status = null, assignee = null } = {}) {
    await this.init();
    this._expireClaims(); await this._save();
    let tasks = this.state.tasks;
    if (status) tasks = tasks.filter(t => t.status === status);
    if (assignee) tasks = tasks.filter(t => t.assignee === assignee || t.claimedBy === assignee);
    return clone(tasks.sort((a, b) => b.id - a.id));
  }

  async approveTask(id, { by, token = null }) {
    await this.init();
    this._requireAgent(by, token);
    const task = this._task(id);
    if (task.status !== 'needs-approval') throw new Error(`task #${id} is not awaiting approval (status: ${task.status})`);
    task.status = 'queued'; task.approvedBy = by; task.updatedAt = now();
    task.history.push({ at: now(), by, action: 'approved' });
    this._event('task.approve', by, `task #${id} approved`);
    await this._save();
    return clone(task);
  }

  /** Claim is exclusive: a second claim while a lease is live fails loudly. */
  async claimTask(id, { by, token = null }) {
    await this.init();
    this._requireAgent(by, token);
    this._expireClaims();
    const task = this._task(id);
    if (task.status === 'claimed') throw Object.assign(new Error(`task #${id} already claimed by ${task.claimedBy}`), { code: 'ALREADY_CLAIMED' });
    if (task.status !== 'queued') throw new Error(`task #${id} cannot be claimed (status: ${task.status})`);
    if (task.assignee && task.assignee !== by) throw new Error(`task #${id} is assigned to ${task.assignee}`);
    task.status = 'claimed'; task.claimedBy = by;
    task.claimExpiresAt = new Date(Date.now() + CLAIM_LEASE_MS).toISOString();
    task.updatedAt = now();
    task.history.push({ at: now(), by, action: 'claimed' });
    this._event('task.claim', by, `task #${id} claimed by ${by}`);
    await this._save();
    return clone(task);
  }

  async completeTask(id, { by, result = '', token = null }) {
    await this.init();
    this._requireAgent(by, token);
    const task = this._task(id);
    if (task.status !== 'claimed') throw new Error(`task #${id} is not claimed (status: ${task.status})`);
    if (task.claimedBy !== by) throw new Error(`task #${id} is claimed by ${task.claimedBy}, not ${by}`);
    task.status = 'done'; task.result = String(result); task.claimExpiresAt = null; task.updatedAt = now();
    task.history.push({ at: now(), by, action: 'completed' });
    this._event('task.complete', by, `task #${id} completed`);
    await this._save();
    return clone(task);
  }

  async cancelTask(id, { by, token = null }) {
    await this.init();
    this._requireAgent(by, token);
    const task = this._task(id);
    if (['done', 'cancelled'].includes(task.status)) throw new Error(`task #${id} already ${task.status}`);
    task.status = 'cancelled'; task.updatedAt = now();
    task.history.push({ at: now(), by, action: 'cancelled' });
    this._event('task.cancel', by, `task #${id} cancelled`);
    await this._save();
    return clone(task);
  }

  _task(id) {
    const task = this.state.tasks.find(t => t.id === Number(id));
    if (!task) throw new Error(`task not found: ${id}`);
    return task;
  }

  // ---------- shared workspace: files + context + board ----------
  async putFile({ by, path: p, text, token = null }) {
    await this.init();
    this._requireAgent(by, token);
    if (!p || typeof text !== 'string') throw new Error('path and text required');
    if (String(p).includes('..')) throw new Error('path may not contain ..');
    this.state.files[p] = { text, updatedBy: by, updatedAt: now() };
    this._event('file.put', by, `${by} wrote ${p} (${text.length} chars)`);
    await this._save();
    return { path: p, bytes: Buffer.byteLength(text) };
  }

  async getFile(p) {
    await this.init();
    const f = this.state.files[p];
    if (!f) throw new Error(`file not found: ${p}`);
    return { path: p, ...clone(f) };
  }

  async listFiles() {
    await this.init();
    return Object.entries(this.state.files).map(([p, f]) => ({ path: p, bytes: Buffer.byteLength(f.text), updatedBy: f.updatedBy, updatedAt: f.updatedAt }));
  }

  async putContext({ by, context, token = null }) {
    await this.init();
    this._requireAgent(by, token);
    if (!context || typeof context !== 'object' || Array.isArray(context)) throw new Error('context must be an object');
    this.state.context = clone(context);
    this._event('context.put', by, `${by} published context`);
    await this._save();
    return { ok: true };
  }

  async getContext() {
    await this.init();
    if (!this.state.context) throw new Error('no context published yet');
    return clone(this.state.context);
  }

  async addTaskComment(id, { by, body, token = null }) {
    await this.init();
    this._requireAgent(by, token);
    if (!body || !String(body).trim()) throw new Error('comment body required');
    const task = this._task(id);
    task.comments = task.comments || [];
    const comment = { by, body: String(body), at: now() };
    task.comments.push(comment);
    task.updatedAt = now();
    task.history.push({ at: now(), by, action: 'commented' });
    this._event('task.comment', by, `${by} commented on task #${id}`, { taskId: task.id });
    await this._save();
    return clone(task);
  }

  async deleteFile({ by, path: p, token = null }) {
    await this.init();
    this._requireAgent(by, token);
    if (!this.state.files[p]) throw new Error(`file not found: ${p}`);
    delete this.state.files[p];
    this._event('file.delete', by, `${by} deleted ${p}`);
    await this._save();
    return { path: p, deleted: true };
  }

  async listChannels() {
    await this.init();
    const counts = {};
    for (const m of this.state.messages) counts[m.channel] = (counts[m.channel] || 0) + 1;
    return Object.entries(counts).map(([channel, messages]) => ({ channel, messages })).sort((a, b) => b.messages - a.messages);
  }

  /** Full-text search across messages, tasks, and shared files. */
  async search(query, { limit = 20 } = {}) {
    await this.init();
    const q = String(query || '').toLowerCase().trim();
    if (q.length < 2) throw new Error('search query needs at least 2 characters');
    const hit = (text) => String(text || '').toLowerCase().includes(q);
    return {
      query,
      messages: clone(this.state.messages.filter(m => hit(m.body)).slice(-limit)),
      tasks: clone(this.state.tasks.filter(t => hit(t.title) || hit(t.body) || hit(t.result)).slice(-limit)),
      files: Object.entries(this.state.files).filter(([p, f]) => hit(p) || hit(f.text)).slice(0, limit)
        .map(([p, f]) => ({ path: p, updatedBy: f.updatedBy, updatedAt: f.updatedAt, excerpt: f.text.slice(0, 200) })),
    };
  }

  /** A human-readable board rendered from live state — the shared picture at a glance. */
  async board() {
    await this.init();
    this._expireClaims();
    const s = this.state;
    const lines = [
      `# ${s.workspace.name} — Board`,
      `Updated: ${now()} · GhostBus v${GHOSTBUS_VERSION}`,
      '',
      `## Agents (${s.agents.length})`,
      ...(s.agents.length ? s.agents.map(a => `- **${a.name}** — ${a.role || 'agent'}${a.capabilities.length ? ` · ${a.capabilities.join(', ')}` : ''} · last seen ${a.lastSeenAt}`) : ['- (none registered)']),
      '',
      `## Open tasks (${s.tasks.filter(t => !['done', 'cancelled'].includes(t.status)).length})`,
      ...(s.tasks.filter(t => !['done', 'cancelled'].includes(t.status)).length
        ? s.tasks.filter(t => !['done', 'cancelled'].includes(t.status)).map(t => `- #${t.id} [${t.status}] ${t.title}${t.claimedBy ? ` — claimed by ${t.claimedBy}` : ''}${t.assignee ? ` — for ${t.assignee}` : ''}`)
        : ['- (none)']),
      '',
      `## Files (${Object.keys(s.files).length})`,
      ...(Object.keys(s.files).length ? Object.keys(s.files).sort().map(p => `- ${p} (${s.files[p].updatedBy}, ${s.files[p].updatedAt})`) : ['- (none)']),
      '',
      `## Recent activity`,
      ...s.events.slice(-10).reverse().map(e => `- ${e.at} · ${e.actor} · ${e.summary}`),
      '',
    ];
    return lines.join('\n');
  }

  async events({ limit = 50 } = {}) {
    await this.init();
    return clone(this.state.events.slice(-Math.min(limit, 500)));
  }

  async status() {
    await this.init();
    this._expireClaims();
    const s = this.state;
    return {
      server: 'ghostbus', version: GHOSTBUS_VERSION, workspace: s.workspace,
      agents: s.agents.length,
      messages: s.messages.length,
      tasks: { total: s.tasks.length, queued: s.tasks.filter(t => t.status === 'queued').length, claimed: s.tasks.filter(t => t.status === 'claimed').length, needsApproval: s.tasks.filter(t => t.status === 'needs-approval').length, done: s.tasks.filter(t => t.status === 'done').length },
      files: Object.keys(s.files).length,
      hasContext: !!s.context,
      events: s.events.length,
    };
  }
}

export async function createBus(store, workspace, opts = {}) {
  const bus = new GhostBus(store, workspace, opts);
  await bus.init();
  return bus;
}
