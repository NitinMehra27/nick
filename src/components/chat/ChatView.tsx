'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import {
  CONVERSATIONS_CHANGED,
  DATA_CHANGED,
  getJson,
  notify,
  postJson,
  todayIso,
  type ActivityRecord,
  type AgentEvent,
  type PendingActionView,
} from '@/lib/client';
import { useVoiceReplies } from '@/lib/speech';
import { ActivityPanel } from '../ActivityPanel';
import { NickCore, type CoreState } from '../NickCore';
import { Badge, Button, ErrorNote, Spinner } from '../ui';
import { MessageItem, type UiMessage } from './MessageItem';

interface StoredMessage {
  id: number;
  role: 'user' | 'assistant';
  content: string;
  meta: UiMessage['meta'] | null;
}

function suggestions(): string[] {
  const exam = new Date();
  exam.setDate(exam.getDate() + 14);
  const examIso = `${exam.getFullYear()}-${String(exam.getMonth() + 1).padStart(2, '0')}-${String(exam.getDate()).padStart(2, '0')}`;
  return [
    'Add a high-priority task to renew my passport by Friday',
    'What tasks do I have coming up?',
    'Remember that I prefer 45-minute study sessions',
    `Make a study plan for Math and Chemistry before my exam on ${examIso}, 2 hours a day`,
  ];
}

export function ChatView({ conversationId: initialId }: { conversationId: string | null }) {
  const [conversationId, setConversationId] = useState<string | null>(initialId);
  const [title, setTitle] = useState<string>('New conversation');
  const [messages, setMessages] = useState<UiMessage[]>([]);
  const [pendingActions, setPendingActions] = useState<Record<string, PendingActionView>>({});
  const [loading, setLoading] = useState(!!initialId);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [input, setInput] = useState('');
  const [running, setRunning] = useState(false);
  const [liveActivity, setLiveActivity] = useState<ActivityRecord[]>([]);
  const [warm, setWarm] = useState<'warming' | 'ready' | 'unavailable'>('warming');
  const [runId, setRunId] = useState<string | null>(null);
  const [stopping, setStopping] = useState(false);
  const voice = useVoiceReplies();
  const scroller = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let cancelled = false;
    void postJson<{ skipped?: boolean }>('/api/warmup', {}).then((r) => !cancelled && setWarm(r.ok ? 'ready' : 'unavailable'));
    return () => {
      cancelled = true;
    };
  }, []);
  const textarea = useRef<HTMLTextAreaElement>(null);

  const load = useCallback(async (id: string) => {
    setLoading(true);
    const res = await getJson<{ conversation?: { title: string }; messages: StoredMessage[]; pendingActions: PendingActionView[] }>(`/api/conversations/${id}`);
    setLoading(false);
    if (!res.ok) {
      setLoadError(res.error);
      return;
    }
    setLoadError(null);
    setTitle(res.conversation?.title ?? 'Conversation');
    setMessages(res.messages.map((m) => ({ key: `db-${m.id}`, role: m.role, content: m.content, meta: m.meta ?? undefined })));
    setPendingActions(Object.fromEntries(res.pendingActions.map((a) => [a.id, a])));
  }, []);

  useEffect(() => {
    if (initialId) void load(initialId);
  }, [initialId, load]);

  // "New conversation" while already on "/" does not remount this component.
  useEffect(() => {
    const reset = () => {
      if (running) return;
      setConversationId(null);
      setTitle('New conversation');
      setMessages([]);
      setPendingActions({});
      setLoadError(null);
      setLiveActivity([]);
      textarea.current?.focus();
    };
    window.addEventListener('nick:new-conversation', reset);
    return () => window.removeEventListener('nick:new-conversation', reset);
  }, [running]);

  useEffect(() => {
    scroller.current?.scrollTo({ top: scroller.current.scrollHeight });
  }, [messages]);

  const updateAssistant = (key: string, fn: (m: UiMessage) => UiMessage) => setMessages((all) => all.map((m) => (m.key === key ? fn(m) : m)));

  const send = async (text: string) => {
    const message = text.trim();
    if (!message || running) return;
    setInput('');
    setRunning(true);
    setLiveActivity([]);
    voice.stop();
    const userKey = `u-${Date.now()}`;
    const botKey = `a-${Date.now()}`;
    setMessages((all) => [
      ...all,
      { key: userKey, role: 'user', content: message },
      { key: botKey, role: 'assistant', content: '', streaming: true, meta: { activity: [], pendingActionIds: [] } },
    ]);
    if (!conversationId) setTitle(message.slice(0, 60));

    const fail = (error: string) =>
      updateAssistant(botKey, (m) => ({ ...m, streaming: false, content: error, meta: { ...m.meta, status: 'failed', systemComposed: true } }));

    try {
      const res = await fetch('/api/chat', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(conversationId ? { conversationId, message } : { message }),
      });
      if (!res.ok || !res.body) {
        const body = await res.json().catch(() => ({}));
        fail(body.error ?? `The request failed (HTTP ${res.status}).`);
        return;
      }
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      let finished = false;
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() ?? '';
        for (const line of lines) {
          if (!line.trim()) continue;
          const event = JSON.parse(line) as AgentEvent;
          switch (event.type) {
            case 'run_started':
              setRunId(event.runId);
              if (!conversationId) {
                setConversationId(event.conversationId);
                window.history.replaceState(null, '', `/c/${event.conversationId}`);
                notify(CONVERSATIONS_CHANGED);
              }
              updateAssistant(botKey, (m) => ({ ...m, meta: { ...m.meta, model: event.model } }));
              break;
            case 'context':
              updateAssistant(botKey, (m) => ({ ...m, meta: { ...m.meta, memoryContext: event.memories } }));
              break;
            case 'status':
              updateAssistant(botKey, (m) => ({ ...m, statusText: event.message }));
              break;
            case 'activity': {
              const upsert = (list: ActivityRecord[] = []) =>
                list.some((a) => a.id === event.activity.id) ? list.map((a) => (a.id === event.activity.id ? event.activity : a)) : [...list, event.activity];
              setLiveActivity((l) => upsert(l));
              updateAssistant(botKey, (m) => ({ ...m, meta: { ...m.meta, activity: upsert(m.meta?.activity) } }));
              break;
            }
            case 'confirmation_required':
              setPendingActions((p) => ({ ...p, [event.action.id]: event.action }));
              updateAssistant(botKey, (m) => ({ ...m, meta: { ...m.meta, pendingActionIds: [...(m.meta?.pendingActionIds ?? []), event.action.id] } }));
              break;
            case 'final':
              finished = true;
              updateAssistant(botKey, (m) => ({
                ...m,
                streaming: false,
                content: event.result.message,
                meta: { ...m.meta, status: event.result.status, systemComposed: event.result.systemComposed, notes: event.result.notes },
              }));
              if (event.result.status !== 'cancelled') voice.speak(event.result.message);
              break;
            case 'error':
              finished = true;
              fail(event.message);
              break;
          }
        }
      }
      if (!finished) fail('The connection closed before NICK finished. Check the terminal running NICK.');
    } catch {
      fail('Could not reach the NICK web server. Is "npm run dev" still running?');
    } finally {
      setRunning(false);
      setRunId(null);
      setStopping(false);
      notify(DATA_CHANGED);
      notify(CONVERSATIONS_CHANGED);
      textarea.current?.focus();
    }
  };

  const onActionResolved = (action: PendingActionView, text: string) => {
    setPendingActions((p) => ({ ...p, [action.id]: action }));
    setMessages((all) => [...all, { key: `sys-${Date.now()}`, role: 'assistant', content: text, meta: { systemComposed: true } }]);
  };

  /** Asks the server to stop this run; the stream then ends with a "Stopped" result. */
  const stop = async () => {
    if (!runId || stopping) return;
    setStopping(true);
    const res = await postJson(`/api/runs/${runId}/cancel`, {});
    if (!res.ok) setStopping(false);
  };

  const empty = !loading && !loadError && messages.length === 0;
  const core: CoreState = running ? 'thinking' : voice.speaking ? 'speaking' : warm === 'unavailable' ? 'offline' : 'idle';
  const coreLabel = { thinking: stopping ? 'Stopping…' : 'Working', speaking: 'Speaking', offline: 'Model offline', idle: warm === 'warming' ? 'Warming up' : 'Online' }[core];

  return (
    <div className="flex h-full">
      <section className="hud-grid flex min-w-0 flex-1 flex-col" aria-label="Conversation">
        <header className="flex items-center justify-between gap-3 border-b border-line bg-bg/60 px-4 py-2.5 backdrop-blur md:px-8">
          <div className="flex min-w-0 items-center gap-2.5">
            <NickCore state={core} size={22} />
            <h1 className="truncate text-sm font-semibold" title={title}>
              {title}
            </h1>
            <span className="hidden text-[11px] uppercase tracking-widest text-faint sm:inline" aria-live="polite">
              {coreLabel}
            </span>
          </div>
          <div className="flex shrink-0 items-center gap-2">
            {voice.supported && (
              <Button
                variant="ghost"
                aria-pressed={voice.enabled}
                disabled={!voice.hasLocalVoice}
                onClick={() => (voice.speaking ? voice.stop() : voice.setEnabled(!voice.enabled))}
                title={
                  !voice.hasLocalVoice
                    ? 'No on-device voice is installed, so spoken replies are unavailable (cloud voices are never used).'
                    : 'Read replies aloud with an on-device voice. Text is not sent anywhere.'
                }
                className="px-2 py-1 text-xs"
              >
                {voice.speaking ? '■ Stop voice' : voice.enabled ? '🔊 Voice on' : '🔈 Voice off'}
              </Button>
            )}
            <Badge title="Responses are generated by a local Ollama model; tools run on the local MCP server.">Local AI · MCP</Badge>
          </div>
        </header>

        <div ref={scroller} className="min-h-0 flex-1 overflow-y-auto px-4 py-6 md:px-8">
          <div className="mx-auto max-w-3xl space-y-6">
            {loading && (
              <p className="flex items-center gap-2 text-sm text-muted">
                <Spinner /> Loading conversation…
              </p>
            )}
            {loadError && <ErrorNote message={loadError} onRetry={initialId ? () => load(initialId) : undefined} />}
            {empty && (
              <div className="pt-6 text-center md:pt-12">
                <NickCore state={core} size={112} className="mb-6" />
                <h2 className="text-2xl font-semibold tracking-tight">What do you want to get done?</h2>
                <p className="mx-auto mt-2 max-w-md text-sm text-muted">
                  Your local personal assistant. NICK keeps your tasks, plans and preferences, and every action runs as a real MCP tool call you can see. Today is{' '}
                  {todayIso()}.
                </p>
                <div className="mx-auto mt-8 grid max-w-2xl gap-2 sm:grid-cols-2">
                  {suggestions().map((s) => (
                    <button
                      key={s}
                      onClick={() => void send(s)}
                      className="rounded-xl border border-line bg-surface/80 px-4 py-3 text-left text-sm text-muted transition-colors hover:border-accent/50 hover:text-ink"
                    >
                      {s}
                    </button>
                  ))}
                </div>
              </div>
            )}
            {messages.map((m) => (
              <MessageItem key={m.key} message={m} pendingActions={pendingActions} onActionResolved={onActionResolved} />
            ))}
          </div>
        </div>

        <form
          className="border-t border-line px-4 py-3 md:px-8"
          onSubmit={(e) => {
            e.preventDefault();
            void send(input);
          }}
        >
          <div className="mx-auto flex max-w-3xl items-end gap-2">
            <label htmlFor="composer" className="sr-only">
              Message NICK
            </label>
            <textarea
              id="composer"
              ref={textarea}
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.shiftKey) {
                  e.preventDefault();
                  void send(input);
                }
              }}
              rows={1}
              maxLength={4000}
              placeholder={running ? 'NICK is working…' : 'Ask NICK to plan, remember or organise something'}
              className="max-h-40 min-h-[42px] flex-1 resize-none rounded-xl border border-line bg-surface px-4 py-2.5 text-sm placeholder:text-faint focus:border-accent focus:shadow-[0_0_0_3px_rgb(56_214_245/0.12)] focus:outline-none"
            />
            {running ? (
              <Button
                variant="danger"
                onClick={() => void stop()}
                disabled={!runId || stopping}
                title="Stop this request. A tool call that already started finishes; nothing new starts."
                className="h-[42px] px-4"
              >
                {stopping ? <Spinner label="Stopping" /> : '■'} Stop
              </Button>
            ) : (
              <Button type="submit" variant="primary" disabled={!input.trim()} className="h-[42px] px-4">
                Send
              </Button>
            )}
          </div>
          <p className="mx-auto mt-1.5 max-w-3xl text-[11px] text-faint">
            Enter to send · Shift+Enter for a new line ·{' '}
            {warm === 'warming'
              ? 'Loading the local model (first load on CPU can take 1–2 min)…'
              : warm === 'ready'
                ? 'Local model ready. Replies run on your CPU and can take 10–40 s.'
                : 'Local model not ready; see the banner above or Settings.'}
          </p>
        </form>
      </section>
      <ActivityPanel live={liveActivity} running={running} />
    </div>
  );
}
