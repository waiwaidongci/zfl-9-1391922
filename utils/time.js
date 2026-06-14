import { isActiveTaskStatus } from "../config/scheduling-rules.js";
import { activeLeavesForPilot } from "./db.js";

export function overlaps(aStart, aEnd, bStart, bEnd) {
  return new Date(aStart) < new Date(bEnd) && new Date(bStart) < new Date(aEnd);
}

export function affectedActiveTasks(db, pilotId, windowStart, windowEnd) {
  return db.tasks.filter((task) => {
    if (task.pilotId !== pilotId) return false;
    if (!isActiveTaskStatus(task.status)) return false;
    if (!task.tideWindow || !task.tideWindow.start || !task.tideWindow.end) return false;
    return overlaps(windowStart, windowEnd, task.tideWindow.start, task.tideWindow.end);
  });
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

export function hourRange(baseDate, hours) {
  const start = baseDate instanceof Date ? new Date(baseDate) : new Date(baseDate);
  const end = new Date(start.getTime() + hours * 3600 * 1000);
  return { start: start.toISOString(), end: end.toISOString() };
}

export function nextTwelveHours(dateStr) {
  const base = dateStr ? new Date(dateStr) : new Date();
  return hourRange(base, 12);
}

export function countOverlapping(intervals, windowStart, windowEnd) {
  let count = 0;
  for (const iv of intervals) {
    if (overlaps(iv.start, iv.end, windowStart, windowEnd)) {
      count++;
    }
  }
  return count;
}

export function peakOverlapCount(intervals, windowStart, windowEnd) {
  const events = [];
  const ws = new Date(windowStart).getTime();
  const we = new Date(windowEnd).getTime();
  for (const iv of intervals) {
    const s = Math.max(new Date(iv.start).getTime(), ws);
    const e = Math.min(new Date(iv.end).getTime(), we);
    if (s < e) {
      events.push({ time: s, delta: 1 });
      events.push({ time: e, delta: -1 });
    }
  }
  events.sort((a, b) => a.time - b.time || a.delta - b.delta);
  let current = 0;
  let peak = 0;
  for (const ev of events) {
    current += ev.delta;
    if (current > peak) peak = current;
  }
  return peak;
}

export function hourlyBuckets(dateStr, hourCount = 12) {
  const base = dateStr ? new Date(dateStr) : new Date();
  const buckets = [];
  for (let i = 0; i < hourCount; i++) {
    const start = new Date(base.getTime() + i * 3600 * 1000);
    const end = new Date(base.getTime() + (i + 1) * 3600 * 1000);
    buckets.push({
      index: i,
      hour: start.getUTCHours(),
      start: start.toISOString(),
      end: end.toISOString()
    });
  }
  return buckets;
}
