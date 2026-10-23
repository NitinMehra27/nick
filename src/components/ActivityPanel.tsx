'use client';

import Link from 'next/link';
import { useCallback, useEffect, useState } from 'react';
import { DATA_CHANGED, callTool, formatDate, getJson, type ActivityRecord, type StudyPlan, type Task } from '@/lib/client';
import { ActivityList } from './chat/ActivityList';
import { Badge } from './ui';

/** Right-hand panel: live run activity, upcoming tasks, active plan and recent tool history. */
export function ActivityPanel({ live, running }: { live: ActivityRecord[]; running: boolean }) {
  const [tasks, setTasks] = useState<Task[] | null>(null);
  const [plan, setPlan] = useState<StudyPlan | null | undefined>(undefined);
  const [recent, setRecent] = useState<ActivityRecord[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    const [t, p, a] = await Promise.all([
      callTool<{ tasks: Task[] }>('list_tasks', { limit: 30 }),
      callTool<{ plan: StudyPlan }>('get_study_plan', {}),
      getJson<{ activity: ActivityRecord[] }>('/api/activity'),
    ]);
    if (t.ok) {
      setTasks(t.data!.tasks.filter((x) => x.status !== 'completed').slice(0, 6));
      setError(null);
    } else setError(t.error ?? 'Could not load tasks.');
    setPlan(p.ok ? p.data!.plan : null);
    setRecent(a.ok ? a.activity.slice(0, 12) : []);
  }, []);

  useEffect(() => {
    void load();
    window.addEventListener(DATA_CHANGED, load);
    return () => window.removeEventListener(DATA_CHANGED, load);
  }, [load]);

  const nextSession = plan?.items.find((i) => !i.completed);

  return (
    <aside className="hidden w-80 shrink-0 overflow-y-auto border-l border-line bg-surface/50 p-4 xl:block" aria-label="Context panel">
      <section>
        <h2 className="text-[11px] font-semibold uppercase tracking-wider text-faint">This request</h2>
        <div className="mt-2">
          {live.length ? <ActivityList items={live} compact /> : <p className="text-xs text-faint">{running ? 'Waiting for the model…' : 'Tool calls for your next message appear here.'}</p>}
        </div>
      </section>

      <section className="mt-6">
        <div className="flex items-center justify-between">
          <h2 className="text-[11px] font-semibold uppercase tracking-wider text-faint">Open tasks</h2>
          <Link href="/tasks" className="text-xs text-accent hover:underline">
            All tasks
          </Link>
        </div>
        <div className="mt-2 space-y-1.5">
          {error && <p className="text-xs text-bad">{error}</p>}
          {!error && tasks === null && <p className="text-xs text-faint">Loading…</p>}
          {tasks?.length === 0 && <p className="text-xs text-faint">No open tasks.</p>}
          {tasks?.map((t) => (
            <div key={t.id} className="rounded-lg border border-line bg-surface px-2.5 py-1.5">
              <p className="truncate text-xs text-ink" title={t.title}>
                <span className="text-faint">#{t.id}</span> {t.title}
              </p>
              <div className="mt-1 flex gap-1">
                {t.dueDate && <Badge tone={t.overdue ? 'bad' : 'neutral'}>{t.overdue ? 'Overdue · ' : ''}{formatDate(t.dueDate)}</Badge>}
                {t.priority === 'high' && <Badge tone="warn">High</Badge>}
              </div>
            </div>
          ))}
        </div>
      </section>

      <section className="mt-6">
        <h2 className="text-[11px] font-semibold uppercase tracking-wider text-faint">Active study plan</h2>
        <div className="mt-2 text-xs">
          {plan === undefined && <p className="text-faint">Loading…</p>}
          {plan === null && <p className="text-faint">No saved plan yet.</p>}
          {plan && (
            <Link href="/plans" className="block rounded-lg border border-line bg-surface px-2.5 py-2 hover:border-faint">
              <p className="truncate text-ink">{plan.title}</p>
              <p className="mt-0.5 text-faint">
                {plan.items.filter((i) => i.completed).length}/{plan.items.length} sessions done
                {nextSession && ` · next: ${nextSession.subject} on ${formatDate(nextSession.date)}`}
              </p>
            </Link>
          )}
        </div>
      </section>

      <section className="mt-6">
        <h2 className="text-[11px] font-semibold uppercase tracking-wider text-faint">Recent tool activity</h2>
        <div className="mt-2">
          {recent === null && <p className="text-xs text-faint">Loading…</p>}
          {recent?.length === 0 && <p className="text-xs text-faint">No tool calls yet.</p>}
          {recent && <ActivityList items={recent} />}
        </div>
      </section>
    </aside>
  );
}
