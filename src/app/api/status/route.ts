import { handle } from '@/server/http';
import { getRuntime } from '@/server/runtime';

export const dynamic = 'force-dynamic';

/** Live health of the MCP server and the local Ollama model, for setup guidance in the UI. */
export function GET() {
  return handle(async () => {
    const rt = getRuntime();
    const { config } = rt;

    const mcp = await (async () => {
      try {
        const info = await rt.mcp.info();
        const tools = await rt.mcp.listTools(true);
        return {
          ok: true as const,
          ...info,
          tools: tools.map((t) => ({ name: t.name, title: t.title ?? null, description: t.description ?? '', destructive: t.annotations?.destructiveHint === true, readOnly: t.annotations?.readOnlyHint === true })),
        };
      } catch (err) {
        return { ok: false as const, url: config.mcpUrl, error: (err as Error).message };
      }
    })();

    const ollama = await (async () => {
      try {
        const signal = AbortSignal.timeout(3000);
        const version = (await (await fetch(`${config.ollamaBaseUrl}/api/version`, { signal })).json()) as { version: string };
        const tags = (await (await fetch(`${config.ollamaBaseUrl}/api/tags`, { signal: AbortSignal.timeout(3000) })).json()) as { models: { name: string }[] };
        const installedModels = tags.models.map((m) => m.name);
        const installed = installedModels.some((n) => n === config.ollamaModel || n === `${config.ollamaModel}:latest`);
        return { ok: installed, reachable: true, baseUrl: config.ollamaBaseUrl, model: config.ollamaModel, version: version.version, installed, installedModels, label: rt.model.label };
      } catch {
        return { ok: false, reachable: false, baseUrl: config.ollamaBaseUrl, model: config.ollamaModel, installed: false, installedModels: [] as string[], label: rt.model.label };
      }
    })();

    return Response.json({
      ok: true,
      mode: 'single-user-local',
      mcp,
      ollama,
      agent: { maxIterations: config.maxIterations, maxToolCalls: config.maxToolCalls, toolTimeoutMs: config.toolTimeoutMs, toolMode: config.toolMode },
    });
  });
}
