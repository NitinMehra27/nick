import { randomUUID } from 'node:crypto';
import { addDays, localToday } from '../../lib/dates';
import type { ToolCallOutcome } from '../../lib/mcpClient';
import type { Tool } from '@modelcontextprotocol/sdk/types.js';
import { CONFIRMATION_REQUIRED, TOOL_PURPOSE, dropCopiedSubjectHours, hasExplicitRememberIntent, normalizeArgs, stableKey, toModelTools } from './toolPolicy';
import {
  ModelError,
  type ActivityRecord,
  type AgentEvent,
  type AgentResultView,
  type AgentStatus,
  type ChatMessage,
  type MemoryContextItem,
  type ModelAdapter,
  type PendingActionView,
} from './types';

export interface AgentMcp {
  listTools(): Promise<Tool[]>;
  callTool(name: string, args: Record<string, unknown>, timeoutMs?: number): Promise<ToolCallOutcome>;
}

export interface AgentDeps {
  model: ModelAdapter;
  mcp: AgentMcp;
  limits: { maxIterations: number; maxToolCalls: number; toolTimeoutMs: number };
  createPendingAction: (a: { toolName: string; args: Record<string, unknown>; summary: string; preview?: unknown }) => PendingActionView;
  recordActivity?: (a: ActivityRecord) => void;
  now?: () => Date;
  /** Aborted when the user presses Stop or disconnects. A tool call already in flight is allowed to finish. */
  signal?: AbortSignal;
}

export interface AgentInput {
  message: string;
  history: { role: 'user' | 'assistant'; content: string }[];
  /** Summaries of real tool results from recent turns of this conversation. */
  recentResults?: string[];
}

export interface AgentResult extends AgentResultView {
  activity: ActivityRecord[];
  pendingActions: PendingActionView[];
  memoryContext: MemoryContextItem[];
}

const MAX_TOOL_RESULT_CHARS = 1500;
const MAX_LISTED_ITEMS = 15;
const HISTORY_MESSAGES = 6;
const WEEKDAY = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

/**
 * The system prompt only changes once a day, so Ollama can reuse its cached prompt prefix
 * (system + tool schemas). Per-request context goes into the user turn instead; measured on
 * a CPU-only laptop this cut prompt processing from ~57 s to ~1 s per model call.
 */
export function systemPrompt(now: Date): string {
  const today = localToday(now);
  return [
    'You are NICK (Natural-language Intelligence for Contextual Knowledge), a local personal assistant. You manage the user\'s tasks, study plans and saved memories by calling tools, and you help with everyday questions.',
    `Today is ${WEEKDAY[now.getDay()]}, ${today}. Tomorrow is ${addDays(today, 1)}.`,
    'Rules:',
    '- Use tools to read or change tasks, study plans and memories. Never invent IDs, tasks, plans or results.',
    '- Only say an action happened if a tool result in this conversation confirms it.',
    '- If a tool returns an error, explain it briefly, then fix the arguments or ask the user.',
    '- Dates must be YYYY-MM-DD. Convert words like "tomorrow" or "Friday" using today\'s date.',
    '- For any question about the user\'s tasks, call list_tasks to get current data. To act on a task without a known ID, call list_tasks with a query first.',
    '- To delete something, call the delete tool; the app will ask the user to confirm.',
    '- Call save_memory only when the user asks you to remember something or states a lasting preference, goal or project. Never store passwords or secrets.',
    '- For a study plan you need subjects, a target date and hours per day. Ask for anything missing, then call create_study_plan. Apply saved preferences (for example session length) and do not invent topics or per-subject hours.',
    '- For greetings, thanks or small talk, reply briefly and naturally without calling any tool.',
    '- For general questions that do not involve the user\'s tasks, plans or memories, answer briefly from your own knowledge without tools. If you are not sure, say so. You cannot browse the web or see live information such as news, weather or prices.',
    '- A user message may start with SAVED MEMORY that NICK already retrieved for you. Use it to answer questions about the user\'s preferences, goals and projects directly.',
    '- Mention saved memory only when it is relevant. Never tell the user that no memories matched unless they asked about their memory. If the user asks about a preference that is not saved, say you do not have it saved. Do not guess.',
    '- Keep replies short and plain. When there are many items, list at most 5 and state the total.',
  ].join('\n');
}

/**
 * With no saved memory the block is left out entirely: an explicit "nothing matches" line made
 * qwen2.5:3b call search_memory on a plain "Hello" and reply that no memories matched.
 */
function withContext(message: string, memories: MemoryContextItem[], relevance: 'matched' | 'recent' | 'none', recentResults: string[]): string {
  if (memories.length === 0 && recentResults.length === 0) return message;
  const block =
    memories.length === 0
      ? ''
      : `SAVED MEMORY (${relevance === 'recent' ? 'most recent entries, may not be relevant' : 'relevant entries'}; first-person statements are the user speaking about themselves):\n` +
        memories.map((m) => `- [memory #${m.id}, ${m.category}, ${m.source === 'user' ? 'saved by the user' : 'inferred earlier'}] ${m.content}`).join('\n');
  const results = recentResults.length
    ? `${block ? '\n\n' : ''}EARLIER TOOL RESULTS IN THIS CONVERSATION (may be outdated; call a tool to act or re-check):\n${recentResults.map((r) => `- ${r}`).join('\n')}`
    : '';
  return `${block}${results}\n\nUSER MESSAGE:\n${message}`;
}

type StoredTurn = { role: 'user' | 'assistant'; content: string; meta?: { activity?: ActivityRecord[] } | null };

/**
 * Splits stored messages into plain prose history plus the real tool results of recent
 * assistant turns. The results are shown to the model as context in the user turn (not inside
 * its own past replies, which a small model would imitate) so it can reuse IDs correctly.
 */
export function historyFromMessages(stored: StoredTurn[]): Pick<AgentInput, 'history' | 'recentResults'> {
  const recentResults = stored
    .filter((m) => m.role === 'assistant')
    .slice(-3)
    .flatMap((m) => (m.meta?.activity ?? []).filter((a) => a.status === 'success' && a.tool !== 'search_memory' && a.summary).map((a) => a.summary!));
  return { history: stored.map((m) => ({ role: m.role, content: m.content })), recentResults: recentResults.slice(-8) };
}

const CLAIM_PHRASE =
  /\b(?:i(?:'ve| have)?|has been|have been)\s+(?:now\s+|successfully\s+|also\s+)?(created|added|scheduled|deleted|removed|completed|marked|updated|changed|renamed|saved|remembered|noted)\b/gi;
const CLAIM_TOOLS: Record<string, string[]> = {
  created: ['create_task', 'save_memory'],
  added: ['create_task', 'save_memory'],
  scheduled: ['create_task'],
  deleted: [], // deletions never run inside an agent turn; they wait for the user's confirmation
  removed: [],
  completed: ['complete_task', 'update_task'],
  marked: ['complete_task', 'update_task'],
  updated: ['update_task', 'update_memory'],
  changed: ['update_task', 'update_memory'],
  renamed: ['update_task'],
  saved: ['save_memory', 'update_memory'],
  remembered: ['save_memory'],
  noted: ['save_memory'],
};

/** Returns the claimed action verbs that no successful tool call in this run backs up. */
export function unbackedClaims(text: string, succeededTools: Set<string>): string[] {
  const verbs = [...text.matchAll(CLAIM_PHRASE)].map((m) => m[1].toLowerCase());
  return [...new Set(verbs.filter((v) => !CLAIM_TOOLS[v].some((t) => succeededTools.has(t))))];
}

function firstLine(text: string): string {
  return text.split('\n')[0].slice(0, 200);
}

type TaskLike = { id: number; title: string; status: string; priority: string; dueDate: string | null; overdue?: boolean };
const compactTask = (t: TaskLike) =>
  `#${t.id} "${t.title}" ${t.status}, ${t.priority} priority${t.dueDate ? `, due ${t.dueDate}${t.overdue ? ' (overdue)' : ''}` : ''}`;

/**
 * What the model sees of a tool result. On a CPU-only machine every prompt token costs
 * ~65 ms, so results are compacted (e.g. a 30-task list once pushed a prompt to 3.3k tokens
 * and caused a timeout). The UI still receives the full structured result.
 */
export function toolResultForModel(tool: string, outcome: Pick<ToolCallOutcome, 'ok' | 'text' | 'structured'>): string {
  if (!outcome.ok) return `Error: ${outcome.text}`.slice(0, MAX_TOOL_RESULT_CHARS);
  const s = outcome.structured ?? {};
  let head = String(s.summary ?? firstLine(outcome.text));
  let body = '';
  if (Array.isArray(s.tasks)) {
    const tasks = s.tasks as TaskLike[];
    const more = tasks.length - MAX_LISTED_ITEMS;
    head = `Found ${tasks.length} task${tasks.length === 1 ? '' : 's'}${more > 0 ? ` (showing ${MAX_LISTED_ITEMS}; …and ${more} more, use filters or a query to narrow down)` : ''}.`;
    body = tasks.slice(0, MAX_LISTED_ITEMS).map((t) => `- ${compactTask(t)}`).join('\n');
  } else if (s.task && typeof s.task === 'object') {
    body = compactTask(s.task as TaskLike);
  } else if (Array.isArray(s.memories)) {
    body = (s.memories as { id: number; content: string; source: string }[])
      .slice(0, MAX_LISTED_ITEMS)
      .map((m) => `- memory #${m.id} (${m.source === 'user' ? 'saved by user' : 'inferred'}): ${m.content}`)
      .join('\n');
  } else if (s.plan && typeof s.plan === 'object') {
    const p = s.plan as { id?: number; title: string; targetDate: string; totalMinutes: number; items: { date: string; subject: string; topic: string | null; minutes: number; completed: boolean }[] };
    const next = p.items.filter((i) => !i.completed).slice(0, 8);
    body =
      `Plan${p.id ? ` #${p.id}` : ''} "${p.title}", exam ${p.targetDate}, ${(p.totalMinutes / 60).toFixed(1)} h in ${p.items.length} sessions. Next sessions:\n` +
      next.map((i) => `- ${i.date} ${i.subject}${i.topic ? ` (${i.topic})` : ''} ${i.minutes} min`).join('\n');
  }
  return (body ? `${head}\n${body}` : head).slice(0, MAX_TOOL_RESULT_CHARS);
}

/**
 * Bounded agent loop: model -> validated tool call -> real MCP tools/call -> result back to model.
 * Destructive tools and study-plan saving are converted into pending actions for the user.
 */
export async function runAgent(input: AgentInput, deps: AgentDeps, emit: (e: AgentEvent) => void): Promise<AgentResult> {
  const now = deps.now?.() ?? new Date();
  const activity: ActivityRecord[] = [];
  const pendingActions: PendingActionView[] = [];
  const notes: string[] = [];
  let toolCalls = 0;
  let iterations = 0;

  const track = async (tool: string, args: Record<string, unknown>, purpose: string): Promise<ToolCallOutcome> => {
    const record: ActivityRecord = { id: randomUUID(), tool, purpose, status: 'running', origin: 'agent', startedAt: new Date().toISOString() };
    activity.push(record);
    emit({ type: 'activity', activity: { ...record } });
    const outcome = await deps.mcp.callTool(tool, args, deps.limits.toolTimeoutMs);
    record.status = outcome.ok ? 'success' : 'error';
    record.durationMs = outcome.durationMs;
    record.summary = firstLine(outcome.text);
    emit({ type: 'activity', activity: { ...record } });
    deps.recordActivity?.({ ...record });
    return outcome;
  };

  const markSkipped = (tool: string, purpose: string, summary: string, status: 'skipped' | 'awaiting_confirmation' | 'error' = 'skipped') => {
    const record: ActivityRecord = { id: randomUUID(), tool, purpose, status, origin: 'agent', startedAt: new Date().toISOString(), summary };
    activity.push(record);
    emit({ type: 'activity', activity: record });
    deps.recordActivity?.({ ...record });
  };

  const finish = (message: string, status: AgentStatus, systemComposed: boolean): AgentResult => {
    const result: AgentResult = { message, status, systemComposed, notes, iterations, toolCalls, activity, pendingActions, memoryContext };
    emit({ type: 'final', result: { message, status, systemComposed, notes, iterations, toolCalls } });
    return result;
  };

  const stopped = () => finish(`Stopped at your request.${completedActions(activity)}`, 'cancelled', true);

  // 1. Retrieve relevant saved context through MCP (never the whole memory table).
  let memoryContext: MemoryContextItem[] = [];
  let relevance: 'matched' | 'recent' | 'none' = 'none';
  const ctx = await track('search_memory', { query: input.message.slice(0, 300), limit: 5 }, 'Retrieve relevant saved memory');
  if (!ctx.ok && ctx.transportError) {
    return finish(`I can't reach NICK's MCP server right now, so I can't read or change your data. ${ctx.text}`, 'mcp_error', true);
  }
  const pick = (o: ToolCallOutcome) =>
    ((o.structured?.memories as MemoryContextItem[] | undefined) ?? []).map(({ id, content, category, source }) => ({ id, content, category, source }));
  memoryContext = ctx.ok ? pick(ctx) : [];
  relevance = memoryContext.length ? 'matched' : 'none';
  if (ctx.ok && memoryContext.length === 0) {
    const recent = await track('search_memory', { limit: 3 }, 'Load recent saved memory');
    memoryContext = recent.ok ? pick(recent) : [];
    relevance = memoryContext.length ? 'recent' : 'none';
  }
  emit({ type: 'context', memories: memoryContext, relevance });
  if (deps.signal?.aborted) return stopped();

  // 2. Discover tools from the live MCP server.
  let tools;
  try {
    tools = toModelTools(await deps.mcp.listTools());
  } catch (err) {
    return finish(`I couldn't load NICK's tools from the MCP server: ${(err as Error).message}`, 'mcp_error', true);
  }
  const allowed = new Set(tools.map((t) => t.name));

  const messages: ChatMessage[] = [
    { role: 'system', content: systemPrompt(now) },
    ...input.history.slice(-HISTORY_MESSAGES).map((m) => ({ role: m.role, content: m.content.slice(0, 2000) })),
    { role: 'user', content: withContext(input.message, memoryContext, relevance, input.recentResults ?? []) },
  ];
  const seen = new Set<string>();
  let duplicates = 0;
  let corrected = false;
  const rememberIntent = hasExplicitRememberIntent(input.message);

  // 3. Bounded loop.
  while (iterations < deps.limits.maxIterations) {
    if (deps.signal?.aborted) return stopped();
    iterations++;
    emit({ type: 'status', message: iterations === 1 ? 'Thinking with the local model…' : 'Reading tool results…' });
    let turn;
    try {
      turn = await deps.model.chat(messages, tools, deps.signal);
    } catch (err) {
      if (deps.signal?.aborted) return stopped();
      const message =
        err instanceof ModelError
          ? `The local AI model could not answer: ${err.message}`
          : `The local AI model failed unexpectedly: ${(err as Error)?.message ?? 'unknown error'}`;
      const status: AgentStatus = err instanceof ModelError && err.kind === 'bad_response' ? 'invalid_output' : 'model_error';
      return finish(message, status, true);
    }

    if (turn.toolCalls.length === 0) {
      const text = turn.content.trim();
      if (!text) return finish('The local model returned an empty response. Please try rephrasing your request.', 'invalid_output', true);
      const succeeded = new Set(activity.filter((a) => a.status === 'success').map((a) => a.tool));
      const claims = unbackedClaims(text, succeeded);
      if (claims.length === 0) {
        if (turn.truncated) notes.push('This reply reached the length limit and was cut short. The Tasks, Study plans and Memory pages show complete data.');
        return finish(text, 'completed', false);
      }
      if (!corrected) {
        // One corrective turn: the reply claims an action that did not happen.
        corrected = true;
        notes.push(`The model's first draft claimed an action (${claims.join(', ')}) that no tool had performed; it was asked to correct itself.`);
        messages.push({ role: 'assistant', content: text });
        messages.push({
          role: 'user',
          content:
            'NICK SYSTEM CHECK: your reply says something was ' +
            claims.join('/') +
            ', but no matching tool call succeeded in this turn, so it did NOT happen. ' +
            'If the user wants it, call the right tool now (use list_tasks to find IDs). Otherwise reply again without claiming it was done.',
        });
        continue;
      }
      return finish(
        'I could not complete that: the model described an action, but no tool actually performed it, so nothing was changed. Please try again with more detail (for example the task number).',
        'invalid_output',
        true,
      );
    }
    if (turn.mode === 'text') notes.push('Tool call was recovered from the model\'s text output.');

    messages.push({ role: 'assistant', content: turn.content ?? '', toolCalls: turn.toolCalls });

    for (const call of turn.toolCalls) {
      if (deps.signal?.aborted) return stopped();
      const purpose = TOOL_PURPOSE[call.name] ?? call.name;
      const reply = (content: string) => messages.push({ role: 'tool', toolName: call.name, content: content.slice(0, MAX_TOOL_RESULT_CHARS) });

      if (toolCalls >= deps.limits.maxToolCalls) {
        notes.push(`Stopped after ${deps.limits.maxToolCalls} tool calls (safety limit).`);
        return finish(summarizeStop(activity, 'I reached the tool-call limit for one request.'), 'limit_reached', true);
      }
      if (!allowed.has(call.name)) {
        markSkipped(call.name || '(unnamed)', 'Rejected tool request', 'Unknown or disallowed tool', 'error');
        reply(`Error: "${call.name}" is not an available tool. Available tools: ${[...allowed].join(', ')}.`);
        continue;
      }
      let args: Record<string, unknown>;
      try {
        args = normalizeArgs(call.name, call.arguments);
      } catch {
        markSkipped(call.name, purpose, 'Malformed arguments from the model', 'error');
        reply('Error: the arguments were not a valid JSON object. Call the tool again with valid arguments.');
        continue;
      }
      const key = stableKey(call.name, args);
      if (seen.has(key)) {
        duplicates++;
        markSkipped(call.name, purpose, 'Identical repeated call skipped');
        reply('This exact call was already made; its result is above. Do not repeat it. Answer the user now.');
        if (duplicates >= 2) {
          notes.push('Stopped because the model kept repeating the same tool call.');
          return finish(summarizeStop(activity, 'I stopped because the model kept repeating the same step.'), 'limit_reached', true);
        }
        continue;
      }
      seen.add(key);
      toolCalls++;

      // --- confirmation-required: never executed here ---
      if (CONFIRMATION_REQUIRED.has(call.name)) {
        const target = await describeDeletionTarget(call.name, args, track);
        if (!target.ok) {
          reply(`Error: ${target.error}`);
          continue;
        }
        const action = deps.createPendingAction({ toolName: call.name, args: { ...args, confirm: true }, summary: target.summary });
        pendingActions.push(action);
        markSkipped(call.name, purpose, `Waiting for your confirmation: ${target.summary}`, 'awaiting_confirmation');
        emit({ type: 'confirmation_required', action });
        return finish(`Please confirm: ${target.summary}. Nothing has been deleted yet. Use the Confirm button to proceed or Cancel to keep it.`, 'awaiting_confirmation', true);
      }

      // --- study plan: preview only, saving needs approval ---
      if (call.name === 'create_study_plan') {
        const fixed = dropCopiedSubjectHours(args, input.message);
        if (fixed.dropped) {
          args = fixed.args;
          notes.push('Per-subject hours that only repeated your daily availability were ignored; time was split across subjects instead.');
        }
        const outcome = await track('create_study_plan', { ...args, save: false }, 'Draft a study plan (preview, not saved)');
        if (!outcome.ok) {
          reply(`Error: ${outcome.text}`);
          continue;
        }
        const plan = outcome.structured?.plan as { title: string; items: unknown[]; totalMinutes: number; warnings: string[]; startDate: string; targetDate: string };
        const summary = `Save study plan "${plan.title}" (${plan.items.length} sessions, ${(plan.totalMinutes / 60).toFixed(1)} h)`;
        const action = deps.createPendingAction({ toolName: 'create_study_plan', args: { ...args, save: true, createTasks: true }, summary, preview: plan });
        pendingActions.push(action);
        emit({ type: 'confirmation_required', action });
        const warn = plan.warnings.length ? ` Notes: ${plan.warnings.join(' ')}` : '';
        return finish(
          `Here is a proposed study plan (not saved yet): ${plan.items.length} sessions from ${plan.startDate} to the day before ${plan.targetDate}, ${(plan.totalMinutes / 60).toFixed(1)} hours in total. It was generated by a simple scheduling rule, so adjust it if it doesn't suit you.${warn} Review it below and choose Save plan to keep it and add the sessions as tasks.`,
          'awaiting_confirmation',
          true,
        );
      }

      if (call.name === 'save_memory') args = { ...args, source: rememberIntent ? 'user' : 'inferred' };

      const outcome = await track(call.name, args, purpose);
      if (!outcome.ok && outcome.transportError) {
        return finish(`I couldn't complete "${purpose}" because the MCP server did not respond. ${outcome.text}`, 'mcp_error', true);
      }
      reply(toolResultForModel(call.name, outcome));
    }
  }

  notes.push(`Stopped after ${deps.limits.maxIterations} reasoning steps (safety limit).`);
  return finish(summarizeStop(activity, 'I reached the step limit for one request.'), 'limit_reached', true);
}

async function describeDeletionTarget(
  tool: string,
  args: Record<string, unknown>,
  track: (tool: string, args: Record<string, unknown>, purpose: string) => Promise<ToolCallOutcome>,
): Promise<{ ok: true; summary: string } | { ok: false; error: string }> {
  if (tool === 'delete_task') {
    if (typeof args.taskId !== 'number') return { ok: false, error: 'delete_task needs a numeric taskId. Use list_tasks to find it.' };
    const found = await track('get_task', { taskId: args.taskId }, 'Look up the task before asking to delete it');
    if (!found.ok) return { ok: false, error: `${found.text} Call list_tasks with a query to find the correct task ID.` };
    const task = found.structured?.task as { id: number; title: string };
    return { ok: true, summary: `delete task #${task.id} "${task.title}"` };
  }
  if (tool === 'delete_memory') {
    if (typeof args.memoryId !== 'number') return { ok: false, error: 'delete_memory needs a numeric memoryId. Use search_memory to find it.' };
    return { ok: true, summary: `delete memory #${args.memoryId}` };
  }
  return { ok: true, summary: tool.replace(/_/g, ' ') };
}

function completedActions(activity: ActivityRecord[]): string {
  const done = activity.filter((a) => a.status === 'success' && a.purpose !== 'Retrieve relevant saved memory' && a.purpose !== 'Load recent saved memory');
  return done.length ? ` Completed actions: ${done.map((a) => a.summary ?? a.purpose).join(' ')}` : ' No actions were completed.';
}

function summarizeStop(activity: ActivityRecord[], reason: string): string {
  return `${reason}${completedActions(activity)} Please rephrase or break the request into smaller steps.`;
}
