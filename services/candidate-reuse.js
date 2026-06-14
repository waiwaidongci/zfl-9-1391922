import { evaluateCandidate } from "../utils/recommendation.js";
import { overlaps } from "../utils/time.js";
import { buildTaskFromRow } from "../utils/validator.js";
import { DEFAULT_TASK_STATUS } from "../config/scheduling-rules.js";

function findConflictingExistingTasks(db, task) {
  const conflicts = [];
  for (const existing of db.tasks) {
    if (existing.status === "cancelled" || existing.status === "completed" || existing.status === "done") continue;
    if (!existing.tideWindow || !task.tideWindow) continue;
    if (overlaps(task.tideWindow.start, task.tideWindow.end, existing.tideWindow.start, existing.tideWindow.end)) {
      if (existing.district === task.district) {
        conflicts.push({
          taskId: existing.id,
          vesselName: existing.vessel?.name || "未知",
          district: existing.district,
          tideWindow: existing.tideWindow,
          status: existing.status,
          pilotId: existing.pilotId,
          berthPlan: existing.berthPlan || null,
          conflictType: existing.pilotId ? "pilot_assigned" : "district_time"
        });
      }
    }
  }
  return conflicts;
}

function findConflictsWithinBatch(taskList, taskIndex) {
  const task = taskList[taskIndex];
  const conflicts = [];
  for (let i = 0; i < taskList.length; i++) {
    if (i === taskIndex) continue;
    const other = taskList[i];
    if (!other.tideWindow || !task.tideWindow) continue;
    if (overlaps(task.tideWindow.start, task.tideWindow.end, other.tideWindow.start, other.tideWindow.end)) {
      if (other.district === task.district) {
        conflicts.push({
          rowIndex: i,
          vesselName: other.vessel?.name || "未知",
          district: other.district,
          tideWindow: other.tideWindow
        });
      }
    }
  }
  return conflicts;
}

function suggestResolution(conflict) {
  if (conflict.conflictType === "pilot_assigned") {
    return {
      type: "reassign_pilot",
      description: `任务${conflict.taskId}已分配引航员${conflict.pilotId || ""}，可考虑重新分配或调整时间窗口`,
      suggestion: "reassign_or_reschedule"
    };
  }
  if (conflict.source === "batch") {
    return {
      type: "batch_conflict",
      description: `批次内第${conflict.rowIndex}行存在同港区时间冲突，建议错开潮汐窗口`,
      suggestion: "reschedule_batch_row"
    };
  }
  return {
    type: "district_time_conflict",
    description: `与已有任务${conflict.taskId}在${conflict.district}港区时间重叠，建议调整窗口或与调度协调`,
    suggestion: "reschedule_or_coordinate"
  };
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

  return {
    totalEligible: eligible.length,
    totalIneligible: candidates.length - eligible.length,
    recommendations: top.map((c) => ({
      pilotId: c.pilotId,
      name: c.name,
      score: c.totalScore,
      disqualifying: c.disqualifying
    })),
    topRecommendation: top[0] ? {
      pilotId: top[0].pilotId,
      name: top[0].name,
      score: top[0].totalScore
    } : null
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

  for (let i = 0; i < validRows.length; i++) {
    const rowIndex = validRows[i];
    const task = taskObjects[i];

    const existingConflicts = findConflictingExistingTasks(db, task);
    const batchConflicts = findConflictsWithinBatch(taskObjects, i);
    const allConflicts = [...existingConflicts, ...batchConflicts.map((c) => ({ ...c, taskId: `row-${c.rowIndex}`, source: "batch" }))];

    const recommendation = recommendForTask(db, task, 3);

    const item = {
      rowIndex,
      task,
      existingConflicts,
      batchConflicts,
      hasConflict: allConflicts.length > 0,
      recommendation
    };

    if (allConflicts.length > 0) {
      conflicting.push(item);
    } else {
      creatable.push(item);
    }
  }

  const pilotSummary = summarizePilotWorkload(db, taskObjects);
  const conflictSummary = summarizeConflicts(creatable, conflicting);

  return {
    creatable: creatable.map((item) => ({
      rowIndex: item.rowIndex,
      taskId: item.task.id,
      vesselName: item.task.vessel.name,
      district: item.task.district,
      tideWindow: item.task.tideWindow,
      topPilot: item.recommendation.topRecommendation,
      eligiblePilotCount: item.recommendation.totalEligible
    })),
    conflicting: conflicting.map((item) => {
      const allConflicts = [...item.existingConflicts, ...item.batchConflicts.map((c) => ({ ...c, taskId: `row-${c.rowIndex}`, source: "batch" }))];
      return {
        rowIndex: item.rowIndex,
        taskId: item.task.id,
        vesselName: item.task.vessel.name,
        district: item.task.district,
        tideWindow: item.task.tideWindow,
        conflictCount: allConflicts.length,
        existingConflicts: item.existingConflicts,
        batchConflicts: item.batchConflicts,
        topPilot: item.recommendation.topRecommendation,
        eligiblePilotCount: item.recommendation.totalEligible,
        resolutions: allConflicts.map((c) => suggestResolution(c))
      };
    }),
    pilotSummary,
    conflictSummary,
    creatableCount: creatable.length,
    conflictingCount: conflicting.length
  };
}

function summarizeConflicts(creatable, conflicting) {
  const districtConflictMap = new Map();
  for (const item of conflicting) {
    const district = item.task.district;
    if (!districtConflictMap.has(district)) {
      districtConflictMap.set(district, { district, conflictCount: 0, existingConflictCount: 0, batchConflictCount: 0 });
    }
    const stat = districtConflictMap.get(district);
    stat.conflictCount++;
    stat.existingConflictCount += item.existingConflicts.length;
    stat.batchConflictCount += item.batchConflicts.length;
  }

  return {
    totalConflictingTasks: conflicting.length,
    byDistrict: [...districtConflictMap.values()],
    totalExistingConflicts: conflicting.reduce((sum, item) => sum + item.existingConflicts.length, 0),
    totalBatchConflicts: conflicting.reduce((sum, item) => sum + item.batchConflicts.length, 0),
    canAutoCreate: creatable.length,
    needsResolution: conflicting.length
  };
}

function summarizePilotWorkload(db, newTasks) {
  const pilotStats = new Map();

  for (const pilot of db.pilots) {
    const activeTasks = db.tasks.filter(
      (t) => t.pilotId === pilot.id &&
        ["pending", "assigned", "in_progress"].includes(t.status)
    );
    pilotStats.set(pilot.id, {
      pilotId: pilot.id,
      name: pilot.name,
      districts: pilot.districts,
      grades: pilot.grades,
      shipTypes: pilot.shipTypes,
      currentTasks: activeTasks.length,
      newAssignable: 0,
      applicableTaskIndices: []
    });
  }

  for (let taskIdx = 0; taskIdx < newTasks.length; taskIdx++) {
    const task = newTasks[taskIdx];
    const recs = db.pilots.map((pilot) => evaluateCandidate(db, pilot, task));
    const eligible = recs.filter((r) => r.eligible);
    for (const r of eligible) {
      const stat = pilotStats.get(r.pilotId);
      if (stat) {
        stat.newAssignable++;
        stat.applicableTaskIndices.push(taskIdx);
      }
    }
  }

  const summary = [];
  for (const stat of pilotStats.values()) {
    summary.push({
      pilotId: stat.pilotId,
      name: stat.name,
      districts: stat.districts,
      grades: stat.grades,
      shipTypes: stat.shipTypes,
      currentTaskCount: stat.currentTasks,
      canTakeNewCount: stat.newAssignable,
      totalAfterImport: stat.currentTasks + Math.min(stat.newAssignable, 1),
      workloadLevel: stat.currentTasks === 0 ? "free" : stat.currentTasks <= 1 ? "normal" : stat.currentTasks <= 2 ? "busy" : "overloaded"
    });
  }

  summary.sort((a, b) => b.canTakeNewCount - a.canTakeNewCount || a.currentTaskCount - b.currentTaskCount);

  return {
    totalPilots: db.pilots.length,
    availablePilots: summary.filter((s) => s.canTakeNewCount > 0).length,
    freePilots: summary.filter((s) => s.workloadLevel === "free").length,
    busyPilots: summary.filter((s) => s.workloadLevel === "busy" || s.workloadLevel === "overloaded").length,
    pilots: summary
  };
}
