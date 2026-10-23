'use client';

import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { DATA_CHANGED, callTool, formatDate, notify, type Task } from '@/lib/client';
import { Badge, Button, ConfirmDialog, EmptyState, ErrorNote, Field, PageHeader, Spinner, inputClass } from './ui';

type Counts = { total: number; pending: number; inProgress: number; completed: number; overdue: number };
type Draft = { title: string; description: string; priority: 'low' | 'medium' | 'high'; dueDate: string; category: string };

const emptyDraft: Draft = { title: '', description: '', priority: 'medium', dueDate: '', category: '' };
const PRIORITY_TONE = { high: 'warn', medium: 'neutral', low: 'neutral' } as const;
const STATUS_LABEL = { pending: 'To do', in_progress: 'In progress', completed: 'Done' } as const;

function TaskForm({ initial, submitLabel, onSubmit, onCancel }: { initial: Draft; submitLabel: string; onSubmit: (d: Draft) => Promise<string | null>; onCancel?: () => void }) {
  const [draft, setDraft] = useState(initial);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const set = <K extends keyof Draft>(k: K, v: Draft[K]) => setDraft((d) => ({ ...d, [k]: v }));
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    const err = await onSubmit(draft);
    setBusy(false);
    if (err) setError(err);
    else if (!onCancel) setDraft(emptyDraft);
  };
  return (
    <form onSubmit={submit} className="space-y-3">
      <div className="grid gap-3 sm:grid-cols-[1fr_9rem_9rem]">
        <Field label="Title">
          <input className={inputClass} value={draft.title} onChange={(e) => set('title', e.target.value)} required maxLength={200} placeholder="e.g. Revise chapter 4" />
        </Field>
        <Field label="Due date">
          <input type="date" className={inputClass} value={draft.dueDate} onChange={(e) => set('dueDate', e.target.value)} />
        </Field>
        <Field label="Priority">
          <select className={inputClass} value={draft.priority} onChange={(e) => set('priority', e.target.value as Draft['priority'])}>
            <option value="low">Low</option>
            <option value="medium">Medium</option>
            <option value="high">High</option>
          </select>
        </Field>
      </div>
      <div className="grid gap-3 sm:grid-cols-[1fr_12rem]">
        <Field label="Description (optional)">
          <input className={inputClass} value={draft.description} onChange={(e) => set('description', e.target.value)} maxLength={2000} />
        </Field>
        <Field label="Category (optional)">
          <input className={inputClass} value={draft.category} onChange={(e) => set('category', e.target.value)} maxLength={50} placeholder="study, work…" />
        </Field>
      </div>
      {error && <ErrorNote message={error} />}
      <div className="flex justify-end gap-2">
        {onCancel && (
          <Button variant="ghost" onClick={onCancel} disabled={busy}>
            Cancel
          </Button>
        )}
        <Button type="submit" variant="primary" disabled={busy || !draft.title.trim()}>
          {busy && <Spinner />} {submitLabel}
        </Button>
      </div>
    </form>
  );
}

export function TasksView() {
  const [tasks, setTasks] = useState<Task[] | null>(null);
  const [counts, setCounts] = useState<Counts | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  const [status, setStatus] = useState('');
  const [priority, setPriority] = useState('');
  const [showForm, setShowForm] = useState(false);
  const [editing, setEditing] = useState<number | null>(null);
  const [toDelete, setToDelete] = useState<Task | null>(null);
  const [deleteBusy, setDeleteBusy] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const [rowError, setRowError] = useState<string | null>(null);

  const load = useCallback(async () => {
    const args: Record<string, unknown> = { limit: 100 };
    if (query.trim()) args.query = query.trim();
    if (status) args.status = status;
    if (priority) args.priority = priority;
    const res = await callTool<{ tasks: Task[]; counts: Counts }>('list_tasks', args);
    if (res.ok) {
      setTasks(res.data!.tasks);
      setCounts(res.data!.counts);
      setError(null);
    } else setError(res.error ?? 'Could not load tasks.');
  }, [query, status, priority]);

  useEffect(() => {
    const t = setTimeout(() => void load(), 200);
    return () => clearTimeout(t);
  }, [load]);

  useEffect(() => {
    window.addEventListener(DATA_CHANGED, load);
    return () => window.removeEventListener(DATA_CHANGED, load);
  }, [load]);

  const toArgs = (d: Draft) => ({
    title: d.title.trim(),
    priority: d.priority,
    ...(d.dueDate ? { dueDate: d.dueDate } : {}),
    ...(d.description.trim() ? { description: d.description.trim() } : {}),
    ...(d.category.trim() ? { category: d.category.trim() } : {}),
  });

  const create = async (d: Draft) => {
    const res = await callTool('create_task', toArgs(d));
    if (!res.ok) return res.error ?? 'Could not create the task.';
    setShowForm(false);
    notify(DATA_CHANGED);
    return null;
  };

  const save = async (task: Task, d: Draft) => {
    const res = await callTool('update_task', {
      taskId: task.id,
      title: d.title.trim(),
      priority: d.priority,
      dueDate: d.dueDate || null,
      description: d.description.trim() || null,
      category: d.category.trim() || null,
    });
    if (!res.ok) return res.error ?? 'Could not save the task.';
    setEditing(null);
    notify(DATA_CHANGED);
    return null;
  };

  const toggle = async (task: Task) => {
    setRowError(null);
    const res = task.status === 'completed' ? await callTool('update_task', { taskId: task.id, status: 'pending' }) : await callTool('complete_task', { taskId: task.id });
    if (!res.ok) setRowError(res.error ?? 'Could not update the task.');
    notify(DATA_CHANGED);
  };

  const setTaskStatus = async (task: Task, next: string) => {
    setRowError(null);
    const res = await callTool('update_task', { taskId: task.id, status: next });
    if (!res.ok) setRowError(res.error ?? 'Could not update the task.');
    notify(DATA_CHANGED);
  };

  const confirmDelete = async () => {
    if (!toDelete) return;
    setDeleteBusy(true);
    const res = await callTool('delete_task', { taskId: toDelete.id }, true);
    setDeleteBusy(false);
    if (!res.ok) {
      setDeleteError(res.error ?? 'Could not delete the task.');
      return;
    }
    setToDelete(null);
    notify(DATA_CHANGED);
  };

  const filtered = !!(query.trim() || status || priority);

  return (
    <div className="h-full overflow-y-auto">
      <PageHeader
        title="Tasks"
        description={
          counts ? `${counts.total} total · ${counts.pending + counts.inProgress} open · ${counts.completed} done${counts.overdue ? ` · ${counts.overdue} overdue` : ''}` : 'Stored in SQLite, read and changed through MCP tools.'
        }
        actions={
          <Button variant="primary" onClick={() => setShowForm((s) => !s)} aria-expanded={showForm}>
            {showForm ? 'Close' : '+ New task'}
          </Button>
        }
      />
      <div className="mx-auto max-w-4xl space-y-4 px-4 py-5 md:px-8">
        {showForm && (
          <div className="rounded-xl border border-line bg-surface p-4">
            <TaskForm initial={emptyDraft} submitLabel="Create task" onSubmit={create} />
          </div>
        )}

        <div className="flex flex-wrap gap-2">
          <label className="min-w-48 flex-1">
            <span className="sr-only">Search tasks</span>
            <input className={inputClass} placeholder="Search title or description…" value={query} onChange={(e) => setQuery(e.target.value)} maxLength={100} />
          </label>
          <label>
            <span className="sr-only">Filter by status</span>
            <select className={inputClass} value={status} onChange={(e) => setStatus(e.target.value)}>
              <option value="">All statuses</option>
              <option value="pending">To do</option>
              <option value="in_progress">In progress</option>
              <option value="completed">Done</option>
            </select>
          </label>
          <label>
            <span className="sr-only">Filter by priority</span>
            <select className={inputClass} value={priority} onChange={(e) => setPriority(e.target.value)}>
              <option value="">All priorities</option>
              <option value="high">High</option>
              <option value="medium">Medium</option>
              <option value="low">Low</option>
            </select>
          </label>
        </div>

        {error && <ErrorNote message={error} onRetry={load} />}
        {rowError && <ErrorNote message={rowError} />}
        {!error && tasks === null && (
          <p className="flex items-center gap-2 text-sm text-muted">
            <Spinner /> Loading tasks…
          </p>
        )}
        {tasks?.length === 0 &&
          (filtered ? (
            <EmptyState title="No tasks match these filters." />
          ) : (
            <EmptyState title="No tasks yet.">Create one above, or ask NICK in chat: “Add a task to revise chapter 3 by Friday”.</EmptyState>
          ))}

        <ul className="space-y-2">
          {tasks?.map((t) => (
            <li key={t.id} className="rounded-xl border border-line bg-surface p-3">
              {editing === t.id ? (
                <TaskForm
                  initial={{ title: t.title, description: t.description ?? '', priority: t.priority, dueDate: t.dueDate ?? '', category: t.category ?? '' }}
                  submitLabel="Save"
                  onSubmit={(d) => save(t, d)}
                  onCancel={() => setEditing(null)}
                />
              ) : (
                <div className="flex items-start gap-3">
                  <input
                    type="checkbox"
                    checked={t.status === 'completed'}
                    onChange={() => void toggle(t)}
                    aria-label={t.status === 'completed' ? `Mark "${t.title}" as not done` : `Mark "${t.title}" as done`}
                    className="mt-1 h-4 w-4 accent-[var(--color-accent-strong)]"
                  />
                  <div className="min-w-0 flex-1">
                    <p className={`text-sm ${t.status === 'completed' ? 'text-faint line-through' : 'text-ink'}`}>
                      <span className="text-faint">#{t.id}</span> {t.title}
                    </p>
                    {t.description && <p className="mt-0.5 text-xs text-muted">{t.description}</p>}
                    <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
                      <Badge tone={PRIORITY_TONE[t.priority]}>{t.priority} priority</Badge>
                      {t.dueDate && <Badge tone={t.overdue ? 'bad' : 'neutral'}>{t.overdue ? 'Overdue · ' : 'Due '}{formatDate(t.dueDate)}</Badge>}
                      {t.category && <Badge tone="accent">{t.category}</Badge>}
                      <label className="ml-1 text-xs text-faint">
                        <span className="sr-only">Status</span>
                        <select value={t.status} onChange={(e) => void setTaskStatus(t, e.target.value)} className="rounded border border-line bg-surface px-1 py-0.5 text-xs text-muted">
                          {Object.entries(STATUS_LABEL).map(([v, l]) => (
                            <option key={v} value={v}>
                              {l}
                            </option>
                          ))}
                        </select>
                      </label>
                    </div>
                  </div>
                  <div className="flex shrink-0 gap-1">
                    <Button variant="ghost" onClick={() => setEditing(t.id)} aria-label={`Edit "${t.title}"`}>
                      Edit
                    </Button>
                    <Button
                      variant="ghost"
                      className="hover:text-bad"
                      onClick={() => {
                        setDeleteError(null);
                        setToDelete(t);
                      }}
                      aria-label={`Delete "${t.title}"`}
                    >
                      Delete
                    </Button>
                  </div>
                </div>
              )}
            </li>
          ))}
        </ul>
      </div>
      <ConfirmDialog
        open={!!toDelete}
        title="Delete task?"
        body={<>Task #{toDelete?.id} “{toDelete?.title}” will be permanently deleted.</>}
        busy={deleteBusy}
        error={deleteError}
        onConfirm={confirmDelete}
        onCancel={() => setToDelete(null)}
      />
    </div>
  );
}
