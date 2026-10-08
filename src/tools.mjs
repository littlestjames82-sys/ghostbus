/**
 * GhostBus MCP tool definitions — shared by the stdio server and the HTTP /mcp endpoint.
 * Every tool takes `agent` (the caller's registered name) where it acts on someone's behalf,
 * so the provenance log always names a real participant.
 */
export const TOOLS = [
  { name: 'bus_status', description: 'Workspace status: agents, message/task/file counts, version.', inputSchema: { type: 'object', properties: {} } },
  { name: 'bus_register', description: 'Register (or rejoin) this agent on the bus with a role and capabilities. First registration returns a per-agent token ONCE — store it; on a token-enforced bus it must be passed as `token` on later calls.', inputSchema: { type: 'object', required: ['agent'], properties: { agent: { type: 'string' }, role: { type: 'string' }, capabilities: { type: 'array', items: { type: 'string' } }, token: { type: 'string' } } } },
  { name: 'bus_rotate_token', description: 'Rotate this agent\'s token (requires the current token on an enforced bus). The old token stops working; the new one is shown once.', inputSchema: { type: 'object', required: ['agent'], properties: { agent: { type: 'string' }, token: { type: 'string' } } } },
  { name: 'bus_heartbeat', description: 'Heartbeat: mark this agent present and get the live agent list with online status.', inputSchema: { type: 'object', required: ['agent'], properties: { agent: { type: 'string' }, token: { type: 'string' } } } },
  { name: 'bus_search', description: 'Search messages, tasks, and shared files by text.', inputSchema: { type: 'object', required: ['query'], properties: { query: { type: 'string' }, limit: { type: 'number', default: 20 } } } },
  { name: 'bus_channels', description: 'List message channels with message counts.', inputSchema: { type: 'object', properties: {} } },
  { name: 'bus_agents', description: 'List registered agents with roles, capabilities, and last-seen times.', inputSchema: { type: 'object', properties: {} } },
  { name: 'bus_send', description: 'Send a message to one agent (to = its name) or broadcast (to = "*"). Set threadId to reply in a thread.', inputSchema: { type: 'object', required: ['agent', 'body'], properties: { agent: { type: 'string' }, to: { type: 'string', default: '*' }, body: { type: 'string' }, channel: { type: 'string', default: 'general' }, threadId: { type: 'number' } } } },
  { name: 'bus_inbox', description: 'Read messages visible to this agent (direct, broadcast, and its own). Marks them read unless markRead=false.', inputSchema: { type: 'object', required: ['agent'], properties: { agent: { type: 'string' }, unreadOnly: { type: 'boolean', default: false }, limit: { type: 'number', default: 50 }, markRead: { type: 'boolean', default: true } } } },
  { name: 'bus_thread', description: 'Read a message thread (root message + its replies).', inputSchema: { type: 'object', required: ['id'], properties: { id: { type: 'number' } } } },
  { name: 'bus_create_task', description: 'Create a handoff task. Optionally assign it, mark urgent, or gate it behind human/agent approval (needsApproval).', inputSchema: { type: 'object', required: ['agent', 'title'], properties: { agent: { type: 'string' }, title: { type: 'string' }, body: { type: 'string' }, assignee: { type: 'string' }, priority: { type: 'string', enum: ['normal', 'urgent'] }, needsApproval: { type: 'boolean', default: false } } } },
  { name: 'bus_list_tasks', description: 'List tasks, optionally filtered by status or assignee/claimer.', inputSchema: { type: 'object', properties: { status: { type: 'string' }, assignee: { type: 'string' } } } },
  { name: 'bus_approve_task', description: 'Approve a task that is waiting in needs-approval, releasing it to the queue.', inputSchema: { type: 'object', required: ['agent', 'id'], properties: { agent: { type: 'string' }, id: { type: 'number' } } } },
  { name: 'bus_claim_task', description: 'Claim a queued task exclusively (15-minute lease). Fails if another agent holds it.', inputSchema: { type: 'object', required: ['agent', 'id'], properties: { agent: { type: 'string' }, id: { type: 'number' } } } },
  { name: 'bus_complete_task', description: 'Complete a task you claimed, with a result summary for the sender.', inputSchema: { type: 'object', required: ['agent', 'id'], properties: { agent: { type: 'string' }, id: { type: 'number' }, result: { type: 'string' } } } },
  { name: 'bus_cancel_task', description: 'Cancel an open task.', inputSchema: { type: 'object', required: ['agent', 'id'], properties: { agent: { type: 'string' }, id: { type: 'number' } } } },
  { name: 'workspace_put_file', description: 'Write a shared workspace file (capsule, note, deliverable). Path may not contain "..".', inputSchema: { type: 'object', required: ['agent', 'path', 'text'], properties: { agent: { type: 'string' }, path: { type: 'string' }, text: { type: 'string' } } } },
  { name: 'workspace_get_file', description: 'Read a shared workspace file.', inputSchema: { type: 'object', required: ['path'], properties: { path: { type: 'string' } } } },
  { name: 'workspace_list_files', description: 'List shared workspace files with size and last writer.', inputSchema: { type: 'object', properties: {} } },
  { name: 'workspace_put_context', description: 'Publish the shared context object (project state every agent reads first).', inputSchema: { type: 'object', required: ['agent', 'context'], properties: { agent: { type: 'string' }, context: { type: 'object' } } } },
  { name: 'workspace_get_context', description: 'Read the shared context object.', inputSchema: { type: 'object', properties: {} } },
  { name: 'workspace_board', description: 'Render the shared board: agents, open tasks, files, recent activity.', inputSchema: { type: 'object', properties: {} } },
  { name: 'bus_comment_task', description: 'Comment on a task (discussion lives on the task, next to its history).', inputSchema: { type: 'object', required: ['agent', 'id', 'body'], properties: { agent: { type: 'string' }, id: { type: 'number' }, body: { type: 'string' }, token: { type: 'string' } } } },
  { name: 'workspace_delete_file', description: 'Delete a shared workspace file.', inputSchema: { type: 'object', required: ['agent', 'path'], properties: { agent: { type: 'string' }, path: { type: 'string' }, token: { type: 'string' } } } },
  { name: 'bus_events', description: 'Read the provenance event log (who did what, when).', inputSchema: { type: 'object', properties: { limit: { type: 'number', default: 50 } } } },
];

export async function callTool(bus, name, args = {}) {
  switch (name) {
    case 'bus_status': return bus.status();
    case 'bus_register': return bus.registerAgent({ name: args.agent, role: args.role, capabilities: args.capabilities, token: args.token ?? null });
    case 'bus_agents': return { agents: await bus.listAgents() };
    case 'bus_send': return bus.sendMessage({ from: args.agent, to: args.to ?? '*', body: args.body, channel: args.channel ?? 'general', threadId: args.threadId ?? null, token: args.token ?? null });
    case 'bus_inbox': return { messages: await bus.inbox(args.agent, { unreadOnly: !!args.unreadOnly, limit: args.limit ?? 50, markRead: args.markRead !== false, token: args.token ?? null }) };
    case 'bus_thread': return { messages: await bus.thread(args.id) };
    case 'bus_create_task': return bus.createTask({ from: args.agent, title: args.title, body: args.body ?? '', assignee: args.assignee ?? null, priority: args.priority ?? 'normal', needsApproval: !!args.needsApproval, token: args.token ?? null });
    case 'bus_list_tasks': return { tasks: await bus.listTasks({ status: args.status ?? null, assignee: args.assignee ?? null }) };
    case 'bus_approve_task': return bus.approveTask(args.id, { by: args.agent, token: args.token ?? null });
    case 'bus_claim_task': return bus.claimTask(args.id, { by: args.agent, token: args.token ?? null });
    case 'bus_complete_task': return bus.completeTask(args.id, { by: args.agent, result: args.result ?? '', token: args.token ?? null });
    case 'bus_cancel_task': return bus.cancelTask(args.id, { by: args.agent, token: args.token ?? null });
    case 'workspace_put_file': return bus.putFile({ by: args.agent, path: args.path, text: args.text, token: args.token ?? null });
    case 'workspace_get_file': return bus.getFile(args.path);
    case 'workspace_list_files': return { files: await bus.listFiles() };
    case 'workspace_put_context': return bus.putContext({ by: args.agent, context: args.context, token: args.token ?? null });
    case 'workspace_get_context': return bus.getContext();
    case 'workspace_board': return { board: await bus.board() };
    case 'bus_events': return { events: await bus.events({ limit: args.limit ?? 50 }) };
    case 'bus_rotate_token': return bus.rotateAgentToken({ name: args.agent, token: args.token ?? null });
    case 'bus_heartbeat': return bus.heartbeat({ name: args.agent, token: args.token ?? null });
    case 'bus_search': return bus.search(args.query, { limit: args.limit ?? 20 });
    case 'bus_channels': return { channels: await bus.listChannels() };
    case 'bus_comment_task': return bus.addTaskComment(args.id, { by: args.agent, body: args.body, token: args.token ?? null });
    case 'workspace_delete_file': return bus.deleteFile({ by: args.agent, path: args.path, token: args.token ?? null });
    default: throw Object.assign(new Error(`unknown tool: ${name}`), { code: 'UNKNOWN_TOOL' });
  }
}
