import { z } from 'zod';
import { ModelError, type ChatMessage, type ModelAdapter, type ModelToolCall, type ModelToolSpec, type ModelTurn } from './types';

interface OllamaOptions {
  baseUrl: string;
  model: string;
  toolMode: 'auto' | 'native' | 'json';
  timeoutMs: number;
  fetchImpl?: typeof fetch;
}

interface OllamaMessage {
  role: string;
  content: string;
  tool_calls?: { function: { name: string; arguments: unknown } }[];
  tool_name?: string;
}

const jsonDecision = z.object({
  action: z.enum(['call_tool', 'respond']),
  tool: z.string().optional(),
  arguments: z.record(z.string(), z.unknown()).optional(),
  message: z.string().optional(),
});

const MAX_REPLY_TOKENS = 300;

const JSON_FORMAT = {
  type: 'object',
  properties: {
    action: { type: 'string', enum: ['call_tool', 'respond'] },
    tool: { type: 'string' },
    arguments: { type: 'object' },
    message: { type: 'string' },
  },
  required: ['action'],
};

/**
 * Adapter for a local Ollama model. Uses native tool calling; in "json" mode (or "auto"
 * after the model reports it lacks tool support) it uses a schema-constrained JSON
 * decision format that is validated before any tool is considered.
 */
export class OllamaAdapter implements ModelAdapter {
  private mode: 'native' | 'json';
  private readonly fetchImpl: typeof fetch;

  constructor(private readonly opts: OllamaOptions) {
    this.mode = opts.toolMode === 'json' ? 'json' : 'native';
    this.fetchImpl = opts.fetchImpl ?? fetch;
  }

  get label() {
    return `${this.opts.model} via Ollama (${this.mode === 'native' ? 'native tool calling' : 'JSON tool adapter'})`;
  }

  async chat(messages: ChatMessage[], tools: ModelToolSpec[], signal?: AbortSignal): Promise<ModelTurn> {
    if (this.mode === 'native') {
      try {
        return await this.nativeChat(messages, tools, signal);
      } catch (err) {
        if (err instanceof ModelError && err.kind === 'tools_unsupported' && this.opts.toolMode === 'auto') {
          this.mode = 'json';
        } else {
          throw err;
        }
      }
    }
    return this.jsonChat(messages, tools, signal);
  }

  /**
   * Loads the model and fills Ollama's prompt cache with the system prompt + tool schemas for
   * both the native path and the JSON fallback path, so neither pays ~1.5 min of CPU prompt
   * processing on the user's first message. Ollama keeps several prompts in its cache.
   */
  async warmUp(systemPrompt: string, tools: ModelToolSpec[]): Promise<void> {
    const options = { temperature: 0.2, num_ctx: 8192, num_predict: 1 };
    if (this.mode === 'native') {
      await this.post({
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: 'ping' },
        ],
        tools: tools.map((t) => ({ type: 'function', function: t })),
        options,
      });
    }
    await this.post({
      messages: [
        { role: 'system', content: jsonSystemPrompt(systemPrompt, tools) },
        { role: 'user', content: 'ping' },
      ],
      format: JSON_FORMAT,
      options,
    });
  }

  private async post(body: Record<string, unknown>, signal?: AbortSignal): Promise<{ message: OllamaMessage; truncated: boolean }> {
    const timeout = AbortSignal.timeout(this.opts.timeoutMs);
    let res: Response;
    try {
      res = await this.fetchImpl(`${this.opts.baseUrl}/api/chat`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        // num_predict caps reply length: at ~5 tokens/s on CPU an unbounded answer can exceed the timeout.
        body: JSON.stringify({ model: this.opts.model, stream: false, keep_alive: '30m', options: { temperature: 0.2, num_ctx: 8192, num_predict: MAX_REPLY_TOKENS }, ...body }),
        signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
      });
    } catch (err) {
      if ((err as Error)?.name === 'TimeoutError' || timeout.aborted) {
        throw new ModelError('timeout', `The local model did not answer within ${Math.round(this.opts.timeoutMs / 1000)}s.`);
      }
      throw new ModelError('unreachable', `Ollama is not reachable at ${this.opts.baseUrl}. Start the Ollama app (or run "ollama serve").`);
    }
    const text = await res.text();
    let data: { message?: OllamaMessage; error?: string; done_reason?: string };
    try {
      data = JSON.parse(text);
    } catch {
      throw new ModelError('bad_response', `Ollama returned a non-JSON response (HTTP ${res.status}).`);
    }
    if (!res.ok || data.error) {
      const msg = data.error ?? `HTTP ${res.status}`;
      if (/does not support tools/i.test(msg)) throw new ModelError('tools_unsupported', msg);
      if (res.status === 404 || /not found/i.test(msg)) {
        throw new ModelError('model_missing', `The model "${this.opts.model}" is not installed. Run: ollama pull ${this.opts.model}`);
      }
      throw new ModelError('bad_response', `Ollama error: ${msg}`);
    }
    if (!data.message || typeof data.message.content !== 'string') throw new ModelError('bad_response', 'Ollama returned no message.');
    return { message: data.message, truncated: data.done_reason === 'length' };
  }

  private async nativeChat(messages: ChatMessage[], tools: ModelToolSpec[], signal?: AbortSignal): Promise<ModelTurn> {
    const { message, truncated } = await this.post(
      {
        messages: messages.map(
          (m): OllamaMessage => ({
            role: m.role,
            content: m.content,
            ...(m.toolCalls ? { tool_calls: m.toolCalls.map((c) => ({ function: { name: c.name, arguments: c.arguments } })) } : {}),
            ...(m.toolName ? { tool_name: m.toolName } : {}),
          }),
        ),
        tools: tools.map((t) => ({ type: 'function', function: t })),
      },
      signal,
    );
    const toolCalls: ModelToolCall[] = (message.tool_calls ?? []).map((c) => ({ name: c.function?.name ?? '', arguments: c.function?.arguments }));
    if (toolCalls.length) return { content: message.content, toolCalls, mode: 'native' };
    const recovered = recoverToolCallsFromText(message.content, new Set(tools.map((t) => t.name)));
    if (recovered.length) return { content: '', toolCalls: recovered, mode: 'text' };
    // Observed with qwen2.5:3b: the model emits a malformed tool call that Ollama's parser
    // drops, leaving neither content nor tool_calls. Retry this turn once with the JSON adapter.
    if (!message.content.trim()) return this.jsonChat(messages, tools, signal);
    return { content: message.content, toolCalls: [], mode: 'native', truncated };
  }

  private async jsonChat(messages: ChatMessage[], tools: ModelToolSpec[], signal?: AbortSignal): Promise<ModelTurn> {
    const mapped: OllamaMessage[] = messages.map((m) => {
      if (m.role === 'tool') return { role: 'user', content: `TOOL RESULT (${m.toolName}):\n${m.content}` };
      if (m.role === 'assistant' && m.toolCalls?.length) {
        const c = m.toolCalls[0];
        return { role: 'assistant', content: JSON.stringify({ action: 'call_tool', tool: c.name, arguments: c.arguments }) };
      }
      return { role: m.role, content: m.content };
    });
    const sysIndex = mapped.findIndex((m) => m.role === 'system');
    if (sysIndex >= 0) mapped[sysIndex] = { ...mapped[sysIndex], content: jsonSystemPrompt(mapped[sysIndex].content, tools) };
    else mapped.unshift({ role: 'system', content: jsonSystemPrompt('', tools) });

    const { message } = await this.post({ messages: mapped, format: JSON_FORMAT }, signal);
    let parsed: z.infer<typeof jsonDecision>;
    try {
      parsed = jsonDecision.parse(JSON.parse(message.content));
    } catch {
      throw new ModelError('bad_response', 'The model returned output that does not match the expected JSON format.');
    }
    if (parsed.action === 'call_tool') {
      if (!parsed.tool) throw new ModelError('bad_response', 'The model asked to call a tool without naming it.');
      return { content: '', toolCalls: [{ name: parsed.tool, arguments: parsed.arguments ?? {} }], mode: 'json' };
    }
    return { content: parsed.message ?? '', toolCalls: [], mode: 'json' };
  }
}

/** System prompt for the JSON adapter: the normal system prompt plus a tool catalog. */
function jsonSystemPrompt(system: string, tools: ModelToolSpec[]): string {
  const catalog = tools.map((t) => `- ${t.name}: ${t.description}\n  arguments schema: ${JSON.stringify(t.parameters)}`).join('\n');
  const instructions =
    'You can use these tools:\n' +
    catalog +
    '\nReply ONLY with JSON. To use a tool: {"action":"call_tool","tool":"<name>","arguments":{...}}. ' +
    'To answer the user: {"action":"respond","message":"<text>"}. Use one tool at a time.';
  return system ? `${system}\n\n${instructions}` : instructions;
}

/**
 * Small models sometimes print a tool call as JSON text instead of using the tool-call
 * channel. Recover only well-formed {"name": <known tool>, "arguments": {...}} objects.
 */
export function recoverToolCallsFromText(content: string, known: Set<string>): ModelToolCall[] {
  const text = content.replace(/<\/?tool_call>/g, '').replace(/```(?:json)?/g, '').trim();
  if (!text.startsWith('{') && !text.startsWith('[')) return [];
  try {
    const value = JSON.parse(text) as unknown;
    const list = Array.isArray(value) ? value : [value];
    const calls: ModelToolCall[] = [];
    for (const v of list) {
      const obj = v as { name?: unknown; arguments?: unknown; parameters?: unknown };
      if (typeof obj?.name === 'string' && known.has(obj.name)) calls.push({ name: obj.name, arguments: obj.arguments ?? obj.parameters ?? {} });
    }
    return calls;
  } catch {
    return [];
  }
}
