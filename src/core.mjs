/**
 * GhostBus core — transport-agnostic agent-to-agent message bus + shared workspace.
 *
 * One workspace holds: registered agents, direct/broadcast messages, claimable
 * tasks (with leases + an approval gate), shared files, a shared context object,
 * and an append-only provenance event log. Every mutation is stamped with the
 * acting agent and a timestamp — nothing enters the workspace anonymously.
 *
 * Storage: any object with async load() -> state|null and async save(state).
 * Ships with MemoryStore, FileStore (atomic JSON file, multi-process
 * sharing semantics) and JournalStore (owning single-process store:
 * snapshot + append-only delta journal — the production hosted store).
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { AsyncLocalStorage } from 'node:async_hooks';

export const GHOSTBUS_VERSION = '0.7.0';
const sha256 = (s) => crypto.createHash('sha256').update(String(s)).digest('hex');
// Timing-safe equality for hex digests (v0.5.3): secret comparisons must not
// short-circuit on the first differing character the way === does.
const hashEqHex = (aHex, bHex) => {
  const a = Buffer.from(String(aHex)); const b = Buffer.from(String(bHex));
  return a.length === b.length && crypto.timingSafeEqual(a, b);
};
export const TASK_STATUSES = ['queued', 'claimed', 'needs-approval', 'done', 'cancelled'];
const CLAIM_LEASE_MS = 15 * 60 * 1000;
// Shared-file names are keys in one plain object, never filesystem paths —
// but three names are special to the object itself (v0.5.4): assigning
// files['__proto__'] invokes the prototype setter and silently replaces the
// map's prototype (the "file" then enumerates nowhere and the store is
// corrupted), while reading files['constructor'] / files['__proto__'] on a
// fresh map returns inherited members instead of "not found". Writes refuse
// the three outright; reads treat them as absent; snapshots may not carry
// them either (validateSnapshot below).
const RESERVED_FILE_NAMES = new Set(['__proto__', 'constructor', 'prototype']);

const now = () => new Date().toISOString();
// Coded errors (v0.6.0): the HTTP layer maps `code` to a status (401 AGENT_AUTH,
// 404 NOT_FOUND, 409 CONFLICT, 413 TOO_LARGE, 507 QUOTA). Uncoded = validation = 400.
const fail = (message, code) => Object.assign(new Error(message), { code });
// HTTP status for a bus error (v0.6.0). Before this every failure was a 400, so clients could not
// tell "fix your request" from "not found", "conflict", "quota" or "the server is broken".
export function statusForError(e) {
  const c = e && e.code;
  if (c === 'AGENT_AUTH') return 401;
  if (c === 'NOT_FOUND') return 404;
  if (c === 'CONFLICT' || c === 'ALREADY_CLAIMED' || c === 'BLOCKED') return 409;
  if (c === 'TOO_LARGE') return 413;
  if (c === 'QUOTA') return 507;
  if (typeof c === 'string' && (c.startsWith('STORE_') || /^E[A-Z0-9]{2,}$/.test(c))) return 500; // storage/OS faults
  return 400;
}
const envInt = (name, def) => { const n = Number(process.env[name]); return Number.isFinite(n) && n >= 1 ? Math.floor(n) : def; };
// Per-workspace quotas (v0.6.0). Operator knobs via env; `opts.limits` overrides per bus.
export const defaultLimits = () => ({
  maxTasks: envInt('GHOSTBUS_MAX_TASKS', 5000),
  maxFiles: envInt('GHOSTBUS_MAX_FILES', 1000),
  maxCommentsPerTask: envInt('GHOSTBUS_MAX_COMMENTS_PER_TASK', 500),
  maxAgents: envInt('GHOSTBUS_MAX_AGENTS', 200),
  maxFileBytes: envInt('GHOSTBUS_MAX_FILE_BYTES', 1_000_000),
  maxContextBytes: envInt('GHOSTBUS_MAX_CONTEXT_BYTES', 262_144),
});
const clone = (v) => JSON.parse(JSON.stringify(v));
// Untrusted numeric inputs (HTTP query params, MCP arguments, direct API
// callers) arrive as NaN, negatives, and absurd magnitudes, and raw
// slice(-n) arithmetic turns them into nonsense: limit=0 or NaN returned
// EVERYTHING (slice(-0) / slice(NaN) both mean "from the start"), limit=-1
// returned all-but-one (v0.5.5). Every list/read path clamps through here:
// non-finite -> the default, fractional -> floored, out-of-range -> the
// [0, max] bound; a clamped limit of 0 honestly means "return none".
const clampLimit = (v, def, max) => {
  const n = Number(v);
  if (!Number.isFinite(n)) return def;
  return Math.max(0, Math.min(Math.floor(n), max));
};
const tailSlice = (arr, lim) => (lim > 0 ? arr.slice(-lim) : []);

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
  constructor(file) { this.file = file; this.shared = true; this._chain = Promise.resolve(); }
  async load() {
    // v0.6.0: only "file does not exist" (or empty) means "no state yet". Any other
    // failure used to return null, so a corrupt/unreadable store was silently replaced
    // by an empty workspace on the next save — data loss. Now it fails loudly instead.
    let text;
    try { text = await fs.promises.readFile(this.file, 'utf8'); }
    catch (e) {
      if (e && e.code === 'ENOENT') return null;
      throw fail(`store unreadable: ${e && e.message}`, 'STORE_UNREADABLE');
    }
    if (!text.trim()) return null;
    try { return JSON.parse(text); }
    catch (e) { throw fail(`store is corrupt (not valid JSON): ${this.file} — refusing to overwrite it; restore from a backup or move the file aside`, 'STORE_CORRUPT'); }
  }
  async save(state) {
    // Serialize saves within this process, and give every save its own temp
    // file: two writers (this process or another sharing the same store
    // file) must never collide on one fixed '.tmp' name — the first rename
    // moves it away and the second save then fails ENOENT.
    const run = async () => {
      await fs.promises.mkdir(path.dirname(this.file), { recursive: true });
      const tmp = this.file + '.tmp.' + process.pid + '.' + Math.random().toString(36).slice(2, 10);
      try {
        // State files hold token hashes — owner-only (0600) from birth
        // (v0.5.3). The mode rides through the atomic rename; the chmod
        // covers filesystems/umasks that would otherwise widen it.
        await fs.promises.writeFile(tmp, JSON.stringify(state), { mode: 0o600 });
        await fs.promises.chmod(tmp, 0o600).catch(() => {});
        await fs.promises.rename(tmp, this.file); // atomic replace
      } finally {
        await fs.promises.unlink(tmp).catch(() => {});
      }
    };
    const p = this._chain.then(run, run);
    this._chain = p.catch(() => {});
    return p;
  }
}

// ---------- JournalStore (v0.7.0): the production-scale store ----------
//
// Why it exists: FileStore re-reads, re-parses, re-stringifies and rewrites
// the WHOLE state on every operation, so per-op cost is O(state size) and
// throughput collapses as a workspace grows. JournalStore is an OWNING
// store — exactly one process serves the workspace (the hosted server's
// model) — so it loads once, keeps state in memory, and makes each save
// O(change size) instead of O(state size):
//
// - `<file>` holds a full-state snapshot in the SAME raw JSON format
//   FileStore writes (plus one bookkeeping key, `_journalGen`, stripped
//   on load), so existing data files are valid snapshots as-is: pointing
//   JournalStore at a FileStore file migrates it in place, no conversion.
// - `<file>.journal` is an append-only log of per-save DELTA records
//   (added/patched/removed items by identity, changed scalars, file
//   put/del), each with a generation number and a checksum. A save
//   appends one small record instead of rewriting the state.
// - Load = snapshot + replay of the records after it. Replay stops at
//   the first torn, gapped or checksum-failing record — a crash mid-
//   append can only ever cost the in-flight operation, never earlier
//   acknowledged work (the same clean-prefix property the SIGKILL drill
//   pins for FileStore) — and the store then compacts to heal the tail.
// - Compaction rewrites the snapshot and restarts the journal when the
//   journal outgrows ~1 MB or ~1000 records. A crash between the two
//   renames is safe: replay skips records already folded into the
//   snapshot by generation number.
// - How a save stays cheap: the bus reports which top-level sections it
//   touched (GhostBus._touch, threaded into save() as a hint), and the
//   store caches the last durable state's per-section JSON — never a
//   second object tree — so a save serializes only the sections that
//   changed. Every 200 saves the hint is ignored and EVERYTHING is
//   diffed, so a section the bus ever failed to report still lands
//   within 200 operations; the suite's round-trip checks pin the hint
//   coverage directly. Events — append-only and never edited in place
//   in the core — take a shape-checked fast path inside hinted saves.
// - Durability: an append survives a process kill (page cache) exactly
//   like FileStore's rename survives it; surviving POWER loss needs the
//   fsync option (GHOSTBUS_JOURNAL_FSYNC=1), one fsync per save — the
//   same caveat class as FileStore, which never fsynced either.
// The trade, stated plainly: JournalStore is NOT multi-process. Two
// processes pointed at one workspace through it will diverge. Sharing a
// workspace file between processes stays FileStore's job (stdio + CLI +
// relay); the hosted server, which already serializes each workspace
// through one process, is the JournalStore deployment.
const JOURNAL_ARRAY_KEYS = { agents: 'name', messages: 'id', tasks: 'id', events: 'seq' };

/** Per-section JSON cache of one durable state: scalars by key, array
 *  items as parallel keys/JSON lists, files by key. Strings, not objects:
 *  diffing never re-serializes the old side, and there is no second state
 *  tree to keep in sync. */
function journalCacheOf(state) {
  const cache = { scalars: new Map(), arrays: new Map(), files: new Map() };
  if (!state) return cache;
  for (const k of Object.keys(state)) {
    if (k === 'files' || k in JOURNAL_ARRAY_KEYS) continue;
    cache.scalars.set(k, JSON.stringify(state[k]));
  }
  for (const [k, keyName] of Object.entries(JOURNAL_ARRAY_KEYS)) {
    const arr = Array.isArray(state[k]) ? state[k] : [];
    cache.arrays.set(k, {
      keys: arr.map(it => (it && typeof it === 'object' ? it[keyName] : undefined)),
      elems: arr.map(it => JSON.stringify(it)),
    });
  }
  for (const [k, v] of Object.entries(state.files || {})) cache.files.set(k, JSON.stringify(v));
  return cache;
}

function journalDiffArray(oldC, newArr, keyName, { fastPath = false } = {}) {
  const newKeys = newArr.map(it => (it && typeof it === 'object' ? it[keyName] : undefined));
  const newElems = newArr.map(it => JSON.stringify(it));
  const cache = { keys: newKeys, elems: newElems };
  const oldKeys = oldC.keys;
  const oldElems = oldC.elems;
  if (oldKeys.length === newKeys.length && oldElems.every((e, i) => e === newElems[i])) return { rec: null, cache };
  // Events fast path (hinted saves only): events are append-only and
  // never edited in place in the core, so a save may only trim a prefix
  // and append a tail. Shape-check by identity keys plus the boundary
  // elements; full diffs (restore, the periodic audit) never take it.
  if (fastPath && keyName === 'seq' && newKeys.length) {
    const t = oldKeys.indexOf(newKeys[0]);
    if (t >= 0) {
      const appended = newKeys.length - (oldKeys.length - t);
      if (appended >= 0) {
        const surv = oldKeys.length - t;
        let ok = true;
        for (let i = 0; i < surv && ok; i++) if (newKeys[i] !== oldKeys[t + i]) ok = false;
        if (ok && surv > 0 && (newElems[0] !== oldElems[t] || newElems[surv - 1] !== oldElems[oldKeys.length - 1])) ok = false;
        if (ok) {
          const d = {};
          if (t > 0) d.del = oldKeys.slice(0, t);
          if (appended > 0) d.add = newArr.slice(surv).map(clone);
          return { rec: Object.keys(d).length ? d : null, cache };
        }
      }
    }
  }
  const usable = (ks) => ks.every(k => k !== undefined && k !== null) && new Set(ks.map(String)).size === ks.length;
  if (!usable(oldKeys) || !usable(newKeys)) return { rec: { set: clone(newArr) }, cache };
  const newKeySet = new Set(newKeys.map(String));
  const oldIdx = new Map(oldKeys.map((k, i) => [String(k), i]));
  const del = oldKeys.filter(k => !newKeySet.has(String(k)));
  const add = [];
  const patch = {};
  for (let i = 0; i < newArr.length; i++) {
    const oi = oldIdx.get(String(newKeys[i]));
    if (oi === undefined) add.push(clone(newArr[i]));
    else if (oldElems[oi] !== newElems[i]) patch[String(newKeys[i])] = clone(newArr[i]);
  }
  // Reconstruction check: survivors in old order, then additions, must
  // reproduce the new order exactly — anything else (a reorder, a
  // restore with different shape) falls back to a full set.
  const expected = oldKeys.filter(k => newKeySet.has(String(k))).concat(add.map(it => it[keyName]));
  if (expected.map(String).join('\u0001') !== newKeys.map(String).join('\u0001')) return { rec: { set: clone(newArr) }, cache };
  const d = {};
  if (del.length) d.del = del;
  if (Object.keys(patch).length) d.patch = patch;
  if (add.length) d.add = add;
  return { rec: Object.keys(d).length ? d : null, cache };
}

function journalDiffFiles(oldMap, newFiles) {
  const cache = new Map();
  const put = {};
  const del = [];
  const newKeys = Object.keys(newFiles);
  for (const k of newKeys) {
    const j = JSON.stringify(newFiles[k]);
    cache.set(k, j);
    if (!oldMap.has(k) || oldMap.get(k) !== j) put[k] = clone(newFiles[k]);
  }
  for (const k of oldMap.keys()) if (!Object.prototype.hasOwnProperty.call(newFiles, k)) del.push(k);
  const changed = Object.keys(put).length + del.length;
  if (!changed) return { rec: null, cache };
  // Wholesale change (a restore, a mass delete): one set beats 500 puts.
  if (changed * 2 > Math.max(oldMap.size, newKeys.length, 1) + 2) return { rec: { set: clone(newFiles) }, cache };
  const d = {};
  if (del.length) d.del = del;
  if (Object.keys(put).length) d.put = put;
  return { rec: d, cache };
}

/** Scalars = every top-level key that is not an array section or files
 *  (workspace, the seq counters, context, any extra keys a restore
 *  carried). Always diffed: they are small, and the counters move on
 *  every operation. */
function journalDiffScalars(oldMap, state) {
  const cache = new Map();
  const s = {};
  const unset = [];
  const keys = new Set(oldMap.keys());
  for (const k of Object.keys(state)) if (k !== 'files' && !(k in JOURNAL_ARRAY_KEYS)) keys.add(k);
  for (const k of keys) {
    if (!Object.prototype.hasOwnProperty.call(state, k)) { unset.push(k); continue; }
    const j = JSON.stringify(state[k]);
    cache.set(k, j);
    if (oldMap.get(k) !== j) s[k] = clone(state[k]);
  }
  const rec = {};
  if (Object.keys(s).length) rec.s = s;
  if (unset.length) rec.unset = unset;
  return { rec: Object.keys(rec).length ? rec : null, cache };
}

function journalApplyRecord(state, rec) {
  if (Array.isArray(rec.unset)) for (const k of rec.unset) delete state[k];
  if (rec.s) for (const [k, v] of Object.entries(rec.s)) state[k] = clone(v);
  if (rec.a) {
    for (const [k, d] of Object.entries(rec.a)) {
      const keyName = JOURNAL_ARRAY_KEYS[k];
      if (!keyName || !Array.isArray(state[k])) continue;
      if (d.set) { state[k] = clone(d.set); continue; }
      let arr = state[k];
      if (Array.isArray(d.del)) { const delSet = new Set(d.del.map(String)); arr = arr.filter(it => !delSet.has(String(it && it[keyName]))); }
      if (d.patch) {
        const idx = new Map(arr.map((it, i) => [String(it && it[keyName]), i]));
        for (const [pk, v] of Object.entries(d.patch)) { const i = idx.get(pk); if (i !== undefined) arr[i] = clone(v); }
      }
      if (Array.isArray(d.add)) arr.push(...clone(d.add));
      state[k] = arr;
    }
  }
  if (rec.f) {
    if (rec.f.set) state.files = clone(rec.f.set);
    else {
      if (!state.files || typeof state.files !== 'object') state.files = {};
      if (Array.isArray(rec.f.del)) for (const k of rec.f.del) delete state.files[k];
      if (rec.f.put) for (const [k, v] of Object.entries(rec.f.put)) state.files[k] = clone(v);
    }
  }
}

const journalRecordSum = (payload) => sha256(JSON.stringify(payload)).slice(0, 16);
function journalRecordPayload(rec) {
  const payload = { v: 1, gen: rec.gen };
  if (rec.s) payload.s = rec.s;
  if (rec.unset) payload.unset = rec.unset;
  if (rec.a) payload.a = rec.a;
  if (rec.f) payload.f = rec.f;
  return payload;
}

export class JournalStore {
  constructor(file, opts = {}) {
    this.file = file;
    this.journalFile = file + '.journal';
    this.shared = false; // owning store: state is loaded once, never re-read per op
    this._chain = Promise.resolve();
    this._cache = null;        // per-section JSON of the last durable state (null until first load/save)
    this._loadedState = null;  // the state as loaded (repeat loads return clones of it)
    this._gen = 0;             // generation of the last durable state
    this._loaded = false;
    this._journalStarted = false;
    this._journalBytes = 0;    // journal bytes since the last snapshot
    this._records = 0;         // records since the last snapshot
    this._sinceAudit = 0;      // saves since the last full (hint-free) diff
    this._auditEvery = opts.auditEvery || 200;
    this._fsync = !!opts.fsync || process.env.GHOSTBUS_JOURNAL_FSYNC === '1';
    this._compactBytes = opts.compactBytes || 1_000_000;
    this._compactRecords = opts.compactRecords || 1000;
  }

  async load() {
    const p = this._chain.then(() => this._load(), () => this._load());
    this._chain = p.catch(() => {});
    return p;
  }

  async _load() {
    if (this._loaded) return this._loadedState ? clone(this._loadedState) : null;
    // Snapshot: same posture as FileStore — only a missing/empty file
    // means "no state yet"; a corrupt one fails loudly, never resets.
    let snapState = null;
    let snapGen = 0;
    let snapText = null;
    try { snapText = await fs.promises.readFile(this.file, 'utf8'); }
    catch (e) {
      if (!(e && e.code === 'ENOENT')) throw fail(`store unreadable: ${e && e.message}`, 'STORE_UNREADABLE');
    }
    if (snapText && snapText.trim()) {
      try { snapState = JSON.parse(snapText); }
      catch { throw fail(`store is corrupt (not valid JSON): ${this.file} — refusing to overwrite it; restore from a backup or move the file aside`, 'STORE_CORRUPT'); }
      if (snapState && typeof snapState._journalGen === 'number') { snapGen = snapState._journalGen; delete snapState._journalGen; }
    }
    let journalText = '';
    try { journalText = await fs.promises.readFile(this.journalFile, 'utf8'); }
    catch (e) {
      if (!(e && e.code === 'ENOENT')) throw fail(`store unreadable: ${e && e.message}`, 'STORE_UNREADABLE');
    }
    let state = snapState;
    let gen = snapGen;
    let torn = false;
    if (journalText) {
      const lines = journalText.split('\n');
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        if (!line.trim()) continue;
        let rec;
        try { rec = JSON.parse(line); } catch { torn = true; break; }
        if (i === 0 && rec && rec.v === 1 && typeof rec.base === 'number' && rec.gen === undefined) continue; // journal header
        if (!rec || typeof rec.gen !== 'number') { torn = true; break; }
        if (rec.gen <= gen) continue; // already folded into the snapshot (crash mid-compaction)
        if (rec.gen !== gen + 1) { torn = true; break; } // a gap: stop at the last whole record
        if (rec.sum !== journalRecordSum(journalRecordPayload(rec))) { torn = true; break; }
        if (!state) throw fail(`store is corrupt (journal has records but no snapshot): ${this.file} — restore from a backup`, 'STORE_CORRUPT');
        journalApplyRecord(state, rec);
        gen = rec.gen;
      }
    }
    this._loadedState = state ? clone(state) : null;
    this._cache = state ? journalCacheOf(state) : null;
    this._gen = gen;
    this._loaded = true;
    this._journalStarted = journalText.length > 0;
    this._journalBytes = Buffer.byteLength(journalText);
    this._records = Math.max(0, gen - snapGen);
    // Heal a torn tail immediately: fold the replayed prefix into a fresh
    // snapshot so the bad bytes are gone before the next save appends.
    if (torn && state) await this._compact(state);
    return state ? clone(state) : null;
  }

  async _compact(state) {
    await fs.promises.mkdir(path.dirname(this.file), { recursive: true });
    const snapTmp = this.file + '.tmp.' + process.pid + '.' + Math.random().toString(36).slice(2, 10);
    try {
      await fs.promises.writeFile(snapTmp, JSON.stringify({ ...clone(state), _journalGen: this._gen }), { mode: 0o600 });
      await fs.promises.chmod(snapTmp, 0o600).catch(() => {});
      await fs.promises.rename(snapTmp, this.file);
    } finally { await fs.promises.unlink(snapTmp).catch(() => {}); }
    const jTmp = this.journalFile + '.tmp.' + process.pid + '.' + Math.random().toString(36).slice(2, 10);
    try {
      await fs.promises.writeFile(jTmp, JSON.stringify({ v: 1, base: this._gen }) + '\n', { mode: 0o600 });
      await fs.promises.chmod(jTmp, 0o600).catch(() => {});
      await fs.promises.rename(jTmp, this.journalFile);
    } finally { await fs.promises.unlink(jTmp).catch(() => {}); }
    this._journalStarted = true;
    this._journalBytes = 0;
    this._records = 0;
  }

  /** save(state, hint?) — hint = {dirty: Set<section>, full: bool} from
   *  the bus (see GhostBus._touch). Stores without a hinting caller (a
   *  direct API user) simply get a full diff every save. */
  async save(state, hint) {
    const run = async () => {
      if (!this._loaded) await this._load();
      if (!this._cache) {
        // First durable write for a fresh workspace: lay down the
        // snapshot; deltas journal from the next save on.
        this._cache = journalCacheOf(state);
        this._gen = 0;
        await this._compact(state);
        return;
      }
      this._sinceAudit += 1;
      const full = !hint || !(hint.dirty instanceof Set) || !!hint.full || this._sinceAudit >= this._auditEvery;
      if (full) this._sinceAudit = 0;
      const dirty = full ? null : hint.dirty;
      const rec = {};
      const sc = journalDiffScalars(this._cache.scalars, state);
      if (sc.rec) { if (sc.rec.s) rec.s = sc.rec.s; if (sc.rec.unset) rec.unset = sc.rec.unset; }
      const a = {};
      const newArrayCaches = new Map();
      for (const [k, keyName] of Object.entries(JOURNAL_ARRAY_KEYS)) {
        if (!full && !dirty.has(k)) continue;
        const d = journalDiffArray(this._cache.arrays.get(k) || { keys: [], elems: [] }, Array.isArray(state[k]) ? state[k] : [], keyName, { fastPath: !full });
        newArrayCaches.set(k, d.cache);
        if (d.rec) a[k] = d.rec;
      }
      if (Object.keys(a).length) rec.a = a;
      let newFilesCache = null;
      if (full || dirty.has('files')) {
        const d = journalDiffFiles(this._cache.files, state.files || {});
        newFilesCache = d.cache;
        if (d.rec) rec.f = d.rec;
      }
      const commitCaches = () => {
        this._cache.scalars = sc.cache;
        for (const [k, c] of newArrayCaches) this._cache.arrays.set(k, c);
        if (newFilesCache) this._cache.files = newFilesCache;
      };
      if (!Object.keys(rec).length) { commitCaches(); return; } // nothing durable changed — append nothing
      this._gen += 1;
      const payload = { v: 1, gen: this._gen, ...rec };
      const line = JSON.stringify({ ...payload, sum: journalRecordSum(payload) }) + '\n';
      let out = line;
      if (!this._journalStarted) out = JSON.stringify({ v: 1, base: this._gen - 1 }) + '\n' + line;
      await fs.promises.mkdir(path.dirname(this.file), { recursive: true });
      await fs.promises.appendFile(this.journalFile, out, { mode: 0o600 });
      if (!this._journalStarted) await fs.promises.chmod(this.journalFile, 0o600).catch(() => {});
      this._journalStarted = true;
      if (this._fsync) {
        const fh = await fs.promises.open(this.journalFile, 'a');
        try { await fh.sync(); } finally { await fh.close(); }
      }
      commitCaches();
      this._journalBytes += Buffer.byteLength(out);
      this._records += 1;
      if (this._journalBytes > this._compactBytes || this._records > this._compactRecords) {
        await this._compact(state);
        this._cache = journalCacheOf(state);
      }
    };
    const p = this._chain.then(run, run);
    this._chain = p.catch(() => {});
    return p;
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
    this.limits = { ...defaultLimits(), ...(opts.limits || {}) };
    this.listeners = new Set(); // live event subscribers (SSE relay)
    // Sections mutated since the last save (v0.7.0): reported to the
    // store as a save hint so a diffing store (JournalStore) only
    // serializes what changed. Stores that ignore the hint (MemoryStore,
    // FileStore) are unaffected. _restore sets _dirtyFull: its save must
    // diff everything. A failed save restores the hint (see _save).
    this._dirty = new Set();
    this._dirtyFull = false;
    // Mutation mutex (v0.5.1): a promise chain serializing every public
    // operation's load -> mutate -> save cycle on THIS instance. Without it,
    // concurrent calls interleave their cycles against the shared store and
    // silently lose each other's updates (one op's reload discards another's
    // not-yet-saved state). The AsyncLocalStorage marker makes the chain
    // reentrant: public methods that call other public methods (updateCapsule
    // -> getCapsule, restore -> status, heartbeat -> listAgents) run inline
    // instead of deadlocking on their own queue.
    this._chain = Promise.resolve();
    this._als = new AsyncLocalStorage();
  }

  /**
   * Run `fn` inside this bus's serialized section. Callers queue FIFO on the
   * promise chain; a throwing operation still releases the chain (finally),
   * so one failure can never wedge the bus. Scope: per Bus instance, in this
   * process — it cannot span processes sharing one store file (each op there
   * is still a single atomic read-modify-write) nor serverless invocations.
   */
  async _serialized(fn) {
    if (this._als.getStore() === this) return fn();
    const prev = this._chain;
    let release;
    const gate = new Promise((resolve) => { release = resolve; });
    this._chain = prev.then(() => gate);
    await prev;
    try {
      return await this._als.run(this, fn);
    } finally {
      release();
    }
  }

  /** Subscribe to provenance events as they happen. Returns an unsubscribe fn. */
  onEvent(fn) { this.listeners.add(fn); return () => this.listeners.delete(fn); }

  async init() { return this._serialized(() => this._init()); }
  async _init() {
    // Shared (file) stores are re-read on every call: several processes
    // (stdio servers, the CLI, a relay) can then share ONE workspace file
    // and actually see each other's writes. Each mutation is a fresh
    // read-modify-write with an atomic replace, so the race window is a
    // single operation. Memory stores skip the reload.
    if (this.state && !this.store.shared) return this;
    const loaded = await this.store.load();
    if (loaded) this.state = loaded;
    else if (!this.state) this.state = emptyState(this.workspaceInfo);
    return this;
  }

  _touch(...sections) { for (const s of sections) this._dirty.add(s); }

  async _save() {
    const hint = { dirty: new Set(this._dirty), full: this._dirtyFull };
    this._dirty.clear();
    this._dirtyFull = false;
    try { await this.store.save(this.state, hint); }
    catch (e) {
      // The mutation did not land durably: hand the hint back so the next
      // save still knows these sections changed.
      for (const s of hint.dirty) this._dirty.add(s);
      if (hint.full) this._dirtyFull = true;
      throw e;
    }
  }

  _event(type, actor, summary, meta = {}) {
    this._touch('events');
    this.state.seq += 1;
    const ev = { seq: this.state.seq, type, actor: actor || 'system', at: now(), summary, ...meta };
    this.state.events.push(ev);
    if (this.state.events.length > 5000) this.state.events.splice(0, this.state.events.length - 5000);
    for (const fn of this.listeners) { try { fn(clone(ev)); } catch { /* a dead listener never breaks the bus */ } }
  }

  _agent(name) { return this.state.agents.find(a => a.name === name) || null; }

  // ---- direct-message visibility (v0.6.0) ----
  // With tokens enforced, an agent's identity is only proven by its token. Read paths that
  // return message content (search, thread, sync, events, SSE, long-poll) used to ignore
  // identity and exposed every agent's direct messages to any key-holder. When enforced,
  // `viewer` is the verified agent name, or null (unproven: broadcasts only). When tokens
  // are NOT enforced there is no identity to protect, so viewer is undefined = no filtering.
  _viewerOf(agent, token) {
    if (!this.requireTokens) return undefined;
    const a = agent ? this._agent(String(agent)) : null;
    if (!a) return null;
    if (!a.tokenHash) return a.name;
    return token && hashEqHex(sha256(token), a.tokenHash) ? a.name : null;
  }
  _canSee(m, viewer) { return viewer === undefined || m.to === '*' || m.to === viewer || m.from === viewer; }
  _redactEvent(ev, viewer) {
    if (viewer === undefined || ev.type !== 'message.send' || ev.to === '*' || ev.to === viewer || ev.actor === viewer) return ev;
    const { excerpt, ...rest } = ev; return rest;
  }
  /** True when `token` proves `name` (always true on a non-enforcing bus). */
  async verifyAgent(name, token = null) { await this.init(); return this._viewerOf(name, token) !== null; }
  /** Strip DM excerpts the agent may not read (no-op unless tokens are enforced). Sync; for SSE/long-poll. */
  redactEvent(ev, agent) { return this.requireTokens ? this._redactEvent(ev, agent) : ev; }

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
      if (!token || !hashEqHex(sha256(token), a.tokenHash)) {
        throw Object.assign(new Error(`agent token required or wrong for: ${name}`), { code: 'AGENT_AUTH' });
      }
    }
    a.lastSeenAt = now();
    this._touch('agents'); // presence is state too: a diffing store must see it
    return a;
  }

  // ---------- agents ----------
  async registerAgent(...args) { return this._serialized(() => this._registerAgent(...args)); }
  async _registerAgent({ name, role = '', capabilities = [], token = null }) {
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
      existing.role = role ? String(role).slice(0, 200) : existing.role;
      if (Array.isArray(capabilities) && capabilities.length) existing.capabilities = capabilities.map(String).slice(0, 32);
      existing.lastSeenAt = now();
      this._touch('agents');
      this._event('agent.rejoin', name, `${name} rejoined`);
      await this._save();
      return { agent: this._publicAgent(existing), rejoined: true };
    }
    if (this.state.agents.length >= this.limits.maxAgents) throw fail(`agent quota reached (max ${this.limits.maxAgents} per workspace)`, 'QUOTA');
    const rawToken = crypto.randomBytes(24).toString('hex');
    const agent = { name, role: String(role).slice(0, 200), capabilities: Array.isArray(capabilities) ? capabilities.map(String).slice(0, 32) : [], joinedAt: now(), lastSeenAt: now(), tokenHash: sha256(rawToken) };
    this.state.agents.push(agent);
    this._touch('agents');
    this._event('agent.join', name, `${name} joined (${agent.role || 'no role'})`);
    await this._save();
    // The raw token is returned ONCE, here. Only its hash is ever stored.
    return { agent: this._publicAgent(agent), rejoined: false, token: rawToken, tokenNote: 'Store this token — it is shown once and only its hash is kept. Present it as `token` (tools) or x-agent-token (HTTP) when the bus runs with requireTokens.' };
  }

  async rotateAgentToken(...args) { return this._serialized(() => this._rotateAgentToken(...args)); }
  async _rotateAgentToken({ name, token = null }) {
    await this.init();
    const a = this._requireAgent(name, token);
    const rawToken = crypto.randomBytes(24).toString('hex');
    a.tokenHash = sha256(rawToken);
    this._event('agent.token_rotate', name, `${name} rotated its agent token`);
    await this._save();
    return { agent: this._publicAgent(a), token: rawToken, tokenNote: 'New token — the old one no longer works. Shown once.' };
  }

  /**
   * Operator recovery (v0.6.0): issue a fresh token for an agent WITHOUT presenting the old
   * one — for an agent that lost its token on an enforcing bus. Deliberately not an MCP tool
   * and not on the agent-facing REST surface: reachable only by the CLI (store-file access)
   * and the hosted admin API (admin key). The old token dies immediately; the event is logged.
   */
  async operatorResetAgentToken(...args) { return this._serialized(() => this._operatorResetAgentToken(...args)); }
  async _operatorResetAgentToken({ name }) {
    await this.init();
    const a = this._agent(String(name || ''));
    if (!a) throw Object.assign(new Error(`agent not registered: ${name}`), { code: 'UNKNOWN_AGENT' });
    const rawToken = crypto.randomBytes(24).toString('hex');
    a.tokenHash = sha256(rawToken);
    this._touch('agents'); // no _requireAgent on this path — name the section explicitly
    this._event('agent.token_reset', 'operator', `operator reset the agent token for ${a.name}`);
    await this._save();
    return { agent: this._publicAgent(a), token: rawToken, tokenNote: 'New token — the old one no longer works. Shown once.' };
  }

  async heartbeat(...args) { return this._serialized(() => this._heartbeat(...args)); }
  async _heartbeat({ name, token = null }) {
    await this.init();
    const a = this._requireAgent(name, token);
    return { agent: this._publicAgent(a), agents: await this.listAgents() };
  }

  async listAgents(...args) { return this._serialized(() => this._listAgents(...args)); }
  async _listAgents() { await this.init(); return this.state.agents.map(a => this._publicAgent(a)); }

  // ---------- messages ----------
  async sendMessage(...args) { return this._serialized(() => this._sendMessage(...args)); }
  async _sendMessage({ from, to = '*', body, channel = 'general', threadId = null, token = null }) {
    await this.init();
    this._requireAgent(from, token);
    if (to !== '*') this._existsAgent(to);
    if (!body || !String(body).trim()) throw new Error('message body required');
    this.state.msgSeq += 1;
    // threadId names a message id; anything that isn't a positive finite
    // number (an object used to land here as NaN, invisible to thread()
    // until a reload quietly rewrote it to null) is simply "no thread".
    const tid = Number(threadId);
    const msg = {
      id: this.state.msgSeq, from, to, channel: String(channel).slice(0, 64),
      body: String(body), threadId: Number.isFinite(tid) && tid >= 1 ? Math.floor(tid) : null,
      createdAt: now(), readBy: [from],
    };
    this.state.messages.push(msg);
    this._touch('messages');
    if (this.state.messages.length > 10000) this.state.messages.splice(0, this.state.messages.length - 10000);
    this._event('message.send', from, `${from} -> ${to} (#${msg.id})`, { to, channel: msg.channel, messageId: msg.id, excerpt: msg.body.slice(0, 280) });
    await this._save();
    return clone(msg);
  }

  /** Messages visible to `agent`: addressed to it, broadcast, or sent by it. Unread-first filtering optional. */
  async inbox(...args) { return this._serialized(() => this._inbox(...args)); }
  async _inbox(agentName, { unreadOnly = false, limit = 50, markRead = true, token = null } = {}) {
    await this.init();
    this._requireAgent(agentName, token);
    let msgs = this.state.messages.filter(m =>
      m.to === agentName || m.to === '*' || m.from === agentName);
    if (unreadOnly) msgs = msgs.filter(m => !m.readBy.includes(agentName));
    msgs = tailSlice(msgs, clampLimit(limit, 50, 500));
    if (markRead) {
      let changed = false;
      for (const m of msgs) if (!m.readBy.includes(agentName)) { m.readBy.push(agentName); changed = true; }
      if (changed) { this._touch('messages'); await this._save(); }
    }
    return clone(msgs);
  }

  async thread(...args) { return this._serialized(() => this._thread(...args)); }
  async _thread(id, { agent = null, token = null } = {}) {
    await this.init();
    const viewer = this._viewerOf(agent, token);
    const root = this.state.messages.find(m => m.id === Number(id));
    if (!root || !this._canSee(root, viewer)) throw fail(`message not found: ${id}`, 'NOT_FOUND');
    return clone(this.state.messages.filter(m => (m.id === root.id || m.threadId === root.id) && this._canSee(m, viewer)));
  }

  // ---------- tasks ----------
  async createTask(...args) { return this._serialized(() => this._createTask(...args)); }
  async _createTask({ from, title, body = '', assignee = null, priority = 'normal', needsApproval = false, blockedBy = [], token = null }) {
    await this.init();
    this._requireAgent(from, token);
    if (assignee) this._existsAgent(assignee);
    if (!title || !String(title).trim()) throw new Error('task title required');
    // Reject unknown priorities instead of silently downgrading them (e.g. "high" used to become "normal").
    const prio = priority == null ? 'normal' : String(priority).toLowerCase();
    if (prio !== 'normal' && prio !== 'urgent') throw new Error(`priority must be "normal" or "urgent" (got ${JSON.stringify(String(priority).slice(0, 40))})`);
    const deps = Array.isArray(blockedBy) ? blockedBy.map(Number).filter(n => n >= 1) : [];
    for (const b of deps) if (!this.state.tasks.some(t => t.id === b)) throw new Error(`blocker task not found: ${b}`);
    this._makeRoomForTask(deps);
    this.state.taskSeq += 1;
    const task = {
      id: this.state.taskSeq, title: String(title).slice(0, 300), body: String(body),
      from, assignee: assignee || null, priority: prio,
      status: needsApproval ? 'needs-approval' : 'queued',
      needsApproval: !!needsApproval, approvedBy: null,
      claimedBy: null, claimExpiresAt: null, result: null, comments: [], blockedBy: deps,
      createdAt: now(), updatedAt: now(),
      history: [{ at: now(), by: from, action: needsApproval ? 'created (awaiting approval)' : 'created' }],
    };
    this.state.tasks.push(task);
    this._touch('tasks');
    this._event('task.create', from, `task #${task.id}: ${task.title}`);
    await this._save();
    return clone(task);
  }

  // Task quota (v0.6.0): at the cap, the oldest finished (done/cancelled) tasks that no live
  // task still names in blockedBy are pruned (5% headroom, one provenance event); if every
  // task is live the create is refused with QUOTA instead of growing without bound.
  _makeRoomForTask(protect = []) {
    const max = this.limits.maxTasks; const tasks = this.state.tasks;
    if (tasks.length < max) return;
    const terminal = (t) => t.status === 'done' || t.status === 'cancelled';
    const keep = new Set(protect);
    for (const t of tasks) if (!terminal(t)) for (const b of t.blockedBy || []) keep.add(b);
    const evictable = tasks.filter(t => terminal(t) && !keep.has(t.id));
    const need = tasks.length - max + 1 + Math.floor(max * 0.05);
    const drop = new Set(evictable.slice(0, need).map(t => t.id));
    if (tasks.length - drop.size >= max) throw fail(`task quota reached (max ${max} per workspace, all still active)`, 'QUOTA');
    this.state.tasks = tasks.filter(t => !drop.has(t.id));
    this._event('task.prune', 'system', `pruned ${drop.size} finished task(s) at the ${max}-task quota`, { pruned: drop.size });
  }

  _expireClaims() {
    const t = Date.now();
    let changed = false;
    for (const task of this.state.tasks) {
      if (task.status === 'claimed' && task.claimExpiresAt && Date.parse(task.claimExpiresAt) < t) {
        changed = true;
        task.status = 'queued'; task.claimedBy = null; task.claimExpiresAt = null; task.updatedAt = now();
        task.history.push({ at: now(), by: 'system', action: 'claim lease expired — returned to queue' });
        this._touch('tasks');
        this._event('task.claim_expired', 'system', `task #${task.id} claim expired`);
      }
    }
    return changed;
  }

  async listTasks(...args) { return this._serialized(() => this._listTasks(...args)); }
  async _listTasks({ status = null, assignee = null } = {}) {
    await this.init();
    // Persist only when a lease actually expired — polling listTasks must not rewrite the whole store each call.
    if (this._expireClaims()) await this._save();
    let tasks = this.state.tasks;
    if (status) tasks = tasks.filter(t => t.status === status);
    if (assignee) tasks = tasks.filter(t => t.assignee === assignee || t.claimedBy === assignee);
    return clone(tasks.sort((a, b) => b.id - a.id));
  }

  async approveTask(...args) { return this._serialized(() => this._approveTask(...args)); }
  async _approveTask(id, { by, token = null }) {
    await this.init();
    this._requireAgent(by, token);
    const task = this._task(id);
    if (task.status !== 'needs-approval') throw fail(`task #${id} is not awaiting approval (status: ${task.status})`, 'CONFLICT');
    task.status = 'queued'; task.approvedBy = by; task.updatedAt = now();
    this._touch('tasks');
    task.history.push({ at: now(), by, action: 'approved' });
    this._event('task.approve', by, `task #${id} approved`);
    await this._save();
    return clone(task);
  }

  /** Claim is exclusive: a second claim while a lease is live fails loudly. */
  async claimTask(...args) { return this._serialized(() => this._claimTask(...args)); }
  async _claimTask(id, { by, token = null }) {
    await this.init();
    this._requireAgent(by, token);
    this._expireClaims();
    const task = this._task(id);
    if (task.status === 'claimed') throw Object.assign(new Error(`task #${id} already claimed by ${task.claimedBy}`), { code: 'ALREADY_CLAIMED' });
    if (task.status !== 'queued') throw fail(`task #${id} cannot be claimed (status: ${task.status})`, 'CONFLICT');
    if (task.assignee && task.assignee !== by) throw fail(`task #${id} is assigned to ${task.assignee}`, 'CONFLICT');
    const openBlockers = (task.blockedBy || []).filter(bid => { const b = this.state.tasks.find(t => t.id === bid); return b && !['done', 'cancelled'].includes(b.status); });
    if (openBlockers.length) throw Object.assign(new Error(`task #${id} is blocked by unfinished task(s): ${openBlockers.join(', ')}`), { code: 'BLOCKED' });
    task.status = 'claimed'; task.claimedBy = by;
    this._touch('tasks');
    task.claimExpiresAt = new Date(Date.now() + CLAIM_LEASE_MS).toISOString();
    task.updatedAt = now();
    task.history.push({ at: now(), by, action: 'claimed' });
    this._event('task.claim', by, `task #${id} claimed by ${by}`);
    await this._save();
    return clone(task);
  }

  async completeTask(...args) { return this._serialized(() => this._completeTask(...args)); }
  async _completeTask(id, { by, result = '', token = null }) {
    await this.init();
    this._requireAgent(by, token);
    const task = this._task(id);
    if (task.status !== 'claimed') throw fail(`task #${id} is not claimed (status: ${task.status})`, 'CONFLICT');
    if (task.claimedBy !== by) throw fail(`task #${id} is claimed by ${task.claimedBy}, not ${by}`, 'CONFLICT');
    task.status = 'done'; task.result = String(result); task.claimExpiresAt = null; task.updatedAt = now();
    this._touch('tasks');
    task.history.push({ at: now(), by, action: 'completed' });
    this._event('task.complete', by, `task #${id} completed`);
    await this._save();
    return clone(task);
  }

  async cancelTask(...args) { return this._serialized(() => this._cancelTask(...args)); }
  async _cancelTask(id, { by, token = null }) {
    await this.init();
    this._requireAgent(by, token);
    const task = this._task(id);
    if (['done', 'cancelled'].includes(task.status)) throw fail(`task #${id} already ${task.status}`, 'CONFLICT');
    task.status = 'cancelled'; task.updatedAt = now();
    this._touch('tasks');
    task.history.push({ at: now(), by, action: 'cancelled' });
    this._event('task.cancel', by, `task #${id} cancelled`);
    await this._save();
    return clone(task);
  }

  _task(id) {
    const task = this.state.tasks.find(t => t.id === Number(id));
    if (!task) throw fail(`task not found: ${id}`, 'NOT_FOUND');
    return task;
  }

  // ---------- shared workspace: files + context + board ----------
  async putFile(...args) { return this._serialized(() => this._putFile(...args)); }
  async _putFile({ by, path: p, text, token = null }) {
    await this.init();
    this._requireAgent(by, token);
    if (typeof p !== 'string' || !p || typeof text !== 'string') throw new Error('path and text required');
    if (p.length > 256) throw new Error('path too long (max 256 chars)');
    if (String(p).includes('..')) throw new Error('path may not contain ..');
    if (RESERVED_FILE_NAMES.has(p)) throw new Error('path is a reserved name');
    if (Buffer.byteLength(text) > this.limits.maxFileBytes) throw fail(`file too large (max ${this.limits.maxFileBytes} bytes)`, 'TOO_LARGE');
    if (!Object.prototype.hasOwnProperty.call(this.state.files, p) && Object.keys(this.state.files).length >= this.limits.maxFiles) throw fail(`file quota reached (max ${this.limits.maxFiles} files per workspace)`, 'QUOTA');
    const prev = this.state.files[p];
    const history = prev ? [...(prev.history || []), { text: prev.text, updatedBy: prev.updatedBy, updatedAt: prev.updatedAt }].slice(-10) : [];
    this.state.files[p] = { text, updatedBy: by, updatedAt: now(), history };
    this._touch('files');
    this._event('file.put', by, `${by} wrote ${p} (${text.length} chars)`);
    await this._save();
    return { path: p, bytes: Buffer.byteLength(text) };
  }

  async getFile(...args) { return this._serialized(() => this._getFile(...args)); }
  async _getFile(p, { withHistory = false } = {}) {
    await this.init();
    const f = Object.prototype.hasOwnProperty.call(this.state.files, p) ? this.state.files[p] : undefined;
    if (!f) throw fail(`file not found: ${p}`, 'NOT_FOUND');
    const { history, ...rest } = f;
    return { path: p, ...clone(rest), versions: (history || []).length + 1, ...(withHistory ? { history: clone(history || []) } : {}) };
  }

  async fileHistory(...args) { return this._serialized(() => this._fileHistory(...args)); }
  async _fileHistory(p) {
    await this.init();
    const f = Object.prototype.hasOwnProperty.call(this.state.files, p) ? this.state.files[p] : undefined;
    if (!f) throw fail(`file not found: ${p}`, 'NOT_FOUND');
    return { path: p, current: { text: f.text, updatedBy: f.updatedBy, updatedAt: f.updatedAt }, history: clone(f.history || []) };
  }

  async listFiles(...args) { return this._serialized(() => this._listFiles(...args)); }
  async _listFiles() {
    await this.init();
    return Object.entries(this.state.files).map(([p, f]) => ({ path: p, bytes: Buffer.byteLength(f.text), updatedBy: f.updatedBy, updatedAt: f.updatedAt }));
  }

  async putContext(...args) { return this._serialized(() => this._putContext(...args)); }
  async _putContext({ by, context, token = null }) {
    await this.init();
    this._requireAgent(by, token);
    if (!context || typeof context !== 'object' || Array.isArray(context)) throw new Error('context must be an object');
    if (Buffer.byteLength(JSON.stringify(context)) > this.limits.maxContextBytes) throw fail(`context too large (max ${this.limits.maxContextBytes} bytes)`, 'TOO_LARGE');
    this.state.context = clone(context);
    this._touch('context');
    this._event('context.put', by, `${by} published context`);
    await this._save();
    return { ok: true };
  }

  async getContext(...args) { return this._serialized(() => this._getContext(...args)); }
  async _getContext() {
    await this.init();
    if (!this.state.context) throw fail('no context published yet', 'NOT_FOUND');
    return clone(this.state.context);
  }

  async addTaskComment(...args) { return this._serialized(() => this._addTaskComment(...args)); }
  async _addTaskComment(id, { by, body, token = null }) {
    await this.init();
    this._requireAgent(by, token);
    if (!body || !String(body).trim()) throw new Error('comment body required');
    const task = this._task(id);
    task.comments = task.comments || [];
    if (task.comments.length >= this.limits.maxCommentsPerTask) throw fail(`comment quota reached for task #${task.id} (max ${this.limits.maxCommentsPerTask})`, 'QUOTA');
    const comment = { by, body: String(body), at: now() };
    task.comments.push(comment);
    this._touch('tasks');
    task.updatedAt = now();
    task.history.push({ at: now(), by, action: 'commented' });
    this._event('task.comment', by, `${by} commented on task #${id}`, { taskId: task.id });
    await this._save();
    return clone(task);
  }

  async deleteFile(...args) { return this._serialized(() => this._deleteFile(...args)); }
  async _deleteFile({ by, path: p, token = null }) {
    await this.init();
    this._requireAgent(by, token);
    if (!Object.prototype.hasOwnProperty.call(this.state.files, p)) throw fail(`file not found: ${p}`, 'NOT_FOUND');
    delete this.state.files[p];
    this._touch('files');
    this._event('file.delete', by, `${by} deleted ${p}`);
    await this._save();
    return { path: p, deleted: true };
  }

  async listChannels(...args) { return this._serialized(() => this._listChannels(...args)); }
  async _listChannels() {
    await this.init();
    // Channel names are attacker-chosen strings; a null-prototype map counts
    // '__proto__' like any other channel instead of dropping it (v0.5.4).
    const counts = Object.create(null);
    for (const m of this.state.messages) counts[m.channel] = (counts[m.channel] || 0) + 1;
    return Object.entries(counts).map(([channel, messages]) => ({ channel, messages })).sort((a, b) => b.messages - a.messages);
  }

  /** Full-text search across messages, tasks, and shared files. */
  async search(...args) { return this._serialized(() => this._search(...args)); }
  async _search(query, { limit = 20, agent = null, token = null } = {}) {
    await this.init();
    const viewer = this._viewerOf(agent, token);
    const q = String(query || '').toLowerCase().trim();
    if (q.length < 2) throw new Error('search query needs at least 2 characters');
    const hit = (text) => String(text || '').toLowerCase().includes(q);
    const lim = clampLimit(limit, 20, 500);
    return {
      query,
      messages: clone(tailSlice(this.state.messages.filter(m => this._canSee(m, viewer) && hit(m.body)), lim)),
      tasks: clone(tailSlice(this.state.tasks.filter(t => hit(t.title) || hit(t.body) || hit(t.result)), lim)),
      files: Object.entries(this.state.files).filter(([p, f]) => hit(p) || hit(f.text)).slice(0, lim)
        .map(([p, f]) => ({ path: p, updatedBy: f.updatedBy, updatedAt: f.updatedAt, excerpt: f.text.slice(0, 200) })),
    };
  }


  _capsulePath(slug) {
    if (!/^[a-z0-9][a-z0-9-]{0,63}$/.test(String(slug))) throw new Error('capsule slug: lowercase letters, digits, - only');
    return `capsules/${slug}.md`;
  }

  _capsuleTemplate(slug, title) {
    return `# Capsule: ${title || slug}\n\n## State\n\n## Decisions (locked)\n\n## Next\n\n## Session log\n`;
  }

  /** Read a project capsule, creating it from the template on first touch when create=true. */
  async getCapsule(...args) { return this._serialized(() => this._getCapsule(...args)); }
  async _getCapsule(slug, { create = false, title = '', by = null, token = null } = {}) {
    await this.init();
    const pth = this._capsulePath(slug);
    if (!this.state.files[pth]) {
      if (!create) throw fail(`capsule not found: ${slug}`, 'NOT_FOUND');
      if (by) this._requireAgent(by, token);
      this.state.files[pth] = { text: this._capsuleTemplate(slug, title), updatedBy: by || 'system', updatedAt: now(), history: [] };
      this._touch('files');
      this._event('capsule.create', by || 'system', `capsule ${slug} created`);
      await this._save();
    }
    return this.getFile(pth);
  }

  /** Replace one capsule section (State / Decisions / Next) or append to the Session log. */
  async updateCapsule(...args) { return this._serialized(() => this._updateCapsule(...args)); }
  async _updateCapsule(slug, { by, section, text, token = null }) {
    await this.init();
    this._requireAgent(by, token);
    await this.getCapsule(slug, { create: true, by, token });
    const pth = this._capsulePath(slug);
    const cur = this.state.files[pth].text;
    const SECTIONS = ['State', 'Decisions (locked)', 'Next', 'Session log'];
    if (!SECTIONS.includes(section)) throw new Error(`section must be one of: ${SECTIONS.join(' | ')}`);
    const marker = `## ${section}`;
    const start = cur.indexOf(marker);
    if (start < 0) throw new Error(`capsule ${slug} is missing section ${section}`);
    const afterHead = start + marker.length;
    const rest = cur.slice(afterHead);
    const nextIdx = rest.indexOf('\n## ');
    const tail = nextIdx >= 0 ? rest.slice(nextIdx) : '';
    const entry = section === 'Session log'
      ? `${rest.trimEnd() ? rest.replace(/\s+$/, '') + '\n' : '\n'}- ${now()} · ${by} — ${String(text).trim()}\n`
      : `\n\n${String(text).trim()}\n`;
    const updated = cur.slice(0, afterHead) + entry + tail.replace(/^\n+/, tail ? '\n' : '');
    const prev = this.state.files[pth];
    this.state.files[pth] = { text: updated.endsWith('\n') ? updated : updated + '\n', updatedBy: by, updatedAt: now(), history: [...(prev.history || []), { text: prev.text, updatedBy: prev.updatedBy, updatedAt: prev.updatedAt }].slice(-10) };
    this._touch('files');
    this._event('capsule.update', by, `${by} updated capsule ${slug} [${section}]`, { capsule: slug });
    await this._save();
    return this.getFile(pth);
  }

  async listCapsules(...args) { return this._serialized(() => this._listCapsules(...args)); }
  async _listCapsules() {
    await this.init();
    return Object.keys(this.state.files).filter(p => p.startsWith('capsules/') && p.endsWith('.md')).map(p => p.slice('capsules/'.length, -3)).sort();
  }

  /** A human-readable board rendered from live state — the shared picture at a glance. */
  async board(...args) { return this._serialized(() => this._board(...args)); }
  async _board() {
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

  /** Catch-up sync: every event after `sinceSeq`, plus the current head seq.
   *  An agent that was offline replays exactly what it missed — nothing more. */
  async sync(...args) { return this._serialized(() => this._sync(...args)); }
  async _sync({ sinceSeq = 0, limit = 500, agent = null, token = null } = {}) {
    await this.init();
    const viewer = this._viewerOf(agent, token);
    // A garbage cursor (NaN from a non-numeric query param) used to match
    // NOTHING and report truncated:false — an offline agent would believe
    // itself caught up while missing everything (v0.5.5). It now means
    // what a missing cursor means: replay from the start, limit-bounded.
    const since = Number.isFinite(Number(sinceSeq)) ? Math.max(0, Math.floor(Number(sinceSeq))) : 0;
    const lim = clampLimit(limit, 500, 1000);
    const evs = this.state.events.filter(e => e.seq > since);
    return { events: clone(evs.slice(0, lim)).map(e => this._redactEvent(e, viewer)), headSeq: this.state.seq, truncated: evs.length > lim };
  }

  async events(...args) { return this._serialized(() => this._events(...args)); }
  async _events({ limit = 50, agent = null, token = null } = {}) {
    await this.init();
    const viewer = this._viewerOf(agent, token);
    return clone(tailSlice(this.state.events, clampLimit(limit, 50, 500))).map(e => this._redactEvent(e, viewer));
  }

  async status(...args) { return this._serialized(() => this._status(...args)); }
  async _status() {
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

  /** Full-state snapshot for backup / migration. The state holds agent token
   *  HASHES only, never plaintext secrets; workspace keys live outside the
   *  state (hosted registry) and are never part of a snapshot. */
  async snapshot(...args) { return this._serialized(() => this._snapshot(...args)); }
  async _snapshot() {
    await this.init();
    return clone(this.state);
  }

  /** Replace this workspace's state with a snapshot (restore / import).
   *  The snapshot is shape-validated, the workspace identity is preserved
   *  unless the snapshot carries one, and the restore itself is recorded
   *  in the provenance log. Returns the post-restore status. */
  async restore(...args) { return this._serialized(() => this._restore(...args)); }
  async _restore(snapshot, { by = 'operator' } = {}) {
    await this.init();
    const bad = validateSnapshot(snapshot);
    if (bad) throw Object.assign(new Error(`invalid snapshot: ${bad}`), { code: 'BAD_SNAPSHOT' });
    const next = clone(snapshot);
    next.workspace = { ...next.workspace, id: this.state.workspace.id, name: next.workspace.name || this.state.workspace.name };
    this.state = next;
    this._touch('agents', 'messages', 'tasks', 'files', 'context', 'events');
    this._dirtyFull = true; // a restore can change anything, including section shapes
    this._event('workspace.restore', by, `workspace restored from snapshot (${next.agents.length} agents, ${next.tasks.length} tasks, ${next.messages.length} messages)`);
    await this._save();
    return this.status();
  }
}

/** Shape-check a candidate workspace snapshot. Returns null when valid,
 *  otherwise a short description of the first problem found.
 *
 *  v0.5.4 deepened this from "the collections exist" to "the collections are
 *  usable": a snapshot is untrusted input (hosted import, CLI import,
 *  restore), and the shallow check waved through states that then crashed
 *  the bus on first use — agents:[null] (agent lookups destructure entries),
 *  a file whose text is not a string (search/sizing throw), a negative seq
 *  counter, a '__proto__' file name (see RESERVED_FILE_NAMES). Entries must
 *  be objects, agents need string names (they are lookup keys), files need
 *  string text, counters must be finite and non-negative, and counts get
 *  sanity caps set far above anything the bus itself can produce (stored
 *  messages trim at 10k, events at 5k), so every export made by v0.5.0–0.5.3
 *  still validates. Unknown EXTRA top-level keys stay allowed on purpose:
 *  rejecting them would break forward compatibility with newer exports for
 *  no safety gain — the known keys are all typed here. */
const SNAPSHOT_CAPS = { agents: 10_000, messages: 100_000, tasks: 100_000, events: 100_000, files: 10_000 };
const isStateObject = (v) => !!v && typeof v === 'object' && !Array.isArray(v);
export function validateSnapshot(s) {
  if (!isStateObject(s)) return 'not an object';
  if (!isStateObject(s.workspace)) return 'missing workspace';
  if (s.workspace.id !== undefined && typeof s.workspace.id !== 'string') return 'workspace.id must be a string';
  if (s.workspace.name !== undefined && typeof s.workspace.name !== 'string') return 'workspace.name must be a string';
  for (const k of ['seq', 'msgSeq', 'taskSeq']) {
    if (typeof s[k] !== 'number' || !Number.isFinite(s[k]) || s[k] < 0) return `missing numeric ${k}`;
  }
  for (const k of ['agents', 'messages', 'tasks', 'events']) {
    if (!Array.isArray(s[k])) return `missing array ${k}`;
    if (s[k].length > SNAPSHOT_CAPS[k]) return `${k} exceeds sanity cap ${SNAPSHOT_CAPS[k]}`;
    for (const el of s[k]) if (!isStateObject(el)) return `${k} entries must be objects`;
  }
  for (const a of s.agents) if (typeof a.name !== 'string' || !a.name) return 'agent entries need a string name';
  if (!isStateObject(s.files)) return 'missing files object';
  const fileNames = Object.keys(s.files);
  if (fileNames.length > SNAPSHOT_CAPS.files) return `files exceeds sanity cap ${SNAPSHOT_CAPS.files}`;
  for (const name of fileNames) {
    if (RESERVED_FILE_NAMES.has(name)) return `files may not use reserved name: ${name}`;
    const f = s.files[name];
    if (!isStateObject(f) || typeof f.text !== 'string') return `file ${name} must be an object with string text`;
  }
  if (s.context !== undefined && s.context !== null && !isStateObject(s.context)) return 'context must be an object or null';
  return null;
}

export async function createBus(store, workspace, opts = {}) {
  const bus = new GhostBus(store, workspace, opts);
  await bus.init();
  return bus;
}
