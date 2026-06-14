import { createSimulationSnapshot, addSimTask, assignSimTask } from "./model.js";
import { evaluateSimCandidate, rankCandidates } from "./rule-engine.js";
import { explainUnassigned } from "./conflict-detector.js";
import { isActiveTaskStatus, ASSIGNED_TASK_STATUS } from "../../config/scheduling-rules.js";
import { pilotFitsCheck } from "../../utils/recommendation.js";
import { saveDb } from "../../utils/db.js";
import { recordAuditEvent, AUDIT_OBJECT_TYPES, AUDIT_ACTIONS } from "../audit.js";

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
    const candidates = rankCandidates(snapshot, task);
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

function addHistory(task, action, note) {
  task.history.push({ at: new Date().toISOString(), action, note });
}

function validateAssignmentLogEntry(entry, index) {
  const errors = [];
  if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
    return { valid: false, errors: [{ code: "invalid_entry_format", message: `第 ${index} 条日志数据格式错误` }] };
  }
  if (entry.taskId === undefined || entry.taskId === null || typeof entry.taskId !== "string" || entry.taskId.trim() === "") {
    errors.push({ code: "missing_task_id", message: `第 ${index} 条日志缺少有效的 taskId` });
  }
  if (entry.pilotId === undefined || entry.pilotId === null || typeof entry.pilotId !== "string" || entry.pilotId.trim() === "") {
    errors.push({ code: "missing_pilot_id", message: `第 ${index} 条日志缺少有效的 pilotId` });
  }
  return { valid: errors.length === 0, errors };
}

export async function submitSimulationAssignments(db, { assignmentLog = [], operator = null, note = null } = {}) {
  if (!Array.isArray(assignmentLog)) {
    return {
      success: false,
      summary: { total: 0, succeeded: 0, failed: 0, skipped: 0 },
      succeeded: [],
      failed: [],
      error: "invalid_assignment_log",
      message: "assignmentLog 必须为数组"
    };
  }

  if (assignmentLog.length === 0) {
    return {
      success: false,
      summary: { total: 0, succeeded: 0, failed: 0, skipped: 0 },
      succeeded: [],
      failed: [],
      error: "empty_assignment_log",
      message: "assignmentLog 不能为空"
    };
  }

  if (assignmentLog.length > 200) {
    return {
      success: false,
      summary: { total: assignmentLog.length, succeeded: 0, failed: 0, skipped: 0 },
      succeeded: [],
      failed: [],
      error: "too_many_entries",
      message: "单次提交不能超过200条"
    };
  }

  const formatValidationErrors = [];
  for (let i = 0; i < assignmentLog.length; i++) {
    const entry = assignmentLog[i];
    const v = validateAssignmentLogEntry(entry, i);
    if (!v.valid) {
      formatValidationErrors.push({
        index: i,
        taskId: entry?.taskId || null,
        errors: v.errors
      });
    }
  }

  if (formatValidationErrors.length > 0) {
    return {
      success: false,
      summary: { total: assignmentLog.length, succeeded: 0, failed: formatValidationErrors.length, skipped: assignmentLog.length - formatValidationErrors.length },
      succeeded: [],
      failed: formatValidationErrors.map((e) => ({
        taskId: e.taskId,
        index: e.index,
        code: "format_validation_failed",
        message: e.errors.map((er) => er.message).join("; "),
        detail: e.errors
      })),
      error: "format_validation_failed",
      message: "日志条目格式校验失败"
    };
  }

  const seenTaskIds = new Set();
  const duplicateEntries = [];
  for (let i = 0; i < assignmentLog.length; i++) {
    const entry = assignmentLog[i];
    if (seenTaskIds.has(entry.taskId)) {
      duplicateEntries.push({
        taskId: entry.taskId,
        index: i,
        code: "duplicate_task_in_batch",
        message: `批次内存在重复的任务ID: ${entry.taskId}`
      });
    } else {
      seenTaskIds.add(entry.taskId);
    }
  }

  const succeeded = [];
  const failed = [...duplicateEntries];
  const duplicateTaskIdSet = new Set(duplicateEntries.map((d) => d.taskId));

  const processedTaskIds = new Set();
  const auditEvents = [];

  for (let i = 0; i < assignmentLog.length; i++) {
    const entry = assignmentLog[i];
    if (duplicateTaskIdSet.has(entry.taskId)) continue;

    const task = db.tasks.find((t) => t.id === entry.taskId);
    if (!task) {
      failed.push({
        taskId: entry.taskId,
        pilotId: entry.pilotId,
        index: i,
        code: "task_not_found",
        message: `任务不存在: ${entry.taskId}`
      });
      continue;
    }

    if (task.status === "cancelled" || task.status === "done" || task.status === "completed") {
      failed.push({
        taskId: entry.taskId,
        pilotId: entry.pilotId,
        index: i,
        code: "task_terminal_state",
        message: `任务已处于终态(${task.status})，无法分配`,
        detail: { currentStatus: task.status }
      });
      continue;
    }

    const pilot = db.pilots.find((p) => p.id === entry.pilotId);
    if (!pilot) {
      failed.push({
        taskId: entry.taskId,
        pilotId: entry.pilotId,
        index: i,
        code: "pilot_not_found",
        message: `引航员不存在: ${entry.pilotId}`
      });
      continue;
    }

    if (task.pilotId === entry.pilotId && task.status === ASSIGNED_TASK_STATUS) {
      failed.push({
        taskId: entry.taskId,
        pilotId: entry.pilotId,
        index: i,
        code: "already_assigned_same_pilot",
        message: `任务已分配给该引航员(${pilot.name})，无需重复提交`,
        detail: { pilotName: pilot.name, currentStatus: task.status }
      });
      continue;
    }

    const fit = pilotFitsCheck(db, pilot, task, task.id);
    if (!fit.ok) {
      failed.push({
        taskId: entry.taskId,
        pilotId: entry.pilotId,
        index: i,
        code: "pilot_not_available",
        message: `引航员(${pilot.name})当前不满足分配条件`,
        detail: {
          pilotName: pilot.name,
          reasons: fit.reasons,
          disqualifying: fit.disqualifying,
          breakdown: fit.breakdown
        }
      });
      continue;
    }

    const beforeSnapshot = JSON.parse(JSON.stringify(task));
    const previousPilotId = task.pilotId;
    const previousStatus = task.status;

    task.pilotId = pilot.id;
    task.status = ASSIGNED_TASK_STATUS;
    const assignNote = note || `仿真提交：分配给${pilot.name}`;
    addHistory(task, "assigned", assignNote);

    auditEvents.push({
      objectType: AUDIT_OBJECT_TYPES.TASK,
      objectId: task.id,
      action: AUDIT_ACTIONS.ASSIGN,
      before: beforeSnapshot,
      after: task,
      operator,
      note: assignNote,
      rollbackable: true
    });

    succeeded.push({
      taskId: task.id,
      pilotId: pilot.id,
      pilotName: pilot.name,
      index: i,
      previousPilotId,
      previousStatus,
      currentStatus: task.status
    });

    processedTaskIds.add(task.id);
  }

  if (succeeded.length > 0) {
    await saveDb(db);

    for (const evt of auditEvents) {
      try {
        await recordAuditEvent(evt);
      } catch (auditErr) {
        console.warn(`[submitSimulationAssignments] 审计写入失败 taskId=${evt.objectId}: ${auditErr.message}`);
      }
    }
  }

  const total = assignmentLog.length;
  const succeededCount = succeeded.length;
  const failedCount = failed.length;
  const skippedCount = total - succeededCount - failedCount;

  const overallSuccess = failedCount === 0 && succeededCount > 0;

  return {
    success: overallSuccess,
    partialSuccess: succeededCount > 0 && failedCount > 0,
    summary: {
      total,
      succeeded: succeededCount,
      failed: failedCount,
      skipped: skippedCount
    },
    succeeded,
    failed
  };
}
