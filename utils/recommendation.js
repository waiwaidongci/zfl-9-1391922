import { overlaps, taskWindow, activeTasksForPilot, intersectInterval } from "./time.js";
import { RECOMMEND_WEIGHTS, gradeScore, shiftCoverageScore, workloadScore, recommendRulesMeta } from "../config/recommend-rules.js";

function minutesBetween(start, end) {
  return (new Date(end) - new Date(start)) / 60000;
}

function bestGrade(pilotGrades) {
  const rank = { A: 2, B: 1 };
  return pilotGrades.reduce((best, g) => (rank[g] ?? 0) > (rank[best] ?? 0) ? g : best, null);
}

export function evaluateCandidate(db, pilot, task) {
  const window = taskWindow(task);
  const taskMinutes = minutesBetween(window.start, window.end);
  const breakdown = {};

  const matchingShifts = pilot.shifts
    .map((s) => intersectInterval(window.start, window.end, s.start, s.end))
    .filter(Boolean);
  const overlapMinutes = matchingShifts.reduce((sum, iv) => sum + minutesBetween(iv.start, iv.end), 0);
  breakdown.shiftCoverage = {
    score: shiftCoverageScore(overlapMinutes, taskMinutes),
    detail: { overlapMinutes, taskMinutes, shifts: pilot.shifts.length }
  };

  const districtOk = pilot.districts.includes(task.district);
  breakdown.district = {
    score: districtOk ? 1 : 0,
    detail: { pilotDistricts: pilot.districts, taskDistrict: task.district }
  };

  const shipTypeOk = pilot.shipTypes.includes(task.vessel.type);
  breakdown.shipType = {
    score: shipTypeOk ? 1 : 0,
    detail: { pilotShipTypes: pilot.shipTypes, taskShipType: task.vessel.type }
  };

  const pilotBestGrade = bestGrade(pilot.grades);
  breakdown.grade = {
    score: gradeScore(pilotBestGrade, task.requiredGrade),
    detail: { pilotGrades: pilot.grades, pilotBestGrade, requiredGrade: task.requiredGrade }
  };

  const activeTasks = activeTasksForPilot(db, pilot.id, task.id);
  const conflicts = activeTasks.filter((t) => overlaps(window.start, window.end, t.tideWindow.start, t.tideWindow.end));
  breakdown.noTimeConflict = {
    score: conflicts.length === 0 ? 1 : 0,
    detail: { activeTaskCount: activeTasks.length, conflictingTasks: conflicts.map((t) => t.id) }
  };

  breakdown.workload = {
    score: workloadScore(activeTasks.length),
    detail: { activeTaskCount: activeTasks.length }
  };

  const weightedScores = {};
  let totalScore = 0;
  for (const dim of Object.keys(RECOMMEND_WEIGHTS)) {
    weightedScores[dim] = Number((breakdown[dim].score * RECOMMEND_WEIGHTS[dim]).toFixed(2));
    totalScore += weightedScores[dim];
  }

  const eligible = breakdown.shiftCoverage.score > 0 &&
    breakdown.district.score > 0 &&
    breakdown.shipType.score > 0 &&
    breakdown.grade.score > 0 &&
    breakdown.noTimeConflict.score > 0;

  const disqualifying = [];
  if (breakdown.shiftCoverage.score <= 0) disqualifying.push("not_on_shift");
  if (breakdown.district.score <= 0) disqualifying.push("district_mismatch");
  if (breakdown.shipType.score <= 0) disqualifying.push("ship_type_mismatch");
  if (breakdown.grade.score <= 0) disqualifying.push("grade_mismatch");
  if (breakdown.noTimeConflict.score <= 0) disqualifying.push("time_conflict");

  return {
    pilotId: pilot.id,
    name: pilot.name,
    totalScore: Number(totalScore.toFixed(2)),
    eligible,
    disqualifying,
    weightedScores,
    breakdown
  };
}

export function recommendPilots(db, task, limit) {
  const candidates = db.pilots.map((pilot) => evaluateCandidate(db, pilot, task));
  candidates.sort((a, b) => {
    if (b.eligible !== a.eligible) return b.eligible ? 1 : -1;
    if (b.totalScore !== a.totalScore) return b.totalScore - a.totalScore;
    return a.name.localeCompare(b.name);
  });
  const result = {
    taskId: task.id,
    dimensions: Object.keys(RECOMMEND_WEIGHTS).map((key) => ({
      key,
      ...recommendRulesMeta[key],
      weight: RECOMMEND_WEIGHTS[key]
    })),
    candidates: typeof limit === "number" ? candidates.slice(0, limit) : candidates
  };
  return result;
}

export function pilotFitsCheck(db, pilot, task, exceptTaskId) {
  const window = taskWindow(task);
  const onShift = pilot.shifts.some((shift) => overlaps(window.start, window.end, shift.start, shift.end));
  const noConflict = activeTasksForPilot(db, pilot.id, exceptTaskId).every((item) => {
    const other = taskWindow(item);
    return !overlaps(window.start, window.end, other.start, other.end);
  });
  const districtMatch = pilot.districts.includes(task.district);
  const shipTypeMatch = pilot.shipTypes.includes(task.vessel.type);
  const gradeMatch = pilot.grades.includes(task.requiredGrade);
  return {
    pilot,
    ok: onShift && noConflict && districtMatch && shipTypeMatch && gradeMatch,
    reasons: [
      onShift ? null : "not_on_shift",
      noConflict ? null : "time_conflict",
      districtMatch ? null : "district_mismatch",
      shipTypeMatch ? null : "ship_type_mismatch",
      gradeMatch ? null : "grade_mismatch"
    ].filter(Boolean)
  };
}
