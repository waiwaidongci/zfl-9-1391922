import { DISTRICTS, ACTIVE_TASK_STATUSES } from "../config/scheduling-rules.js";
import { nextTwelveHours, overlaps, leaveConflictsForPilot, peakOverlapCount, countOverlapping, hourlyBuckets } from "../utils/time.js";
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

function pilotAvailabilityReasons(db, pilot, windowStart, windowEnd) {
  const reasons = [];
  const onShift = pilot.shifts.some((s) => overlaps(s.start, s.end, windowStart, windowEnd));
  if (!onShift) {
    reasons.push({ code: "off_shift", detail: "不在值班时段" });
    return reasons;
  }
  const leaves = leaveConflictsForPilot(db, pilot.id, windowStart, windowEnd);
  if (leaves.length > 0) {
    reasons.push({
      code: "leave",
      detail: leaves.map((l) => ({ leaveId: l.id, type: l.type, reason: l.reason }))
    });
  }
  const activeTasks = activeTasksForPilot(db, pilot.id);
  const busyTasks = activeTasks.filter((t) => overlaps(t.tideWindow.start, t.tideWindow.end, windowStart, windowEnd));
  if (busyTasks.length > 0) {
    reasons.push({
      code: "busy",
      detail: busyTasks.map((t) => ({ taskId: t.id, vesselName: t.vessel.name, status: t.status }))
    });
  }
  return reasons;
}

function hourlyCapacity(db, district, dateStr) {
  const buckets = hourlyBuckets(dateStr, 12);
  const districtTasks = (tasksByDistrict(db.tasks)[district] || []).filter((t) =>
    ACTIVE_TASK_STATUSES.includes(t.status)
  );
  const districtPilots = pilotsForDistrict(db, district);
  const result = [];
  for (const bucket of buckets) {
    const bucketTasks = districtTasks.filter((t) =>
      overlaps(t.tideWindow.start, t.tideWindow.end, bucket.start, bucket.end)
    );
    const taskIntervals = bucketTasks.map((t) => ({ start: t.tideWindow.start, end: t.tideWindow.end }));
    const peak = peakOverlapCount(taskIntervals, bucket.start, bucket.end);
    const available = districtPilots.filter((p) => isPilotAvailable(db, p, bucket.start, bucket.end));
    const gapCauses = [];
    for (const pilot of districtPilots) {
      if (isPilotAvailable(db, pilot, bucket.start, bucket.end)) continue;
      const reasons = pilotAvailabilityReasons(db, pilot, bucket.start, bucket.end);
      if (reasons.length > 0) {
        gapCauses.push({
          pilotId: pilot.id,
          name: pilot.name,
          unavailableReasons: reasons
        });
      }
    }
    result.push({
      index: bucket.index,
      hour: bucket.hour,
      start: bucket.start,
      end: bucket.end,
      taskCount: bucketTasks.length,
      peakOverlap: peak,
      availablePilots: available.length,
      totalPilots: districtPilots.length,
      gapCauses
    });
  }
  return result;
}

export function buildDistrictBoard(db, district, windowStart, windowEnd) {
  const districtTasks = tasksByDistrict(db.tasks)[district] || [];
  return {
    district,
    taskCounts: statusCounts(districtTasks),
    tidePressure: tidePressure(districtTasks.filter((t) => ACTIVE_TASK_STATUSES.includes(t.status)), windowStart, windowEnd),
    pilots: availablePilots(db, district, windowStart, windowEnd),
    hourlyCapacity: hourlyCapacity(db, district, windowStart)
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
