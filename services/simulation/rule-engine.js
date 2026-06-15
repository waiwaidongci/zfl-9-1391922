import { evaluateCandidateCore, HARD_RULES, DISQUALIFY_MAP } from "../../config/rule-engine.js";
import { overlaps } from "../../utils/time.js";
import { isActiveTaskStatus } from "../../config/scheduling-rules.js";

function getActiveTasksFromSnapshot(snapshot, pilotId, taskId) {
  return snapshot.tasks.filter(
    (t) => t.pilotId === pilotId && t.id !== taskId && isActiveTaskStatus(t.status)
  );
}

function getLeaveConflictsFromSnapshot(snapshot, pilotId, windowStart, windowEnd) {
  return snapshot.leaveRecords.filter(
    (l) =>
      l.pilotId === pilotId &&
      l.status === "active" &&
      overlaps(windowStart, windowEnd, l.period.start, l.period.end)
  );
}

export function evaluateSimCandidate(snapshot, pilot, task) {
  const activeTasks = getActiveTasksFromSnapshot(snapshot, pilot.id, task.id);
  const leaveConflicts = getLeaveConflictsFromSnapshot(
    snapshot, pilot.id, task.tideWindow.start, task.tideWindow.end
  );

  const core = evaluateCandidateCore(pilot, task, {
    activeTasks,
    leaveConflicts
  });

  return {
    pilotId: core.pilotId,
    name: core.name,
    eligible: core.eligible,
    totalScore: core.totalScore,
    rules: core.rules,
    weightedScores: core.weightedScores,
    disqualifying: core.disqualifying
  };
}

export function rankCandidates(snapshot, task) {
  const candidates = snapshot.pilots.map((pilot) => evaluateSimCandidate(snapshot, pilot, task));
  candidates.sort((a, b) => {
    if (b.eligible !== a.eligible) return b.eligible ? 1 : -1;
    if (b.totalScore !== a.totalScore) return b.totalScore - a.totalScore;
    return a.name.localeCompare(b.name);
  });
  return candidates;
}

export { HARD_RULES, DISQUALIFY_MAP };
