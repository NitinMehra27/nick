'use client';

import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { DATA_CHANGED, callTool, notify, type Memory } from '@/lib/client';
import { Badge, Button, ConfirmDialog, EmptyState, ErrorNote, Field, PageHeader, Spinner, inputClass } from './ui';

const CATEGORIES = ['preference', 'goal', 'project', 'fact', 'other'] as const;

export function MemoryView() {
  const [memories, setMemories] = useState<Memory[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  const [content, setContent] = useState('');
  const [category, setCategory] = useState<(typeof CATEGORIES)[number]>('preference');
  const [adding, setAdding] = useState(false);
  const [addError, setAddError] = useState<string | null>(null);
  const [editing, setEditing] = useState<{ id: number; content: string } | null>(null);
  const [editError, setEditError] = useState<string | null>(null);
  const [toDelete, setToDelete] = useState<Memory | null>(null);
  const [clearing, setClearing] = useState(false);
  const [dialogBusy, setDialogBusy] = useState(false);
  const [dialogError, setDialogError] = useState<string | null>(null);

  const load = useCallback(async () => {
    const res = await callTool<{ memories: Memory[] }>('search_memory', query.trim() ? { query: query.trim(), limit: 50 } : { limit: 50 });
    if (res.ok) {
      setMemories(res.data!.memories);
      setError(null);
    } else setError(res.error ?? 'Could not load memories.');
  }, [query]);

  useEffect(() => {
    const t = setTimeout(() => void load(), 200);
    return () => clearTimeout(t);
  }, [load]);

  const add = async (e: FormEvent) => {
    e.preventDefault();
    setAdding(true);
    setAddError(null);
    const res = await callTool('save_memory', { content: content.trim(), category });
    setAdding(false);
    if (!res.ok) return setAddError(res.error ?? 'Could not save.');
    setContent('');
    notify(DATA_CHANGED);
    void load();
  };

  const saveEdit = async () => {
    if (!editing) return;
    const res = await callTool('update_memory', { memoryId: editing.id, content: editing.content.trim() });
    if (!res.ok) return setEditError(res.error ?? 'Could not update.');
    setEditing(null);
    setEditError(null);
    void load();
  };

  const runDialog = async () => {
    setDialogBusy(true);
    setDialogError(null);
    const res = clearing ? await callTool('clear_memories', {}, true) : await callTool('delete_memory', { memoryId: toDelete!.id }, true);
    setDialogBusy(false);
    if (!res.ok) return setDialogError(res.error ?? 'The operation failed.');
    setToDelete(null);
    setClearing(false);
    notify(DATA_CHANGED);
    void load();
  };

  return (
    <div className="h-full overflow-y-auto">
      <PageHeader
        title="Memory"
        description="What NICK may use as context. Only relevant entries are retrieved for each request."
        actions={
          <Button
            variant="danger"
            onClick={() => {
              setDialogError(null);
              setClearing(true);
            }}
            disabled={!memories || memories.length === 0 || !!query.trim()}
            title={query.trim() ? 'Clear the search to clear all memory' : undefined}
          >
            Clear all
          </Button>
        }
      />
      <div className="mx-auto max-w-3xl space-y-4 px-4 py-5 md:px-8">
        <form onSubmit={add} className="space-y-3 rounded-xl border border-line bg-surface p-4">
          <div className="grid gap-3 sm:grid-cols-[1fr_10rem]">
            <Field label="Add something NICK should remember" hint="Keep it short. Passwords, keys and ID numbers are refused.">
              <input className={inputClass} value={content} onChange={(e) => setContent(e.target.value)} maxLength={500} placeholder="e.g. Prefers 45-minute study sessions" />
            </Field>
            <Field label="Category">
              <select className={inputClass} value={category} onChange={(e) => setCategory(e.target.value as (typeof CATEGORIES)[number])}>
                {CATEGORIES.map((c) => (
                  <option key={c} value={c}>
                    {c}
                  </option>
                ))}
              </select>
            </Field>
          </div>
          {addError && <ErrorNote message={addError} />}
          <div className="flex justify-end">
            <Button type="submit" variant="primary" disabled={adding || !content.trim()}>
              {adding && <Spinner />} Save memory
            </Button>
          </div>
        </form>

        <label className="block">
          <span className="sr-only">Search memory</span>
          <input className={inputClass} placeholder="Search memory by keyword…" value={query} onChange={(e) => setQuery(e.target.value)} maxLength={300} />
        </label>

        {error && <ErrorNote message={error} onRetry={load} />}
        {!error && memories === null && (
          <p className="flex items-center gap-2 text-sm text-muted">
            <Spinner /> Loading…
          </p>
        )}
        {memories?.length === 0 &&
          (query.trim() ? (
            <EmptyState title="No memories match that search." />
          ) : (
            <EmptyState title="Nothing saved yet.">Add one above, or tell NICK in chat: “Remember that I study best in the morning”.</EmptyState>
          ))}

        <ul className="space-y-2">
          {memories?.map((m) => (
            <li key={m.id} className="rounded-xl border border-line bg-surface p-3">
              {editing?.id === m.id ? (
                <div className="space-y-2">
                  <input className={inputClass} value={editing.content} onChange={(e) => setEditing({ id: m.id, content: e.target.value })} maxLength={500} aria-label="Memory content" />
                  {editError && <ErrorNote message={editError} />}
                  <div className="flex justify-end gap-2">
                    <Button variant="ghost" onClick={() => setEditing(null)}>
                      Cancel
                    </Button>
                    <Button variant="primary" onClick={saveEdit} disabled={!editing.content.trim()}>
                      Save
                    </Button>
                  </div>
                </div>
              ) : (
                <div className="flex items-start gap-3">
                  <div className="min-w-0 flex-1">
                    <p className="text-sm text-ink">{m.content}</p>
                    <div className="mt-1.5 flex flex-wrap gap-1.5">
                      <Badge tone="accent">{m.category}</Badge>
                      <Badge tone={m.source === 'user' ? 'ok' : 'warn'} title={m.source === 'user' ? 'You explicitly asked NICK to remember this' : 'NICK saved this without an explicit request'}>
                        {m.source === 'user' ? 'Saved by you' : 'Inferred by NICK'}
                      </Badge>
                      <span className="text-[11px] text-faint">#{m.id} · updated {new Date(m.updatedAt).toLocaleString()}</span>
                    </div>
                  </div>
                  <Button variant="ghost" onClick={() => { setEditError(null); setEditing({ id: m.id, content: m.content }); }}>
                    Edit
                  </Button>
                  <Button variant="ghost" className="hover:text-bad" onClick={() => { setDialogError(null); setToDelete(m); }}>
                    Delete
                  </Button>
                </div>
              )}
            </li>
          ))}
        </ul>
      </div>
      <ConfirmDialog
        open={!!toDelete || clearing}
        title={clearing ? 'Clear all memory?' : 'Delete memory?'}
        body={clearing ? <>Every saved memory will be permanently deleted. Tasks and plans are not affected.</> : <>“{toDelete?.content}” will be permanently deleted.</>}
        confirmLabel={clearing ? 'Clear all memory' : 'Delete'}
        requireText={clearing ? 'CLEAR' : undefined}
        busy={dialogBusy}
        error={dialogError}
        onConfirm={runDialog}
        onCancel={() => {
          setToDelete(null);
          setClearing(false);
        }}
      />
    </div>
  );
}
