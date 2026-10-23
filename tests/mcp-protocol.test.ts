import http from 'node:http';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { LATEST_PROTOCOL_VERSION } from '@modelcontextprotocol/sdk/types.js';
import { NickMcpClient } from '../lib/mcpClient';
import { parseMcpBody, startTestServer, tempDir, type RunningServer } from './helpers';

const EXPECTED_TOOLS = [
  'create_task', 'list_tasks', 'get_task', 'update_task', 'complete_task', 'delete_task',
  'create_study_plan', 'get_study_plan', 'list_study_plans', 'update_study_plan_item', 'delete_study_plan',
  'save_memory', 'search_memory', 'update_memory', 'delete_memory', 'clear_memories',
];

const initializeBody = {
  jsonrpc: '2.0',
  id: 1,
  method: 'initialize',
  params: { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'raw-http-test', version: '1.0.0' } },
};

const postHeaders = { 'content-type': 'application/json', accept: 'application/json, text/event-stream' };

let tmp: ReturnType<typeof tempDir>;
let server: RunningServer;
let client: Client;
let transport: StreamableHTTPClientTransport;

beforeAll(async () => {
  tmp = tempDir();
  server = await startTestServer(path.join(tmp.dir, 'nick.db'));
  client = new Client({ name: 'vitest-client', version: '1.0.0' });
  transport = new StreamableHTTPClientTransport(new URL(server.url));
  await client.connect(transport);
});

afterAll(async () => {
  await client?.close();
  await server?.stop();
  tmp.cleanup();
});

describe('Streamable HTTP wire behaviour (raw HTTP)', () => {
  it('initialize returns protocol 2025-11-25, capabilities and an Mcp-Session-Id', async () => {
    const res = await fetch(server.url, { method: 'POST', headers: postHeaders, body: JSON.stringify(initializeBody) });
    expect(res.status).toBe(200);
    const sessionId = res.headers.get('mcp-session-id');
    expect(sessionId).toMatch(/^[0-9a-f-]{36}$/);
    const [msg] = parseMcpBody(res.headers.get('content-type'), await res.text()) as {
      result: { protocolVersion: string; capabilities: { tools?: unknown }; serverInfo: { name: string } };
    }[];
    expect(LATEST_PROTOCOL_VERSION).toBe('2025-11-25');
    expect(msg.result.protocolVersion).toBe('2025-11-25');
    expect(msg.result.capabilities.tools).toBeDefined();
    expect(msg.result.serverInfo.name).toBe('nick-mcp-server');

    // complete the handshake, then call tools/list on the same session
    const sessionHeaders = { ...postHeaders, 'mcp-session-id': sessionId!, 'mcp-protocol-version': '2025-11-25' };
    const notified = await fetch(server.url, {
      method: 'POST',
      headers: sessionHeaders,
      body: JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }),
    });
    expect(notified.status).toBe(202);
    const list = await fetch(server.url, { method: 'POST', headers: sessionHeaders, body: JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list' }) });
    const [listMsg] = parseMcpBody(list.headers.get('content-type'), await list.text()) as { result: { tools: { name: string }[] } }[];
    expect(listMsg.result.tools.map((t) => t.name).sort()).toEqual([...EXPECTED_TOOLS].sort());

    // DELETE terminates the session; it can no longer be used
    const del = await fetch(server.url, { method: 'DELETE', headers: { 'mcp-session-id': sessionId! } });
    expect(del.status).toBe(200);
    const after = await fetch(server.url, { method: 'POST', headers: sessionHeaders, body: JSON.stringify({ jsonrpc: '2.0', id: 3, method: 'tools/list' }) });
    expect(after.status).toBe(404);
  });

  it('rejects non-initialize requests without a session (400) and unknown sessions (404)', async () => {
    const noSession = await fetch(server.url, { method: 'POST', headers: postHeaders, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }) });
    expect(noSession.status).toBe(400);
    const unknown = await fetch(server.url, {
      method: 'POST',
      headers: { ...postHeaders, 'mcp-session-id': '00000000-0000-0000-0000-000000000000' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
    });
    expect(unknown.status).toBe(404);
  });

  it('rejects malformed JSON without leaking internals', async () => {
    const res = await fetch(server.url, { method: 'POST', headers: postHeaders, body: '{"jsonrpc":' });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error.code).toBe(-32700);
    expect(JSON.stringify(body)).not.toMatch(/at .*\.(js|ts):\d+/);
  });

  it('rejects oversized request bodies', async () => {
    const huge = JSON.stringify({ ...initializeBody, params: { ...initializeBody.params, pad: 'x'.repeat(200_000) } });
    const res = await fetch(server.url, { method: 'POST', headers: postHeaders, body: huge });
    expect(res.status).toBe(413);
  });

  it('rejects foreign Origin headers (DNS rebinding protection)', async () => {
    const res = await fetch(server.url, {
      method: 'POST',
      headers: { ...postHeaders, origin: 'https://evil.example' },
      body: JSON.stringify(initializeBody),
    });
    expect(res.status).toBe(403);
  });

  it('rejects foreign Host headers (DNS rebinding protection)', async () => {
    const status = await new Promise<number>((resolve, reject) => {
      const req = http.request(
        { host: '127.0.0.1', port: server.port, path: '/mcp', method: 'POST', headers: { ...postHeaders, host: 'evil.example' } },
        (res) => {
          res.resume();
          resolve(res.statusCode ?? 0);
        },
      );
      req.on('error', reject);
      req.end(JSON.stringify(initializeBody));
    });
    expect(status).toBe(403);
  });
});

describe('MCP via the official SDK client', () => {
  it('negotiates capabilities', () => {
    expect(client.getServerVersion()).toMatchObject({ name: 'nick-mcp-server' });
    expect(client.getServerCapabilities()?.tools).toBeDefined();
    expect(transport.protocolVersion).toBe('2025-11-25');
    expect(transport.sessionId).toBeTruthy();
  });

  it('tools/list exposes every tool with a JSON object input schema and annotations', async () => {
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual([...EXPECTED_TOOLS].sort());
    for (const tool of tools) {
      expect(tool.inputSchema.type).toBe('object');
      expect(tool.description).toBeTruthy();
    }
    const del = tools.find((t) => t.name === 'delete_task')!;
    expect(del.annotations?.destructiveHint).toBe(true);
    expect(del.inputSchema.required).toEqual(expect.arrayContaining(['taskId', 'confirm']));
  });

  it('tools/call create_task persists a task and returns structured content', async () => {
    const res = await client.callTool({ name: 'create_task', arguments: { title: 'Read chapter 4', priority: 'high', dueDate: '2030-05-01' } });
    expect(res.isError).toBeFalsy();
    const sc = res.structuredContent as { success: boolean; taskId: number; task: { title: string } };
    expect(sc.success).toBe(true);
    expect(sc.task.title).toBe('Read chapter 4');
    const row = server.db.prepare('SELECT title, priority, due_date FROM tasks WHERE id = ?').get(sc.taskId);
    expect(row).toEqual({ title: 'Read chapter 4', priority: 'high', due_date: '2030-05-01' });
  });

  it('runs the full task lifecycle over MCP', async () => {
    const created = (await client.callTool({ name: 'create_task', arguments: { title: 'Lifecycle' } })).structuredContent as { taskId: number };
    const id = created.taskId;
    const got = await client.callTool({ name: 'get_task', arguments: { taskId: id } });
    expect((got.structuredContent as { task: { status: string } }).task.status).toBe('pending');
    const upd = await client.callTool({ name: 'update_task', arguments: { taskId: id, priority: 'low', category: 'demo' } });
    expect((upd.structuredContent as { task: { priority: string } }).task.priority).toBe('low');
    const done = await client.callTool({ name: 'complete_task', arguments: { taskId: id } });
    expect((done.structuredContent as { task: { status: string } }).task.status).toBe('completed');
    const listed = await client.callTool({ name: 'list_tasks', arguments: { status: 'completed' } });
    expect((listed.structuredContent as { tasks: { id: number }[] }).tasks.map((t) => t.id)).toContain(id);
    const del = await client.callTool({ name: 'delete_task', arguments: { taskId: id, confirm: true } });
    expect(del.isError).toBeFalsy();
    const gone = await client.callTool({ name: 'get_task', arguments: { taskId: id } });
    expect(gone.isError).toBe(true);
  });

  it('returns tool errors (isError) for invalid arguments', async () => {
    const cases: [string, Record<string, unknown>][] = [
      ['create_task', {}],
      ['create_task', { title: 'x', priority: 'urgent' }],
      ['create_task', { title: 'x', dueDate: '2026-02-30' }],
      ['create_task', { title: 'x', sql: 'DROP TABLE tasks' }],
      ['update_task', { taskId: 1 }],
      ['delete_task', { taskId: 1 }],
      ['delete_task', { taskId: 1, confirm: 'yes' }],
      ['get_task', { taskId: -5 }],
    ];
    for (const [name, args] of cases) {
      const res = await client.callTool({ name, arguments: args });
      expect(res.isError, `${name} ${JSON.stringify(args)}`).toBe(true);
      expect((res.content as { text: string }[])[0].text).toMatch(/Input validation error/);
    }
  });

  it('returns an error for unknown tools', async () => {
    const res = await client.callTool({ name: 'run_sql', arguments: { query: 'SELECT 1' } });
    expect(res.isError).toBe(true);
    expect((res.content as { text: string }[])[0].text).toMatch(/Tool run_sql not found/);
  });

  it('returns a domain error for missing records', async () => {
    const res = await client.callTool({ name: 'complete_task', arguments: { taskId: 99999 } });
    expect(res.isError).toBe(true);
    expect((res.content as { text: string }[])[0].text).toBe('Task 99999 was not found.');
  });

  it('memory tools: save, dedupe, refuse secrets, search, update, delete, clear', async () => {
    const saved = await client.callTool({ name: 'save_memory', arguments: { content: 'Prefers morning study sessions', category: 'preference', source: 'user' } });
    const memoryId = (saved.structuredContent as { memoryId: number }).memoryId;
    const dup = await client.callTool({ name: 'save_memory', arguments: { content: 'prefers morning study sessions' } });
    expect((dup.structuredContent as { duplicate: boolean }).duplicate).toBe(true);
    const secret = await client.callTool({ name: 'save_memory', arguments: { content: 'My password is hunter2' } });
    expect(secret.isError).toBe(true);
    const found = await client.callTool({ name: 'search_memory', arguments: { query: 'when do I like to study' } });
    expect((found.structuredContent as { memories: { id: number; source: string }[] }).memories).toEqual([
      expect.objectContaining({ id: memoryId, source: 'user' }),
    ]);
    const upd = await client.callTool({ name: 'update_memory', arguments: { memoryId, content: 'Prefers evening study sessions' } });
    expect(upd.isError).toBeFalsy();
    const del = await client.callTool({ name: 'delete_memory', arguments: { memoryId, confirm: true } });
    expect(del.isError).toBeFalsy();
    await client.callTool({ name: 'save_memory', arguments: { content: 'Goal: finish NICK' } });
    const cleared = await client.callTool({ name: 'clear_memories', arguments: { confirm: true } });
    expect((cleared.structuredContent as { deletedCount: number }).deletedCount).toBe(1);
  });

  it('study plan tools: preview does not save; save persists and creates tasks', async () => {
    const args = { subjects: [{ name: 'Biology', topics: ['Cells', 'Genetics'] }], startDate: '2030-06-01', targetDate: '2030-06-04', hoursPerDay: 1 };
    const preview = await client.callTool({ name: 'create_study_plan', arguments: args });
    expect((preview.structuredContent as { saved: boolean }).saved).toBe(false);
    expect(server.db.prepare('SELECT COUNT(*) n FROM study_plans').get()).toEqual({ n: 0 });

    const saved = await client.callTool({ name: 'create_study_plan', arguments: { ...args, save: true, createTasks: true } });
    const sc = saved.structuredContent as { planId: number; plan: { items: { id: number; taskId: number }[] } };
    expect(sc.plan.items.length).toBeGreaterThan(0);
    expect(sc.plan.items.every((i) => i.taskId)).toBe(true);

    const got = await client.callTool({ name: 'get_study_plan', arguments: {} });
    expect((got.structuredContent as { plan: { id: number } }).plan.id).toBe(sc.planId);
    const item = sc.plan.items[0];
    const upd = await client.callTool({ name: 'update_study_plan_item', arguments: { planId: sc.planId, itemId: item.id, completed: true } });
    expect(upd.isError).toBeFalsy();
    const list = await client.callTool({ name: 'list_study_plans', arguments: {} });
    expect((list.structuredContent as { plans: { completedMinutes: number }[] }).plans[0].completedMinutes).toBeGreaterThan(0);

    const bad = await client.callTool({ name: 'create_study_plan', arguments: { ...args, targetDate: '2030-05-01' } });
    expect(bad.isError).toBe(true);
    expect((bad.content as { text: string }[])[0].text).toMatch(/must be after/);
  });

  it('handles many repeated tool calls on one session', async () => {
    for (let i = 0; i < 25; i++) {
      const res = await client.callTool({ name: 'list_tasks', arguments: { limit: 5 } });
      expect(res.isError).toBeFalsy();
    }
  });

  it('records tool executions without storing arguments', () => {
    const cols = (server.db.prepare('PRAGMA table_info(tool_execution_logs)').all() as { name: string }[]).map((c) => c.name);
    expect(cols).not.toContain('arguments');
    const n = (server.db.prepare('SELECT COUNT(*) n FROM tool_execution_logs').get() as { n: number }).n;
    expect(n).toBeGreaterThan(10);
  });
});

describe('persistence and reconnection', () => {
  it('data survives a server restart; NickMcpClient reconnects with a new session', async () => {
    const t = tempDir();
    const file = path.join(t.dir, 'nick.db');
    const s = await startTestServer(file);
    const c = new NickMcpClient(s.url, 'restart-test');
    const created = await c.callTool('create_task', { title: 'Persist me' });
    expect(created.ok).toBe(true);
    const firstSession = (await c.info()).sessionId;
    const port = s.port;
    await s.stop();

    // restart on the same port and file
    const { openDatabase } = await import('../lib/db/sqlite');
    const { nickMigrations } = await import('../lib/db/nickSchema');
    const { createHttpApp } = await import('../server/httpApp');
    const { createRepos } = await import('../server/mcpServer');
    const db = openDatabase(file, nickMigrations);
    const { app, closeAll } = createHttpApp(createRepos(db), { host: '127.0.0.1', log: () => undefined });
    const httpServer = await new Promise<http.Server>((resolve) => {
      const srv = app.listen(port, '127.0.0.1', () => resolve(srv));
    });
    try {
      const listed = await c.callTool('list_tasks', {});
      expect(listed.ok).toBe(true);
      expect((listed.structured as { tasks: { title: string }[] }).tasks.map((x) => x.title)).toEqual(['Persist me']);
      expect((await c.info()).sessionId).not.toBe(firstSession);
    } finally {
      await c.close();
      await closeAll();
      httpServer.closeAllConnections();
      await new Promise<void>((r) => httpServer.close(() => r()));
      db.close();
      t.cleanup();
    }
  });

  it('reports a clear error when the server is unreachable', async () => {
    const c = new NickMcpClient('http://127.0.0.1:1/mcp', 'unreachable-test');
    const res = await c.callTool('list_tasks', {});
    expect(res.ok).toBe(false);
    expect(res.transportError).toBe(true);
    expect(res.text).toMatch(/Could not connect to the NICK MCP server/);
  });
});
