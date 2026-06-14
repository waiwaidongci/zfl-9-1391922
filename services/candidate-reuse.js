import { evaluateCandidate } from "../utils/recommendation.js";
import { overlaps, intersectInterval } from "../utils/time.js";
import { buildTaskFromRow } from "../utils/validator.js";
import { DEFAULT_TASK_STATUS, isActiveTaskStatus } from "../config/scheduling-rules.js";

function minutesBetween(start, end) {
  return Math.round((new Date(end) - new Date(start)) / 60000);
}

function findConflictingExistingTasks(db, task) {
  const conflicts = [];
  for (const existing of db.tasks) {
    if (!isActiveTaskStatus(existing.status)) continue;
    if (!existing.tideWindow || !task.tideWindow) continue;

    const overlap = intersectInterval(
      task.tideWindow.start,
      task.tideWindow.end,
      existing.tideWindow.start,
      existing.tideWindow.end
    );

    if (overlap && existing.district === task.district) {
      const overlapMinutes = minutesBetween(overlap.start, overlap.end);
      const taskDuration = minutesBetween(task.tideWindow.start, task.tideWindow.end);
      const overlapRatio = taskDuration > 0 ? overlapMinutes / taskDuration : 0;

      let severity = "low";
      if (overlapRatio >= 0.8 || overlapMinutes >= 120) {
        severity = "high";
      } else if (overlapRatio >= 0.4 || overlapMinutes >= 60) {
        severity = "medium";
      }

      conflicts.push({
        taskId: existing.id,
        vesselName: existing.vessel?.name || "未知",
        district: existing.district,
        tideWindow: existing.tideWindow,
        status: existing.status,
        pilotId: existing.pilotId,
        pilotName: existing.pilotId ? (db.pilots.find((p) => p.id === existing.pilotId)?.name || null) : null,
        overlap,
        overlapMinutes,
        overlapRatio: Number(overlapRatio.toFixed(2)),
        severity,
        source: "existing"
      });
    }
  }
  return conflicts;
}

function findConflictsWithinBatch(taskList, taskIndex, allRowIndices) {
  const task = taskList[taskIndex];
  const conflicts = [];
  for (let i = 0; i < taskList.length; i++) {
    if (i === taskIndex) continue;
    const other = taskList[i];
    if (!other.tideWindow || !task.tideWindow) continue;

    const overlap = intersectInterval(
      task.tideWindow.start,
      task.tideWindow.end,
      other.tideWindow.start,
      other.tideWindow.end
    );

    if (overlap && other.district === task.district) {
      const overlapMinutes = minutesBetween(overlap.start, overlap.end);
      const taskDuration = minutesBetween(task.tideWindow.start, task.tideWindow.end);
      const overlapRatio = taskDuration > 0 ? overlapMinutes / taskDuration : 0;

      let severity = "low";
      if (overlapRatio >= 0.8 || overlapMinutes >= 120) {
        severity = "high";
      } else if (overlapRatio >= 0.4 || overlapMinutes >= 60) {
        severity = "medium";
      }

      conflicts.push({
        rowIndex: allRowIndices[i],
        taskId: other.id,
        vesselName: other.vessel?.name || "未知",
        district: other.district,
        tideWindow: other.tideWindow,
        overlap,
        overlapMinutes,
        overlapRatio: Number(overlapRatio.toFixed(2)),
        severity,
        source: "batch"
      });
    }
  }
  return conflicts;
}

function recommendForTask(db, task, limit = 3) {
  const candidates = db.pilots.map((pilot) => evaluateCandidate(db, pilot, task));
  candidates.sort((a, b) => {
    if (b.eligible !== a.eligible) return b.eligible ? 1 : -1;
    if (b.totalScore !== a.totalScore) return b.totalScore - a.totalScore;
    return a.name.localeCompare(b.name);
  });

  const eligible = candidates.filter((c) => c.eligible);
  const top = eligible.slice(0, limit);
  const ineligible = candidates.filter((c) => !c.eligible).slice(0, 2);

  return {
    totalPilots: candidates.length,
    totalEligible: eligible.length,
    noEligiblePilots: eligible.length === 0,
    recommendations: top.map((c) => ({
      pilotId: c.pilotId,
      name: c.name,
      score: c.totalScore,
      grades: db.pilots.find((p) => p.id === c.pilotId)?.grades || [],
      districts: db.pilots.find((p) => p.id === c.pilotId)?.districts || [],
      disqualifying: c.disqualifying
    })),
    topRecommendation: top[0] ? {
      pilotId: top[0].pilotId,
      name: top[0].name,
      score: top[0].totalScore
    } : null,
    alternativePilots: ineligible.map((c) => ({
      pilotId: c.pilotId,
      name: c.name,
      disqualifying: c.disqualifying
    }))
  };
}

export function analyzeImportBatch(db, validRows, allRows) {
  const taskObjects = validRows.map((rowIndex) => {
    const row = allRows[rowIndex];
    const task = buildTaskFromRow(row);
    task.status = DEFAULT_TASK_STATUS;
    task.pilotId = null;
    task.id = row.id || `T-IMPORT-${rowIndex}`;
    return task;
  });

  const creatable = [];
  const conflicting = [];
  const noPilotTasks = [];

  for (let i = 0; i < validRows.length; i++) {
    const rowIndex = validRows[i];
    const task = taskObjects[i];

    const existingConflicts = findConflictingExistingTasks(db, task);
    const batchConflicts = findConflictsWithinBatch(taskObjects, i, validRows);
    const allConflicts = [...existingConflicts, ...batchConflicts];

    const hasHighSeverityConflict = allConflicts.some((c) => c.severity === "high");
    const hasMediumSeverityConflict = allConflicts.some((c) => c.severity === "medium");

    const recommendation = recommendForTask(db, task, 3);

    if (recommendation.noEligiblePilots) {
      noPilotTasks.push({
        rowIndex,
        taskId: task.id,
        vesselName: task.vessel.name,
        district: task.district,
        requiredGrade: task.requiredGrade,
        shipType: task.vessel.type
      });
    }

    const item = {
      rowIndex,
      task,
      existingConflicts,
      batchConflicts,
      hasConflict: allConflicts.length > 0,
      conflictSeverity: hasHighSeverityConflict ? "high" : (hasMediumSeverityConflict ? "medium" : (allConflicts.length > 0 ? "low" : "none")),
      conflictCount: allConflicts.length,
      recommendation
    };

    if (allConflicts.length > 0) {
      conflicting.push(item);
    } else {
      creatable.push(item);
    }
  }

  const pilotSummary = summarizePilotWorkload(db, taskObjects);

  return {
    creatable: creatable.map((item) => ({
      rowIndex: item.rowIndex,
      taskId: item.task.id,
      vesselName: item.task.vessel.name,
      shipType: item.task.vessel.type,
      district: item.task.district,
      requiredGrade: item.task.requiredGrade,
      tideWindow: item.task.tideWindow,
      topPilot: item.recommendation.topRecommendation,
      eligiblePilotCount: item.recommendation.totalEligible
    })),
    conflicting: conflicting.map((item) => ({
      rowIndex: item.rowIndex,
      taskId: item.task.id,
      vesselName: item.task.vessel.name,
      shipType: item.task.vessel.type,
      district: item.task.district,
      requiredGrade: item.task.requiredGrade,
      tideWindow: item.task.tideWindow,
      conflictCount: item.conflictCount,
      conflictSeverity: item.conflictSeverity,
      existingConflictCount: item.existingConflicts.length,
      batchConflictCount: item.batchConflicts.length,
      highSeverityCount: item.existingConflicts.filter((c) => c.severity === "high").length +
        item.batchConflicts.filter((c) => c.severity === "high").length,
      existingConflicts: item.existingConflicts,
      batchConflicts: item.batchConflicts,
      topPilot: item.recommendation.topRecommendation,
      eligiblePilotCount: item.recommendation.totalEligible
    })),
    pilotSummary,
    noPilotTasks,
    creatableCount: creatable.length,
    conflictingCount: conflicting.length,
    noPilotCount: noPilotTasks.length
  };
}

function summarizePilotWorkload(db, newTasks) {
  const pilotStats = new Map();

  for (const pilot of db.pilots) {
    const activeTasks = db.tasks.filter(
      (t) => t.pilotId === pilot.id && isActiveTaskStatus(t.status)
    );

    const upcomingHours = activeTasks.reduce((sum, t) => {
      if (t.tideWindow) {
        return sum + minutesBetween(t.tideWindow.start, t.tideWindow.end) / 60;
      }
      return sum;
    }, 0);

    pilotStats.set(pilot.id, {
      pilotId: pilot.id,
      name: pilot.name,
      districts: pilot.districts,
      shipTypes: pilot.shipTypes,
      grades: pilot.grades,
      currentTasks: activeTasks.length,
      currentWorkloadHours: Number(upcomingHours.toFixed(1)),
      newAssignable: 0,
      newAssignableTasks: []
    });
  }

  for (let i = 0; i < newTasks.length; i++) {
    const task = newTasks[i];
    const recs = db.pilots.map((pilot) => evaluateCandidate(db, pilot, task));
    const eligible = recs.filter((r) => r.eligible);
    for (const r of eligible) {
      const stat = pilotStats.get(r.pilotId);
      if (stat) {
        stat.newAssignable++;
        stat.newAssignableTasks.push({
          taskId: task.id,
          vesselName: task.vessel?.name || "",
          score: r.totalScore
        });
      }
    }
  }

  const summary = [];
  for (const stat of pilotStats.values()) {
    stat.newAssignableTasks.sort((a, b) => b.score - a.score);
    summary.push({
      pilotId: stat.pilotId,
      name: stat.name,
      districts: stat.districts,
      shipTypes: stat.shipTypes,
      grades: stat.grades,
      currentTaskCount: stat.currentTasks,
      currentWorkloadHours: stat.currentWorkloadHours,
      canTakeNewCount: stat.newAssignable,
      totalAfterImport: stat.currentTasks + Math.min(stat.newAssignable, 1),
      overloaded: stat.currentTasks >= 3 || stat.currentWorkloadHours >= 12,
      topAssignableTasks: stat.newAssignableTasks.slice(0, 3)
    });
  }

  summary.sort((a, b) => {
    if (b.canTakeNewCount !== a.canTakeNewCount) return b.canTakeNewCount - a.canTakeNewCount;
    if (a.overloaded !== b.overloaded) return a.overloaded ? 1 : -1;
    return a.currentTaskCount - b.currentTaskCount;
  });

  const overloadedCount = summary.filter((s) => s.overloaded).length;
  const idlePilots = summary.filter((s) => s.currentTaskCount === 0 && s.canTakeNewCount > 0).length;

  return {
    totalPilots: db.pilots.length,
    availablePilots: summary.filter((s) => s.canTakeNewCount > 0).length,
    overloadedPilots: overloadedCount,
    idlePilots,
    districtBreakdown: buildDistrictBreakdown(summary),
    pilots: summary
  };
}

function buildDistrictBreakdown(pilotSummary) {
  const breakdown = {};
  for (const pilot of pilotSummary) {
    for (const district of pilot.districts) {
      if (!breakdown[district]) {
        breakdown[district] = {
          totalPilots: 0,
          availablePilots: 0,
          overloadedPilots: 0
        };
      }
      breakdown[district].totalPilots++;
      if (pilot.canTakeNewCount > 0) breakdown[district].availablePilots++;
      if (pilot.overloaded) breakdown[district].overloadedPilots++;
    }
  }
  return breakdown;
}
