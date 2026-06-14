import { DISTRICTS, ACTIVE_TASK_STATUSES } from "../config/scheduling-rules.js";
import { nextTwelveHours, overlaps, leaveConflictsForPilot, peakOverlapCount, countOverlapping } from "../utils/time.js";
import { activeTasksForPilot } from "../utils/time.js";

const BOARD_STATUSES = ["pending", "assigned", "in_progress", "done", "cancelled"];

function emptyStatusCounts() {
  const counts = {};
  for (const s of BOARD_STATUSES) counts[s] = 0;
  return counts;
}

function tasksByDistrict(tasks) {
  const map = {};
  for (const d of DISTRICTS) map[d] = [];
  for (const task of tasks) {
    if (map[task.district]) {
      map[task.district].push(task);
    }
  }
  return map;
}

function statusCounts(tasks) {
  const counts = emptyStatusCounts();
  for (const task of tasks) {
    if (BOARD_STATUSES.includes(task.status)) {
      counts[task.status]++;
    }
  }
  return counts;
}

function tideWindowsInRange(tasks, windowStart, windowEnd) {
  return tasks
    .filter((t) => t.tideWindow && overlaps(t.tideWindow.start, t.tideWindow.end, windowStart, windowEnd))
    .map((t) => ({ start: t.tideWindow.start, end: t.tideWindow.end, taskId: t.id }));
}

function tidePressure(tasks, windowStart, windowEnd) {
  const windows = tideWindowsInRange(tasks, windowStart, windowEnd);
  const peak = peakOverlapCount(windows, windowStart, windowEnd);
  const total = countOverlapping(windows.map((w) => ({ start: w.start, end: w.end })), windowStart, windowEnd);
  let level = "low";
  if (peak >= 5 || total >= 10) level = "high";
  else if (peak >= 3 || total >= 5) level = "medium";
  return {
    level,
    peakTasks: peak,
    totalTasks: total,
    window: { start: windowStart, end: windowEnd }
  };
}

function pilotsForDistrict(db, district) {
  return db.pilots.filter((p) => p.districts.includes(district));
}

function isPilotAvailable(db, pilot, windowStart, windowEnd) {
  const onShift = pilot.shifts.some((s) => overlaps(s.start, s.end, windowStart, windowEnd));
  if (!onShift) return false;
  const onLeave = leaveConflictsForPilot(db, pilot.id, windowStart, windowEnd).length > 0;
  if (onLeave) return false;
  const activeTasks = activeTasksForPilot(db, pilot.id);
  const busy = activeTasks.some((t) => overlaps(t.tideWindow.start, t.tideWindow.end, windowStart, windowEnd));
  return !busy;
}

function availablePilots(db, district, windowStart, windowEnd) {
  const districtPilots = pilotsForDistrict(db, district);
  const available = districtPilots.filter((p) => isPilotAvailable(db, p, windowStart, windowEnd));
  return {
    total: districtPilots.length,
    available: available.length,
    availablePilots: available.map((p) => ({ pilotId: p.id, name: p.name, grades: p.grades, shipTypes: p.shipTypes }))
  };
}

export function buildDistrictBoard(db, district, windowStart, windowEnd) {
  const districtTasks = tasksByDistrict(db.tasks)[district] || [];
  return {
    district,
    taskCounts: statusCounts(districtTasks),
    tidePressure: tidePressure(districtTasks.filter((t) => ACTIVE_TASK_STATUSES.includes(t.status)), windowStart, windowEnd),
    pilots: availablePilots(db, district, windowStart, windowEnd)
  };
}

export function buildBoard(db, dateStr) {
  const range = nextTwelveHours(dateStr);
  const districts = DISTRICTS.map((d) => buildDistrictBoard(db, d, range.start, range.end));
  const totalCounts = emptyStatusCounts();
  for (const d of districts) {
    for (const s of BOARD_STATUSES) {
      totalCounts[s] += d.taskCounts[s];
    }
  }
  return {
    generatedAt: new Date().toISOString(),
    window: range,
    summary: {
      totalTasks: districts.reduce((sum, d) => sum + d.taskCounts.pending + d.taskCounts.assigned + d.taskCounts.in_progress, 0),
      taskCounts: totalCounts,
      districts: districts.length
    },
    districts
  };
}
