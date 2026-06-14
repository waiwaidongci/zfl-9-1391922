import { evaluateCandidate } from "../utils/recommendation.js";
import { overlaps } from "../utils/time.js";
import { buildTaskFromRow } from "../utils/validator.js";
import { DEFAULT_TASK_STATUS } from "../config/scheduling-rules.js";

export function findConflictingExistingTasks(db, task) {
  const conflicts = [];
  for (const existing of db.tasks) {
    if (existing.status === "cancelled" || existing.status === "completed" || existing.status === "done") continue;
    if (!existing.tideWindow || !task.tideWindow) continue;
    if (existing.id === task.id) continue;
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
  if (conflict.conflictType === "id_duplicate") {
    return {
      type: "id_duplicate",
      description: `任务ID ${conflict.taskId} 与已有任务ID重复，确认提交时将更新已有任务（可设置 overwrite: false 跳过）`,
      suggestion: "overwrite_or_skip"
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

export function recommendForTask(db, task, limit = 3) {
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
      eligible: c.eligible,
      disqualifying: c.disqualifying,
      weightedScores: c.weightedScores,
      breakdown: c.breakdown
    })),
    topRecommendation: top[0] ? {
      pilotId: top[0].pilotId,
      name: top[0].name,
      score: top[0].totalScore,
      eligible: top[0].eligible,
      disqualifying: top[0].disqualifying,
      weightedScores: top[0].weightedScores,
      breakdown: top[0].breakdown
    } : null
  };
}

export function analyzeImportBatch(db, validRows, allRows, duplicateIdRowMap = new Map()) {
  const taskObjects = validRows.map((rowIndex) => {
    const row = allRows[rowIndex];
    const task = buildTaskFromRow(row);
    task.status = DEFAULT_TASK_STATUS;
    task.pilotId = null;
    return task;
  });

  const creatable = [];
  const updatable = [];
  const conflicting = [];

  for (let i = 0; i < validRows.length; i++) {
    const rowIndex = validRows[i];
    const task = taskObjects[i];

    const isIdDuplicate = duplicateIdRowMap.has(rowIndex);

    const existingConflicts = findConflictingExistingTasks(db, task);
    const batchConflicts = findConflictsWithinBatch(taskObjects, i);

    const idConflictList = [];
    if (isIdDuplicate) {
      const dupInfo = duplicateIdRowMap.get(rowIndex);
      const existingTask = db.tasks.find((t) => t.id === dupInfo.id);
      idConflictList.push({
        taskId: dupInfo.id,
        vesselName: existingTask?.vessel?.name || "未知",
        district: existingTask?.district || null,
        tideWindow: existingTask?.tideWindow || null,
        status: existingTask?.status || null,
        pilotId: existingTask?.pilotId || null,
        berthPlan: existingTask?.berthPlan || null,
        conflictType: "id_duplicate"
      });
    }

    const allConflicts = [...idConflictList, ...existingConflicts, ...batchConflicts.map((c) => ({ ...c, taskId: `row-${c.rowIndex}`, source: "batch" }))];

    const recommendation = recommendForTask(db, task, 3);

    const item = {
      rowIndex,
      task,
      idConflicts: idConflictList,
      existingConflicts,
      batchConflicts,
      hasConflict: allConflicts.length > 0,
      recommendation
    };

    const hasTimeDistrictConflict = existingConflicts.length > 0 || batchConflicts.length > 0;

    if (hasTimeDistrictConflict) {
      conflicting.push(item);
    } else if (isIdDuplicate) {
      updatable.push(item);
    } else {
      creatable.push(item);
    }
  }

  const pilotSummary = summarizePilotWorkload(db, taskObjects);
  const conflictSummary = summarizeConflicts(creatable, updatable, conflicting);

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
    updatable: updatable.map((item) => {
      const existingTask = db.tasks.find((t) => t.id === item.task.id);
      return {
        rowIndex: item.rowIndex,
        taskId: item.task.id,
        vesselName: item.task.vessel.name,
        district: item.task.district,
        tideWindow: item.task.tideWindow,
        topPilot: item.recommendation.topRecommendation,
        eligiblePilotCount: item.recommendation.totalEligible,
        existingTask: existingTask ? {
          id: existingTask.id,
          vesselName: existingTask.vessel?.name,
          district: existingTask.district,
          tideWindow: existingTask.tideWindow,
          status: existingTask.status,
          pilotId: existingTask.pilotId
        } : null
      };
    }),
    conflicting: conflicting.map((item) => {
      const allConflicts = [...item.idConflicts, ...item.existingConflicts, ...item.batchConflicts.map((c) => ({ ...c, taskId: `row-${c.rowIndex}`, source: "batch" }))];
      return {
        rowIndex: item.rowIndex,
        taskId: item.task.id,
        vesselName: item.task.vessel.name,
        district: item.task.district,
        tideWindow: item.task.tideWindow,
        conflictCount: allConflicts.length,
        idConflicts: item.idConflicts,
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
    updatableCount: updatable.length,
    conflictingCount: conflicting.length
  };
}

function summarizeConflicts(creatable, updatable, conflicting) {
  const districtConflictMap = new Map();
  for (const item of conflicting) {
    const district = item.task.district;
    if (!districtConflictMap.has(district)) {
      districtConflictMap.set(district, { district, conflictCount: 0, idConflictCount: 0, existingConflictCount: 0, batchConflictCount: 0 });
    }
    const stat = districtConflictMap.get(district);
    stat.conflictCount++;
    stat.idConflictCount += item.idConflicts?.length || 0;
    stat.existingConflictCount += item.existingConflicts.length;
    stat.batchConflictCount += item.batchConflicts.length;
  }

  const idDuplicateOnly = updatable.length;

  return {
    totalConflictingTasks: conflicting.length,
    totalUpdatableTasks: updatable.length,
    byDistrict: [...districtConflictMap.values()],
    totalIdConflicts: conflicting.reduce((sum, item) => sum + (item.idConflicts?.length || 0), 0) + updatable.length,
    totalExistingConflicts: conflicting.reduce((sum, item) => sum + item.existingConflicts.length, 0),
    totalBatchConflicts: conflicting.reduce((sum, item) => sum + item.batchConflicts.length, 0),
    canAutoCreate: creatable.length,
    canAutoUpdate: idDuplicateOnly,
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
