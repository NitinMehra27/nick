import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { CONFIRMATION_REQUIRED, TOOL_PURPOSE } from '@/agent/toolPolicy';
import type { ActivityRecord } from '@/agent/types';
import { HttpError, handle, readJson } from '@/server/http';
import { getRuntime } from '@/server/runtime';

export const dynamic = 'force-dynamic';

/** MCP tools the dashboard pages may call directly (every call still goes through MCP tools/call). */
const UI_TOOLS = new Set([
  'list_tasks',
  'get_task',
  'create_task',
  'update_task',
  'complete_task',
  'delete_task',
  'search_memory',
  'save_memory',
  'update_memory',
  'delete_memory',
  'clear_memories',
  'create_study_plan',
  'get_study_plan',
  'list_study_plans',
  'update_study_plan_item',
  'delete_study_plan',
]);

const READ_ONLY = new Set(['list_tasks', 'get_task', 'search_memory', 'get_study_plan', 'list_study_plans']);

const body = z.strictObject({
  args: z.record(z.string(), z.unknown()).default({}),
  /** Set by the UI only after the user confirmed in a dialog. */
  confirmed: z.boolean().optional(),
});

export function POST(req: Request, { params }: { params: Promise<{ name: string }> }) {
  return handle(async () => {
    const { name } = await params;
    if (!UI_TOOLS.has(name)) throw new HttpError(404, `Unknown tool: ${name}`);
    const { args, confirmed } = await readJson(req, body);
    const finalArgs: Record<string, unknown> = { ...args };
    delete finalArgs.confirm;
    if (CONFIRMATION_REQUIRED.has(name)) {
      if (confirmed !== true) throw new HttpError(428, 'This action needs your confirmation first.');
      finalArgs.confirm = true;
    }
    if (name === 'save_memory') finalArgs.source = 'user';

    const rt = getRuntime();
    const outcome = await rt.mcp.callTool(name, finalArgs, rt.config.toolTimeoutMs);
    if (!READ_ONLY.has(name)) {
      const record: ActivityRecord = {
        id: randomUUID(),
        tool: name,
        purpose: `${TOOL_PURPOSE[name] ?? name} (from dashboard)`,
        status: outcome.ok ? 'success' : 'error',
        origin: 'ui',
        startedAt: new Date().toISOString(),
        durationMs: outcome.durationMs,
        summary: outcome.text.split('\n')[0].slice(0, 200),
      };
      rt.store.recordActivity(null, record);
    }
    const summary = outcome.text.split('\n')[0];
    if (!outcome.ok) {
      return Response.json({ ok: false, error: summary, transportError: outcome.transportError }, { status: outcome.transportError ? 503 : 422 });
    }
    return Response.json({ ok: true, summary, data: outcome.structured, durationMs: outcome.durationMs });
  });
}
