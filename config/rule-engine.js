import { overlaps, intersectInterval } from "../utils/time.js";

export const HARD_RULES = [
  "shift_coverage",
  "district_match",
  "ship_type_match",
  "grade_match",
  "no_time_conflict",
  "no_leave_conflict"
];

export const DISQUALIFY_MAP = {
  shift_coverage: "not_on_shift",
  district_match: "district_mismatch",
  ship_type_match: "ship_type_mismatch",
  grade_match: "grade_mismatch",
  no_time_conflict: "time_conflict",
  no_leave_conflict: "leave_conflict"
};

export const RULE_WEIGHTS = {
  shift_coverage: 25,
  district_match: 20,
  ship_type_match: 15,
  grade_match: 20,
  no_time_conflict: 15,
  no_leave_conflict: 10,
  workload: 5
};

const GRADE_RANK = { A: 2, B: 1 };

export function bestGrade(pilotGrades) {
  return pilotGrades.reduce(
    (best, g) => (GRADE_RANK[g] ?? 0) > (GRADE_RANK[best] ?? 0) ? g : best,
    null
  );
}

export function gradeScore(pilotGrade, requiredGrade) {
  const pilotRank = GRADE_RANK[pilotGrade] ?? 0;
  const requiredRank = GRADE_RANK[requiredGrade] ?? 99;
  if (pilotRank >= requiredRank) return 1;
  return 0;
}

export function shiftCoverageScore(overlapMinutes, taskMinutes) {
  if (taskMinutes <= 0) return 0;
  return Math.min(1, overlapMinutes / taskMinutes);
}

export function workloadScore(currentTaskCount) {
  if (currentTaskCount === 0) return 1;
  if (currentTaskCount === 1) return 0.7;
  if (currentTaskCount === 2) return 0.4;
  return 0.1;
}

function minutesBetween(start, end) {
  return (new Date(end) - new Date(start)) / 60000;
}

function getShiftCoverage(pilot, window, taskMinutes) {
  const matchingShifts = pilot.shifts
    .map((s) => intersectInterval(window.start, window.end, s.start, s.end))
    .filter(Boolean);
  const overlapMinutes = matchingShifts.reduce(
    (sum, iv) => sum + minutesBetween(iv.start, iv.end), 0
  );
  const score = shiftCoverageScore(overlapMinutes, taskMinutes);
  return {
    rule: "shift_coverage",
    passed: score > 0,
    score,
    weight: RULE_WEIGHTS.shift_coverage,
    detail: { overlapMinutes, taskMinutes, shifts: pilot.shifts.length }
  };
}

function getDistrictMatch(pilot, task) {
  const ok = pilot.districts.includes(task.district);
  return {
    rule: "district_match",
    passed: ok,
    score: ok ? 1 : 0,
    weight: RULE_WEIGHTS.district_match,
    detail: { pilotDistricts: pilot.districts, taskDistrict: task.district }
  };
}

function getShipTypeMatch(pilot, task) {
  const ok = pilot.shipTypes.includes(task.vessel.type);
  return {
    rule: "ship_type_match",
    passed: ok,
    score: ok ? 1 : 0,
    weight: RULE_WEIGHTS.ship_type_match,
    detail: { pilotShipTypes: pilot.shipTypes, taskShipType: task.vessel.type }
  };
}

function getGradeMatch(pilot, task) {
  const pilotBest = bestGrade(pilot.grades);
  const score = gradeScore(pilotBest, task.requiredGrade);
  return {
    rule: "grade_match",
    passed: score > 0,
    score,
    weight: RULE_WEIGHTS.grade_match,
    detail: { pilotGrades: pilot.grades, pilotBestGrade: pilotBest, requiredGrade: task.requiredGrade }
  };
}

function getNoTimeConflict(activeTasks, window) {
  const conflicts = activeTasks.filter(
    (t) => t.tideWindow && overlaps(window.start, window.end, t.tideWindow.start, t.tideWindow.end)
  );
  const ok = conflicts.length === 0;
  return {
    rule: "no_time_conflict",
    passed: ok,
    score: ok ? 1 : 0,
    weight: RULE_WEIGHTS.no_time_conflict,
    detail: { activeTaskCount: activeTasks.length, conflictingTasks: conflicts.map((t) => t.id) }
  };
}

function getNoLeaveConflict(leaveConflicts) {
  const ok = leaveConflicts.length === 0;
  return {
    rule: "no_leave_conflict",
    passed: ok,
    score: ok ? 1 : 0,
    weight: RULE_WEIGHTS.no_leave_conflict,
    detail: { conflictingLeaves: leaveConflicts.map((l) => ({ id: l.id, type: l.type })) }
  };
}

function getWorkload(activeTaskCount) {
  return {
    rule: "workload",
    passed: true,
    score: workloadScore(activeTaskCount),
    weight: RULE_WEIGHTS.workload,
    detail: { activeTaskCount }
  };
}

export function evaluateCandidateCore(pilot, task, { activeTasks, leaveConflicts }) {
  const window = { start: task.tideWindow.start, end: task.tideWindow.end };
  const taskMinutes = minutesBetween(window.start, window.end);

  const rules = [
    getShiftCoverage(pilot, window, taskMinutes),
    getDistrictMatch(pilot, task),
    getShipTypeMatch(pilot, task),
    getGradeMatch(pilot, task),
    getNoTimeConflict(activeTasks, window),
    getNoLeaveConflict(leaveConflicts),
    getWorkload(activeTasks.length)
  ];

  const eligible = rules
    .filter((r) => HARD_RULES.includes(r.rule))
    .every((r) => r.passed);

  const disqualifying = rules
    .filter((r) => HARD_RULES.includes(r.rule) && !r.passed)
    .map((r) => DISQUALIFY_MAP[r.rule]);

  let totalScore = 0;
  const weightedScores = {};
  for (const r of rules) {
    const ws = Number((r.score * r.weight).toFixed(2));
    weightedScores[r.rule] = ws;
    totalScore += ws;
  }

  return {
    pilotId: pilot.id,
    name: pilot.name,
    eligible,
    totalScore: Number(totalScore.toFixed(2)),
    disqualifying,
    weightedScores,
    rules
  };
}
