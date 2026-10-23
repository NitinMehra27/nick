import { z } from 'zod';
import { historyFromMessages, runAgent } from '@/agent/agent';
import { toView } from '@/agent/store';
import type { AgentEvent } from '@/agent/types';
import { handle, readJson } from '@/server/http';
import { getRuntime } from '@/server/runtime';

export const dynamic = 'force-dynamic';

const body = z.strictObject({
  conversationId: z.uuid().optional(),
  message: z.string().trim().min(1, 'Message is empty').max(4000, 'Message is too long (max 4000 characters)'),
});

/** Runs one agent turn and streams progress as NDJSON events. */
export function POST(req: Request) {
  return handle(async () => {
    const { conversationId: requested, message } = await readJson(req, body);
    const rt = getRuntime();
    const conversationId = requested && rt.store.conversationExists(requested) ? requested : rt.store.createConversation(message).id;
    const { history, recentResults } = historyFromMessages(rt.store.messages(conversationId) as Parameters<typeof historyFromMessages>[0]);
    rt.store.addMessage(conversationId, 'user', message);
    const runId = rt.store.startRun(conversationId, rt.model.label);
    const abort = new AbortController();
    rt.activeRuns.set(runId, abort);
    req.signal?.addEventListener('abort', () => abort.abort(), { once: true });

    const encoder = new TextEncoder();
    const stream = new ReadableStream<Uint8Array>({
      cancel() {
        abort.abort();
      },
      async start(controller) {
        const send = (e: AgentEvent) => {
          try {
            controller.enqueue(encoder.encode(`${JSON.stringify(e)}\n`));
          } catch {
            // client disconnected; the run still completes and is saved
          }
        };
        send({ type: 'run_started', runId, conversationId, model: rt.model.label });
        try {
          const result = await runAgent(
            { message, history, recentResults },
            {
              model: rt.model,
              mcp: rt.mcp,
              limits: { maxIterations: rt.config.maxIterations, maxToolCalls: rt.config.maxToolCalls, toolTimeoutMs: rt.config.toolTimeoutMs },
              createPendingAction: (a) => toView(rt.store.createPendingAction(conversationId, a)),
              recordActivity: (a) => rt.store.recordActivity(conversationId, a),
              signal: abort.signal,
            },
            send,
          );
          rt.store.addMessage(conversationId, 'assistant', result.message, {
            status: result.status,
            systemComposed: result.systemComposed,
            notes: result.notes,
            activity: result.activity,
            pendingActionIds: result.pendingActions.map((p) => p.id),
            memoryContext: result.memoryContext,
            model: rt.model.label,
          });
          rt.store.finishRun(runId, result.status, result.iterations, result.toolCalls);
        } catch (err) {
          console.error('[agent] run failed:', err instanceof Error ? err.message : err);
          const text = 'NICK hit an unexpected error while handling this request. Nothing further was executed.';
          rt.store.addMessage(conversationId, 'assistant', text, { status: 'failed', systemComposed: true });
          rt.store.finishRun(runId, 'failed', 0, 0);
          send({ type: 'error', message: text });
        } finally {
          rt.activeRuns.delete(runId);
        }
        try {
          controller.close();
        } catch {
          // already closed
        }
      },
    });
    return new Response(stream, { headers: { 'content-type': 'application/x-ndjson; charset=utf-8', 'cache-control': 'no-store' } });
  });
}
