import { createSimulationSnapshot, addSimTask, assignSimTask } from "./model.js";
import { evaluateSimCandidate, rankCandidates } from "./rule-engine.js";
import { explainUnassigned } from "./conflict-detector.js";
import { isActiveTaskStatus } from "../../config/scheduling-rules.js";

function buildPilotLoadMap(snapshot) {
  const loadMap = new Map();
  for (const pilot of snapshot.pilots) {
    const activeTasks = snapshot.tasks.filter(
      (t) => t.pilotId === pilot.id && isActiveTaskStatus(t.status)
    );
    loadMap.set(pilot.id, {
      pilotId: pilot.id,
      name: pilot.name,
      districts: pilot.districts,
      shipTypes: pilot.shipTypes,
      grades: pilot.grades,
      assignedTaskCount: activeTasks.length,
      assignedTasks: activeTasks.map((t) => ({
        taskId: t.id,
        district: t.district,
        tideWindow: t.tideWindow,
        vesselName: t.vessel?.name
      }))
    });
  }
  return loadMap;
}

function sortTasksByPriority(tasks) {
  return [...tasks].sort((a, b) => {
    const gradeRank = { A: 2, B: 1 };
    const ga = gradeRank[a.requiredGrade] ?? 0;
    const gb = gradeRank[b.requiredGrade] ?? 0;
    if (ga !== gb) return gb - ga;
    if (a.tideWindow && b.tideWindow) {
      return new Date(a.tideWindow.start) - new Date(b.tideWindow.start);
    }
    return 0;
  });
}

export function runSimulation(db, { tasks = [], tempShifts = [] } = {}) {
  const snapshot = createSimulationSnapshot(db, { tempShifts });

  const simTasks = [];
  for (const task of tasks) {
    addSimTask(snapshot, task);
    simTasks.push(task);
  }

  const assignments = [];
  const unassigned = [];
  const simAssignedTaskIds = new Set();
  const assignmentLog = [];

  const sortedTasks = sortTasksByPriority(simTasks);

  for (const task of sortedTasks) {
    const candidates = rankCandidates(snapshot, task, simAssignedTaskIds);
    const eligible = candidates.filter((c) => c.eligible);

    if (eligible.length === 0) {
      const explanation = explainUnassigned(snapshot, task);
      unassigned.push({
        taskId: task.id,
        vesselName: task.vessel?.name,
        district: task.district,
        tideWindow: task.tideWindow,
        requiredGrade: task.requiredGrade,
        reasons: explanation.globalConflicts,
        pilotConflictSummary: explanation.pilotConflictSummary,
        allCandidates: candidates.map((c) => ({
          pilotId: c.pilotId,
          name: c.name,
          eligible: c.eligible,
          disqualifying: c.disqualifying
        }))
      });
      continue;
    }

    const chosen = eligible[0];
    const assignedTask = assignSimTask(snapshot, task.id, chosen.pilotId);
    simAssignedTaskIds.add(task.id);

    const ruleTrace = chosen.rules.map((r) => ({
      rule: r.rule,
      passed: r.passed,
      score: r.score,
      weight: r.weight,
      detail: r.detail
    }));

    assignments.push({
      taskId: task.id,
      vesselName: task.vessel?.name,
      district: task.district,
      tideWindow: task.tideWindow,
      requiredGrade: task.requiredGrade,
      pilotId: chosen.pilotId,
      pilotName: chosen.name,
      score: chosen.totalScore,
      ruleTrace
    });

    assignmentLog.push({
      step: assignments.length,
      taskId: task.id,
      pilotId: chosen.pilotId,
      pilotName: chosen.name,
      score: chosen.totalScore,
      triggeredRules: ruleTrace.filter((r) => r.passed).map((r) => r.rule),
      disqualifyingRules: ruleTrace.filter((r) => !r.passed).map((r) => r.rule)
    });
  }

  const pilotLoadMap = buildPilotLoadMap(snapshot);
  const pilotLoads = [];
  for (const pilot of snapshot.pilots) {
    const load = pilotLoadMap.get(pilot.id);
    pilotLoads.push({
      ...load,
      workloadLevel: load.assignedTaskCount === 0 ? "free" : load.assignedTaskCount <= 1 ? "normal" : load.assignedTaskCount <= 2 ? "busy" : "overloaded"
    });
  }
  pilotLoads.sort((a, b) => b.assignedTaskCount - a.assignedTaskCount);

  const conflictCount = unassigned.length;

  return {
    summary: {
      totalInputTasks: simTasks.length,
      assignedCount: assignments.length,
      unassignedCount: unassigned.length,
      conflictCount,
      totalPilots: snapshot.pilots.length,
      freePilots: pilotLoads.filter((p) => p.workloadLevel === "free").length,
      busyPilots: pilotLoads.filter((p) => p.workloadLevel === "busy" || p.workloadLevel === "overloaded").length,
      tempShiftsApplied: tempShifts.length
    },
    assignments,
    unassigned,
    pilotLoads,
    assignmentLog
  };
}
