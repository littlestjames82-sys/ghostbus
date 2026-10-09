#!/usr/bin/env node
/**
 * GhostBus terminal CLI — drive a workspace from the shell (handy for humans,
 * scripts, and wake hooks). Works directly on a store file:
 *
 *   ghostbus-cli --store ./ghostbus-data.json status
 *   ghostbus-cli register alice --role planner
 *   ghostbus-cli send alice bob "ship it"        (to = * broadcasts)
 *   ghostbus-cli inbox bob
 *   ghostbus-cli task alice "Build the API" [--assign bob] [--urgent] [--approve-first]
 *   ghostbus-cli tasks [--status queued]
 *   ghostbus-cli claim 1 bob | complete 1 bob "done, tests green" | comment 1 alice "note"
 *   ghostbus-cli board | agents | search "API" | put-file alice path.md ./local.md | get-file path.md
 *   ghostbus-cli export ./backup.json            (full-state snapshot to a file, or stdout with -)
 *   ghostbus-cli import ./backup.json            (restore a snapshot INTO this store — replaces state)
 *
 * Env: GHOSTBUS_STORE, GHOSTBUS_TOKEN_<AGENT> for token-enforced buses.
 */
import fs from 'node:fs';
import { createBus, MemoryStore, FileStore, GHOSTBUS_VERSION } from './core.mjs';

const argv = process.argv.slice(2);
const storeIdx = argv.indexOf('--store');
const storePath = storeIdx >= 0 ? argv[storeIdx + 1] : (process.env.GHOSTBUS_STORE || './ghostbus-data.json');
const args = argv.filter((a, i) => i !== storeIdx && i !== storeIdx + 1);
const [cmd, ...rest] = args;
const flag = (name) => rest.includes(name);
const flagVal = (name) => { const i = rest.indexOf(name); return i >= 0 ? rest[i + 1] : null; };
const positional = rest.filter((a, i) => !a.startsWith('--') && rest[i - 1] !== '--assign' && rest[i - 1] !== '--status' && rest[i - 1] !== '--role');
const tokenFor = (agent) => process.env[`GHOSTBUS_TOKEN_${String(agent).toUpperCase().replace(/[^A-Z0-9]/g, '_')}`] || null;

const store = storePath === ':memory:' ? new MemoryStore() : new FileStore(storePath);
const bus = await createBus(store, {}, { requireTokens: process.env.GHOSTBUS_REQUIRE_TOKENS === '1' });
const out = (v) => console.log(typeof v === 'string' ? v : JSON.stringify(v, null, 2));

try {
  switch (cmd) {
    case 'status': out(await bus.status()); break;
    case 'agents': out(await bus.listAgents()); break;
    case 'register': {
      const r = await bus.registerAgent({ name: positional[0], role: flagVal('--role') || '', token: tokenFor(positional[0]) });
      out(r); if (r.token) console.error('⚠ agent token shown ONCE — store it (CLI: GHOSTBUS_TOKEN_' + positional[0].toUpperCase() + ')');
      break;
    }
    case 'send': out(await bus.sendMessage({ from: positional[0], to: positional[1], body: positional.slice(2).join(' '), token: tokenFor(positional[0]) })); break;
    case 'inbox': out(await bus.inbox(positional[0], { unreadOnly: flag('--unread'), token: tokenFor(positional[0]) })); break;
    case 'task': out(await bus.createTask({ from: positional[0], title: positional.slice(1).join(' '), assignee: flagVal('--assign'), priority: flag('--urgent') ? 'urgent' : 'normal', needsApproval: flag('--approve-first'), token: tokenFor(positional[0]) })); break;
    case 'tasks': out(await bus.listTasks({ status: flagVal('--status') })); break;
    case 'claim': out(await bus.claimTask(Number(positional[0]), { by: positional[1], token: tokenFor(positional[1]) })); break;
    case 'approve': out(await bus.approveTask(Number(positional[0]), { by: positional[1], token: tokenFor(positional[1]) })); break;
    case 'complete': out(await bus.completeTask(Number(positional[0]), { by: positional[1], result: positional.slice(2).join(' '), token: tokenFor(positional[1]) })); break;
    case 'comment': out(await bus.addTaskComment(Number(positional[0]), { by: positional[1], body: positional.slice(2).join(' '), token: tokenFor(positional[1]) })); break;
    case 'board': out(await bus.board()); break;
    case 'search': out(await bus.search(positional.join(' '))); break;
    case 'put-file': out(await bus.putFile({ by: positional[0], path: positional[1], text: fs.readFileSync(positional[2], 'utf8'), token: tokenFor(positional[0]) })); break;
    case 'get-file': { const f = await bus.getFile(positional[0]); out(f.text); break; }
    case 'events': out(await bus.events({ limit: Number(flagVal('--limit') || 20) })); break;
    case 'export': {
      const env = { ghostbusExport: 1, version: GHOSTBUS_VERSION, exportedAt: new Date().toISOString(), workspace: (await bus.status()).workspace, state: await bus.snapshot() };
      const text = JSON.stringify(env, null, 2);
      if (!positional[0] || positional[0] === '-') console.log(text);
      else { fs.writeFileSync(positional[0], text); console.error(`exported ${env.state.agents.length} agents, ${env.state.tasks.length} tasks, ${env.state.messages.length} messages -> ${positional[0]}`); }
      break;
    }
    case 'import': {
      if (!positional[0]) { console.error('usage: ghostbus-cli import <backup.json>'); process.exit(2); }
      const parsed = JSON.parse(fs.readFileSync(positional[0], 'utf8'));
      const state = parsed.ghostbusExport ? parsed.state : (parsed.state || parsed);
      const st = await bus.restore(state, { by: 'cli' });
      out({ imported: true, agents: st.agents, messages: st.messages, tasks: st.tasks.total });
      break;
    }
    default:
      console.error('usage: ghostbus-cli [--store file] <status|agents|register|send|inbox|task|tasks|claim|approve|complete|comment|board|search|put-file|get-file|events|export|import>');
      process.exit(2);
  }
} catch (e) { console.error(`Error: ${e.message}`); process.exit(1); }
