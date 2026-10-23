'use client';

import type { StudyPlan } from '@/lib/client';
import { formatDate, formatMinutes } from '@/lib/client';

/** Read-only table of a study plan grouped by day. */
export function PlanPreview({ plan, maxDays }: { plan: StudyPlan; maxDays?: number }) {
  const days = new Map<string, StudyPlan['items']>();
  for (const item of plan.items) days.set(item.date, [...(days.get(item.date) ?? []), item]);
  const entries = [...days.entries()];
  const shown = maxDays ? entries.slice(0, maxDays) : entries;
  return (
    <div className="space-y-2 text-sm">
      <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted">
        <span>{plan.items.length} sessions</span>
        <span>{formatMinutes(plan.totalMinutes)} scheduled</span>
        <span>
          {formatDate(plan.startDate)} → exam {formatDate(plan.targetDate)}
        </span>
        <span>Up to {plan.hoursPerDay} h/day</span>
      </div>
      <div className="flex flex-wrap gap-1.5">
        {plan.totals.map((t) => (
          <span key={t.subject} className="rounded-md bg-raised px-2 py-0.5 text-xs text-muted">
            {t.subject}: {formatMinutes(t.minutes)}
          </span>
        ))}
      </div>
      {plan.warnings.length > 0 && (
        <ul className="list-disc pl-4 text-xs text-warn">
          {plan.warnings.map((w) => (
            <li key={w}>{w}</li>
          ))}
        </ul>
      )}
      <div className="max-h-64 overflow-y-auto rounded-lg border border-line">
        <table className="w-full text-left text-xs">
          <thead className="sticky top-0 bg-raised text-faint">
            <tr>
              <th className="px-2 py-1.5 font-medium">Day</th>
              <th className="px-2 py-1.5 font-medium">Session</th>
              <th className="px-2 py-1.5 text-right font-medium">Time</th>
            </tr>
          </thead>
          <tbody>
            {shown.flatMap(([date, items]) =>
              items.map((i, idx) => (
                <tr key={`${date}-${i.sequence}`} className="border-t border-line">
                  <td className="px-2 py-1 text-muted">{idx === 0 ? formatDate(date) : ''}</td>
                  <td className="px-2 py-1">
                    {i.subject}
                    {i.topic && <span className="text-faint"> · {i.topic}</span>}
                  </td>
                  <td className="px-2 py-1 text-right text-muted">{i.minutes} min</td>
                </tr>
              )),
            )}
          </tbody>
        </table>
      </div>
      {maxDays && entries.length > maxDays && <p className="text-xs text-faint">+ {entries.length - maxDays} more days</p>}
    </div>
  );
}
