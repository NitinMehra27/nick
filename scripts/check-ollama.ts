/**
 * Checks that Ollama is reachable, the configured model is installed, and that the model
 * can produce a native tool call. Usage: npm run check:ollama
 */
import { getAgentConfig } from '../lib/config';

try {
  process.loadEnvFile();
} catch {
  // optional
}

const { ollamaBaseUrl, ollamaModel } = getAgentConfig();

const version = await fetch(`${ollamaBaseUrl}/api/version`).then((r) => r.json()).catch(() => null);
if (!version) {
  console.error(`Ollama is not reachable at ${ollamaBaseUrl}. Start the Ollama app or run "ollama serve".`);
  process.exit(1);
}
console.log(`Ollama ${version.version} reachable at ${ollamaBaseUrl}`);

const tags = (await fetch(`${ollamaBaseUrl}/api/tags`).then((r) => r.json())) as { models: { name: string }[] };
if (!tags.models.some((m) => m.name === ollamaModel || m.name === `${ollamaModel}:latest`)) {
  console.error(`Model "${ollamaModel}" is not installed. Run: ollama pull ${ollamaModel}`);
  console.error(`Installed: ${tags.models.map((m) => m.name).join(', ') || '(none)'}`);
  process.exit(1);
}

const started = Date.now();
const res = await fetch(`${ollamaBaseUrl}/api/chat`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({
    model: ollamaModel,
    stream: false,
    messages: [{ role: 'user', content: 'Create a task called "Buy notebook" with high priority.' }],
    tools: [
      {
        type: 'function',
        function: {
          name: 'create_task',
          description: 'Create a new task',
          parameters: {
            type: 'object',
            properties: { title: { type: 'string' }, priority: { type: 'string', enum: ['low', 'medium', 'high'] } },
            required: ['title'],
          },
        },
      },
    ],
  }),
});
const body = (await res.json()) as { message?: { content: string; tool_calls?: unknown[] }; error?: string; eval_count?: number };
console.log(`HTTP ${res.status} in ${((Date.now() - started) / 1000).toFixed(1)}s`);
if (body.error) {
  console.error('Model error:', body.error);
  process.exit(1);
}
console.log('tool_calls:', JSON.stringify(body.message?.tool_calls ?? null));
console.log('content:', JSON.stringify(body.message?.content ?? ''));
console.log(body.message?.tool_calls?.length ? 'Native tool calling: OK' : 'Native tool calling: NOT produced (the JSON adapter can be used: OLLAMA_TOOL_MODE=json)');
