#!/usr/bin/env node
/**
 * Two-agent demo — planner and builder meet on one bus, no human in the middle
 * except the approval gate. Run: node examples/two-agent-demo.mjs
 * Uses an in-memory workspace and prints the shared board at the end.
 */
import { createBus, MemoryStore } from '../src/core.mjs';

const bus = await createBus(new MemoryStore(), { name: 'Demo Workspace' });

await bus.registerAgent({ name: 'planner', role: 'planning + review', capabilities: ['research', 'specs'] });
await bus.registerAgent({ name: 'builder', role: 'implementation', capabilities: ['node', 'tests'] });

await bus.putContext({ by: 'planner', context: { project: 'widget-api', stack: 'node', phase: 'build' } });
await bus.putFile({ by: 'planner', path: 'capsules/widget-api.md', text: '# Widget API\nGET /widgets, POST /widgets. JSON in/out.' });

const task = await bus.createTask({ from: 'planner', title: 'Implement Widget API', body: 'Spec: capsules/widget-api.md', assignee: 'builder', priority: 'urgent' });
await bus.sendMessage({ from: 'planner', to: 'builder', body: `Task #${task.id} is yours — spec is in the workspace.` });

const inbox = await bus.inbox('builder');
console.log('builder inbox:', inbox.map(m => `#${m.id} from ${m.from}: ${m.body}`).join(' | '));

await bus.claimTask(task.id, { by: 'builder' });
try { await bus.claimTask(task.id, { by: 'planner' }); } catch (e) { console.log('double-claim correctly refused:', e.message); }

await bus.completeTask(task.id, { by: 'builder', result: 'Widget API implemented; endpoints verified.' });
await bus.sendMessage({ from: 'builder', to: 'planner', body: 'Done — result is on the task.', threadId: inbox[0].id });

const deploy = await bus.createTask({ from: 'builder', title: 'Deploy widget-api to production', needsApproval: true });
console.log(`deploy task #${deploy.id} is gated: status=${deploy.status}`);
await bus.approveTask(deploy.id, { by: 'planner' });
console.log(`after planner approval: status=${(await bus.listTasks()).find(t => t.id === deploy.id).status}`);

console.log('\n' + await bus.board());
