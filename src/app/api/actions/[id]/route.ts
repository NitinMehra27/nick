import { z } from 'zod';
import { cancelPendingAction, confirmPendingAction } from '@/agent/actions';
import { HttpError, handle, jsonError, readJson } from '@/server/http';
import { getRuntime } from '@/server/runtime';

export const dynamic = 'force-dynamic';

const body = z.strictObject({
  decision: z.enum(['confirm', 'cancel']),
  createTasks: z.boolean().optional(),
});

/** The user's decision on an action NICK proposed (deletions, saving a study plan). */
export function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  return handle(async () => {
    const { decision, createTasks } = await readJson(req, body);
    const { id } = await params;
    if (!z.uuid().safeParse(id).success) throw new HttpError(400, 'Invalid action id.');
    const rt = getRuntime();
    if (decision === 'cancel') {
      const r = cancelPendingAction(rt.store, id);
      return r.ok ? Response.json({ ok: true, status: 'cancelled' }) : jsonError(r.status, r.error!);
    }
    const r = await confirmPendingAction(rt.store, rt.mcp, id, { createTasks }, rt.config.toolTimeoutMs);
    return r.ok ? Response.json({ ok: true, status: 'confirmed', summary: r.summary, data: r.structured }) : jsonError(r.status, r.error);
  });
}
