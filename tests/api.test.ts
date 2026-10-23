import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startTestServer, tempDir, type RunningServer } from './helpers';

// Route handlers read configuration from the environment on first use.
let tmp: ReturnType<typeof tempDir>;
let server: RunningServer;
let routes: {
  tools: typeof import('../src/app/api/tools/[name]/route');
  chat: typeof import('../src/app/api/chat/route');
  conversations: typeof import('../src/app/api/conversations/route');
  conversation: typeof import('../src/app/api/conversations/[id]/route');
  actions: typeof import('../src/app/api/actions/[id]/route');
  activity: typeof import('../src/app/api/activity/route');
  status: typeof import('../src/app/api/status/route');
  cancel: typeof import('../src/app/api/runs/[id]/cancel/route');
};

beforeAll(async () => {
  tmp = tempDir();
  server = await startTestServer(path.join(tmp.dir, 'nick.db'));
  process.env.NICK_MCP_URL = server.url;
  process.env.NICK_DATA_DIR = tmp.dir;
  process.env.OLLAMA_BASE_URL = 'http://127.0.0.1:1'; // deliberately unreachable
  routes = {
    tools: await import('../src/app/api/tools/[name]/route'),
    chat: await import('../src/app/api/chat/route'),
    conversations: await import('../src/app/api/conversations/route'),
    conversation: await import('../src/app/api/conversations/[id]/route'),
    actions: await import('../src/app/api/actions/[id]/route'),
    activity: await import('../src/app/api/activity/route'),
    status: await import('../src/app/api/status/route'),
    cancel: await import('../src/app/api/runs/[id]/cancel/route'),
  };
});

afterAll(async () => {
  const g = globalThis as { __nickRuntime?: { mcp: { close(): Promise<void> }; store: { db: { close(): void } } } };
  await g.__nickRuntime?.mcp.close();
  g.__nickRuntime?.store.db.close();
  await server.stop();
  tmp.cleanup();
});

const json = (url: string, body: unknown, headers: Record<string, string> = {}, method = 'POST') =>
  new Request(`http://127.0.0.1:3000${url}`, { method, headers: { 'content-type': 'application/json', host: '127.0.0.1:3000', ...headers }, body: JSON.stringify(body) });

const callTool = (name: string, body: unknown, headers?: Record<string, string>) =>
  routes.tools.POST(json(`/api/tools/${name}`, body, headers), { params: Promise.resolve({ name }) });

describe('/api/tools/:name (dashboard -> MCP tools/call)', () => {
  it('creates and lists tasks through MCP, persisting to SQLite', async () => {
    const created = await callTool('create_task', { args: { title: 'From dashboard', priority: 'high' } });
    expect(created.status).toBe(200);
    const body = await created.json();
    expect(body).toMatchObject({ ok: true, summary: expect.stringMatching(/^Created task #\d+/) });
    expect(server.db.prepare('SELECT title FROM tasks').all()).toEqual([{ title: 'From dashboard' }]);

    const listed = await (await callTool('list_tasks', { args: {} })).json();
    expect(listed.data.tasks.map((t: { title: string }) => t.title)).toEqual(['From dashboard']);
  });

  it('updates tasks and returns validation errors as 422', async () => {
    const id = (server.db.prepare('SELECT id FROM tasks').get() as { id: number }).id;
    const ok = await callTool('update_task', { args: { taskId: id, status: 'in_progress' } });
    expect((await ok.json()).data.task.status).toBe('in_progress');
    const bad = await callTool('update_task', { args: { taskId: id, priority: 'urgent' } });
    expect(bad.status).toBe(422);
    expect((await bad.json()).error).toMatch(/Input validation error/);
  });

  it('refuses destructive tools without explicit confirmation (428) and ignores a smuggled confirm arg', async () => {
    const id = (server.db.prepare('SELECT id FROM tasks').get() as { id: number }).id;
    const res = await callTool('delete_task', { args: { taskId: id, confirm: true } });
    expect(res.status).toBe(428);
    expect(server.db.prepare('SELECT COUNT(*) n FROM tasks').get()).toEqual({ n: 1 });
    const confirmed = await callTool('delete_task', { args: { taskId: id }, confirmed: true });
    expect(confirmed.status).toBe(200);
    expect(server.db.prepare('SELECT COUNT(*) n FROM tasks').get()).toEqual({ n: 0 });
  });

  it('marks dashboard-saved memories as user-sourced', async () => {
    await callTool('save_memory', { args: { content: 'Studies best after 8pm', source: 'inferred' } });
    expect(server.db.prepare('SELECT source FROM memories').get()).toEqual({ source: 'user' });
  });

  it('rejects unknown tools, cross-origin requests, non-JSON bodies and unexpected fields', async () => {
    expect((await callTool('run_sql', { args: {} })).status).toBe(404);
    expect((await callTool('list_tasks', { args: {} }, { origin: 'https://evil.example' })).status).toBe(403);
    const textPlain = new Request('http://127.0.0.1:3000/api/tools/list_tasks', { method: 'POST', headers: { 'content-type': 'text/plain' }, body: '{}' });
    expect((await routes.tools.POST(textPlain, { params: Promise.resolve({ name: 'list_tasks' }) })).status).toBe(415);
    expect((await callTool('list_tasks', { args: {}, extra: 1 })).status).toBe(400);
  });

  it('records dashboard writes in the activity log', async () => {
    const res = await routes.activity.GET();
    const { activity } = await res.json();
    expect(activity.some((a: { tool: string; origin: string }) => a.tool === 'create_task' && a.origin === 'ui')).toBe(true);
  });
});

describe('/api/chat with the model unavailable', () => {
  it('stores the conversation and returns an honest, system-composed error', async () => {
    const res = await routes.chat.POST(json('/api/chat', { message: 'Add a task to buy milk' }));
    expect(res.headers.get('content-type')).toContain('application/x-ndjson');
    const events = (await res.text()).trim().split('\n').map((l) => JSON.parse(l));
    const final = events.find((e) => e.type === 'final');
    expect(final.result).toMatchObject({ status: 'model_error', systemComposed: true });
    expect(final.result.message).toMatch(/Ollama is not reachable/);
    expect(server.db.prepare("SELECT COUNT(*) n FROM tasks WHERE title LIKE '%milk%'").get()).toEqual({ n: 0 });

    const { conversations } = await (await routes.conversations.GET()).json();
    expect(conversations).toHaveLength(1);
    const id = conversations[0].id;
    const detail = await (await routes.conversation.GET(new Request('http://x'), { params: Promise.resolve({ id }) })).json();
    expect(detail.messages.map((m: { role: string }) => m.role)).toEqual(['user', 'assistant']);

    // delete requires an explicit confirmation body
    const noConfirm = await routes.conversation.DELETE(json(`/api/conversations/${id}`, {}, {}, 'DELETE'), { params: Promise.resolve({ id }) });
    expect(noConfirm.status).toBe(400);
    const del = await routes.conversation.DELETE(json(`/api/conversations/${id}`, { confirmed: true }, {}, 'DELETE'), { params: Promise.resolve({ id }) });
    expect(del.status).toBe(200);
  });

  it('validates chat input', async () => {
    expect((await routes.chat.POST(json('/api/chat', { message: '   ' }))).status).toBe(400);
    expect((await routes.chat.POST(json('/api/chat', { message: 'x'.repeat(4001) }))).status).toBe(400);
    expect((await routes.chat.POST(json('/api/chat', { message: 'hi', conversationId: 'not-a-uuid' }))).status).toBe(400);
  });

  it('/api/status reports MCP connected and Ollama unreachable', async () => {
    const status = await (await routes.status.GET()).json();
    expect(status.mcp).toMatchObject({ ok: true, protocolVersion: '2025-11-25' });
    expect(status.mcp.tools).toHaveLength(16);
    expect(status.ollama).toMatchObject({ ok: false, reachable: false });
    expect(status.mode).toBe('single-user-local');
  });

  it('/api/actions rejects unknown action ids', async () => {
    const id = '00000000-0000-4000-8000-000000000000';
    const res = await routes.actions.POST(json(`/api/actions/${id}`, { decision: 'confirm' }), { params: Promise.resolve({ id }) });
    expect(res.status).toBe(404);
  });

  it('/api/runs/:id/cancel aborts an active run and rejects finished or invalid ids', async () => {
    const { getRuntime } = await import('../src/server/runtime');
    const id = '11111111-1111-4111-8111-111111111111';
    const abort = new AbortController();
    getRuntime().activeRuns.set(id, abort);
    const cancel = (runId: string) => routes.cancel.POST(json(`/api/runs/${runId}/cancel`, {}), { params: Promise.resolve({ id: runId }) });
    expect((await cancel(id)).status).toBe(200);
    expect(abort.signal.aborted).toBe(true);
    getRuntime().activeRuns.delete(id);
    expect((await cancel(id)).status).toBe(404);
    expect((await cancel('not-a-uuid')).status).toBe(400);
  });
});
