import { RECOMMEND_WEIGHTS, gradeScore, shiftCoverageScore, workloadScore } from "../../config/recommend-rules.js";
import { overlaps, intersectInterval } from "../../utils/time.js";
import { isActiveTaskStatus } from "../../config/scheduling-rules.js";

function minutesBetween(start, end) {
  return (new Date(end) - new Date(start)) / 60000;
}

function bestGrade(pilotGrades) {
  const rank = { A: 2, B: 1 };
  return pilotGrades.reduce((best, g) => (rank[g] ?? 0) > (rank[best] ?? 0) ? g : best, null);
}

export function evaluateSimCandidate(snapshot, pilot, task, simAssignedTaskIds = new Set()) {
  const window = { start: task.tideWindow.start, end: task.tideWindow.end };
  const taskMinutes = minutesBetween(window.start, window.end);
  const rules = [];

  const matchingShifts = pilot.shifts
    .map((s) => intersectInterval(window.start, window.end, s.start, s.end))
    .filter(Boolean);
  const overlapMinutes = matchingShifts.reduce((sum, iv) => sum + minutesBetween(iv.start, iv.end), 0);
  const shiftScore = shiftCoverageScore(overlapMinutes, taskMinutes);
  rules.push({
    rule: "shift_coverage",
    passed: shiftScore > 0,
    score: shiftScore,
    weight: RECOMMEND_WEIGHTS.shiftCoverage,
    detail: { overlapMinutes, taskMinutes, shifts: pilot.shifts.length }
  });

  const districtOk = pilot.districts.includes(task.district);
  rules.push({
    rule: "district_match",
    passed: districtOk,
    score: districtOk ? 1 : 0,
    weight: RECOMMEND_WEIGHTS.district,
    detail: { pilotDistricts: pilot.districts, taskDistrict: task.district }
  });

  const shipTypeOk = pilot.shipTypes.includes(task.vessel.type);
  rules.push({
    rule: "ship_type_match",
    passed: shipTypeOk,
    score: shipTypeOk ? 1 : 0,
    weight: RECOMMEND_WEIGHTS.shipType,
    detail: { pilotShipTypes: pilot.shipTypes, taskShipType: task.vessel.type }
  });

  const pilotBestGrade = bestGrade(pilot.grades);
  const gradeOk = gradeScore(pilotBestGrade, task.requiredGrade) > 0;
  rules.push({
    rule: "grade_match",
    passed: gradeOk,
    score: gradeOk ? 1 : 0,
    weight: RECOMMEND_WEIGHTS.grade,
    detail: { pilotGrades: pilot.grades, pilotBestGrade, requiredGrade: task.requiredGrade }
  });

  const simActiveTasks = snapshot.tasks.filter(
    (t) => t.pilotId === pilot.id && t.id !== task.id && isActiveTaskStatus(t.status)
  );
  const simConflictTasks = simActiveTasks.filter(
    (t) => t.tideWindow && overlaps(window.start, window.end, t.tideWindow.start, t.tideWindow.end)
  );
  const noTimeConflict = simConflictTasks.length === 0;
  rules.push({
    rule: "no_time_conflict",
    passed: noTimeConflict,
    score: noTimeConflict ? 1 : 0,
    weight: RECOMMEND_WEIGHTS.noTimeConflict,
    detail: { activeTaskCount: simActiveTasks.length, conflictingTasks: simConflictTasks.map((t) => t.id) }
  });

  const leaveConflicts = snapshot.leaveRecords.filter(
    (l) => l.pilotId === pilot.id && l.status === "active" && overlaps(window.start, window.end, l.period.start, l.period.end)
  );
  const noLeaveConflict = leaveConflicts.length === 0;
  rules.push({
    rule: "no_leave_conflict",
    passed: noLeaveConflict,
    score: noLeaveConflict ? 1 : 0,
    weight: RECOMMEND_WEIGHTS.noLeaveConflict,
    detail: { conflictingLeaves: leaveConflicts.map((l) => ({ id: l.id, type: l.type })) }
  });

  const wlScore = workloadScore(simActiveTasks.length);
  rules.push({
    rule: "workload",
    passed: true,
    score: wlScore,
    weight: RECOMMEND_WEIGHTS.workload,
    detail: { activeTaskCount: simActiveTasks.length }
  });

  const hardRules = ["shift_coverage", "district_match", "ship_type_match", "grade_match", "no_time_conflict", "no_leave_conflict"];
  const eligible = rules.filter((r) => hardRules.includes(r.rule)).every((r) => r.passed);

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
    rules,
    weightedScores,
    disqualifying: rules.filter((r) => hardRules.includes(r.rule) && !r.passed).map((r) => r.rule)
  };
}

export function rankCandidates(snapshot, task, simAssignedTaskIds) {
  const candidates = snapshot.pilots.map((pilot) => evaluateSimCandidate(snapshot, pilot, task, simAssignedTaskIds));
  candidates.sort((a, b) => {
    if (b.eligible !== a.eligible) return b.eligible ? 1 : -1;
    if (b.totalScore !== a.totalScore) return b.totalScore - a.totalScore;
    return a.name.localeCompare(b.name);
  });
  return candidates;
}
