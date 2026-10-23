import type { DB } from '../db/sqlite';
import { nowIso } from '../db/sqlite';
import { localToday } from '../dates';
import type { Task, TaskPriority, TaskStatus } from '../schemas';

interface TaskRow {
  id: number;
  title: string;
  description: string | null;
  status: TaskStatus;
  priority: TaskPriority;
  category: string | null;
  due_date: string | null;
  created_at: string;
  updated_at: string;
  completed_at: string | null;
}

export interface NewTask {
  title: string;
  description?: string;
  priority?: TaskPriority;
  dueDate?: string;
  category?: string;
}

export interface TaskFilter {
  status?: TaskStatus;
  priority?: TaskPriority;
  category?: string;
  dueFrom?: string;
  dueTo?: string;
  query?: string;
  limit?: number;
}

export interface TaskPatch {
  title?: string;
  description?: string | null;
  status?: TaskStatus;
  priority?: TaskPriority;
  dueDate?: string | null;
  category?: string | null;
}

function toTask(row: TaskRow, today = localToday()): Task {
  return {
    id: row.id,
    title: row.title,
    description: row.description,
    status: row.status,
    priority: row.priority,
    category: row.category,
    dueDate: row.due_date,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    completedAt: row.completed_at,
    overdue: row.status !== 'completed' && row.due_date !== null && row.due_date < today,
  };
}

const escapeLike = (s: string) => s.replace(/[\\%_]/g, (c) => `\\${c}`);

export class TaskRepository {
  constructor(private readonly db: DB) {}

  create(input: NewTask): Task {
    const now = nowIso();
    const info = this.db
      .prepare(
        `INSERT INTO tasks (title, description, priority, category, due_date, created_at, updated_at)
         VALUES (@title, @description, @priority, @category, @dueDate, @now, @now)`,
      )
      .run({
        title: input.title,
        description: input.description ?? null,
        priority: input.priority ?? 'medium',
        category: input.category ?? null,
        dueDate: input.dueDate ?? null,
        now,
      });
    return this.get(Number(info.lastInsertRowid))!;
  }

  get(id: number): Task | null {
    const row = this.db.prepare('SELECT * FROM tasks WHERE id = ?').get(id) as TaskRow | undefined;
    return row ? toTask(row) : null;
  }

  list(filter: TaskFilter = {}): Task[] {
    const where: string[] = [];
    const params: Record<string, unknown> = {};
    if (filter.status) {
      where.push('status = @status');
      params.status = filter.status;
    }
    if (filter.priority) {
      where.push('priority = @priority');
      params.priority = filter.priority;
    }
    if (filter.category) {
      where.push('category = @category COLLATE NOCASE');
      params.category = filter.category;
    }
    if (filter.dueFrom) {
      where.push('due_date >= @dueFrom');
      params.dueFrom = filter.dueFrom;
    }
    if (filter.dueTo) {
      where.push('due_date <= @dueTo');
      params.dueTo = filter.dueTo;
    }
    if (filter.query) {
      where.push("(title LIKE @q ESCAPE '\\' OR description LIKE @q ESCAPE '\\')");
      params.q = `%${escapeLike(filter.query)}%`;
    }
    params.limit = filter.limit ?? 100;
    const sql = `SELECT * FROM tasks ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
      ORDER BY (status = 'completed'), due_date IS NULL, due_date,
               CASE priority WHEN 'high' THEN 0 WHEN 'medium' THEN 1 ELSE 2 END, id DESC
      LIMIT @limit`;
    const today = localToday();
    return (this.db.prepare(sql).all(params) as TaskRow[]).map((r) => toTask(r, today));
  }

  update(id: number, patch: TaskPatch): Task | null {
    const existing = this.get(id);
    if (!existing) return null;
    const sets: string[] = [];
    const params: Record<string, unknown> = { id, now: nowIso() };
    const columns: Record<keyof TaskPatch, string> = {
      title: 'title',
      description: 'description',
      status: 'status',
      priority: 'priority',
      dueDate: 'due_date',
      category: 'category',
    };
    for (const key of Object.keys(columns) as (keyof TaskPatch)[]) {
      if (patch[key] !== undefined) {
        sets.push(`${columns[key]} = @${key}`);
        params[key] = patch[key];
      }
    }
    if (patch.status !== undefined) {
      sets.push('completed_at = @completedAt');
      params.completedAt = patch.status === 'completed' ? (existing.completedAt ?? params.now) : null;
    }
    if (sets.length === 0) return existing;
    sets.push('updated_at = @now');
    this.db.prepare(`UPDATE tasks SET ${sets.join(', ')} WHERE id = @id`).run(params);
    return this.get(id);
  }

  complete(id: number): Task | null {
    return this.update(id, { status: 'completed' });
  }

  delete(id: number): boolean {
    return this.db.prepare('DELETE FROM tasks WHERE id = ?').run(id).changes === 1;
  }

  counts(): { total: number; pending: number; inProgress: number; completed: number; overdue: number } {
    const today = localToday();
    const row = this.db
      .prepare(
        `SELECT COUNT(*) AS total,
                SUM(status = 'pending') AS pending,
                SUM(status = 'in_progress') AS inProgress,
                SUM(status = 'completed') AS completed,
                SUM(status != 'completed' AND due_date IS NOT NULL AND due_date < ?) AS overdue
         FROM tasks`,
      )
      .get(today) as Record<string, number | null>;
    return {
      total: row.total ?? 0,
      pending: row.pending ?? 0,
      inProgress: row.inProgress ?? 0,
      completed: row.completed ?? 0,
      overdue: row.overdue ?? 0,
    };
  }
}
