import { z } from 'zod';
import { HttpError, handle, readJson } from '@/server/http';
import { getRuntime } from '@/server/runtime';

export const dynamic = 'force-dynamic';

const idSchema = z.uuid();

async function conversationId(params: Promise<{ id: string }>): Promise<string> {
  const { id } = await params;
  if (!idSchema.safeParse(id).success) throw new HttpError(400, 'Invalid conversation id.');
  return id;
}

export function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  return handle(async () => {
    const id = await conversationId(params);
    const { store } = getRuntime();
    if (!store.conversationExists(id)) throw new HttpError(404, 'Conversation not found.');
    const conversation = store.listConversations(500).find((c) => c.id === id);
    return Response.json({ ok: true, conversation, messages: store.messages(id), pendingActions: store.pendingActionsForConversation(id) });
  });
}

export function DELETE(req: Request, { params }: { params: Promise<{ id: string }> }) {
  return handle(async () => {
    await readJson(req, z.strictObject({ confirmed: z.literal(true) }));
    const id = await conversationId(params);
    if (!getRuntime().store.deleteConversation(id)) throw new HttpError(404, 'Conversation not found.');
    return Response.json({ ok: true });
  });
}
