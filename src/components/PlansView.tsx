'use client';

import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react';
import { DATA_CHANGED, callTool, formatDate, formatMinutes, notify, type StudyPlan } from '@/lib/client';
import { PlanPreview } from './PlanPreview';
import { Badge, Button, ConfirmDialog, EmptyState, ErrorNote, Field, PageHeader, Spinner, inputClass } from './ui';

interface PlanSummary {
  id: number;
  title: string;
  status: string;
  startDate: string;
  targetDate: string;
  totalMinutes: number;
  completedMinutes: number;
  itemCount: number;
}

const WEEKDAYS = ['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday'] as const;

/** Parses "Math:hard, Chemistry, History:easy" into subjects with optional difficulty. */
function parseSubjects(text: string) {
  return text
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
    .map((s) => {
      const [name, diff] = s.split(':').map((x) => x.trim());
      const difficulty = ['easy', 'medium', 'hard'].includes(diff?.toLowerCase()) ? (diff.toLowerCase() as 'easy' | 'medium' | 'hard') : undefined;
      return { name, ...(difficulty ? { difficulty } : {}) };
    });
}

function Planner({ onSaved }: { onSaved: (id: number) => void }) {
  const [subjects, setSubjects] = useState('');
  const [targetDate, setTargetDate] = useState('');
  const [hoursPerDay, setHoursPerDay] = useState('2');
  const [sessionMinutes, setSessionMinutes] = useState('50');
  const [restDays, setRestDays] = useState<string[]>([]);
  const [title, setTitle] = useState('');
  const [preview, setPreview] = useState<StudyPlan | null>(null);
  const [createTasks, setCreateTasks] = useState(true);
  const [busy, setBusy] = useState<'preview' | 'save' | null>(null);
  const [error, setError] = useState<string | null>(null);

  const args = () => ({
    subjects: parseSubjects(subjects),
    targetDate,
    hoursPerDay: Number(hoursPerDay),
    sessionMinutes: Number(sessionMinutes),
    ...(restDays.length ? { restDays } : {}),
    ...(title.trim() ? { title: title.trim() } : {}),
  });

  const runPreview = async (e: FormEvent) => {
    e.preventDefault();
    setBusy('preview');
    setError(null);
    const res = await callTool<{ plan: StudyPlan }>('create_study_plan', args());
    setBusy(null);
    if (!res.ok) {
      setPreview(null);
      return setError(res.error ?? 'Could not generate a plan.');
    }
    setPreview(res.data!.plan);
  };

  const save = async () => {
    setBusy('save');
    setError(null);
    const res = await callTool<{ planId: number }>('create_study_plan', { ...args(), save: true, createTasks });
    setBusy(null);
    if (!res.ok) return setError(res.error ?? 'Could not save the plan.');
    setPreview(null);
    setSubjects('');
    setTitle('');
    notify(DATA_CHANGED);
    onSaved(res.data!.planId);
  };

  return (
    <div className="rounded-xl border border-line bg-surface p-4">
      <form onSubmit={runPreview} className="space-y-3">
        <div className="grid gap-3 sm:grid-cols-[1fr_10rem]">
          <Field label="Subjects (comma separated)" hint='Optional difficulty: "Math:hard, Chemistry, History:easy"'>
            <input className={inputClass} value={subjects} onChange={(e) => { setSubjects(e.target.value); setPreview(null); }} required placeholder="Math:hard, Chemistry" />
          </Field>
          <Field label="Exam / target date">
            <input type="date" className={inputClass} value={targetDate} onChange={(e) => { setTargetDate(e.target.value); setPreview(null); }} required />
          </Field>
        </div>
        <div className="grid gap-3 sm:grid-cols-3">
          <Field label="Hours available per day">
            <input type="number" min="0.25" max="16" step="0.25" className={inputClass} value={hoursPerDay} onChange={(e) => { setHoursPerDay(e.target.value); setPreview(null); }} required />
          </Field>
          <Field label="Session length (minutes)">
            <input type="number" min="15" max="240" step="5" className={inputClass} value={sessionMinutes} onChange={(e) => { setSessionMinutes(e.target.value); setPreview(null); }} required />
          </Field>
          <Field label="Plan title (optional)">
            <input className={inputClass} value={title} onChange={(e) => setTitle(e.target.value)} maxLength={120} />
          </Field>
        </div>
        <fieldset>
          <legend className="mb-1 text-xs font-medium text-muted">Rest days (no study)</legend>
          <div className="flex flex-wrap gap-2">
            {WEEKDAYS.map((d) => (
              <label key={d} className="flex items-center gap-1 text-xs text-muted">
                <input
                  type="checkbox"
                  checked={restDays.includes(d)}
                  onChange={(e) => { setRestDays((r) => (e.target.checked ? [...r, d] : r.filter((x) => x !== d))); setPreview(null); }}
                  className="accent-[var(--color-accent-strong)]"
                />
                {d.slice(0, 3)}
              </label>
            ))}
          </div>
        </fieldset>
        {error && <ErrorNote message={error} />}
        <div className="flex justify-end">
          <Button type="submit" disabled={!!busy || !subjects.trim() || !targetDate}>
            {busy === 'preview' && <Spinner />} Preview plan
          </Button>
        </div>
      </form>
      {preview && (
        <div className="mt-4 border-t border-line pt-4">
          <div className="mb-2 flex flex-wrap items-center gap-2">
            <Badge tone="warn">Preview · not saved</Badge>
            <span className="text-sm font-medium">{preview.title}</span>
          </div>
          <p className="mb-3 text-xs text-faint">Generated by a simple, transparent scheduling rule (harder subjects get more time, never above your daily hours). It is a starting point, not an optimal plan.</p>
          <PlanPreview plan={preview} />
          <div className="mt-3 flex flex-wrap items-center justify-end gap-3">
            <label className="flex items-center gap-2 text-xs text-muted">
              <input type="checkbox" checked={createTasks} onChange={(e) => setCreateTasks(e.target.checked)} className="accent-[var(--color-accent-strong)]" />
              Also add each session as a task
            </label>
            <Button variant="primary" onClick={save} disabled={!!busy}>
              {busy === 'save' && <Spinner />} Save plan
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}

export function PlansView() {
  const [plans, setPlans] = useState<PlanSummary[] | null>(null);
  const [selected, setSelected] = useState<StudyPlan | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [showPlanner, setShowPlanner] = useState(false);
  const [toDelete, setToDelete] = useState<PlanSummary | null>(null);
  const [deleteBusy, setDeleteBusy] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const [itemError, setItemError] = useState<string | null>(null);

  const selectedId = useRef<number | null>(null);

  const open = useCallback(async (id: number) => {
    selectedId.current = id;
    const res = await callTool<{ plan: StudyPlan }>('get_study_plan', { planId: id });
    if (res.ok) setSelected(res.data!.plan);
    else setError(res.error ?? 'Could not open the plan.');
  }, []);

  const load = useCallback(async () => {
    const res = await callTool<{ plans: PlanSummary[] }>('list_study_plans');
    if (!res.ok) return setError(res.error ?? 'Could not load plans.');
    setError(null);
    setPlans(res.data!.plans);
    const current = selectedId.current;
    const keep = current && res.data!.plans.some((p) => p.id === current) ? current : res.data!.plans[0]?.id;
    if (keep) void open(keep);
    else {
      selectedId.current = null;
      setSelected(null);
    }
  }, [open]);

  useEffect(() => {
    void load();
    window.addEventListener(DATA_CHANGED, load);
    return () => window.removeEventListener(DATA_CHANGED, load);
  }, [load]);

  const toggleItem = async (itemId: number, completed: boolean) => {
    if (!selected?.id) return;
    setItemError(null);
    const res = await callTool<{ plan: StudyPlan }>('update_study_plan_item', { planId: selected.id, itemId, completed });
    if (res.ok) {
      setSelected(res.data!.plan);
      void callTool<{ plans: PlanSummary[] }>('list_study_plans').then((r) => r.ok && setPlans(r.data!.plans));
    } else setItemError(res.error ?? 'Could not update the session.');
  };

  const confirmDelete = async () => {
    if (!toDelete) return;
    setDeleteBusy(true);
    const res = await callTool('delete_study_plan', { planId: toDelete.id }, true);
    setDeleteBusy(false);
    if (!res.ok) return setDeleteError(res.error ?? 'Could not delete the plan.');
    setToDelete(null);
    selectedId.current = null;
    setSelected(null);
    notify(DATA_CHANGED);
  };

  const days = new Map<string, StudyPlan['items']>();
  for (const i of selected?.items ?? []) days.set(i.date, [...(days.get(i.date) ?? []), i]);

  return (
    <div className="h-full overflow-y-auto">
      <PageHeader
        title="Study plans"
        description="Create a plan here or ask NICK in chat. Plans are previews until you save them."
        actions={
          <Button variant="primary" onClick={() => setShowPlanner((s) => !s)} aria-expanded={showPlanner}>
            {showPlanner ? 'Close' : '+ New plan'}
          </Button>
        }
      />
      <div className="mx-auto max-w-5xl space-y-5 px-4 py-5 md:px-8">
        {showPlanner && (
          <Planner
            onSaved={(id) => {
              setShowPlanner(false);
              void open(id);
            }}
          />
        )}
        {error && <ErrorNote message={error} onRetry={load} />}
        {!error && plans === null && (
          <p className="flex items-center gap-2 text-sm text-muted">
            <Spinner /> Loading plans…
          </p>
        )}
        {plans?.length === 0 && !showPlanner && (
          <EmptyState title="No saved study plans.">Use “+ New plan”, or ask NICK: “Make a study plan for Math and Physics before my exam on the 30th, 2 hours a day”.</EmptyState>
        )}
        {plans && plans.length > 0 && (
          <div className="grid gap-5 lg:grid-cols-[16rem_1fr]">
            <ul className="space-y-2">
              {plans.map((p) => (
                <li key={p.id}>
                  <button
                    onClick={() => void open(p.id)}
                    aria-current={selected?.id === p.id}
                    className={`w-full rounded-xl border px-3 py-2 text-left ${selected?.id === p.id ? 'border-accent/60 bg-raised' : 'border-line bg-surface hover:border-faint'}`}
                  >
                    <p className="truncate text-sm">{p.title}</p>
                    <p className="mt-0.5 text-xs text-faint">
                      {formatMinutes(p.completedMinutes)} of {formatMinutes(p.totalMinutes)} done · exam {formatDate(p.targetDate)}
                    </p>
                    <div className="mt-1.5 h-1 overflow-hidden rounded bg-line">
                      <div className="h-full bg-accent-strong" style={{ width: `${p.totalMinutes ? Math.round((p.completedMinutes / p.totalMinutes) * 100) : 0}%` }} />
                    </div>
                  </button>
                </li>
              ))}
            </ul>
            {selected && (
              <section className="rounded-xl border border-line bg-surface p-4" aria-label="Plan details">
                <div className="flex flex-wrap items-start justify-between gap-2">
                  <div>
                    <h2 className="font-semibold">{selected.title}</h2>
                    <p className="text-xs text-muted">
                      {selected.items.length} sessions · {formatMinutes(selected.totalMinutes)} · up to {selected.hoursPerDay} h/day · exam {formatDate(selected.targetDate)}
                    </p>
                  </div>
                  <Button
                    variant="ghost"
                    className="hover:text-bad"
                    onClick={() => {
                      setDeleteError(null);
                      setToDelete(plans.find((p) => p.id === selected.id) ?? null);
                    }}
                  >
                    Delete plan
                  </Button>
                </div>
                {selected.warnings.length > 0 && (
                  <ul className="mt-2 list-disc pl-4 text-xs text-warn">
                    {selected.warnings.map((w) => (
                      <li key={w}>{w}</li>
                    ))}
                  </ul>
                )}
                {itemError && <div className="mt-2"><ErrorNote message={itemError} /></div>}
                <div className="mt-4 space-y-3">
                  {[...days.entries()].map(([date, items]) => (
                    <div key={date}>
                      <h3 className="text-xs font-semibold text-muted">{formatDate(date)}</h3>
                      <ul className="mt-1 space-y-1">
                        {items.map((i) => (
                          <li key={i.id} className="flex items-center gap-2 text-sm">
                            <input
                              type="checkbox"
                              checked={i.completed}
                              onChange={(e) => void toggleItem(i.id!, e.target.checked)}
                              aria-label={`Mark ${i.subject} session on ${date} as ${i.completed ? 'not done' : 'done'}`}
                              className="h-4 w-4 accent-[var(--color-accent-strong)]"
                            />
                            <span className={i.completed ? 'text-faint line-through' : ''}>
                              {i.subject}
                              {i.topic && <span className="text-faint"> · {i.topic}</span>}
                            </span>
                            <span className="ml-auto text-xs text-faint">{i.minutes} min</span>
                            {i.taskId && <Badge>task #{i.taskId}</Badge>}
                          </li>
                        ))}
                      </ul>
                    </div>
                  ))}
                </div>
              </section>
            )}
          </div>
        )}
      </div>
      <ConfirmDialog
        open={!!toDelete}
        title="Delete study plan?"
        body={<>“{toDelete?.title}” will be deleted. Tasks that were created from it are kept.</>}
        busy={deleteBusy}
        error={deleteError}
        onConfirm={confirmDelete}
        onCancel={() => setToDelete(null)}
      />
    </div>
  );
}
