import { describe, expect, it } from 'vitest';
import { OllamaAdapter, recoverToolCallsFromText } from '../src/agent/ollama';
import { dropCopiedSubjectHours, normalizeArgs } from '../src/agent/toolPolicy';
import { ModelError, type ModelToolSpec } from '../src/agent/types';

const tools: ModelToolSpec[] = [{ name: 'create_task', description: 'Create a task', parameters: { type: 'object', properties: { title: { type: 'string' } } } }];

function fakeFetch(responses: ((body: Record<string, unknown>) => { status: number; json: unknown } | Error)[]) {
  const bodies: Record<string, unknown>[] = [];
  const impl = (async (_url: string, init: RequestInit) => {
    const body = JSON.parse(String(init.body));
    bodies.push(body);
    const r = responses[bodies.length - 1](body);
    if (r instanceof Error) throw r;
    return new Response(JSON.stringify(r.json), { status: r.status });
  }) as unknown as typeof fetch;
  return { impl, bodies };
}

const adapter = (toolMode: 'auto' | 'native' | 'json', fetchImpl: typeof fetch) =>
  new OllamaAdapter({ baseUrl: 'http://127.0.0.1:11434', model: 'qwen2.5:3b', toolMode, timeoutMs: 5000, fetchImpl });

describe('OllamaAdapter', () => {
  it('parses native tool calls and sends tools in Ollama format', async () => {
    const f = fakeFetch([() => ({ status: 200, json: { message: { role: 'assistant', content: '', tool_calls: [{ function: { name: 'create_task', arguments: { title: 'A' } } }] } } })]);
    const turn = await adapter('native', f.impl).chat([{ role: 'user', content: 'hi' }], tools);
    expect(turn).toEqual({ content: '', toolCalls: [{ name: 'create_task', arguments: { title: 'A' } }], mode: 'native' });
    expect(f.bodies[0]).toMatchObject({ model: 'qwen2.5:3b', stream: false, tools: [{ type: 'function', function: { name: 'create_task' } }] });
    expect(f.bodies[0].options).toMatchObject({ num_ctx: 8192, num_predict: 300 });
  });

  it('reports replies cut off at the length cap', async () => {
    const f = fakeFetch([() => ({ status: 200, json: { message: { role: 'assistant', content: '- #11 "Study Math" due on' }, done_reason: 'length' } })]);
    const turn = await adapter('native', f.impl).chat([{ role: 'user', content: 'list' }], tools);
    expect(turn.truncated).toBe(true);
  });

  it('warmUp primes both the native and the JSON-fallback prompts with 1-token generations', async () => {
    const ok = () => ({ status: 200, json: { message: { role: 'assistant', content: 'p' } } });
    const f = fakeFetch([ok, ok]);
    await adapter('native', f.impl).warmUp('SYSTEM PROMPT', tools);
    expect(f.bodies).toHaveLength(2);
    expect(f.bodies[0]).toMatchObject({
      messages: [{ role: 'system', content: 'SYSTEM PROMPT' }, { role: 'user', content: 'ping' }],
      tools: [{ type: 'function', function: { name: 'create_task' } }],
      options: { num_ctx: 8192, num_predict: 1 },
    });
    expect(f.bodies[1].format).toBeDefined();
    expect((f.bodies[1].messages as { content: string }[])[0].content).toMatch(/^SYSTEM PROMPT\n\nYou can use these tools/);
  });

  it('falls back to the validated JSON adapter when the model lacks tool support (auto mode)', async () => {
    const f = fakeFetch([
      () => ({ status: 400, json: { error: 'registry.ollama.ai/library/gemma:2b does not support tools' } }),
      () => ({ status: 200, json: { message: { role: 'assistant', content: '{"action":"call_tool","tool":"create_task","arguments":{"title":"B"}}' } } }),
    ]);
    const a = adapter('auto', f.impl);
    const turn = await a.chat([{ role: 'system', content: 'sys' }, { role: 'user', content: 'hi' }], tools);
    expect(turn).toEqual({ content: '', toolCalls: [{ name: 'create_task', arguments: { title: 'B' } }], mode: 'json' });
    expect(f.bodies[1].format).toBeDefined();
    expect(f.bodies[1].tools).toBeUndefined();
    expect(a.label).toMatch(/JSON tool adapter/);
  });

  it('retries an empty native response once through the JSON adapter', async () => {
    const f = fakeFetch([
      () => ({ status: 200, json: { message: { role: 'assistant', content: '' }, eval_count: 34 } }),
      () => ({ status: 200, json: { message: { role: 'assistant', content: '{"action":"respond","message":"You prefer 45-minute sessions."}' } } }),
    ]);
    const turn = await adapter('native', f.impl).chat([{ role: 'user', content: 'How long are my sessions?' }], tools);
    expect(turn).toEqual({ content: 'You prefer 45-minute sessions.', toolCalls: [], mode: 'json' });
    expect(f.bodies).toHaveLength(2);
    expect(f.bodies[1].format).toBeDefined();
  });

  it('rejects malformed JSON-mode output instead of guessing', async () => {
    const f = fakeFetch([() => ({ status: 200, json: { message: { role: 'assistant', content: '{"action":"dance"}' } } })]);
    await expect(adapter('json', f.impl).chat([{ role: 'user', content: 'x' }], tools)).rejects.toMatchObject({ kind: 'bad_response' });
  });

  it('classifies missing models and unreachable servers', async () => {
    const missing = fakeFetch([() => ({ status: 404, json: { error: "model 'qwen2.5:3b' not found" } })]);
    await expect(adapter('native', missing.impl).chat([], tools)).rejects.toMatchObject({ kind: 'model_missing', message: expect.stringMatching(/ollama pull qwen2.5:3b/) });
    const down = fakeFetch([() => new TypeError('fetch failed')]);
    const err = await adapter('native', down.impl).chat([], tools).catch((e) => e);
    expect(err).toBeInstanceOf(ModelError);
    expect(err.kind).toBe('unreachable');
  });

  it('recovers a tool call printed as JSON text, but only for known tools', () => {
    const known = new Set(['create_task']);
    expect(recoverToolCallsFromText('<tool_call>{"name":"create_task","arguments":{"title":"C"}}</tool_call>', known)).toEqual([
      { name: 'create_task', arguments: { title: 'C' } },
    ]);
    expect(recoverToolCallsFromText('{"name":"rm_rf","arguments":{}}', known)).toEqual([]);
    expect(recoverToolCallsFromText('Sure! I created it.', known)).toEqual([]);
  });
});

describe('normalizeArgs', () => {
  it('parses JSON strings, drops nulls/empties/app-controlled fields and coerces numeric IDs', () => {
    expect(normalizeArgs('delete_task', '{"taskId":"7","confirm":true}')).toEqual({ taskId: 7 });
    expect(normalizeArgs('create_task', { title: 'x', description: null, category: '' })).toEqual({ title: 'x' });
    expect(normalizeArgs('save_memory', { content: 'x', source: 'user' })).toEqual({ content: 'x' });
    expect(() => normalizeArgs('create_task', '[1,2]')).toThrow();
    expect(() => normalizeArgs('create_task', '{oops')).toThrow();
    expect(normalizeArgs('create_study_plan', { subjects: ['Math', { name: 'Chem' }] }).subjects).toEqual([{ name: 'Math' }, { name: 'Chem' }]);
  });
});

describe('dropCopiedSubjectHours', () => {
  const args = { subjects: [{ name: 'Math', hours: 2 }, { name: 'Chemistry', hours: 2 }], hoursPerDay: 2, targetDate: '2030-01-10' };
  it('drops per-subject hours that only repeat hoursPerDay', () => {
    const r = dropCopiedSubjectHours(args, 'Make a study plan for Math and Chemistry, 2 hours a day');
    expect(r.dropped).toBe(true);
    expect(r.args.subjects).toEqual([{ name: 'Math' }, { name: 'Chemistry' }]);
  });
  it('keeps them when the user spoke about per-subject or total hours', () => {
    expect(dropCopiedSubjectHours(args, '2 hours each for Math and Chemistry, 2 hours a day').dropped).toBe(false);
    expect(dropCopiedSubjectHours({ ...args, subjects: [{ name: 'Math', hours: 5 }] }, 'x').dropped).toBe(false);
  });
});
