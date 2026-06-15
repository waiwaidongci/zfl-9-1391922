import { overlaps, leaveConflictsForPilot, activeTasksForPilot, intersectInterval } from "./time.js";
import { RECOMMEND_WEIGHTS, recommendRulesMeta } from "../config/recommend-rules.js";
import { isActiveTaskStatus } from "../config/scheduling-rules.js";
import { evaluateCandidateCore, bestGrade, gradeScore, shiftCoverageScore, workloadScore, DISQUALIFY_MAP } from "../config/rule-engine.js";

const RULE_KEY_TO_DIM = {
  shift_coverage: "shiftCoverage",
  district_match: "district",
  ship_type_match: "shipType",
  grade_match: "grade",
  no_time_conflict: "noTimeConflict",
  no_leave_conflict: "noLeaveConflict",
  workload: "workload"
};

function minutesBetween(start, end) {
  return (new Date(end) - new Date(start)) / 60000;
}

export function evaluateCandidate(db, pilot, task, exceptTaskId = null) {
  const effectiveExceptTaskId = exceptTaskId === null ? task.id : exceptTaskId;
  const pilotActiveTasks = activeTasksForPilot(db, pilot.id, effectiveExceptTaskId);
  const pilotLeaveConflicts = leaveConflictsForPilot(
    db, pilot.id, task.tideWindow.start, task.tideWindow.end
  );

  const core = evaluateCandidateCore(pilot, task, {
    activeTasks: pilotActiveTasks,
    leaveConflicts: pilotLeaveConflicts
  });

  const weightedScores = {};
  const breakdown = {};
  for (const r of core.rules) {
    const dimKey = RULE_KEY_TO_DIM[r.rule];
    const weight = RECOMMEND_WEIGHTS[dimKey] ?? 0;
    const ws = Number((r.score * weight).toFixed(2));
    weightedScores[dimKey] = ws;
    breakdown[dimKey] = { score: r.score, detail: r.detail };
  }

  return {
    pilotId: core.pilotId,
    name: core.name,
    totalScore: core.totalScore,
    eligible: core.eligible,
    disqualifying: core.disqualifying,
    weightedScores,
    breakdown
  };
}

export function pilotFitsCheck(db, pilot, task, exceptTaskId = null) {
  const result = evaluateCandidate(db, pilot, task, exceptTaskId);
  return {
    pilot,
    ok: result.eligible,
    reasons: result.disqualifying,
    eligible: result.eligible,
    disqualifying: result.disqualifying,
    totalScore: result.totalScore,
    weightedScores: result.weightedScores,
    breakdown: result.breakdown
  };
}

export function buildCandidateExplanation(db, pilot, task, exceptTaskId = null) {
  const fit = pilotFitsCheck(db, pilot, task, exceptTaskId);
  return fit;
}

export function recommendPilots(db, task, limit = null) {
  const candidates = db.pilots.map((pilot) => evaluateCandidate(db, pilot, task, task.id));

  candidates.sort((a, b) => {
    if (b.eligible !== a.eligible) return b.eligible ? 1 : -1;
    if (b.totalScore !== a.totalScore) return b.totalScore - a.totalScore;
    return a.name.localeCompare(b.name);
  });

  const resultCandidates = limit ? candidates.slice(0, limit) : candidates;

  const dimensions = Object.keys(RECOMMEND_WEIGHTS).map((key) => ({
    key,
    label: recommendRulesMeta[key]?.label || key,
    description: recommendRulesMeta[key]?.description || key,
    weight: RECOMMEND_WEIGHTS[key]
  }));

  return {
    taskId: task.id,
    dimensions,
    candidates: resultCandidates
  };
}

export function findAlternativesForTask(db, task, excludedPilotId, limit = 3) {
  const candidates = db.pilots
    .filter((pilot) => pilot.id !== excludedPilotId)
    .map((pilot) => evaluateCandidate(db, pilot, task, task.id));

  candidates.sort((a, b) => {
    if (b.eligible !== a.eligible) return b.eligible ? 1 : -1;
    if (b.totalScore !== a.totalScore) return b.totalScore - a.totalScore;
    return a.name.localeCompare(b.name);
  });

  return limit ? candidates.slice(0, limit) : candidates;
}

export { bestGrade, gradeScore, shiftCoverageScore, workloadScore };
