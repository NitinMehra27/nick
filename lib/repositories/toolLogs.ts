import type { DB } from '../db/sqlite';
import { nowIso } from '../db/sqlite';

export interface ToolLogEntry {
  id: number;
  toolName: string;
  status: 'success' | 'error';
  durationMs: number;
  summary: string | null;
  createdAt: string;
}

/** Records tool executions without arguments or payloads, so logs never hold user content verbatim. */
export class ToolLogRepository {
  constructor(private readonly db: DB) {}

  record(toolName: string, status: 'success' | 'error', durationMs: number, summary: string | null): void {
    this.db
      .prepare('INSERT INTO tool_execution_logs (tool_name, status, duration_ms, summary, created_at) VALUES (?, ?, ?, ?, ?)')
      .run(toolName, status, Math.round(durationMs), summary?.slice(0, 200) ?? null, nowIso());
    // keep the log bounded
    this.db.prepare('DELETE FROM tool_execution_logs WHERE id <= (SELECT MAX(id) - 1000 FROM tool_execution_logs)').run();
  }

  recent(limit = 50): ToolLogEntry[] {
    return (
      this.db
        .prepare('SELECT * FROM tool_execution_logs ORDER BY id DESC LIMIT ?')
        .all(limit) as { id: number; tool_name: string; status: 'success' | 'error'; duration_ms: number; summary: string | null; created_at: string }[]
    ).map((r) => ({ id: r.id, toolName: r.tool_name, status: r.status, durationMs: r.duration_ms, summary: r.summary, createdAt: r.created_at }));
  }
}
