'use client';

export type { Task, Memory, StudyPlan, StudyPlanItem } from '../../lib/schemas';
export type { ActivityRecord, AgentEvent, AgentResultView, MemoryContextItem, PendingActionView } from '../agent/types';

export interface ToolResponse<T = Record<string, unknown>> {
  ok: boolean;
  summary?: string;
  data?: T;
  error?: string;
}

/** Calls an MCP tool through the local backend (/api/tools/:name -> MCP tools/call). */
export async function callTool<T = Record<string, unknown>>(name: string, args: Record<string, unknown> = {}, confirmed = false): Promise<ToolResponse<T>> {
  try {
    const res = await fetch(`/api/tools/${name}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(confirmed ? { args, confirmed: true } : { args }),
    });
    const body = (await res.json()) as ToolResponse<T>;
    return res.ok ? body : { ok: false, error: body.error ?? `Request failed (HTTP ${res.status})` };
  } catch {
    return { ok: false, error: 'Could not reach the NICK web server. Is "npm run dev" still running?' };
  }
}

export async function postJson<T = Record<string, unknown>>(url: string, body: unknown, method = 'POST'): Promise<{ ok: boolean; error?: string } & Partial<T>> {
  try {
    const res = await fetch(url, { method, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    const json = await res.json().catch(() => ({}));
    return res.ok ? json : ({ ok: false, error: json.error ?? `Request failed (HTTP ${res.status})` } as { ok: boolean; error?: string } & Partial<T>);
  } catch {
    return { ok: false, error: 'Could not reach the NICK web server.' } as { ok: boolean; error?: string } & Partial<T>;
  }
}

export async function getJson<T>(url: string): Promise<({ ok: true } & T) | { ok: false; error: string }> {
  try {
    const res = await fetch(url, { cache: 'no-store' });
    const json = await res.json().catch(() => ({}));
    return res.ok ? json : { ok: false, error: json.error ?? `Request failed (HTTP ${res.status})` };
  } catch {
    return { ok: false, error: 'Could not reach the NICK web server.' };
  }
}

export const CONVERSATIONS_CHANGED = 'nick:conversations-changed';
export const DATA_CHANGED = 'nick:data-changed';

export function notify(event: string) {
  window.dispatchEvent(new Event(event));
}

export function formatDate(iso: string | null | undefined): string {
  if (!iso) return '';
  const [y, m, d] = iso.slice(0, 10).split('-').map(Number);
  return new Date(y, m - 1, d).toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' });
}

export function formatMinutes(min: number): string {
  const h = Math.floor(min / 60);
  const m = min % 60;
  return h ? (m ? `${h} h ${m} min` : `${h} h`) : `${m} min`;
}

export function todayIso(): string {
  const n = new Date();
  return `${n.getFullYear()}-${String(n.getMonth() + 1).padStart(2, '0')}-${String(n.getDate()).padStart(2, '0')}`;
}
