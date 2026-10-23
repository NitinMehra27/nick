import { randomUUID } from 'node:crypto';
import { TOOL_PURPOSE } from './toolPolicy';
import type { AgentMcp } from './agent';
import type { AgentStore } from './store';
import type { ActivityRecord } from './types';

export type ConfirmOutcome =
  | { ok: true; summary: string; structured: Record<string, unknown> | null }
  | { ok: false; status: number; error: string };

/**
 * Executes a stored pending action after the user pressed Confirm. Only the arguments
 * stored server-side are used; the request can only toggle createTasks for study plans.
 */
export async function confirmPendingAction(
  store: AgentStore,
  mcp: AgentMcp,
  id: string,
  options: { createTasks?: boolean } = {},
  toolTimeoutMs = 15_000,
): Promise<ConfirmOutcome> {
  const action = store.getPendingAction(id);
  if (!action) return { ok: false, status: 404, error: 'This action no longer exists.' };
  if (action.status !== 'pending') return { ok: false, status: 409, error: `This action was already ${action.status}.` };
  if (!store.claimPendingAction(id)) return { ok: false, status: 409, error: 'This action was already handled.' };

  const args = { ...action.args };
  if (action.toolName === 'create_study_plan' && typeof options.createTasks === 'boolean') args.createTasks = options.createTasks;

  const record: ActivityRecord = {
    id: randomUUID(),
    tool: action.toolName,
    purpose: `${TOOL_PURPOSE[action.toolName] ?? action.toolName} (confirmed by you)`,
    status: 'running',
    origin: 'confirmation',
    startedAt: new Date().toISOString(),
  };
  const outcome = await mcp.callTool(action.toolName, args, toolTimeoutMs);
  record.status = outcome.ok ? 'success' : 'error';
  record.durationMs = outcome.durationMs;
  record.summary = outcome.text.split('\n')[0].slice(0, 200);
  store.recordActivity(action.conversationId, record);

  if (!outcome.ok) {
    store.resolvePendingAction(id, 'failed', record.summary);
    if (action.conversationId) store.addMessage(action.conversationId, 'assistant', `That action failed: ${record.summary}`, { systemComposed: true, activity: [record] });
    return { ok: false, status: 502, error: record.summary };
  }
  store.resolvePendingAction(id, 'confirmed', record.summary);
  if (action.conversationId) store.addMessage(action.conversationId, 'assistant', `Done: ${record.summary}`, { systemComposed: true, activity: [record] });
  return { ok: true, summary: record.summary, structured: outcome.structured };
}

export function cancelPendingAction(store: AgentStore, id: string): { ok: boolean; status: number; error?: string } {
  const action = store.getPendingAction(id);
  if (!action) return { ok: false, status: 404, error: 'This action no longer exists.' };
  if (action.status !== 'pending') return { ok: false, status: 409, error: `This action was already ${action.status}.` };
  store.resolvePendingAction(id, 'cancelled', 'Cancelled by you. Nothing was changed.');
  if (action.conversationId) store.addMessage(action.conversationId, 'assistant', `Cancelled: ${action.summary}. Nothing was changed.`, { systemComposed: true });
  return { ok: true, status: 200 };
}
