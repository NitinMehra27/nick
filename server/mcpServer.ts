import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import type { DB } from '../lib/db/sqlite';
import { localToday } from '../lib/dates';
import { MemoryRepository, detectSensitive } from '../lib/repositories/memories';
import { StudyPlanRepository } from '../lib/repositories/studyPlans';
import { TaskRepository } from '../lib/repositories/tasks';
import { ToolLogRepository } from '../lib/repositories/toolLogs';
import * as s from '../lib/schemas';
import { StudyPlanError, generateStudyPlan } from '../lib/studyPlanner';

export const SERVER_INFO = { name: 'nick-mcp-server', version: '0.1.0' };

/** Expected failures whose message is safe to show to the caller. */
class ToolError extends Error {}

export interface NickRepos {
  tasks: TaskRepository;
  memories: MemoryRepository;
  plans: StudyPlanRepository;
  logs: ToolLogRepository;
}

export function createRepos(db: DB): NickRepos {
  return {
    tasks: new TaskRepository(db),
    memories: new MemoryRepository(db),
    plans: new StudyPlanRepository(db),
    logs: new ToolLogRepository(db),
  };
}

type Result = { summary: string; data: Record<string, unknown> };

function ok({ summary, data }: Result): CallToolResult {
  return {
    content: [{ type: 'text', text: `${summary}\n${JSON.stringify(data)}` }],
    structuredContent: { success: true, summary, ...data },
  };
}

function fail(message: string): CallToolResult {
  return { isError: true, content: [{ type: 'text', text: message }] };
}

const notFound = (kind: string, id: number) => new ToolError(`${kind} ${id} was not found.`);

/**
 * Builds an McpServer with all NICK tools registered. A new instance is created per
 * Streamable HTTP session; all instances share the same repositories (one SQLite file).
 */
export function createNickMcpServer(repos: NickRepos, log: (line: string) => void = console.log): McpServer {
  const server = new McpServer(SERVER_INFO, {
    capabilities: { logging: {} },
    instructions:
      'NICK manages a single local user\'s tasks, study plans and saved memories. Dates use YYYY-MM-DD. ' +
      'Destructive tools require confirm=true, which a client must only send after the human explicitly confirmed.',
  });

  const run = <A>(name: string, handler: (args: A) => Result) => {
    return async (args: A): Promise<CallToolResult> => {
      const started = performance.now();
      try {
        const result = handler(args);
        const ms = performance.now() - started;
        repos.logs.record(name, 'success', ms, result.summary);
        log(`[mcp] tool=${name} status=success ms=${ms.toFixed(1)}`);
        return ok(result);
      } catch (err) {
        const ms = performance.now() - started;
        const expected = err instanceof ToolError || err instanceof StudyPlanError;
        const message = expected ? (err as Error).message : `NICK could not complete ${name} because of an internal storage error.`;
        try {
          repos.logs.record(name, 'error', ms, message);
        } catch {
          // logging must never mask the original failure
        }
        log(`[mcp] tool=${name} status=error ms=${ms.toFixed(1)}${expected ? '' : ` internal=${(err as Error)?.name ?? 'Error'}`}`);
        return fail(message);
      }
    };
  };

  // ---------------- tasks ----------------

  server.registerTool(
    'create_task',
    {
      title: 'Create task',
      description: 'Create a new task. Only title is required. Use dueDate in YYYY-MM-DD.',
      inputSchema: s.createTaskInput,
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
    },
    run('create_task', (a: z.infer<typeof s.createTaskInput>) => {
      const task = repos.tasks.create(a);
      return { summary: `Created task #${task.id} "${task.title}".`, data: { taskId: task.id, task } };
    }),
  );

  server.registerTool(
    'list_tasks',
    {
      title: 'List tasks',
      description: 'List tasks, optionally filtered by status, priority, category, due date range or a text query.',
      inputSchema: s.listTasksInput,
      annotations: { readOnlyHint: true },
    },
    run('list_tasks', (a: z.infer<typeof s.listTasksInput>) => {
      const tasks = repos.tasks.list(a);
      const preview = tasks.slice(0, 10).map((t) => `#${t.id} "${t.title}"${t.status === 'completed' ? ' (done)' : ''}`).join(', ');
      return {
        summary: `Found ${tasks.length} task${tasks.length === 1 ? '' : 's'}${tasks.length ? `: ${preview}${tasks.length > 10 ? ', …' : ''}` : ''}.`,
        data: { count: tasks.length, today: localToday(), tasks, counts: repos.tasks.counts() },
      };
    }),
  );

  server.registerTool(
    'get_task',
    { title: 'Get task', description: 'Get one task by its numeric ID.', inputSchema: s.taskIdInput, annotations: { readOnlyHint: true } },
    run('get_task', (a: z.infer<typeof s.taskIdInput>) => {
      const task = repos.tasks.get(a.taskId);
      if (!task) throw notFound('Task', a.taskId);
      return { summary: `Task #${task.id} "${task.title}" is ${task.status}.`, data: { task } };
    }),
  );

  server.registerTool(
    'update_task',
    {
      title: 'Update task',
      description: 'Change fields of an existing task (title, description, status, priority, dueDate, category).',
      inputSchema: s.updateTaskInput,
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
    },
    run('update_task', (a: z.infer<typeof s.updateTaskInput>) => {
      const { taskId, ...patch } = a;
      const task = repos.tasks.update(taskId, patch);
      if (!task) throw notFound('Task', taskId);
      return { summary: `Updated task #${task.id} "${task.title}".`, data: { task } };
    }),
  );

  server.registerTool(
    'complete_task',
    {
      title: 'Complete task',
      description: 'Mark an existing task as completed.',
      inputSchema: s.taskIdInput,
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
    },
    run('complete_task', (a: z.infer<typeof s.taskIdInput>) => {
      const task = repos.tasks.complete(a.taskId);
      if (!task) throw notFound('Task', a.taskId);
      return { summary: `Marked task #${task.id} "${task.title}" as completed.`, data: { task } };
    }),
  );

  server.registerTool(
    'delete_task',
    {
      title: 'Delete task',
      description: 'Permanently delete a task. Requires confirm=true after the user explicitly confirmed.',
      inputSchema: s.deleteTaskInput,
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true },
    },
    run('delete_task', (a: z.infer<typeof s.deleteTaskInput>) => {
      const task = repos.tasks.get(a.taskId);
      if (!task || !repos.tasks.delete(a.taskId)) throw notFound('Task', a.taskId);
      return { summary: `Deleted task #${task.id} "${task.title}".`, data: { deletedTaskId: task.id, title: task.title } };
    }),
  );

  // ---------------- study plans ----------------

  server.registerTool(
    'create_study_plan',
    {
      title: 'Create study plan',
      description:
        'Generate a study schedule from subjects, a target date and daily available hours. ' +
        'By default returns a preview only; save=true stores it (only after the user approved the preview).',
      inputSchema: s.createStudyPlanInput,
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
    },
    run('create_study_plan', (a: z.infer<typeof s.createStudyPlanInput>) => {
      const { save, createTasks, ...request } = a;
      const plan = generateStudyPlan(request);
      if (!save) {
        return {
          summary: `Preview: ${plan.items.length} sessions, ${Math.round(plan.totalMinutes / 60)}h total. Not saved yet.`,
          data: { saved: false, plan },
        };
      }
      const saved = repos.plans.save(plan, request, { createTasks });
      const tasksNote = createTasks ? ` and ${saved.items.length} tasks` : '';
      return { summary: `Saved study plan #${saved.id} "${saved.title}"${tasksNote}.`, data: { saved: true, planId: saved.id, plan: saved } };
    }),
  );

  server.registerTool(
    'get_study_plan',
    {
      title: 'Get study plan',
      description: 'Get a saved study plan by ID, or the most recent active plan when planId is omitted.',
      inputSchema: s.getStudyPlanInput,
      annotations: { readOnlyHint: true },
    },
    run('get_study_plan', (a: z.infer<typeof s.getStudyPlanInput>) => {
      const plan = a.planId ? repos.plans.get(a.planId) : repos.plans.latestActive();
      if (!plan) throw a.planId ? notFound('Study plan', a.planId) : new ToolError('There is no saved study plan yet.');
      return { summary: `Study plan #${plan.id} "${plan.title}" has ${plan.items.length} sessions.`, data: { plan } };
    }),
  );

  server.registerTool(
    'list_study_plans',
    { title: 'List study plans', description: 'List saved study plans with progress.', inputSchema: z.strictObject({}), annotations: { readOnlyHint: true } },
    run('list_study_plans', () => {
      const plans = repos.plans.list();
      return { summary: `Found ${plans.length} saved study plan${plans.length === 1 ? '' : 's'}.`, data: { plans } };
    }),
  );

  server.registerTool(
    'update_study_plan_item',
    {
      title: 'Update study session',
      description: 'Edit one session of a saved study plan: mark completed, change minutes, date or topic.',
      inputSchema: s.updateStudyPlanItemInput,
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
    },
    run('update_study_plan_item', (a: z.infer<typeof s.updateStudyPlanItemInput>) => {
      const { planId, itemId, ...patch } = a;
      const plan = repos.plans.updateItem(planId, itemId, patch);
      if (!plan) throw new ToolError(`Session ${itemId} was not found in study plan ${planId}.`);
      return { summary: `Updated session ${itemId} of study plan #${planId}.`, data: { plan } };
    }),
  );

  server.registerTool(
    'delete_study_plan',
    {
      title: 'Delete study plan',
      description: 'Permanently delete a saved study plan. Tasks created from it are kept. Requires confirm=true.',
      inputSchema: s.deleteStudyPlanInput,
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true },
    },
    run('delete_study_plan', (a: z.infer<typeof s.deleteStudyPlanInput>) => {
      if (!repos.plans.delete(a.planId)) throw notFound('Study plan', a.planId);
      return { summary: `Deleted study plan #${a.planId}.`, data: { deletedPlanId: a.planId } };
    }),
  );

  // ---------------- memory ----------------

  server.registerTool(
    'save_memory',
    {
      title: 'Save memory',
      description:
        'Save one concise, durable user preference, goal, project or fact for future conversations. ' +
        'Write it about the user, e.g. "User prefers 45-minute study sessions". Never save passwords, secrets or sensitive identifiers.',
      inputSchema: s.saveMemoryInput,
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
    },
    run('save_memory', (a: z.infer<typeof s.saveMemoryInput>) => {
      const reason = detectSensitive(a.content);
      if (reason) throw new ToolError(`Not saved: the content ${reason}. NICK does not store credentials or sensitive identifiers.`);
      const existing = repos.memories.findExact(a.content);
      if (existing) return { summary: `Memory #${existing.id} already exists.`, data: { memoryId: existing.id, memory: existing, duplicate: true } };
      const memory = repos.memories.create({ ...a, source: a.source ?? 'inferred' });
      return { summary: `Saved memory #${memory.id}.`, data: { memoryId: memory.id, memory, duplicate: false } };
    }),
  );

  server.registerTool(
    'search_memory',
    {
      title: 'Search memory',
      description: 'Find saved memories relevant to keywords. Omit query to list the most recent memories.',
      inputSchema: s.searchMemoryInput,
      annotations: { readOnlyHint: true },
    },
    run('search_memory', (a: z.infer<typeof s.searchMemoryInput>) => {
      const memories = repos.memories.search(a);
      return { summary: `Found ${memories.length} matching memor${memories.length === 1 ? 'y' : 'ies'}.`, data: { count: memories.length, memories } };
    }),
  );

  server.registerTool(
    'update_memory',
    {
      title: 'Update memory',
      description: 'Correct the content or category of a saved memory.',
      inputSchema: s.updateMemoryInput,
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
    },
    run('update_memory', (a: z.infer<typeof s.updateMemoryInput>) => {
      if (a.content) {
        const reason = detectSensitive(a.content);
        if (reason) throw new ToolError(`Not saved: the content ${reason}.`);
      }
      const memory = repos.memories.update(a.memoryId, a);
      if (!memory) throw notFound('Memory', a.memoryId);
      return { summary: `Updated memory #${memory.id}.`, data: { memory } };
    }),
  );

  server.registerTool(
    'delete_memory',
    {
      title: 'Delete memory',
      description: 'Permanently delete one saved memory. Requires confirm=true after the user explicitly confirmed.',
      inputSchema: s.deleteMemoryInput,
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true },
    },
    run('delete_memory', (a: z.infer<typeof s.deleteMemoryInput>) => {
      if (!repos.memories.delete(a.memoryId)) throw notFound('Memory', a.memoryId);
      return { summary: `Deleted memory #${a.memoryId}.`, data: { deletedMemoryId: a.memoryId } };
    }),
  );

  server.registerTool(
    'clear_memories',
    {
      title: 'Clear all memory',
      description: 'Delete ALL saved memories. Requires confirm=true after the user explicitly confirmed.',
      inputSchema: s.clearMemoriesInput,
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true },
    },
    run('clear_memories', () => {
      const deleted = repos.memories.clear();
      return { summary: `Cleared ${deleted} memor${deleted === 1 ? 'y' : 'ies'}.`, data: { deletedCount: deleted } };
    }),
  );

  return server;
}
