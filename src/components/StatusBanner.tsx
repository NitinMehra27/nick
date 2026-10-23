'use client';

import Link from 'next/link';
import { useCallback, useEffect, useState } from 'react';
import { getJson } from '@/lib/client';

export interface StatusPayload {
  mcp: { ok: boolean; url: string; error?: string };
  ollama: { ok: boolean; reachable: boolean; baseUrl: string; model: string; installed: boolean };
}

/** Shows setup guidance only when the MCP server or the local model is unavailable. */
export function StatusBanner() {
  const [status, setStatus] = useState<StatusPayload | null>(null);
  const [checking, setChecking] = useState(false);

  const check = useCallback(async () => {
    setChecking(true);
    const res = await getJson<StatusPayload>('/api/status');
    setChecking(false);
    if (res.ok) setStatus(res);
  }, []);

  useEffect(() => {
    void check();
  }, [check]);

  if (!status || (status.mcp.ok && status.ollama.ok)) return null;

  const problems: string[] = [];
  if (!status.mcp.ok) problems.push(`MCP server not reachable at ${status.mcp.url}. Start it with "npm run dev" (or "npm run dev:mcp").`);
  if (!status.ollama.reachable) problems.push(`Ollama is not running at ${status.ollama.baseUrl}. Start the Ollama app; chat needs it, the dashboards do not.`);
  else if (!status.ollama.installed) problems.push(`Model "${status.ollama.model}" is not installed. Run: ollama pull ${status.ollama.model}`);

  return (
    <div role="alert" className="flex flex-wrap items-start gap-x-4 gap-y-1 border-b border-warn/30 bg-warn/10 px-4 py-2 text-sm text-warn md:px-8">
      <ul className="min-w-0 flex-1 list-disc space-y-0.5 pl-4">
        {problems.map((p) => (
          <li key={p}>{p}</li>
        ))}
      </ul>
      <div className="flex gap-3">
        <button className="underline underline-offset-2 disabled:opacity-60" onClick={check} disabled={checking}>
          {checking ? 'Checking…' : 'Check again'}
        </button>
        <Link href="/settings" className="underline underline-offset-2">
          Details
        </Link>
      </div>
    </div>
  );
}
