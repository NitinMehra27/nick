import { describe, expect, it } from 'vitest';
import { weekday } from '../lib/dates';
import { StudyPlanError, generateStudyPlan, validateStudyPlan } from '../lib/studyPlanner';

const base = { startDate: '2030-01-01', targetDate: '2030-01-11', hoursPerDay: 2 };

describe('generateStudyPlan', () => {
  it('never exceeds daily availability and stays before the target date', () => {
    const plan = generateStudyPlan({ ...base, subjects: [{ name: 'Math', difficulty: 'hard' }, { name: 'History', difficulty: 'easy' }] });
    expect(validateStudyPlan(plan)).toEqual([]);
    const perDay = new Map<string, number>();
    for (const i of plan.items) perDay.set(i.date, (perDay.get(i.date) ?? 0) + i.minutes);
    expect(Math.max(...perDay.values())).toBeLessThanOrEqual(120);
    expect(plan.items.every((i) => i.date >= '2030-01-01' && i.date < '2030-01-11')).toBe(true);
    expect(plan.totalMinutes).toBeLessThanOrEqual(plan.capacityMinutes);
  });

  it('gives harder subjects more time', () => {
    const plan = generateStudyPlan({ ...base, subjects: [{ name: 'Math', difficulty: 'hard' }, { name: 'History', difficulty: 'easy' }] });
    const math = plan.totals.find((t) => t.subject === 'Math')!.minutes;
    const history = plan.totals.find((t) => t.subject === 'History')!.minutes;
    expect(math).toBeGreaterThan(history);
  });

  it('scales explicit hours down with a warning when they exceed availability', () => {
    const plan = generateStudyPlan({ ...base, subjects: [{ name: 'Math', hours: 40 }] });
    expect(plan.totalMinutes).toBeLessThanOrEqual(10 * 120);
    expect(plan.warnings.join(' ')).toMatch(/scaled down/);
  });

  it('respects rest days and cycles topics', () => {
    const plan = generateStudyPlan({ ...base, restDays: ['sunday', 'saturday'], subjects: [{ name: 'Chem', topics: ['Acids', 'Bases'] }] });
    expect(plan.items.some((i) => [0, 6].includes(weekday(i.date)))).toBe(false);
    expect(plan.items.slice(0, 2).map((i) => i.topic)).toEqual(['Acids', 'Bases']);
  });

  it('uses full-length sessions on spaced-out days when total time is short', () => {
    const plan = generateStudyPlan({
      startDate: '2030-01-01',
      targetDate: '2030-01-15',
      hoursPerDay: 2,
      sessionMinutes: 50,
      subjects: [{ name: 'Math', hours: 2 }, { name: 'Chemistry', hours: 2 }],
    });
    expect(plan.totalMinutes).toBe(240);
    expect(plan.items.filter((i) => i.minutes < 40)).toEqual([]);
    const dates = plan.items.map((i) => i.date);
    expect(dates.at(-1)! > '2030-01-08').toBe(true); // spread across the window, not front-loaded
  });

  it('rejects impossible inputs', () => {
    expect(() => generateStudyPlan({ ...base, targetDate: '2030-01-01', subjects: [{ name: 'X' }] })).toThrow(StudyPlanError);
    expect(() => generateStudyPlan({ ...base, subjects: [{ name: 'X' }, { name: 'x' }] })).toThrow(/more than once/);
    expect(() =>
      generateStudyPlan({ ...base, targetDate: '2030-01-02', restDays: [['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'][new Date(Date.UTC(2030, 0, 1)).getUTCDay()] as 'monday'], subjects: [{ name: 'X' }] }),
    ).toThrow(/No study days/);
  });
});
