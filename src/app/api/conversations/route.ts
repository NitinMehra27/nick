import { handle } from '@/server/http';
import { getRuntime } from '@/server/runtime';

export const dynamic = 'force-dynamic';

export function GET() {
  return handle(async () => Response.json({ ok: true, conversations: getRuntime().store.listConversations() }));
}
