import { getAgentConfig, type AgentConfig } from '../../lib/config';
import { NickMcpClient } from '../../lib/mcpClient';
import { systemPrompt } from '../agent/agent';
import { OllamaAdapter } from '../agent/ollama';
import { toModelTools } from '../agent/toolPolicy';
import { AgentStore } from '../agent/store';

export interface Runtime {
  config: AgentConfig;
  store: AgentStore;
  mcp: NickMcpClient;
  model: OllamaAdapter;
  warmup: { running: Promise<WarmupResult> | null; doneAt: number };
  /** Agent runs in progress, by run id, so the Stop button can abort them. */
  activeRuns: Map<string, AbortController>;
}

export type WarmupResult = { ok: true; ms: number; skipped: boolean } | { ok: false; error: string };

const WARM_TTL_MS = 20 * 60_000; // Ollama keeps the model loaded for 30 min (keep_alive)

/** Warms the local model once; concurrent callers share the same in-flight request. */
export function warmUpModel(rt: Runtime): Promise<WarmupResult> {
  if (Date.now() - rt.warmup.doneAt < WARM_TTL_MS) return Promise.resolve({ ok: true, ms: 0, skipped: true });
  if (!rt.warmup.running) {
    const started = Date.now();
    rt.warmup.running = (async (): Promise<WarmupResult> => {
      try {
        const tools = toModelTools(await rt.mcp.listTools());
        await rt.model.warmUp(systemPrompt(new Date()), tools);
        rt.warmup.doneAt = Date.now();
        return { ok: true, ms: Date.now() - started, skipped: false };
      } catch (err) {
        return { ok: false, error: (err as Error).message };
      } finally {
        rt.warmup.running = null;
      }
    })();
  }
  return rt.warmup.running;
}

// Cached on globalThis so Next.js dev hot reloads reuse one DB handle and one MCP session.
const g = globalThis as typeof globalThis & { __nickRuntime?: Runtime };

export function getRuntime(): Runtime {
  if (!g.__nickRuntime) {
    const config = getAgentConfig();
    g.__nickRuntime = {
      config,
      store: AgentStore.open(config.agentDbPath),
      mcp: new NickMcpClient(config.mcpUrl, 'nick-web-agent'),
      model: new OllamaAdapter({
        baseUrl: config.ollamaBaseUrl,
        model: config.ollamaModel,
        toolMode: config.toolMode,
        timeoutMs: config.ollamaTimeoutMs,
      }),
      warmup: { running: null, doneAt: 0 },
      activeRuns: new Map(),
    };
  }
  // A runtime cached by an older build during a dev hot reload may predate this field.
  g.__nickRuntime.activeRuns ??= new Map();
  return g.__nickRuntime;
}
