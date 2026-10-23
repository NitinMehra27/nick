'use client';

import { useState } from 'react';
import { DATA_CHANGED, notify, postJson, type PendingActionView, type StudyPlan } from '@/lib/client';
import { PlanPreview } from '../PlanPreview';
import { Badge, Button, ErrorNote, Spinner } from '../ui';

const STATUS_BADGE: Record<PendingActionView['status'], { tone: 'warn' | 'ok' | 'neutral' | 'bad'; label: string }> = {
  pending: { tone: 'warn', label: 'Awaiting your confirmation' },
  confirmed: { tone: 'ok', label: 'Executed' },
  cancelled: { tone: 'neutral', label: 'Cancelled' },
  failed: { tone: 'bad', label: 'Failed' },
  expired: { tone: 'neutral', label: 'Expired' },
};

/** A proposed action that only runs when the user presses Confirm. */
export function PendingActionCard({ action, onResolved }: { action: PendingActionView; onResolved: (a: PendingActionView, message: string) => void }) {
  const [busy, setBusy] = useState<'confirm' | 'cancel' | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [createTasks, setCreateTasks] = useState(true);
  const isPlan = action.toolName === 'create_study_plan';
  const badge = STATUS_BADGE[action.status];

  const decide = async (decision: 'confirm' | 'cancel') => {
    setBusy(decision);
    setError(null);
    const res = await postJson<{ summary?: string }>(`/api/actions/${action.id}`, isPlan && decision === 'confirm' ? { decision, createTasks } : { decision });
    setBusy(null);
    if (!res.ok) {
      setError(res.error ?? 'The action could not be completed.');
      if (decision === 'confirm') onResolved({ ...action, status: 'failed', resultSummary: res.error }, `That action failed: ${res.error}`);
      return;
    }
    if (decision === 'confirm') {
      onResolved({ ...action, status: 'confirmed', resultSummary: res.summary ?? null }, `Done: ${res.summary}`);
      notify(DATA_CHANGED);
    } else {
      onResolved({ ...action, status: 'cancelled', resultSummary: 'Cancelled by you. Nothing was changed.' }, `Cancelled: ${action.summary}. Nothing was changed.`);
    }
  };

  return (
    <div className={`mt-3 rounded-xl border p-3 ${action.status === 'pending' ? 'border-warn/40 bg-warn/5' : 'border-line bg-surface'}`}>
      <div className="flex flex-wrap items-center gap-2">
        <Badge tone={badge.tone}>{badge.label}</Badge>
        <span className="text-sm font-medium">{isPlan ? 'Proposed study plan' : 'Proposed action'}</span>
      </div>
      <p className="mt-1.5 text-sm text-muted first-letter:uppercase">{action.summary}</p>
      {isPlan && !!action.preview && (
        <div className="mt-3">
          <PlanPreview plan={action.preview as StudyPlan} maxDays={7} />
        </div>
      )}
      {action.resultSummary && action.status !== 'pending' && <p className="mt-2 text-xs text-faint">{action.resultSummary}</p>}
      {error && <div className="mt-2"><ErrorNote message={error} /></div>}
      {action.status === 'pending' && (
        <div className="mt-3 flex flex-wrap items-center gap-3">
          {isPlan && (
            <label className="flex items-center gap-2 text-xs text-muted">
              <input type="checkbox" checked={createTasks} onChange={(e) => setCreateTasks(e.target.checked)} className="accent-[var(--color-accent-strong)]" />
              Also add each session as a task
            </label>
          )}
          <div className="ml-auto flex gap-2">
            <Button variant="ghost" onClick={() => decide('cancel')} disabled={!!busy}>
              {busy === 'cancel' && <Spinner />} Cancel
            </Button>
            <Button variant={isPlan ? 'primary' : 'danger'} onClick={() => decide('confirm')} disabled={!!busy}>
              {busy === 'confirm' && <Spinner />} {isPlan ? 'Save plan' : 'Confirm'}
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}
