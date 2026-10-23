import path from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { NickMcpClient } from '../lib/mcpClient';
import { cancelPendingAction, confirmPendingAction } from '../src/agent/actions';
import { historyFromMessages, runAgent, toolResultForModel, unbackedClaims, type AgentDeps } from '../src/agent/agent';
import { AgentStore } from '../src/agent/store';
import { ModelError, type AgentEvent, type ChatMessage, type ModelAdapter, type ModelToolSpec, type ModelTurn } from '../src/agent/types';
import { startTestServer, tempDir, type RunningServer } from './helpers';

/** A deterministic stand-in for the LLM: returns scripted turns and records what it was sent. */
class ScriptedModel implements ModelAdapter {
  label = 'scripted test model';
  calls: { messages: ChatMessage[]; tools: ModelToolSpec[] }[] = [];
  constructor(private readonly script: (call: number, messages: ChatMessage[]) => ModelTurn | Error) {}
  async chat(messages: ChatMessage[], tools: ModelToolSpec[]): Promise<ModelTurn> {
    this.calls.push({ messages: structuredClone(messages), tools });
    const next = this.script(this.calls.length, messages);
    if (next instanceof Error) throw next;
    return next;
  }
}

const tool = (name: string, args: unknown): ModelTurn => ({ content: '', toolCalls: [{ name, arguments: args }], mode: 'native' });
const say = (content: string): ModelTurn => ({ content, toolCalls: [], mode: 'native' });

let tmp: ReturnType<typeof tempDir>;
let server: RunningServer;
let mcp: NickMcpClient;
let store: AgentStore;
let conversationId: string;

beforeAll(async () => {
  tmp = tempDir();
  server = await startTestServer(path.join(tmp.dir, 'nick.db'));
  mcp = new NickMcpClient(server.url, 'agent-test');
  store = AgentStore.open(path.join(tmp.dir, 'agent.db'));
});

afterAll(async () => {
  await mcp.close();
  store.db.close();
  await server.stop();
  tmp.cleanup();
});

beforeEach(() => {
  server.db.exec('DELETE FROM tasks; DELETE FROM memories; DELETE FROM study_plans;');
  conversationId = store.createConversation('test').id;
});

function deps(model: ModelAdapter, limits: Partial<AgentDeps['limits']> = {}): AgentDeps {
  return {
    model,
    mcp,
    limits: { maxIterations: 6, maxToolCalls: 8, toolTimeoutMs: 10_000, ...limits },
    createPendingAction: (a) => store.createPendingAction(conversationId, a),
    now: () => new Date(2030, 0, 15, 10, 0, 0),
  };
}

async function run(model: ModelAdapter, message: string, limits?: Partial<AgentDeps['limits']>) {
  const events: AgentEvent[] = [];
  const result = await runAgent({ message, history: [] }, deps(model, limits), (e) => events.push(e));
  return { result, events };
}

const taskCount = () => (server.db.prepare('SELECT COUNT(*) n FROM tasks').get() as { n: number }).n;

describe('agent loop with a real MCP server', () => {
  it('selects a tool, executes it via MCP and answers from the real result', async () => {
    const model = new ScriptedModel((n) =>
      n === 1 ? tool('create_task', { title: 'Study physics', dueDate: '2030-01-16', priority: 'high', description: null }) : say('Your task is saved.'),
    );
    const { result, events } = await run(model, 'Add a high priority task to study physics tomorrow');
    expect(result.status).toBe('completed');
    expect(result.systemComposed).toBe(false);
    expect(result.message).toBe('Your task is saved.');
    expect(server.db.prepare('SELECT title, due_date, priority FROM tasks').all()).toEqual([
      { title: 'Study physics', due_date: '2030-01-16', priority: 'high' },
    ]);
    const createActivity = result.activity.find((a) => a.tool === 'create_task')!;
    expect(createActivity.status).toBe('success');
    expect(createActivity.durationMs).toBeGreaterThanOrEqual(0);
    // the real tool result was fed back to the model
    const toolMsg = model.calls[1].messages.find((m) => m.role === 'tool')!;
    expect(toolMsg.content).toMatch(/Created task #\d+ "Study physics"/);
    // the system prompt carried today's date for resolving "tomorrow"
    expect(model.calls[0].messages[0].content).toContain('Today is Tuesday, 2030-01-15. Tomorrow is 2030-01-16.');
    // a running status is emitted before success
    const statuses = events.filter((e) => e.type === 'activity' && e.activity.tool === 'create_task').map((e) => (e as { activity: { status: string } }).activity.status);
    expect(statuses).toEqual(['running', 'success']);
  });

  it('offers the model only agent tools, with app-controlled fields hidden', async () => {
    const model = new ScriptedModel(() => say('Hello!'));
    await run(model, 'hi');
    const names = model.calls[0].tools.map((t) => t.name);
    expect(names).not.toContain('clear_memories');
    expect(names).toContain('create_task');
    const del = model.calls[0].tools.find((t) => t.name === 'delete_task')!;
    expect(Object.keys((del.parameters as { properties: object }).properties)).toEqual(['taskId']);
  });

  it('reports model failure honestly without inventing a reply', async () => {
    const model = new ScriptedModel(() => new ModelError('unreachable', 'Ollama is not reachable at http://127.0.0.1:11434.'));
    const { result } = await run(model, 'Create a task to buy milk');
    expect(result.status).toBe('model_error');
    expect(result.systemComposed).toBe(true);
    expect(result.message).toMatch(/could not answer: Ollama is not reachable/);
    expect(taskCount()).toBe(0);
  });

  it('rejects malformed arguments and unknown tools, then recovers', async () => {
    const model = new ScriptedModel((n) => {
      if (n === 1) return { content: '', toolCalls: [{ name: 'create_task', arguments: '{"title": broken' }, { name: 'run_sql', arguments: { q: 'DROP TABLE tasks' } }], mode: 'native' };
      if (n === 2) return tool('create_task', { title: 'Fixed' });
      return say('Done.');
    });
    const { result } = await run(model, 'make a task');
    const errors = result.activity.filter((a) => a.status === 'error').map((a) => a.summary);
    expect(errors).toEqual(['Malformed arguments from the model', 'Unknown or disallowed tool']);
    const fedBack = model.calls[1].messages.filter((m) => m.role === 'tool').map((m) => m.content);
    expect(fedBack[0]).toMatch(/not a valid JSON object/);
    expect(fedBack[1]).toMatch(/"run_sql" is not an available tool/);
    expect(taskCount()).toBe(1);
    expect(result.status).toBe('completed');
  });

  it('feeds tool validation errors back so the model can correct itself', async () => {
    const model = new ScriptedModel((n) => (n === 1 ? tool('create_task', { title: 'X', priority: 'urgent' }) : n === 2 ? tool('create_task', { title: 'X', priority: 'high' }) : say('ok')));
    const { result } = await run(model, 'urgent task X');
    expect(result.activity.filter((a) => a.tool === 'create_task').map((a) => a.status)).toEqual(['error', 'success']);
    expect(model.calls[1].messages.at(-1)!.content).toMatch(/^Error: .*Input validation error/);
    expect(taskCount()).toBe(1);
  });

  it('stops at the iteration limit', async () => {
    let i = 0;
    const model = new ScriptedModel(() => tool('list_tasks', { limit: ++i }));
    const { result } = await run(model, 'loop forever', { maxIterations: 3, maxToolCalls: 10 });
    expect(result.status).toBe('limit_reached');
    expect(result.iterations).toBe(3);
    expect(model.calls).toHaveLength(3);
    expect(result.notes.join(' ')).toMatch(/3 reasoning steps/);
  });

  it('stops at the tool-call limit', async () => {
    let i = 0;
    const model = new ScriptedModel(() => ({ content: '', toolCalls: [1, 2, 3].map(() => ({ name: 'list_tasks', arguments: { limit: ++i } })), mode: 'native' }));
    const { result } = await run(model, 'many calls', { maxIterations: 10, maxToolCalls: 4 });
    expect(result.status).toBe('limit_reached');
    expect(result.toolCalls).toBe(4);
  });

  it('skips identical repeated tool calls and stops a repeating model', async () => {
    const model = new ScriptedModel(() => tool('list_tasks', { status: 'pending' }));
    const { result } = await run(model, 'list');
    expect(result.activity.filter((a) => a.tool === 'list_tasks' && a.status === 'success')).toHaveLength(1);
    expect(result.activity.filter((a) => a.status === 'skipped')).toHaveLength(2);
    expect(result.status).toBe('limit_reached');
  });

  it('never deletes on the model\'s request; deletion waits for user confirmation', async () => {
    const created = await mcp.callTool('create_task', { title: 'Old draft' });
    const taskId = (created.structured as { taskId: number }).taskId;
    // even if the model tries to self-confirm, confirm is stripped and the call becomes a pending action
    const model = new ScriptedModel(() => tool('delete_task', { taskId: String(taskId), confirm: true }));
    const { result, events } = await run(model, 'delete the old draft task');
    expect(result.status).toBe('awaiting_confirmation');
    expect(result.message).toMatch(/Nothing has been deleted yet/);
    expect(taskCount()).toBe(1);
    expect(model.calls).toHaveLength(1);
    const pending = events.find((e) => e.type === 'confirmation_required') as Extract<AgentEvent, { type: 'confirmation_required' }>;
    expect(pending.action.summary).toBe(`delete task #${taskId} "Old draft"`);

    const confirmed = await confirmPendingAction(store, mcp, pending.action.id);
    expect(confirmed.ok).toBe(true);
    expect(taskCount()).toBe(0);
    const again = await confirmPendingAction(store, mcp, pending.action.id);
    expect(again).toMatchObject({ ok: false, status: 409 });
    expect(store.messages(conversationId).at(-1)!.content).toMatch(/^Done: Deleted task/);
  });

  it('cancelling a pending deletion keeps the data', async () => {
    const created = await mcp.callTool('create_task', { title: 'Keep me' });
    const taskId = (created.structured as { taskId: number }).taskId;
    const model = new ScriptedModel(() => tool('delete_task', { taskId }));
    const { result } = await run(model, 'delete it');
    const cancel = cancelPendingAction(store, result.pendingActions[0].id);
    expect(cancel.ok).toBe(true);
    expect(taskCount()).toBe(1);
    expect((await confirmPendingAction(store, mcp, result.pendingActions[0].id)).ok).toBe(false);
    expect(taskCount()).toBe(1);
  });

  it('does not create a pending deletion for a task that does not exist', async () => {
    const model = new ScriptedModel((n) => (n === 1 ? tool('delete_task', { taskId: 4242 }) : say('That task does not exist.')));
    const { result } = await run(model, 'delete task 4242');
    expect(result.pendingActions).toHaveLength(0);
    expect(model.calls[1].messages.at(-1)!.content).toBe('Error: Task 4242 was not found. Call list_tasks with a query to find the correct task ID.');
  });

  it('study plans are previewed, not saved, until the user approves', async () => {
    const model = new ScriptedModel(() =>
      tool('create_study_plan', { subjects: [{ name: 'Chemistry' }], startDate: '2030-01-15', targetDate: '2030-01-20', hoursPerDay: 1, save: true }),
    );
    const { result } = await run(model, 'Plan chemistry study until the 20th, 1 hour a day');
    expect(result.status).toBe('awaiting_confirmation');
    expect(result.message).toMatch(/not saved yet/);
    expect(server.db.prepare('SELECT COUNT(*) n FROM study_plans').get()).toEqual({ n: 0 });
    const confirmed = await confirmPendingAction(store, mcp, result.pendingActions[0].id, { createTasks: false });
    expect(confirmed.ok).toBe(true);
    expect(server.db.prepare('SELECT COUNT(*) n FROM study_plans').get()).toEqual({ n: 1 });
    expect(taskCount()).toBe(0);
  });

  it('marks memories as user-saved only when the user explicitly asked', async () => {
    const m1 = new ScriptedModel((n) => (n === 1 ? tool('save_memory', { content: 'Prefers 45-minute study sessions', category: 'preference', source: 'inferred' }) : say('Noted.')));
    await run(m1, 'Remember that I prefer 45-minute study sessions');
    const m2 = new ScriptedModel((n) => (n === 1 ? tool('save_memory', { content: 'Is learning Spanish', source: 'user' }) : say('ok')));
    await run(m2, 'I am learning Spanish these days');
    expect(server.db.prepare('SELECT content, source FROM memories ORDER BY id').all()).toEqual([
      { content: 'Prefers 45-minute study sessions', source: 'user' },
      { content: 'Is learning Spanish', source: 'inferred' },
    ]);
  });

  it('retrieves relevant saved memory into the prompt in a new conversation', async () => {
    await mcp.callTool('save_memory', { content: 'Prefers 45-minute study sessions', category: 'preference', source: 'user' });
    await mcp.callTool('save_memory', { content: 'Has a dog named Bruno', category: 'fact', source: 'user' });
    const model = new ScriptedModel(() => say('Your sessions are 45 minutes.'));
    const { events } = await run(model, 'How long are my study sessions?');
    const ctx = events.find((e) => e.type === 'context') as Extract<AgentEvent, { type: 'context' }>;
    expect(ctx.relevance).toBe('matched');
    expect(ctx.memories.map((m) => m.content)).toEqual(['Prefers 45-minute study sessions']);
    const userTurn = model.calls[0].messages.at(-1)!;
    expect(userTurn.role).toBe('user');
    expect(userTurn.content).toContain('saved by the user] Prefers 45-minute study sessions');
    expect(userTurn.content).toMatch(/USER MESSAGE:\nHow long are my study sessions\?$/);
    expect(userTurn.content).not.toContain('Bruno');
    // the system prompt stays free of per-request data so the model's prompt cache can be reused
    expect(model.calls[0].messages[0].content).not.toContain('[memory #');
  });

  it('sends a plain message with no memory preamble when nothing is saved', async () => {
    const model = new ScriptedModel(() => say('Hi! How can I help?'));
    const { events } = await run(model, 'Hello');
    expect((events.find((e) => e.type === 'context') as Extract<AgentEvent, { type: 'context' }>).relevance).toBe('none');
    expect(model.calls[0].messages.at(-1)).toMatchObject({ role: 'user', content: 'Hello' });
  });

  it('Stop during the model call ends the run as cancelled without executing anything', async () => {
    const abort = new AbortController();
    const model: ModelAdapter = {
      label: 'hanging model',
      chat: (_m, _t, signal) =>
        new Promise((_, reject) => {
          signal?.addEventListener('abort', () => reject(new ModelError('unreachable', 'aborted')));
          setTimeout(() => abort.abort(), 20);
        }),
    };
    const result = await runAgent({ message: 'Add a task to buy milk', history: [] }, { ...deps(model), signal: abort.signal }, () => {});
    expect(result.status).toBe('cancelled');
    expect(result.systemComposed).toBe(true);
    expect(result.message).toBe('Stopped at your request. No actions were completed.');
    expect(taskCount()).toBe(0);
  });

  it('Stop lets a started tool call finish, reports it, and starts nothing new', async () => {
    const abort = new AbortController();
    const model = new ScriptedModel(() => ({
      content: '',
      toolCalls: [
        { name: 'create_task', arguments: { title: 'First' } },
        { name: 'create_task', arguments: { title: 'Second' } },
      ],
      mode: 'native',
    }));
    const events: AgentEvent[] = [];
    const result = await runAgent({ message: 'Add two tasks', history: [] }, { ...deps(model), signal: abort.signal }, (e) => {
      events.push(e);
      if (e.type === 'activity' && e.activity.tool === 'create_task' && e.activity.status === 'running') abort.abort();
    });
    expect(result.status).toBe('cancelled');
    expect(result.message).toMatch(/^Stopped at your request\. Completed actions: Created task #\d+ "First"\.$/);
    expect(server.db.prepare('SELECT title FROM tasks').all()).toEqual([{ title: 'First' }]);
    expect(model.calls).toHaveLength(1);
  });

  it('a false action claim triggers one corrective turn, which can then call the real tool', async () => {
    const created = await mcp.callTool('create_task', { title: 'Old physics task' });
    const taskId = (created.structured as { taskId: number }).taskId;
    const model = new ScriptedModel((n) => (n === 1 ? say('I have deleted the task "Old physics task".') : tool('delete_task', { taskId })));
    const { result } = await run(model, 'delete the physics task');
    expect(model.calls[1].messages.at(-1)!.content).toMatch(/^NICK SYSTEM CHECK: your reply says something was deleted/);
    expect(result.status).toBe('awaiting_confirmation');
    expect(result.pendingActions).toHaveLength(1);
    expect(taskCount()).toBe(1);
  });

  it('a repeated false claim is replaced by an honest system message', async () => {
    const model = new ScriptedModel(() => say("I've created the task for you."));
    const { result } = await run(model, 'create a task');
    expect(taskCount()).toBe(0);
    expect(model.calls).toHaveLength(2);
    expect(result.status).toBe('invalid_output');
    expect(result.systemComposed).toBe(true);
    expect(result.message).toMatch(/nothing was changed/);
    expect(result.message).not.toMatch(/I've created/);
  });

  it('claims backed by a successful tool call pass the check', () => {
    expect(unbackedClaims("I've added the task and it has been saved.", new Set(['create_task', 'save_memory']))).toEqual([]);
    expect(unbackedClaims("I've added the task.", new Set(['list_tasks']))).toEqual(['added']);
    expect(unbackedClaims('Task #1 has been deleted.', new Set(['delete_task']))).toEqual(['deleted']);
    expect(unbackedClaims('You have a task that is marked high priority.', new Set())).toEqual([]);
  });

  it('passes earlier tool results (with IDs) as context, not inside past assistant replies', async () => {
    const { history, recentResults } = historyFromMessages([
      { role: 'user', content: 'add physics task' },
      {
        role: 'assistant',
        content: 'Added it.',
        meta: {
          activity: [
            { id: '1', tool: 'search_memory', purpose: 'x', status: 'success', origin: 'agent', startedAt: '', summary: 'Found 0 matching memories.' },
            { id: '2', tool: 'create_task', purpose: 'x', status: 'success', origin: 'agent', startedAt: '', summary: 'Created task #7 "Physics".' },
            { id: '3', tool: 'create_task', purpose: 'x', status: 'error', origin: 'agent', startedAt: '', summary: 'Input validation error' },
          ],
        },
      },
    ]);
    expect(history).toEqual([
      { role: 'user', content: 'add physics task' },
      { role: 'assistant', content: 'Added it.' },
    ]);
    expect(recentResults).toEqual(['Created task #7 "Physics".']);

    const model = new ScriptedModel(() => say('ok'));
    await runAgent({ message: 'delete it', history, recentResults }, deps(model), () => undefined);
    const userTurn = model.calls[0].messages.at(-1)!.content;
    expect(userTurn).toContain('EARLIER TOOL RESULTS IN THIS CONVERSATION');
    expect(userTurn).toContain('- Created task #7 "Physics".');
  });

  it('sends the model a compact tool result, capped in size, while the UI keeps full data', async () => {
    for (let i = 1; i <= 30; i++) await mcp.callTool('create_task', { title: `Study session ${i} with a fairly long descriptive title`, description: 'x'.repeat(500) });
    const model = new ScriptedModel((n) => (n === 1 ? tool('list_tasks', {}) : say('You have 30 tasks.')));
    await run(model, 'list my tasks');
    const toolMsg = model.calls[1].messages.find((m) => m.role === 'tool')!.content;
    expect(toolMsg.length).toBeLessThanOrEqual(1500);
    expect(toolMsg).toMatch(/^Found 30 tasks/);
    expect(toolMsg).toContain('…and 15 more');
    expect(toolMsg).not.toContain('xxxxx'); // descriptions are not sent to the model
    expect(toolResultForModel('get_task', { ok: false, text: 'Task 9 was not found.', structured: null })).toBe('Error: Task 9 was not found.');
  });

  it('adds a note when the model reply was cut at the length limit', async () => {
    const model = new ScriptedModel(() => ({ content: 'Here are your tasks: #1 Study Math due on', toolCalls: [], mode: 'native', truncated: true }));
    const { result } = await run(model, 'list my tasks');
    expect(result.status).toBe('completed');
    expect(result.notes.join(' ')).toMatch(/reached the length limit/);
  });

  it('reports an unreachable MCP server without calling the model', async () => {
    const offline = new NickMcpClient('http://127.0.0.1:1/mcp', 'offline');
    const model = new ScriptedModel(() => say('should not be called'));
    const result = await runAgent({ message: 'list my tasks', history: [] }, { ...deps(model), mcp: offline }, () => undefined);
    expect(result.status).toBe('mcp_error');
    expect(model.calls).toHaveLength(0);
  });
});
