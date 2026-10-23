import type { z } from 'zod';

const MAX_BODY_BYTES = 64 * 1024;

export class HttpError extends Error {
  constructor(
    public readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

export function jsonError(status: number, message: string): Response {
  return Response.json({ ok: false, error: message }, { status });
}

/**
 * Basic protections for the local API: JSON-only writes (forces a CORS preflight for
 * cross-site requests), same-origin check when an Origin header is present, and a size cap.
 */
export async function readJson<T extends z.ZodType>(req: Request, schema: T): Promise<z.infer<T>> {
  const origin = req.headers.get('origin');
  if (origin) {
    const host = req.headers.get('host');
    let originHost: string | null = null;
    try {
      originHost = new URL(origin).host;
    } catch {
      // invalid origin header
    }
    if (!host || originHost !== host) throw new HttpError(403, 'Cross-origin requests are not allowed.');
  }
  if (!(req.headers.get('content-type') ?? '').includes('application/json')) throw new HttpError(415, 'Content-Type must be application/json.');
  const declared = Number(req.headers.get('content-length') ?? '0');
  if (declared > MAX_BODY_BYTES) throw new HttpError(413, 'Request body too large.');
  const text = await req.text();
  if (text.length > MAX_BODY_BYTES) throw new HttpError(413, 'Request body too large.');
  let raw: unknown;
  try {
    raw = text ? JSON.parse(text) : {};
  } catch {
    throw new HttpError(400, 'Request body is not valid JSON.');
  }
  const parsed = schema.safeParse(raw);
  if (!parsed.success) throw new HttpError(400, `Invalid request: ${parsed.error.issues.map((i) => `${i.path.join('.') || 'body'} ${i.message}`).join('; ')}`);
  return parsed.data;
}

/** Wraps a route handler so unexpected errors never expose stack traces. */
export function handle(fn: () => Promise<Response>): Promise<Response> {
  return fn().catch((err: unknown) => {
    if (err instanceof HttpError) return jsonError(err.status, err.message);
    console.error('[api] unexpected error:', err instanceof Error ? err.message : err);
    return jsonError(500, 'Something went wrong on the server. Check the terminal running NICK for details.');
  });
}
