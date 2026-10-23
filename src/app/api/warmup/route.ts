import { z } from 'zod';
import { handle, readJson } from '@/server/http';
import { getRuntime, warmUpModel } from '@/server/runtime';

export const dynamic = 'force-dynamic';

/** Pre-loads the local model and its prompt cache so the first chat reply is faster. */
export function POST(req: Request) {
  return handle(async () => {
    await readJson(req, z.strictObject({}));
    const result = await warmUpModel(getRuntime());
    return Response.json(result, { status: result.ok ? 200 : 503 });
  });
}
