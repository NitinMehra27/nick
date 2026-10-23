'use client';

import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { useCallback, useEffect, useState, type ReactNode } from 'react';
import { CONVERSATIONS_CHANGED, getJson, postJson } from '@/lib/client';
import { NickCore } from './NickCore';
import { StatusBanner } from './StatusBanner';
import { Button, ConfirmDialog } from './ui';

interface ConversationSummary {
  id: string;
  title: string;
  updatedAt: string;
  messageCount: number;
}

const NAV = [
  { href: '/', label: 'Chat', match: (p: string) => p === '/' || p.startsWith('/c/') },
  { href: '/tasks', label: 'Tasks', match: (p: string) => p.startsWith('/tasks') },
  { href: '/plans', label: 'Study plans', match: (p: string) => p.startsWith('/plans') },
  { href: '/memory', label: 'Memory', match: (p: string) => p.startsWith('/memory') },
  { href: '/settings', label: 'Settings & status', match: (p: string) => p.startsWith('/settings') },
];

export function AppShell({ children }: { children: ReactNode }) {
  const pathname = usePathname();
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [conversations, setConversations] = useState<ConversationSummary[] | null>(null);
  const [listError, setListError] = useState<string | null>(null);
  const [pendingDelete, setPendingDelete] = useState<ConversationSummary | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);

  const load = useCallback(async () => {
    const res = await getJson<{ conversations: ConversationSummary[] }>('/api/conversations');
    if (res.ok) {
      setConversations(res.conversations);
      setListError(null);
    } else setListError(res.error);
  }, []);

  useEffect(() => {
    void load();
    window.addEventListener(CONVERSATIONS_CHANGED, load);
    return () => window.removeEventListener(CONVERSATIONS_CHANGED, load);
  }, [load]);

  useEffect(() => setOpen(false), [pathname]);

  const activeId = pathname.startsWith('/c/') ? pathname.slice(3) : null;

  const confirmDelete = async () => {
    if (!pendingDelete) return;
    setDeleting(true);
    const res = await postJson(`/api/conversations/${pendingDelete.id}`, { confirmed: true }, 'DELETE');
    setDeleting(false);
    if (!res.ok) {
      setDeleteError(res.error ?? 'Could not delete the conversation.');
      return;
    }
    const wasActive = pendingDelete.id === activeId;
    setPendingDelete(null);
    void load();
    if (wasActive) router.push('/');
  };

  return (
    <div className="flex h-dvh overflow-hidden">
      {open && <button aria-label="Close menu" className="fixed inset-0 z-30 bg-black/50 md:hidden" onClick={() => setOpen(false)} />}
      <aside
        className={`fixed inset-y-0 left-0 z-40 flex w-72 flex-col border-r border-line bg-surface transition-transform md:static md:translate-x-0 ${open ? 'translate-x-0' : '-translate-x-full'}`}
        aria-label="Sidebar"
      >
        <div className="px-4 pt-5 pb-3">
          <Link href="/" className="flex items-center gap-2.5">
            <NickCore size={32} />
            <span>
              <span className="block text-sm font-semibold tracking-[0.2em]">NICK</span>
              <span className="block text-[11px] text-faint">Local personal AI assistant</span>
            </span>
          </Link>
        </div>
        <div className="px-3">
          <Link
            href="/"
            onClick={() => window.dispatchEvent(new Event('nick:new-conversation'))}
            className="flex w-full items-center justify-center rounded-lg border border-line bg-raised px-3 py-2 text-sm font-medium hover:border-faint"
          >
            + New conversation
          </Link>
        </div>
        <nav className="mt-4 px-3" aria-label="Main">
          {NAV.map((item) => (
            <Link
              key={item.href}
              href={item.href}
              aria-current={item.match(pathname) ? 'page' : undefined}
              className={`block rounded-lg border-l-2 px-3 py-2 text-sm ${item.match(pathname) ? 'border-accent bg-raised text-ink' : 'border-transparent text-muted hover:bg-raised hover:text-ink'}`}
            >
              {item.label}
            </Link>
          ))}
        </nav>
        <div className="mt-5 flex min-h-0 flex-1 flex-col px-3">
          <h2 className="px-3 pb-1 text-[11px] font-semibold uppercase tracking-wider text-faint">Conversations</h2>
          <div className="min-h-0 flex-1 overflow-y-auto pb-3">
            {listError && <p className="px-3 text-xs text-bad">{listError}</p>}
            {!listError && conversations === null && <p className="px-3 text-xs text-faint">Loading…</p>}
            {conversations?.length === 0 && <p className="px-3 text-xs text-faint">No conversations yet.</p>}
            {conversations?.map((c) => (
              <div key={c.id} className={`group flex items-center rounded-lg ${c.id === activeId ? 'bg-raised' : 'hover:bg-raised'}`}>
                <Link href={`/c/${c.id}`} className="min-w-0 flex-1 truncate px-3 py-1.5 text-sm text-muted group-hover:text-ink" title={c.title}>
                  {c.title}
                </Link>
                <button
                  aria-label={`Delete conversation ${c.title}`}
                  className="mr-1 rounded px-1.5 text-faint opacity-60 hover:text-bad group-hover:opacity-100 focus:opacity-100"
                  onClick={() => {
                    setDeleteError(null);
                    setPendingDelete(c);
                  }}
                >
                  ×
                </button>
              </div>
            ))}
          </div>
        </div>
        <p className="border-t border-line px-4 py-3 text-[11px] leading-relaxed text-faint">
          Single-user local app. Data stays in SQLite on this computer; AI runs locally via Ollama.
        </p>
      </aside>

      <div className="flex min-w-0 flex-1 flex-col">
        <div className="flex items-center gap-2 border-b border-line px-3 py-2 md:hidden">
          <Button variant="ghost" aria-label="Open menu" onClick={() => setOpen(true)}>
            ☰
          </Button>
          <span className="text-sm font-semibold">NICK</span>
        </div>
        <StatusBanner />
        <main className="min-h-0 flex-1 overflow-hidden">{children}</main>
      </div>

      <ConfirmDialog
        open={!!pendingDelete}
        title="Delete conversation?"
        body={
          <>
            “{pendingDelete?.title}” and its messages will be removed from this computer. Tasks, plans and memories created in it are kept.
          </>
        }
        busy={deleting}
        error={deleteError}
        onConfirm={confirmDelete}
        onCancel={() => setPendingDelete(null)}
      />
    </div>
  );
}
