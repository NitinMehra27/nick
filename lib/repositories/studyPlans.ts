import type { DB } from '../db/sqlite';
import { nowIso } from '../db/sqlite';
import type { StudyPlan, StudyPlanItem, StudyPlanRequest } from '../schemas';
import { TaskRepository } from './tasks';

interface PlanRow {
  id: number;
  title: string;
  status: 'active' | 'archived';
  start_date: string;
  target_date: string;
  hours_per_day: number;
  session_minutes: number;
  input_json: string;
  warnings_json: string;
  created_at: string;
  updated_at: string;
}

interface ItemRow {
  id: number;
  sequence: number;
  date: string;
  subject: string;
  topic: string | null;
  minutes: number;
  completed: number;
  task_id: number | null;
}

export interface PlanSummary {
  id: number;
  title: string;
  status: 'active' | 'archived';
  startDate: string;
  targetDate: string;
  totalMinutes: number;
  completedMinutes: number;
  itemCount: number;
  createdAt: string;
}

export class StudyPlanRepository {
  private readonly tasks: TaskRepository;

  constructor(private readonly db: DB) {
    this.tasks = new TaskRepository(db);
  }

  /** Saves a generated plan (and optionally one task per session) in a single transaction. */
  save(plan: StudyPlan, request: StudyPlanRequest, opts: { createTasks?: boolean } = {}): StudyPlan {
    const now = nowIso();
    const planId = this.db.transaction(() => {
      const info = this.db
        .prepare(
          `INSERT INTO study_plans (title, start_date, target_date, hours_per_day, session_minutes, input_json, warnings_json, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(plan.title, plan.startDate, plan.targetDate, plan.hoursPerDay, plan.sessionMinutes, JSON.stringify(request), JSON.stringify(plan.warnings), now, now);
      const id = Number(info.lastInsertRowid);
      const insertItem = this.db.prepare(
        `INSERT INTO study_plan_items (plan_id, sequence, date, subject, topic, minutes, task_id) VALUES (?, ?, ?, ?, ?, ?, ?)`,
      );
      for (const item of plan.items) {
        const taskId = opts.createTasks
          ? this.tasks.create({
              title: `Study ${item.subject}${item.topic ? `: ${item.topic}` : ''} (${item.minutes} min)`.slice(0, 200),
              dueDate: item.date,
              category: 'study',
              priority: 'medium',
              description: `Session ${item.sequence} of "${plan.title}".`,
            }).id
          : null;
        insertItem.run(id, item.sequence, item.date, item.subject, item.topic, item.minutes, taskId);
      }
      return id;
    })();
    return this.get(planId)!;
  }

  get(id: number): StudyPlan | null {
    const row = this.db.prepare('SELECT * FROM study_plans WHERE id = ?').get(id) as PlanRow | undefined;
    return row ? this.hydrate(row) : null;
  }

  latestActive(): StudyPlan | null {
    const row = this.db
      .prepare("SELECT * FROM study_plans WHERE status = 'active' ORDER BY created_at DESC, id DESC LIMIT 1")
      .get() as PlanRow | undefined;
    return row ? this.hydrate(row) : null;
  }

  list(): PlanSummary[] {
    const rows = this.db
      .prepare(
        `SELECT p.*, COALESCE(SUM(i.minutes), 0) AS total, COALESCE(SUM(CASE WHEN i.completed THEN i.minutes END), 0) AS done,
                COUNT(i.id) AS n
         FROM study_plans p LEFT JOIN study_plan_items i ON i.plan_id = p.id
         GROUP BY p.id ORDER BY p.created_at DESC, p.id DESC LIMIT 50`,
      )
      .all() as (PlanRow & { total: number; done: number; n: number })[];
    return rows.map((r) => ({
      id: r.id,
      title: r.title,
      status: r.status,
      startDate: r.start_date,
      targetDate: r.target_date,
      totalMinutes: r.total,
      completedMinutes: r.done,
      itemCount: r.n,
      createdAt: r.created_at,
    }));
  }

  updateItem(
    planId: number,
    itemId: number,
    patch: { completed?: boolean; minutes?: number; date?: string; topic?: string | null },
  ): StudyPlan | null {
    const plan = this.get(planId);
    if (!plan || !plan.items.some((i) => i.id === itemId)) return null;
    this.db.transaction(() => {
      this.db
        .prepare(
          `UPDATE study_plan_items SET
             completed = COALESCE(@completed, completed),
             minutes   = COALESCE(@minutes, minutes),
             date      = COALESCE(@date, date),
             topic     = CASE WHEN @setTopic THEN @topic ELSE topic END
           WHERE id = @itemId AND plan_id = @planId`,
        )
        .run({
          planId,
          itemId,
          completed: patch.completed === undefined ? null : patch.completed ? 1 : 0,
          minutes: patch.minutes ?? null,
          date: patch.date ?? null,
          setTopic: patch.topic !== undefined ? 1 : 0,
          topic: patch.topic ?? null,
        });
      this.db.prepare('UPDATE study_plans SET updated_at = ? WHERE id = ?').run(nowIso(), planId);
    })();
    return this.get(planId);
  }

  delete(id: number): boolean {
    return this.db.prepare('DELETE FROM study_plans WHERE id = ?').run(id).changes === 1;
  }

  private hydrate(row: PlanRow): StudyPlan {
    const itemRows = this.db
      .prepare('SELECT * FROM study_plan_items WHERE plan_id = ? ORDER BY date, sequence')
      .all(row.id) as ItemRow[];
    const items: StudyPlanItem[] = itemRows.map((i) => ({
      id: i.id,
      sequence: i.sequence,
      date: i.date,
      subject: i.subject,
      topic: i.topic,
      minutes: i.minutes,
      completed: i.completed === 1,
      taskId: i.task_id,
    }));
    const totalsMap = new Map<string, number>();
    for (const i of items) totalsMap.set(i.subject, (totalsMap.get(i.subject) ?? 0) + i.minutes);
    const totals = [...totalsMap].map(([subject, minutes]) => ({ subject, minutes }));
    const days = new Set(items.map((i) => i.date)).size;
    return {
      id: row.id,
      title: row.title,
      status: row.status,
      startDate: row.start_date,
      targetDate: row.target_date,
      hoursPerDay: row.hours_per_day,
      sessionMinutes: row.session_minutes,
      items,
      totals,
      totalMinutes: totals.reduce((s, t) => s + t.minutes, 0),
      capacityMinutes: Math.floor(row.hours_per_day * 60) * days,
      warnings: JSON.parse(row.warnings_json) as string[],
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }
}
