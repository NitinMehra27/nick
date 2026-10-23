'use client';

import type { ActivityRecord } from '@/lib/client';
import { Spinner } from '../ui';

const ICON: Record<ActivityRecord['status'], { symbol: string; className: string; label: string }> = {
  running: { symbol: '', className: '', label: 'Running' },
  success: { symbol: '✓', className: 'text-ok', label: 'Succeeded' },
  error: { symbol: '✕', className: 'text-bad', label: 'Failed' },
  skipped: { symbol: '–', className: 'text-faint', label: 'Skipped' },
  awaiting_confirmation: { symbol: '?', className: 'text-warn', label: 'Waiting for your confirmation' },
};

/** Compact list of real MCP tool executions (statuses come from actual results). */
export function ActivityList({ items, compact = false }: { items: ActivityRecord[]; compact?: boolean }) {
  if (items.length === 0) return null;
  return (
    <ul className="space-y-1" aria-label="Tool activity">
      {items.map((a) => {
        const icon = ICON[a.status];
        return (
          <li key={a.id} className="flex items-start gap-2 text-xs">
            <span className={`mt-0.5 inline-flex w-3.5 shrink-0 justify-center font-bold ${icon.className}`} aria-label={icon.label} title={icon.label}>
              {a.status === 'running' ? <Spinner label="Running" /> : icon.symbol}
            </span>
            <span className="min-w-0 flex-1">
              <span className="text-ink">{a.purpose}</span>{' '}
              <code className="rounded bg-raised px-1 font-mono text-[11px] text-muted">{a.tool}</code>
              {typeof a.durationMs === 'number' && <span className="text-faint"> · {a.durationMs} ms</span>}
              {!compact && a.summary && <span className={`block truncate ${a.status === 'error' ? 'text-bad' : 'text-faint'}`} title={a.summary}>{a.summary}</span>}
            </span>
          </li>
        );
      })}
    </ul>
  );
}
