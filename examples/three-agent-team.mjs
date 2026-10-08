#!/usr/bin/env node
/**
 * Three-agent software team demo — planner, builder, reviewer cooperate on one
 * bus with NO human relaying messages: a spec is published, work is claimed,
 * reviewed with comments, fixed, approved, and a gated deploy is released.
 * Run: node examples/three-agent-team.mjs
 */
import { createBus, MemoryStore } from '../src/core.mjs';

const bus = await createBus(new MemoryStore(), { name: 'Team Demo' });
for (const [name, role, caps] of [
  ['planner', 'planning + product', ['specs', 'prioritization']],
  ['builder', 'implementation', ['node', 'api']],
  ['reviewer', 'code review + QA', ['review', 'tests']],
]) await bus.registerAgent({ name, role, capabilities: caps });

console.log('team on the bus:', (await bus.listAgents()).map(a => a.name).join(', '));

// Planner sets the shared picture
await bus.putContext({ by: 'planner', context: { project: 'widget-api', release: '0.1', freeze: 'Friday' } });
await bus.putFile({ by: 'planner', path: 'capsules/widget-api.md', text: '# Widget API\nGET /widgets returns [] initially.\nPOST /widgets {name} -> 201.' });

const build = await bus.createTask({ from: 'planner', title: 'Implement Widget API', body: 'Spec: capsules/widget-api.md', assignee: 'builder', priority: 'urgent' });
await bus.sendMessage({ from: 'planner', to: 'builder', body: `Task #${build.id} ready — spec in workspace.`, channel: 'dev' });

// Builder works it
await bus.claimTask(build.id, { by: 'builder' });
await bus.completeTask(build.id, { by: 'builder', result: 'Endpoints implemented; manual smoke passed.' });

// Reviewer reviews via comments + a follow-up task
const review = await bus.createTask({ from: 'reviewer', title: 'Review Widget API', body: 'Check status codes + empty-name handling.', assignee: 'reviewer' });
await bus.claimTask(review.id, { by: 'reviewer' });
await bus.addTaskComment(review.id, { by: 'reviewer', body: 'Found: POST with empty name returns 201, should be 400.' });
const fix = await bus.createTask({ from: 'reviewer', title: 'Fix: empty widget name must 400', assignee: 'builder' });
await bus.claimTask(fix.id, { by: 'builder' });
await bus.completeTask(fix.id, { by: 'builder', result: 'Validation added; empty name now 400.' });
await bus.completeTask(review.id, { by: 'reviewer', result: 'Re-checked after fix — clean.' });

// Gated deploy: builder proposes, planner approves
const deploy = await bus.createTask({ from: 'builder', title: 'Deploy widget-api 0.1', needsApproval: true });
console.log(`deploy gated: #${deploy.id} status=${deploy.status}`);
await bus.approveTask(deploy.id, { by: 'planner' });
await bus.claimTask(deploy.id, { by: 'builder' });
await bus.completeTask(deploy.id, { by: 'builder', result: 'Deployed.' });
await bus.sendMessage({ from: 'builder', to: '*', body: 'widget-api 0.1 is live. 🎉', channel: 'announce' });

const found = await bus.search('empty name');
console.log(`search "empty name" -> ${found.tasks.length} task(s), ${found.messages.length} message(s)`);
console.log('channels:', (await bus.listChannels()).map(c => `${c.channel}(${c.messages})`).join(' '));
console.log('\n' + await bus.board());
