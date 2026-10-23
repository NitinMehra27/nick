import type { Tool } from '@modelcontextprotocol/sdk/types.js';
import type { ModelToolSpec } from './types';

/** Tools the model may request. Bulk/administrative tools (e.g. clear_memories) are UI-only. */
export const AGENT_TOOLS = [
  'create_task',
  'list_tasks',
  'get_task',
  'update_task',
  'complete_task',
  'delete_task',
  'create_study_plan',
  'get_study_plan',
  'save_memory',
  'search_memory',
  'update_memory',
  'delete_memory',
] as const;

/** Tools that are never executed on the model's request; the user must confirm first. */
export const CONFIRMATION_REQUIRED = new Set(['delete_task', 'delete_memory', 'delete_study_plan', 'clear_memories']);

/** Arguments the application controls; they are hidden from the model and overwritten. */
const APP_CONTROLLED_ARGS: Record<string, string[]> = {
  delete_task: ['confirm'],
  delete_memory: ['confirm'],
  save_memory: ['source', 'metadata'],
  create_study_plan: ['save', 'createTasks'],
};

export const TOOL_PURPOSE: Record<string, string> = {
  create_task: 'Create a task',
  list_tasks: 'Look up tasks',
  get_task: 'Read a task',
  update_task: 'Update a task',
  complete_task: 'Mark a task completed',
  delete_task: 'Delete a task',
  create_study_plan: 'Draft a study plan',
  get_study_plan: 'Read a study plan',
  list_study_plans: 'List study plans',
  update_study_plan_item: 'Update a study session',
  delete_study_plan: 'Delete a study plan',
  save_memory: 'Save a memory',
  search_memory: 'Search saved memory',
  update_memory: 'Update a memory',
  delete_memory: 'Delete a memory',
  clear_memories: 'Clear all memory',
};

function stripSchema(schema: Record<string, unknown>, hidden: string[]): Record<string, unknown> {
  const { $schema: _s, additionalProperties: _a, ...rest } = schema;
  const props = { ...((rest.properties as Record<string, unknown>) ?? {}) };
  for (const h of hidden) delete props[h];
  const required = ((rest.required as string[]) ?? []).filter((r) => !hidden.includes(r));
  return { ...rest, properties: props, ...(required.length ? { required } : { required: undefined }) };
}

/** Converts the MCP server's real tools/list result into model tool specs. */
export function toModelTools(mcpTools: Tool[]): ModelToolSpec[] {
  const allowed = new Set<string>(AGENT_TOOLS);
  return mcpTools
    .filter((t) => allowed.has(t.name))
    .map((t) => {
      let description = t.description ?? t.name;
      if (CONFIRMATION_REQUIRED.has(t.name)) description = `${description.split('.')[0]}. The app will ask the user to confirm before anything is deleted.`;
      if (t.name === 'create_study_plan') description = 'Draft a study schedule (preview). The app shows it to the user, who decides whether to save it.';
      return {
        name: t.name,
        description,
        parameters: stripSchema(t.inputSchema as Record<string, unknown>, APP_CONTROLLED_ARGS[t.name] ?? []),
      };
    });
}

/**
 * Normalizes model-produced arguments: parses JSON strings, drops null/empty-string values
 * (small models often emit them for unused optional fields) and app-controlled fields.
 */
export function normalizeArgs(tool: string, raw: unknown): Record<string, unknown> {
  let value = raw;
  if (typeof value === 'string') {
    const trimmed = value.trim();
    value = trimmed === '' ? {} : JSON.parse(trimmed);
  }
  if (value === undefined || value === null) value = {};
  if (typeof value !== 'object' || Array.isArray(value)) throw new Error('arguments must be a JSON object');
  const out: Record<string, unknown> = {};
  const hidden = APP_CONTROLLED_ARGS[tool] ?? [];
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    if (v === null || v === '' || hidden.includes(k)) continue;
    // small models sometimes send numeric IDs as strings
    if (/Id$/.test(k) && typeof v === 'string' && /^\d+$/.test(v)) out[k] = Number(v);
    else out[k] = v;
  }
  // small models often send study subjects as plain names: ["Math"] -> [{ name: "Math" }]
  if (tool === 'create_study_plan' && Array.isArray(out.subjects)) {
    out.subjects = out.subjects.map((s) => (typeof s === 'string' ? { name: s } : s));
  }
  return out;
}

/**
 * Observed with qwen2.5:3b: "2 hours a day" is also copied into every subject's `hours`,
 * shrinking the plan to 2 h per subject in total. Drop per-subject hours when they all equal
 * hoursPerDay and the user did not talk about per-subject or total hours.
 */
export function dropCopiedSubjectHours(args: Record<string, unknown>, userMessage: string): { args: Record<string, unknown>; dropped: boolean } {
  const subjects = args.subjects as { hours?: unknown }[] | undefined;
  if (!Array.isArray(subjects) || subjects.length === 0 || typeof args.hoursPerDay !== 'number') return { args, dropped: false };
  const allCopied = subjects.every((s) => s && typeof s === 'object' && s.hours === args.hoursPerDay);
  if (!allCopied || /\b(each|per subject|total)\b/i.test(userMessage)) return { args, dropped: false };
  return { args: { ...args, subjects: subjects.map(({ hours: _h, ...rest }) => rest) }, dropped: true };
}

export function stableKey(tool: string, args: Record<string, unknown>): string {
  const sort = (v: unknown): unknown =>
    Array.isArray(v) ? v.map(sort) : v && typeof v === 'object' ? Object.fromEntries(Object.entries(v).sort(([a], [b]) => a.localeCompare(b)).map(([k, x]) => [k, sort(x)])) : v;
  return `${tool}:${JSON.stringify(sort(args))}`;
}

const REMEMBER_INTENT = /\b(remember|memori[sz]e|save (this|that|it)|note (that|this)|keep in mind|don'?t forget|make a note)\b/i;

/** Whether the user's own message explicitly asks NICK to remember something. */
export function hasExplicitRememberIntent(message: string): boolean {
  return REMEMBER_INTENT.test(message);
}
