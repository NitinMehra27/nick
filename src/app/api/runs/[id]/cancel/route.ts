import { z } from 'zod';
import { HttpError, handle, readJson } from '@/server/http';
import { getRuntime } from '@/server/runtime';

export const dynamic = 'force-dynamic';

/**
 * Stops an agent run (the Stop button). The model call in progress is aborted; a tool call
 * that already started is allowed to finish, and nothing new starts. The chat stream then
 * ends with a "cancelled" result listing what was actually completed.
 */
export function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  return handle(async () => {
    await readJson(req, z.strictObject({}));
    const { id } = await params;
    if (!z.uuid().safeParse(id).success) throw new HttpError(400, 'Invalid run id.');
    const run = getRuntime().activeRuns.get(id);
    if (!run) throw new HttpError(404, 'This request has already finished.');
    run.abort();
    return Response.json({ ok: true });
  });
}
