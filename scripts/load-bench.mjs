#!/usr/bin/env node
/**
 * GhostBus load bench (v0.5.6) — the "prove it under load" evidence tool.
 *
 * Boots a throwaway HOSTED server on a temp data dir, creates one workspace,
 * and runs N concurrent agents through a mixed workload (register, heartbeat,
 * send, inbox poll, task create/claim/complete, file put) for a fixed window.
 * Per-agent tokens are ENFORCED (the hosted default) and every call presents
 * its token, so the numbers describe the posture a paying deployment runs.
 *
 * One deliberate disclosure: the in-workspace rate limiter is raised via
 * GHOSTBUS_RATE_LIMIT_PER_MIN for the run. At the shipped default
 * (300/min/IP) the limiter — not the bus — is the first ceiling for any
 * single-IP client, which is a policy fact, not a capacity fact. The bench
 * measures the bus; the limiter's default behavior is pinned by the suite.
 *
 * Reconciliation is exact, not sampled: every op that returned 200 is
 * counted client-side, and at the end the server's own status/file listing
 * must match those counts precisely (messages sent == messages stored,
 * tasks created == tasks stored, tasks done == tasks completed, files put
 * == files listed). Anything else is a lost or duplicated write under
 * concurrency and fails the run.
 *
 *   node scripts/load-bench.mjs [--agents 25] [--seconds 30] [--port 18561]
 *
 * Exits 0 only when there were no request errors and counts reconcile.
 */
import http from 'node:http';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ADMIN_KEY = 'bench-admin-key-not-a-real-secret'; // bench-only placeholder: set as GHOSTBUS_ADMIN_KEY for the throwaway server this script spawns, never a live key

const pct = (arr, p) => {
  if (!arr.length) return 0;
  const s = [...arr].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))];
};
const rssMB = (pid) => {
  try {
    const m = fs.readFileSync(`/proc/${pid}/status`, 'utf8').match(/VmRSS:\s+(\d+) kB/);
    return m ? Math.round(Number(m[1]) / 102.4) / 10 : null;
  } catch { return null; }
};

export async function runBench({ agents: agentCount = 25, seconds = 30, port = 18561, quiet = false } = {}) {
  const log = (...a) => { if (!quiet) console.log(...a); };
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ghostbus-bench-'));
  const env = {
    ...process.env,
    GHOSTBUS_ADMIN_KEY: ADMIN_KEY,
    GHOSTBUS_RATE_LIMIT_PER_MIN: '1000000', // see header: measures the bus, not the limiter
  };
  const proc = spawn('node', ['src/hosted-server.mjs', '--port', String(port), '--data-dir', dataDir], { cwd: ROOT, env, stdio: ['ignore', 'pipe', 'pipe'] });
  let serverStderr = '';
  proc.stderr.on('data', (d) => { serverStderr += d; });
  const base = `http://127.0.0.1:${port}`;

  const stats = new Map(); // class -> {n, errors, lat[]}
  const note = (cls, ms, ok) => {
    let s = stats.get(cls);
    if (!s) { s = { n: 0, errors: 0, lat: [] }; stats.set(cls, s); }
    s.n += 1; if (!ok) s.errors += 1; s.lat.push(ms);
  };
  const counters = { messagesSent: 0, tasksCreated: 0, tasksCompleted: 0, filesPut: 0 };

  // Minimal keep-alive HTTP client, one agent (socket pool) per bench agent.
  const call = (agent, method, p, { key, token, body } = {}) => new Promise((resolve) => {
    const t0 = performance.now();
    const data = body === undefined ? null : JSON.stringify(body);
    const req = http.request(base + p, {
      method, agent,
      headers: {
        ...(data ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(data) } : {}),
        ...(key ? { 'x-bus-key': key } : {}),
        ...(token ? { 'x-agent-token': token } : {}),
      },
    }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const ms = performance.now() - t0;
        let json = null;
        try { json = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { /* non-JSON */ }
        resolve({ status: res.statusCode, json, ms });
      });
    });
    req.on('error', () => resolve({ status: 0, json: null, ms: performance.now() - t0 }));
    if (data) req.write(data);
    req.end();
  });

  try {
    // ---- boot + one workspace ----
    let up = false;
    for (let i = 0; i < 50 && !up; i++) {
      try { const r = await fetch(`${base}/health`); up = r.ok; } catch { /* not yet */ }
      if (!up) await new Promise(r => setTimeout(r, 100));
    }
    if (!up) throw new Error('hosted server did not come up: ' + serverStderr.slice(-400));
    const bootAgent = new http.Agent({ keepAlive: true });
    const wsRes = await call(bootAgent, 'POST', '/api/workspaces', { key: ADMIN_KEY, body: { id: 'bench', name: 'Load Bench' } });
    if (wsRes.status !== 201) throw new Error(`workspace create failed: ${wsRes.status} ${JSON.stringify(wsRes.json)}`);
    const wsKey = wsRes.json.key;
    const W = '/w/bench';
    const rssBefore = rssMB(proc.pid);
    const rssSamples = [];
    const rssTimer = setInterval(() => { const mb = rssMB(proc.pid); if (mb !== null) rssSamples.push(mb); }, 5000);
    rssTimer.unref?.();

    // ---- agents ----
    const deadline = Date.now() + seconds * 1000;
    const worker = async (i) => {
      const name = `bench-${String(i).padStart(2, '0')}`;
      const agent = new http.Agent({ keepAlive: true });
      const reg = await call(agent, 'POST', `${W}/api/agents`, { key: wsKey, body: { agent: name, role: 'load bench' } });
      note('register', reg.ms, reg.status === 200);
      if (reg.status !== 200) { agent.destroy(); return; }
      const token = reg.json.token;
      const peer = `bench-${String((i + 1) % agentCount).padStart(2, '0')}`;
      let n = 0;
      // Fixed rotation: send, inbox, send, heartbeat, task cycle, file put.
      // Sequential per agent (each op awaited) so per-class latency is honest
      // queueing+service time under the shared per-Bus mutex.
      while (Date.now() < deadline) {
        n += 1;
        const step = n % 6;
        if (step === 1 || step === 3) {
          const r = await call(agent, 'POST', `${W}/api/messages`, { key: wsKey, token, body: { agent: name, to: peer, body: `bench message ${name} #${n}` } });
          note('send', r.ms, r.status === 200);
          if (r.status === 200) counters.messagesSent += 1;
        } else if (step === 2) {
          const r = await call(agent, 'GET', `${W}/api/inbox?agent=${name}&limit=20`, { key: wsKey, token });
          note('inbox', r.ms, r.status === 200);
        } else if (step === 4) {
          const r = await call(agent, 'POST', `${W}/api/heartbeat`, { key: wsKey, token, body: { agent: name } });
          note('heartbeat', r.ms, r.status === 200);
        } else if (step === 5) {
          const c = await call(agent, 'POST', `${W}/api/tasks`, { key: wsKey, token, body: { agent: name, title: `bench task ${name} #${n}` } });
          note('taskCreate', c.ms, c.status === 200);
          if (c.status === 200) {
            counters.tasksCreated += 1;
            const tid = c.json.id;
            const cl = await call(agent, 'POST', `${W}/api/tasks/${tid}/claim`, { key: wsKey, token, body: { agent: name } });
            note('taskClaim', cl.ms, cl.status === 200);
            if (cl.status === 200) {
              const cp = await call(agent, 'POST', `${W}/api/tasks/${tid}/complete`, { key: wsKey, token, body: { agent: name, result: 'bench done' } });
              note('taskComplete', cp.ms, cp.status === 200);
              if (cp.status === 200) counters.tasksCompleted += 1;
            }
          }
        } else {
          const r = await call(agent, 'PUT', `${W}/api/files`, { key: wsKey, token, body: { agent: name, path: `bench/${name}/${n}.txt`, text: `bench file ${name} #${n}` } });
          note('filePut', r.ms, r.status === 200);
          if (r.status === 200) counters.filesPut += 1;
        }
      }
      agent.destroy();
    };
    const t0 = Date.now();
    await Promise.all(Array.from({ length: agentCount }, (_, i) => worker(i)));
    const elapsedS = (Date.now() - t0) / 1000;

    // ---- reconcile, exactly ----
    const status = (await call(bootAgent, 'GET', `${W}/api/status`, { key: wsKey })).json;
    const files = (await call(bootAgent, 'GET', `${W}/api/files/list`, { key: wsKey })).json;
    clearInterval(rssTimer);
    const rssAfter = rssMB(proc.pid);
    const stateBytes = fs.statSync(path.join(dataDir, 'bench.json')).size;
    const mismatches = [];
    if (!status) mismatches.push('status unreadable at end of run');
    else {
      if (status.messages !== counters.messagesSent) mismatches.push(`messages: sent ${counters.messagesSent} != stored ${status.messages}`);
      if (status.tasks.total !== counters.tasksCreated) mismatches.push(`tasks: created ${counters.tasksCreated} != stored ${status.tasks.total}`);
      if (status.tasks.done !== counters.tasksCompleted) mismatches.push(`tasks done: completed ${counters.tasksCompleted} != stored ${status.tasks.done}`);
      if (status.agents !== agentCount) mismatches.push(`agents: expected ${agentCount}, stored ${status.agents}`);
    }
    if (!files || files.files.length !== counters.filesPut) mismatches.push(`files: put ${counters.filesPut} != listed ${files ? files.files.length : 'unreadable'}`);

    let totalOps = 0, totalErrors = 0;
    const perClass = {};
    for (const [cls, s] of stats) {
      totalOps += s.n; totalErrors += s.errors;
      perClass[cls] = { n: s.n, errors: s.errors, p50: Math.round(pct(s.lat, 50) * 10) / 10, p95: Math.round(pct(s.lat, 95) * 10) / 10 };
    }
    bootAgent.destroy();
    return {
      agents: agentCount, seconds: elapsedS, totalOps, totalErrors, perClass, counters,
      reconciled: mismatches.length === 0, mismatches,
      rssBeforeMB: rssBefore, rssAfterMB: rssAfter, rssSamplesMB: rssSamples, stateBytes,
      serverStderrTail: serverStderr.slice(-300),
    };
  } finally {
    proc.kill('SIGKILL');
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const arg = (flag, def) => { const i = process.argv.indexOf(flag); return i >= 0 ? Number(process.argv[i + 1]) : def; };
  const r = await runBench({ agents: arg('--agents', 25), seconds: arg('--seconds', 30), port: arg('--port', 18561) });
  console.log(`\nghostbus load bench — ${r.agents} agents, ${r.seconds.toFixed(1)}s window, one hosted workspace, tokens enforced`);
  console.log('(in-workspace rate limiter raised via GHOSTBUS_RATE_LIMIT_PER_MIN for the run — see header)');
  console.log(`\n${'op class'.padEnd(14)} ${'count'.padStart(7)} ${'errors'.padStart(7)} ${'p50 ms'.padStart(9)} ${'p95 ms'.padStart(9)}`);
  for (const [cls, s] of Object.entries(r.perClass)) {
    console.log(`${cls.padEnd(14)} ${String(s.n).padStart(7)} ${String(s.errors).padStart(7)} ${String(s.p50).padStart(9)} ${String(s.p95).padStart(9)}`);
  }
  console.log(`\ntotal ops ${r.totalOps} (${(r.totalOps / r.seconds).toFixed(1)}/s), errors ${r.totalErrors}`);
  console.log(`server RSS ${r.rssBeforeMB} MB -> ${r.rssAfterMB} MB · final state file ${(r.stateBytes / 1024).toFixed(0)} KB`);
  if (r.rssSamplesMB.length) console.log(`server RSS every 5s: ${r.rssSamplesMB.join(' -> ')} MB`);
  console.log(r.reconciled
    ? `RECONCILED: messages ${r.counters.messagesSent}, tasks ${r.counters.tasksCreated}/${r.counters.tasksCompleted} done, files ${r.counters.filesPut} — server counts match client counts exactly`
    : `MISMATCH: ${r.mismatches.join('; ')}`);
  process.exit(r.totalErrors === 0 && r.reconciled ? 0 : 1);
}
