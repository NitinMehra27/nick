import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import path from 'node:path';
import { addDays, localToday } from '../lib/dates';
import { nickMigrations } from '../lib/db/nickSchema';
import { openDatabase, type DB } from '../lib/db/sqlite';
import { MemoryRepository, detectSensitive } from '../lib/repositories/memories';
import { StudyPlanRepository } from '../lib/repositories/studyPlans';
import { TaskRepository } from '../lib/repositories/tasks';
import { generateStudyPlan } from '../lib/studyPlanner';
import { tempDir } from './helpers';

let tmp: ReturnType<typeof tempDir>;
let db: DB;
let file: string;

beforeEach(() => {
  tmp = tempDir();
  file = path.join(tmp.dir, 'nick.db');
  db = openDatabase(file, nickMigrations);
});
afterEach(() => {
  if (db.open) db.close();
  tmp.cleanup();
});

describe('database initialization', () => {
  it('creates all tables and records the schema version', () => {
    const tables = (db.prepare("SELECT name FROM sqlite_master WHERE type IN ('table')").all() as { name: string }[]).map((t) => t.name);
    for (const t of ['tasks', 'memories', 'memories_fts', 'study_plans', 'study_plan_items', 'tool_execution_logs']) {
      expect(tables).toContain(t);
    }
    expect(db.pragma('user_version', { simple: true })).toBe(nickMigrations.at(-1)!.version);
    expect(db.pragma('foreign_keys', { simple: true })).toBe(1);
  });

  it('re-opening an existing database keeps data (migrations are not re-applied)', () => {
    new TaskRepository(db).create({ title: 'Survives restart' });
    db.close();
    db = openDatabase(file, nickMigrations);
    expect(new TaskRepository(db).list().map((t) => t.title)).toEqual(['Survives restart']);
  });

  it('enforces CHECK constraints at the database level', () => {
    expect(() => db.prepare("INSERT INTO tasks (title, priority, created_at, updated_at) VALUES ('x', 'urgent', '', '')").run()).toThrow();
    expect(() => db.prepare("INSERT INTO tasks (title, created_at, updated_at) VALUES ('', '', '')").run()).toThrow();
  });
});

describe('TaskRepository', () => {
  it('creates, retrieves, updates, completes and deletes tasks', () => {
    const repo = new TaskRepository(db);
    const t = repo.create({ title: 'Revise calculus', priority: 'high', dueDate: '2030-01-10', category: 'study' });
    expect(t).toMatchObject({ id: 1, title: 'Revise calculus', status: 'pending', priority: 'high', dueDate: '2030-01-10', overdue: false });

    expect(repo.get(t.id)?.title).toBe('Revise calculus');
    expect(repo.get(999)).toBeNull();

    const updated = repo.update(t.id, { title: 'Revise integrals', dueDate: null });
    expect(updated).toMatchObject({ title: 'Revise integrals', dueDate: null });

    const done = repo.complete(t.id)!;
    expect(done.status).toBe('completed');
    expect(done.completedAt).not.toBeNull();

    const reopened = repo.update(t.id, { status: 'pending' })!;
    expect(reopened.completedAt).toBeNull();

    expect(repo.delete(t.id)).toBe(true);
    expect(repo.delete(t.id)).toBe(false);
    expect(repo.get(t.id)).toBeNull();
  });

  it('filters by status, priority, category, due range and text, and flags overdue tasks', () => {
    const repo = new TaskRepository(db);
    const yesterday = addDays(localToday(), -1);
    repo.create({ title: 'Overdue essay', dueDate: yesterday, priority: 'high', category: 'study' });
    repo.create({ title: 'Buy groceries', category: 'home', priority: 'low' });
    const c = repo.create({ title: '100% done thing', dueDate: yesterday });
    repo.complete(c.id);

    expect(repo.list({ priority: 'high' }).map((t) => t.title)).toEqual(['Overdue essay']);
    expect(repo.list({ category: 'HOME' }).map((t) => t.title)).toEqual(['Buy groceries']);
    expect(repo.list({ status: 'completed' })).toHaveLength(1);
    expect(repo.list({ dueTo: yesterday })).toHaveLength(2);
    expect(repo.list({ query: 'groc' })).toHaveLength(1);
    // LIKE wildcards in user input are treated literally
    expect(repo.list({ query: '%' }).map((t) => t.title)).toEqual(['100% done thing']);

    const overdue = repo.list().filter((t) => t.overdue).map((t) => t.title);
    expect(overdue).toEqual(['Overdue essay']); // the completed one is not overdue
    expect(repo.counts()).toMatchObject({ total: 3, completed: 1, overdue: 1 });
  });

  it('treats SQL-looking input as plain data', () => {
    const repo = new TaskRepository(db);
    const t = repo.create({ title: "x'); DROP TABLE tasks; --" });
    expect(repo.get(t.id)?.title).toBe("x'); DROP TABLE tasks; --");
    expect(repo.list()).toHaveLength(1);
  });
});

describe('MemoryRepository', () => {
  it('persists, searches with FTS ranking, updates and deletes memories', () => {
    const repo = new MemoryRepository(db);
    const a = repo.create({ content: 'Prefers 45-minute study sessions', category: 'preference', source: 'user' });
    repo.create({ content: 'Goal: pass the AWS Cloud Practitioner exam', category: 'goal', source: 'user' });
    repo.create({ content: 'Working on the NICK hackathon project', category: 'project', source: 'inferred' });

    expect(repo.search({ query: 'how long should my study session be?' }).map((m) => m.id)).toEqual([a.id]);
    expect(repo.search({ query: 'exam' })[0].category).toBe('goal');
    expect(repo.search({ query: 'zzzz-unrelated' })).toEqual([]);
    expect(repo.search({ category: 'project' })).toHaveLength(1);
    expect(repo.search()).toHaveLength(3);
    // FTS operators in user text cannot break the query
    expect(() => repo.search({ query: 'study" OR NEAR(( * -' })).not.toThrow();

    const updated = repo.update(a.id, { content: 'Prefers 30-minute study sessions' })!;
    expect(updated.content).toContain('30-minute');
    expect(repo.search({ query: '30-minute' }).map((m) => m.id)).toEqual([a.id]);
    expect(repo.search({ query: '45' })).toEqual([]); // FTS index follows updates

    expect(repo.delete(a.id)).toBe(true);
    expect(repo.search({ query: 'study sessions' })).toEqual([]);
    expect(repo.clear()).toBe(2);
    expect(repo.count()).toBe(0);
  });

  it('detects credentials and sensitive identifiers', () => {
    expect(detectSensitive('my password is hunter2')).not.toBeNull();
    expect(detectSensitive('api key: sk-abcdefghijklmnop1234')).not.toBeNull();
    expect(detectSensitive('card 4111 1111 1111 1111')).not.toBeNull();
    expect(detectSensitive('Prefers studying in the morning')).toBeNull();
    expect(detectSensitive('Exam is on 2026-11-30')).toBeNull();
  });
});

describe('StudyPlanRepository', () => {
  it('saves a generated plan with tasks in one transaction and cascades deletes', () => {
    const repo = new StudyPlanRepository(db);
    const request = {
      subjects: [{ name: 'Math', topics: ['Algebra', 'Calculus'] }, { name: 'Physics' }],
      startDate: '2030-03-01',
      targetDate: '2030-03-05',
      hoursPerDay: 2,
    };
    const plan = generateStudyPlan(request, '2030-03-01');
    const saved = repo.save(plan, request, { createTasks: true });
    expect(saved.id).toBe(1);
    expect(saved.items).toHaveLength(plan.items.length);
    expect(saved.items.every((i) => i.taskId !== null)).toBe(true);
    expect(new TaskRepository(db).list({ category: 'study', limit: 100 })).toHaveLength(plan.items.length);

    const first = saved.items[0];
    const afterEdit = repo.updateItem(saved.id!, first.id!, { completed: true, topic: null })!;
    expect(afterEdit.items.find((i) => i.id === first.id)).toMatchObject({ completed: true, topic: null });
    expect(repo.list()[0].completedMinutes).toBe(first.minutes);

    expect(repo.latestActive()?.id).toBe(saved.id);
    expect(repo.delete(saved.id!)).toBe(true);
    expect((db.prepare('SELECT COUNT(*) n FROM study_plan_items').get() as { n: number }).n).toBe(0);
    // tasks created from the plan are kept
    expect(new TaskRepository(db).list({ category: 'study', limit: 100 })).toHaveLength(plan.items.length);
  });
});
