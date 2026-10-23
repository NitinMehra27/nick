'use client';

import { useCallback, useEffect, useState, type ReactNode } from 'react';
import { getJson } from '@/lib/client';
import { Badge, Button, ErrorNote, PageHeader, Spinner } from './ui';

interface Status {
  mode: string;
  mcp:
    | {
        ok: true;
        url: string;
        serverName: string | null;
        serverVersion: string | null;
        protocolVersion: string | null;
        sessionId: string | null;
        capabilities: Record<string, unknown> | null;
        tools: { name: string; title: string | null; description: string; destructive: boolean; readOnly: boolean }[];
      }
    | { ok: false; url: string; error: string };
  ollama: { ok: boolean; reachable: boolean; baseUrl: string; model: string; version?: string; installed: boolean; installedModels: string[]; label: string };
  agent: { maxIterations: number; maxToolCalls: number; toolTimeoutMs: number; toolMode: string };
}

function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="grid gap-1 border-t border-line py-2 text-sm sm:grid-cols-[12rem_1fr]">
      <dt className="text-muted">{label}</dt>
      <dd className="min-w-0 break-words">{children}</dd>
    </div>
  );
}

export function SettingsView() {
  const [status, setStatus] = useState<Status | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    const res = await getJson<Status>('/api/status');
    setLoading(false);
    if (res.ok) {
      setStatus(res);
      setError(null);
    } else setError(res.error);
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  return (
    <div className="h-full overflow-y-auto">
      <PageHeader
        title="Settings & status"
        description="Live connection details. Configuration is read from .env (see .env.example)."
        actions={
          <Button onClick={load} disabled={loading}>
            {loading && <Spinner />} Refresh
          </Button>
        }
      />
      <div className="mx-auto max-w-4xl space-y-6 px-4 py-5 md:px-8">
        {error && <ErrorNote message={error} onRetry={load} />}
        {!status && !error && (
          <p className="flex items-center gap-2 text-sm text-muted">
            <Spinner /> Checking services…
          </p>
        )}
        {status && (
          <>
            <section className="rounded-xl border border-line bg-surface p-4">
              <div className="flex items-center gap-2">
                <h2 className="font-semibold">MCP server</h2>
                <Badge tone={status.mcp.ok ? 'ok' : 'bad'}>{status.mcp.ok ? 'Connected' : 'Unavailable'}</Badge>
              </div>
              <dl className="mt-3">
                <Row label="Endpoint">
                  <code className="font-mono text-xs">{status.mcp.url}</code> (Streamable HTTP)
                </Row>
                {status.mcp.ok ? (
                  <>
                    <Row label="Server">
                      {status.mcp.serverName} {status.mcp.serverVersion}
                    </Row>
                    <Row label="Negotiated protocol">{status.mcp.protocolVersion}</Row>
                    <Row label="Capabilities">
                      <code className="font-mono text-xs">{JSON.stringify(status.mcp.capabilities)}</code>
                    </Row>
                    <Row label="Session">
                      <code className="font-mono text-xs">{status.mcp.sessionId}</code>
                    </Row>
                  </>
                ) : (
                  <Row label="Error">
                    <span className="text-bad">{status.mcp.error}</span>
                    <span className="mt-1 block text-xs text-muted">Start it with: npm run dev (both services) or npm run dev:mcp</span>
                  </Row>
                )}
              </dl>
              {status.mcp.ok && (
                <>
                  <h3 className="mt-4 text-sm font-medium">Tools from tools/list ({status.mcp.tools.length})</h3>
                  <ul className="mt-2 grid gap-2 sm:grid-cols-2">
                    {status.mcp.tools.map((t) => (
                      <li key={t.name} className="rounded-lg border border-line px-3 py-2">
                        <div className="flex flex-wrap items-center gap-1.5">
                          <code className="font-mono text-xs text-accent">{t.name}</code>
                          {t.readOnly && <Badge>read-only</Badge>}
                          {t.destructive && <Badge tone="bad">needs confirmation</Badge>}
                        </div>
                        <p className="mt-1 text-xs text-muted">{t.description}</p>
                      </li>
                    ))}
                  </ul>
                </>
              )}
            </section>

            <section className="rounded-xl border border-line bg-surface p-4">
              <div className="flex items-center gap-2">
                <h2 className="font-semibold">Local AI (Ollama)</h2>
                <Badge tone={status.ollama.ok ? 'ok' : 'bad'}>{status.ollama.ok ? 'Ready' : status.ollama.reachable ? 'Model missing' : 'Not running'}</Badge>
              </div>
              <dl className="mt-3">
                <Row label="Ollama URL">
                  <code className="font-mono text-xs">{status.ollama.baseUrl}</code>
                  {status.ollama.version && <span className="text-muted"> · v{status.ollama.version}</span>}
                </Row>
                <Row label="Configured model">
                  <code className="font-mono text-xs">{status.ollama.model}</code> {status.ollama.installed ? <Badge tone="ok">installed</Badge> : <Badge tone="bad">not installed</Badge>}
                </Row>
                <Row label="Adapter">{status.ollama.label}</Row>
                <Row label="Installed models">{status.ollama.installedModels.join(', ') || 'none'}</Row>
                {!status.ollama.reachable && (
                  <Row label="How to fix">Install Ollama from ollama.com, start it, then run: ollama pull {status.ollama.model}</Row>
                )}
                {status.ollama.reachable && !status.ollama.installed && <Row label="How to fix">Run: ollama pull {status.ollama.model}</Row>}
              </dl>
            </section>

            <section className="rounded-xl border border-line bg-surface p-4">
              <h2 className="font-semibold">Agent safety limits</h2>
              <dl className="mt-3">
                <Row label="Max reasoning steps">{status.agent.maxIterations} per request</Row>
                <Row label="Max tool calls">{status.agent.maxToolCalls} per request</Row>
                <Row label="Tool timeout">{status.agent.toolTimeoutMs / 1000} s</Row>
                <Row label="Tool-calling mode">{status.agent.toolMode}</Row>
                <Row label="Confirmation">Deletions and saving study plans always wait for your explicit confirmation.</Row>
              </dl>
            </section>

            <section className="rounded-xl border border-line bg-surface p-4 text-sm text-muted">
              <h2 className="font-semibold text-ink">About this installation</h2>
              <p className="mt-2">
                NICK is a <strong className="text-ink">single-user local application</strong>. There is no login and no multi-user isolation; anyone using this
                computer&apos;s browser can see and change the data. All services listen on 127.0.0.1 only. NICK is not connected to an Alexa device; it
                demonstrates the Alexa+ MCP-server path with a web client.
              </p>
            </section>
          </>
        )}
      </div>
    </div>
  );
}
