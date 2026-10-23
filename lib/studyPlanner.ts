import { addDays, daysBetweenInclusive, localToday, weekday } from './dates';
import type { StudyPlan, StudyPlanItem, StudyPlanRequest } from './schemas';

const WEEKDAYS = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
const DIFFICULTY_WEIGHT = { easy: 1, medium: 1.5, hard: 2 } as const;
const MIN_SESSION = 15;

export class StudyPlanError extends Error {}

/**
 * Deterministic, transparent allocator. It never schedules more than hoursPerDay on any
 * day and only schedules between startDate and the day before targetDate.
 * Harder subjects receive proportionally more time unless explicit hours are given.
 */
export function generateStudyPlan(req: StudyPlanRequest, today: string = localToday()): StudyPlan {
  const warnings: string[] = [];
  const startDate = req.startDate ?? today;
  if (req.targetDate <= startDate) {
    throw new StudyPlanError(`targetDate (${req.targetDate}) must be after the start date (${startDate}).`);
  }
  const lastDay = addDays(req.targetDate, -1);
  const rest = new Set((req.restDays ?? []).map((d) => WEEKDAYS.indexOf(d)));
  const days = daysBetweenInclusive(startDate, lastDay).filter((d) => !rest.has(weekday(d)));
  if (days.length === 0) throw new StudyPlanError('No study days are available between the start date and the target date.');
  if (days.length > 366) throw new StudyPlanError('Study plans are limited to one year.');

  const dailyCap = Math.floor(req.hoursPerDay * 60);
  if (dailyCap < MIN_SESSION) throw new StudyPlanError('hoursPerDay must allow at least 15 minutes of study.');
  let sessionMinutes = req.sessionMinutes ?? 50;
  if (sessionMinutes > dailyCap) {
    warnings.push(`Session length reduced from ${sessionMinutes} to ${dailyCap} minutes to fit your daily availability.`);
    sessionMinutes = dailyCap;
  }
  const capacity = dailyCap * days.length;

  // 1. Decide how many minutes each subject gets.
  const names = new Set<string>();
  for (const s of req.subjects) {
    const key = s.name.toLowerCase();
    if (names.has(key)) throw new StudyPlanError(`Subject "${s.name}" is listed more than once.`);
    names.add(key);
  }
  const explicit = req.subjects.filter((s) => s.hours !== undefined);
  const weighted = req.subjects.filter((s) => s.hours === undefined);
  let explicitTotal = explicit.reduce((sum, s) => sum + Math.round(s.hours! * 60), 0);
  const scale = explicitTotal > capacity ? capacity / explicitTotal : 1;
  if (scale < 1) {
    warnings.push(
      `Requested ${Math.round(explicitTotal / 60)}h exceeds the ${Math.round(capacity / 60)}h available before the target date; hours were scaled down proportionally.`,
    );
    explicitTotal = capacity;
  }
  const remainingCapacity = capacity - explicitTotal;
  const weightSum = weighted.reduce((sum, s) => sum + DIFFICULTY_WEIGHT[s.difficulty ?? 'medium'], 0);
  if (weighted.length > 0 && remainingCapacity < MIN_SESSION * weighted.length) {
    warnings.push('Some subjects without explicit hours received little or no time because the available time is already allocated.');
  }
  const allocation = req.subjects.map((s) => {
    const minutes =
      s.hours !== undefined
        ? Math.floor(Math.round(s.hours * 60) * scale)
        : Math.floor((remainingCapacity * DIFFICULTY_WEIGHT[s.difficulty ?? 'medium']) / (weightSum || 1));
    const remaining = Math.floor(minutes / 5) * 5;
    // equal-length sessions no longer than the preferred length (120 min @ 50 -> 3 x 40, not 50+50+20)
    const sessions = Math.max(1, Math.ceil(remaining / sessionMinutes));
    const chunk = Math.min(sessionMinutes, Math.max(MIN_SESSION, Math.ceil(remaining / sessions / 5) * 5));
    return { subject: s.name, topics: s.topics ?? [], remaining, chunk, sessions, topicIndex: 0 };
  });
  const totalMinutes = allocation.reduce((sum, a) => sum + a.remaining, 0);

  // 2. Spread sessions evenly across available days, interleaving subjects. When there are
  //    fewer sessions than days, use full-length sessions on evenly spaced days rather than
  //    short daily fragments.
  const sessionsNeeded = allocation.reduce((sum, a) => sum + (a.remaining > 0 ? a.sessions : 0), 0);
  const studyDays =
    sessionsNeeded > 0 && sessionsNeeded < days.length
      ? Array.from({ length: sessionsNeeded }, (_, i) => days[Math.floor((i * days.length) / sessionsNeeded)])
      : days;
  const dayTarget = Math.min(dailyCap, Math.max(sessionMinutes, Math.ceil(totalMinutes / studyDays.length / 5) * 5));
  const items: StudyPlanItem[] = [];
  const used = new Map<string, number>();
  const placeDay = (date: string, limit: number) => {
    let capLeft = limit - (used.get(date) ?? 0);
    let previous: string | null = null;
    while (capLeft >= MIN_SESSION) {
      const candidates = allocation.filter((a) => a.remaining >= MIN_SESSION).sort((a, b) => b.remaining - a.remaining);
      if (candidates.length === 0) break;
      const pick = candidates.find((c) => c.subject !== previous) ?? candidates[0];
      const minutes = Math.min(pick.chunk, pick.remaining, capLeft);
      if (minutes < MIN_SESSION) break;
      const topic = pick.topics.length ? pick.topics[pick.topicIndex++ % pick.topics.length] : null;
      items.push({ sequence: 0, date, subject: pick.subject, topic, minutes, completed: false, taskId: null });
      pick.remaining -= minutes;
      capLeft -= minutes;
      used.set(date, limit - capLeft);
      previous = pick.subject;
    }
  };
  for (const day of studyDays) placeDay(day, dayTarget);
  for (const day of days) placeDay(day, dailyCap); // second pass absorbs rounding remainders
  const unscheduled = allocation.reduce((sum, a) => sum + a.remaining, 0);
  if (unscheduled > 0) warnings.push(`${unscheduled} minutes could not be scheduled within your availability.`);

  items.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
  items.forEach((item, i) => (item.sequence = i + 1));

  const totals = req.subjects.map((s) => ({
    subject: s.name,
    minutes: items.filter((i) => i.subject === s.name).reduce((sum, i) => sum + i.minutes, 0),
  }));
  const plan: StudyPlan = {
    title: req.title ?? `Study plan: ${req.subjects.map((s) => s.name).join(', ')}`.slice(0, 120),
    status: 'preview',
    startDate,
    targetDate: req.targetDate,
    hoursPerDay: req.hoursPerDay,
    sessionMinutes,
    items,
    totals,
    totalMinutes: totals.reduce((sum, t) => sum + t.minutes, 0),
    capacityMinutes: capacity,
    warnings,
  };
  const problems = validateStudyPlan(plan);
  if (problems.length) throw new StudyPlanError(`Generated plan failed validation: ${problems.join('; ')}`);
  return plan;
}

/** Returns a list of rule violations (empty when the plan is valid). */
export function validateStudyPlan(plan: StudyPlan): string[] {
  const problems: string[] = [];
  const cap = Math.floor(plan.hoursPerDay * 60);
  const perDay = new Map<string, number>();
  for (const item of plan.items) {
    if (item.minutes <= 0) problems.push(`item ${item.sequence} has no duration`);
    if (item.date < plan.startDate || item.date >= plan.targetDate) problems.push(`item ${item.sequence} is outside the plan window`);
    perDay.set(item.date, (perDay.get(item.date) ?? 0) + item.minutes);
  }
  for (const [date, minutes] of perDay) {
    if (minutes > cap) problems.push(`${date} has ${minutes} minutes scheduled (limit ${cap})`);
  }
  return problems;
}
