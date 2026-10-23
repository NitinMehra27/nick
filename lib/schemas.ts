import { z } from 'zod';
import { isIsoDate } from './dates';

export const TASK_STATUSES = ['pending', 'in_progress', 'completed'] as const;
export const TASK_PRIORITIES = ['low', 'medium', 'high'] as const;
export const MEMORY_CATEGORIES = ['preference', 'goal', 'project', 'fact', 'other'] as const;

export const isoDate = z
  .string()
  .refine(isIsoDate, { message: 'must be a valid calendar date in YYYY-MM-DD format' })
  .describe('Date in YYYY-MM-DD format');

const trimmed = (max: number) => z.string().trim().min(1).max(max);
export const id = z.number().int().positive();

// ---------- tasks ----------

export const createTaskInput = z.strictObject({
  title: trimmed(200).describe('Short task title'),
  description: z.string().trim().max(2000).optional(),
  priority: z.enum(TASK_PRIORITIES).optional().describe('low, medium or high (default medium)'),
  dueDate: isoDate.optional(),
  category: trimmed(50).optional().describe('Free-form category such as "study" or "work"'),
});

export const listTasksInput = z.strictObject({
  status: z.enum(TASK_STATUSES).optional(),
  priority: z.enum(TASK_PRIORITIES).optional(),
  category: trimmed(50).optional(),
  dueFrom: isoDate.optional().describe('Only tasks due on or after this date'),
  dueTo: isoDate.optional().describe('Only tasks due on or before this date'),
  query: trimmed(100).optional().describe('Case-insensitive text search in title and description'),
  limit: z.number().int().min(1).max(100).optional(),
});

export const taskIdInput = z.strictObject({ taskId: id.describe('Numeric task ID') });

export const updateTaskInput = z
  .strictObject({
    taskId: id.describe('Numeric task ID'),
    title: trimmed(200).optional(),
    description: z.string().trim().max(2000).nullable().optional().describe('null clears the description'),
    status: z.enum(TASK_STATUSES).optional(),
    priority: z.enum(TASK_PRIORITIES).optional(),
    dueDate: isoDate.nullable().optional().describe('null clears the due date'),
    category: trimmed(50).nullable().optional(),
  })
  .refine((v) => Object.keys(v).some((k) => k !== 'taskId'), { message: 'Provide at least one field to update' });

export const deleteTaskInput = z.strictObject({
  taskId: id.describe('Numeric task ID'),
  confirm: z.literal(true).describe('Must be true. Only set after the user explicitly confirmed this deletion.'),
});

// ---------- memories ----------

export const saveMemoryInput = z.strictObject({
  content: trimmed(500).describe('One concise fact or preference, written in third person'),
  category: z.enum(MEMORY_CATEGORIES).optional(),
  source: z.enum(['user', 'inferred']).optional().describe('user = the user explicitly asked to remember it'),
  metadata: z.record(z.string(), z.union([z.string().max(200), z.number(), z.boolean()])).optional(),
});

export const searchMemoryInput = z.strictObject({
  query: z.string().trim().max(300).optional().describe('Keywords to look for; omit to list recent memories'),
  category: z.enum(MEMORY_CATEGORIES).optional(),
  limit: z.number().int().min(1).max(50).optional(),
});

export const updateMemoryInput = z
  .strictObject({
    memoryId: id,
    content: trimmed(500).optional(),
    category: z.enum(MEMORY_CATEGORIES).optional(),
  })
  .refine((v) => v.content !== undefined || v.category !== undefined, { message: 'Provide content or category' });

export const deleteMemoryInput = z.strictObject({
  memoryId: id,
  confirm: z.literal(true).describe('Must be true. Only set after the user explicitly confirmed this deletion.'),
});

export const clearMemoriesInput = z.strictObject({
  confirm: z.literal(true).describe('Must be true. Only set after the user explicitly confirmed clearing ALL memory.'),
});

// ---------- study plans ----------

export const studySubject = z.strictObject({
  name: trimmed(80),
  topics: z.array(trimmed(120)).max(30).optional().describe('Only topics the user named; omit if none were given'),
  difficulty: z.enum(['easy', 'medium', 'hard']).optional(),
  hours: z
    .number()
    .positive()
    .max(500)
    .optional()
    .describe('Total hours for this subject, only if the user stated one. Omit otherwise; never copy hoursPerDay here'),
});

export const studyPlanRequest = z.strictObject({
  title: trimmed(120).optional(),
  subjects: z.array(studySubject).min(1).max(12),
  targetDate: isoDate.describe('Exam or deadline date; sessions are scheduled before it'),
  startDate: isoDate.optional().describe('Defaults to today'),
  hoursPerDay: z.number().positive().max(16).describe('Maximum study hours available per day'),
  sessionMinutes: z.number().int().min(15).max(240).optional().describe('Preferred session length (default 50)'),
  restDays: z
    .array(z.enum(['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday']))
    .max(6)
    .optional(),
});

export const createStudyPlanInput = studyPlanRequest.extend({
  save: z.boolean().optional().describe('false (default) returns a preview only; true saves it'),
  createTasks: z.boolean().optional().describe('When saving, also create one task per session'),
});

export const getStudyPlanInput = z.strictObject({
  planId: id.optional().describe('Omit to get the most recent active plan'),
});

export const updateStudyPlanItemInput = z
  .strictObject({
    planId: id,
    itemId: id,
    completed: z.boolean().optional(),
    minutes: z.number().int().min(5).max(960).optional(),
    date: isoDate.optional(),
    topic: z.string().trim().max(120).nullable().optional(),
  })
  .refine((v) => v.completed !== undefined || v.minutes !== undefined || v.date !== undefined || v.topic !== undefined, {
    message: 'Provide at least one field to update',
  });

export const deleteStudyPlanInput = z.strictObject({
  planId: id,
  confirm: z.literal(true).describe('Must be true. Only set after the user explicitly confirmed this deletion.'),
});

// ---------- domain types ----------

export type TaskStatus = (typeof TASK_STATUSES)[number];
export type TaskPriority = (typeof TASK_PRIORITIES)[number];
export type MemoryCategory = (typeof MEMORY_CATEGORIES)[number];

export interface Task {
  id: number;
  title: string;
  description: string | null;
  status: TaskStatus;
  priority: TaskPriority;
  category: string | null;
  dueDate: string | null;
  createdAt: string;
  updatedAt: string;
  completedAt: string | null;
  overdue: boolean;
}

export interface Memory {
  id: number;
  content: string;
  category: MemoryCategory;
  source: 'user' | 'inferred';
  metadata: Record<string, unknown> | null;
  createdAt: string;
  updatedAt: string;
}

export interface StudyPlanItem {
  id?: number;
  sequence: number;
  date: string;
  subject: string;
  topic: string | null;
  minutes: number;
  completed: boolean;
  taskId: number | null;
}

export interface StudyPlan {
  id?: number;
  title: string;
  status: 'active' | 'archived' | 'preview';
  startDate: string;
  targetDate: string;
  hoursPerDay: number;
  sessionMinutes: number;
  items: StudyPlanItem[];
  totals: { subject: string; minutes: number }[];
  totalMinutes: number;
  capacityMinutes: number;
  warnings: string[];
  createdAt?: string;
  updatedAt?: string;
}

export type StudyPlanRequest = z.infer<typeof studyPlanRequest>;
