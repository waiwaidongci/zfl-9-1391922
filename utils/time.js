import { isActiveTaskStatus } from "../config/scheduling-rules.js";
import { activeLeavesForPilot } from "./db.js";

export function overlaps(aStart, aEnd, bStart, bEnd) {
  return new Date(aStart) < new Date(bEnd) && new Date(bStart) < new Date(aEnd);
}

export function leaveConflictsForPilot(db, pilotId, windowStart, windowEnd) {
  const leaves = activeLeavesForPilot(db, pilotId);
  return leaves.filter((leave) =>
    overlaps(windowStart, windowEnd, leave.period.start, leave.period.end)
  );
}

export function taskWindow(task) {
  return { start: task.tideWindow.start, end: task.tideWindow.end };
}

export function activeTasksForPilot(db, pilotId, exceptTaskId) {
  return db.tasks.filter((task) => task.pilotId === pilotId && task.id !== exceptTaskId && isActiveTaskStatus(task.status));
}

export function dayRange(dateStr) {
  const date = dateStr ? new Date(dateStr) : new Date();
  const year = date.getUTCFullYear();
  const month = String(date.getUTCMonth() + 1).padStart(2, "0");
  const day = String(date.getUTCDate()).padStart(2, "0");
  const start = new Date(`${year}-${month}-${day}T00:00:00.000Z`);
  const end = new Date(`${year}-${month}-${day}T23:59:59.999Z`);
  return { start, end, dateKey: `${year}-${month}-${day}` };
}

export function intersectInterval(aStart, aEnd, bStart, bEnd) {
  const s = new Date(aStart) > new Date(bStart) ? new Date(aStart) : new Date(bStart);
  const e = new Date(aEnd) < new Date(bEnd) ? new Date(aEnd) : new Date(bEnd);
  if (s >= e) return null;
  return { start: s.toISOString(), end: e.toISOString() };
}

export function sortIntervals(intervals) {
  return [...intervals].sort((a, b) => new Date(a.start) - new Date(b.start));
}

export function subtractIntervals(minuend, subtrahend) {
  const mSorted = sortIntervals(minuend.map((i) => ({ start: new Date(i.start), end: new Date(i.end) })));
  const sSorted = sortIntervals(subtrahend.map((i) => ({ start: new Date(i.start), end: new Date(i.end) })));
  const result = [];
  for (const m of mSorted) {
    let cursor = m.start;
    for (const s of sSorted) {
      if (s.end <= cursor || s.start >= m.end) continue;
      if (s.start > cursor) {
        result.push({ start: cursor.toISOString(), end: s.start.toISOString() });
      }
      cursor = s.end > m.end ? m.end : s.end;
      if (cursor >= m.end) break;
    }
    if (cursor < m.end) {
      result.push({ start: cursor.toISOString(), end: m.end.toISOString() });
    }
  }
  return result;
}

export function intervalsInDay(intervals, dayStart, dayEnd) {
  const out = [];
  for (const iv of intervals) {
    const clipped = intersectInterval(iv.start, iv.end, dayStart, dayEnd);
    if (clipped) out.push(clipped);
  }
  return out;
}
