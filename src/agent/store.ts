import { randomUUID } from 'node:crypto';
import { openDatabase, nowIso, type DB, type Migration } from '../../lib/db/sqlite';
import type { ActivityRecord, PendingActionView } from './types';

/** Schema for data/agent.db — conversation and agent execution state, separate from user data. */
export const agentMigrations: Migration[] = [
  {
    version: 1,
    description: 'conversations, messages, pending actions, activity, agent runs',
    sql: `
      CREATE TABLE conversations (
        id         TEXT PRIMARY KEY,
        title      TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE messages (
        id              INTEGER PRIMARY KEY AUTOINCREMENT,
        conversation_id TEXT NOT NULL REFERENCES conversations (id) ON DELETE CASCADE,
        role            TEXT NOT NULL CHECK (role IN ('user', 'assistant')),
        content         TEXT NOT NULL,
        meta            TEXT CHECK (meta IS NULL OR json_valid(meta)),
        created_at      TEXT NOT NULL
      );
      CREATE INDEX idx_messages_conversation ON messages (conversation_id, id);

      CREATE TABLE pending_actions (
        id              TEXT PRIMARY KEY,
        conversation_id TEXT REFERENCES conversations (id) ON DELETE CASCADE,
        tool_name       TEXT NOT NULL,
        arguments       TEXT NOT NULL CHECK (json_valid(arguments)),
        summary         TEXT NOT NULL,
        preview         TEXT CHECK (preview IS NULL OR json_valid(preview)),
        status          TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'confirmed', 'cancelled', 'failed', 'expired')),
        result_summary  TEXT,
        created_at      TEXT NOT NULL,
        resolved_at     TEXT
      );

      CREATE TABLE activity (
        id              TEXT PRIMARY KEY,
        conversation_id TEXT,
        origin          TEXT NOT NULL CHECK (origin IN ('agent', 'ui', 'confirmation')),
        tool_name       TEXT NOT NULL,
        purpose         TEXT NOT NULL,
        status          TEXT NOT NULL,
        duration_ms     INTEGER,
        summary         TEXT,
        created_at      TEXT NOT NULL
      );
      CREATE INDEX idx_activity_created ON activity (created_at);

      CREATE TABLE agent_runs (
        id              TEXT PRIMARY KEY,
        conversation_id TEXT NOT NULL,
        model           TEXT NOT NULL,
        status          TEXT NOT NULL,
        iterations      INTEGER NOT NULL DEFAULT 0,
        tool_calls      INTEGER NOT NULL DEFAULT 0,
        started_at      TEXT NOT NULL,
        finished_at     TEXT
      );
    `,
  },
];

const MAX_MESSAGES_PER_CONVERSATION = 200;
const MAX_ACTIVITY_ROWS = 500;
const PENDING_TTL_MS = 60 * 60_000;

export interface ConversationSummary {
  id: string;
  title: string;
  createdAt: string;
  updatedAt: string;
  messageCount: number;
}

export interface StoredMessage {
  id: number;
  role: 'user' | 'assistant';
  content: string;
  meta: Record<string, unknown> | null;
  createdAt: string;
}

export interface PendingActionRecord extends PendingActionView {
  conversationId: string | null;
  args: Record<string, unknown>;
}

interface PendingRow {
  id: string;
  conversation_id: string | null;
  tool_name: string;
  arguments: string;
  summary: string;
  preview: string | null;
  status: PendingActionView['status'];
  result_summary: string | null;
  created_at: string;
}

const toPending = (r: PendingRow): PendingActionRecord => ({
  id: r.id,
  conversationId: r.conversation_id,
  toolName: r.tool_name,
  args: JSON.parse(r.arguments),
  summary: r.summary,
  preview: r.preview ? JSON.parse(r.preview) : undefined,
  status: r.status,
  resultSummary: r.result_summary,
  createdAt: r.created_at,
});

/** Client-safe view of a pending action (stored arguments stay on the server). */
export function toView(a: PendingActionRecord): PendingActionView {
  return { id: a.id, toolName: a.toolName, summary: a.summary, status: a.status, preview: a.preview, resultSummary: a.resultSummary, createdAt: a.createdAt };
}

export class AgentStore {
  constructor(public readonly db: DB) {}

  static open(file: string): AgentStore {
    return new AgentStore(openDatabase(file, agentMigrations));
  }

  createConversation(firstMessage: string): ConversationSummary {
    const id = randomUUID();
    const now = nowIso();
    const title = firstMessage.replace(/\s+/g, ' ').trim().slice(0, 60) || 'New conversation';
    this.db.prepare('INSERT INTO conversations (id, title, created_at, updated_at) VALUES (?, ?, ?, ?)').run(id, title, now, now);
    return { id, title, createdAt: now, updatedAt: now, messageCount: 0 };
  }

  conversationExists(id: string): boolean {
    return !!this.db.prepare('SELECT 1 FROM conversations WHERE id = ?').get(id);
  }

  listConversations(limit = 50): ConversationSummary[] {
    return (
      this.db
        .prepare(
          `SELECT c.id, c.title, c.created_at, c.updated_at, COUNT(m.id) AS n
           FROM conversations c LEFT JOIN messages m ON m.conversation_id = c.id
           GROUP BY c.id ORDER BY c.updated_at DESC LIMIT ?`,
        )
        .all(limit) as { id: string; title: string; created_at: string; updated_at: string; n: number }[]
    ).map((r) => ({ id: r.id, title: r.title, createdAt: r.created_at, updatedAt: r.updated_at, messageCount: r.n }));
  }

  deleteConversation(id: string): boolean {
    return this.db.prepare('DELETE FROM conversations WHERE id = ?').run(id).changes === 1;
  }

  addMessage(conversationId: string, role: 'user' | 'assistant', content: string, meta?: Record<string, unknown>): StoredMessage {
    const now = nowIso();
    const info = this.db
      .prepare('INSERT INTO messages (conversation_id, role, content, meta, created_at) VALUES (?, ?, ?, ?, ?)')
      .run(conversationId, role, content.slice(0, 8000), meta ? JSON.stringify(meta) : null, now);
    this.db.prepare('UPDATE conversations SET updated_at = ? WHERE id = ?').run(now, conversationId);
    // Bounded transcript: keep only the most recent messages per conversation.
    this.db
      .prepare(
        `DELETE FROM messages WHERE conversation_id = ? AND id NOT IN
           (SELECT id FROM messages WHERE conversation_id = ? ORDER BY id DESC LIMIT ?)`,
      )
      .run(conversationId, conversationId, MAX_MESSAGES_PER_CONVERSATION);
    return { id: Number(info.lastInsertRowid), role, content, meta: meta ?? null, createdAt: now };
  }

  messages(conversationId: string): StoredMessage[] {
    return (
      this.db.prepare('SELECT * FROM messages WHERE conversation_id = ? ORDER BY id').all(conversationId) as {
        id: number;
        role: 'user' | 'assistant';
        content: string;
        meta: string | null;
        created_at: string;
      }[]
    ).map((r) => ({ id: r.id, role: r.role, content: r.content, meta: r.meta ? JSON.parse(r.meta) : null, createdAt: r.created_at }));
  }

  createPendingAction(
    conversationId: string | null,
    a: { toolName: string; args: Record<string, unknown>; summary: string; preview?: unknown },
  ): PendingActionRecord {
    const id = randomUUID();
    const now = nowIso();
    this.db
      .prepare(
        'INSERT INTO pending_actions (id, conversation_id, tool_name, arguments, summary, preview, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
      )
      .run(id, conversationId, a.toolName, JSON.stringify(a.args), a.summary, a.preview === undefined ? null : JSON.stringify(a.preview), now);
    return this.getPendingAction(id)!;
  }

  getPendingAction(id: string): PendingActionRecord | null {
    const row = this.db.prepare('SELECT * FROM pending_actions WHERE id = ?').get(id) as PendingRow | undefined;
    if (!row) return null;
    if (row.status === 'pending' && Date.now() - Date.parse(row.created_at) > PENDING_TTL_MS) {
      this.resolvePendingAction(id, 'expired', 'Expired before confirmation.');
      return this.getPendingAction(id);
    }
    return toPending(row);
  }

  pendingActionsForConversation(conversationId: string): PendingActionView[] {
    const ids = this.db.prepare('SELECT id FROM pending_actions WHERE conversation_id = ? ORDER BY created_at').all(conversationId) as { id: string }[];
    return ids.map((r) => toView(this.getPendingAction(r.id)!));
  }

  /** Atomically moves a pending action out of 'pending'; returns false if it was already resolved. */
  claimPendingAction(id: string): boolean {
    return (
      this.db.prepare("UPDATE pending_actions SET status = 'confirmed', resolved_at = ? WHERE id = ? AND status = 'pending'").run(nowIso(), id)
        .changes === 1
    );
  }

  resolvePendingAction(id: string, status: PendingActionView['status'], resultSummary: string | null): void {
    this.db.prepare('UPDATE pending_actions SET status = ?, result_summary = ?, resolved_at = ? WHERE id = ?').run(status, resultSummary, nowIso(), id);
  }

  recordActivity(conversationId: string | null, a: ActivityRecord): void {
    this.db
      .prepare(
        `INSERT INTO activity (id, conversation_id, origin, tool_name, purpose, status, duration_ms, summary, created_at)
         VALUES (@id, @conversationId, @origin, @tool, @purpose, @status, @durationMs, @summary, @startedAt)
         ON CONFLICT (id) DO UPDATE SET status = excluded.status, duration_ms = excluded.duration_ms, summary = excluded.summary`,
      )
      .run({ ...a, conversationId, durationMs: a.durationMs ?? null, summary: a.summary ?? null });
    this.db.prepare('DELETE FROM activity WHERE id NOT IN (SELECT id FROM activity ORDER BY created_at DESC LIMIT ?)').run(MAX_ACTIVITY_ROWS);
  }

  recentActivity(limit = 40): (ActivityRecord & { conversationId: string | null })[] {
    return (
      this.db.prepare('SELECT * FROM activity ORDER BY created_at DESC LIMIT ?').all(limit) as {
        id: string;
        conversation_id: string | null;
        origin: ActivityRecord['origin'];
        tool_name: string;
        purpose: string;
        status: ActivityRecord['status'];
        duration_ms: number | null;
        summary: string | null;
        created_at: string;
      }[]
    ).map((r) => ({
      id: r.id,
      conversationId: r.conversation_id,
      origin: r.origin,
      tool: r.tool_name,
      purpose: r.purpose,
      status: r.status,
      durationMs: r.duration_ms ?? undefined,
      summary: r.summary ?? undefined,
      startedAt: r.created_at,
    }));
  }

  startRun(conversationId: string, model: string): string {
    const id = randomUUID();
    this.db.prepare("INSERT INTO agent_runs (id, conversation_id, model, status, started_at) VALUES (?, ?, ?, 'running', ?)").run(id, conversationId, model, nowIso());
    return id;
  }

  finishRun(id: string, status: string, iterations: number, toolCalls: number): void {
    this.db.prepare('UPDATE agent_runs SET status = ?, iterations = ?, tool_calls = ?, finished_at = ? WHERE id = ?').run(status, iterations, toolCalls, nowIso(), id);
  }
}
