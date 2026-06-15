import { saveDb } from "../utils/db.js";
import {
  recordAuditEvent,
  getAuditEventById,
  getLatestRollbackableEvent,
  getAuditHistory,
  AUDIT_OBJECT_TYPES,
  AUDIT_ACTIONS,
  ROLLBACKABLE_ACTIONS
} from "./audit.js";

import { isActiveTaskStatus } from "../config/scheduling-rules.js";
import { overlaps as timeOverlaps } from "../utils/time.js";

function deepClone(obj) {
  return obj ? JSON.parse(JSON.stringify(obj)) : null;
}

function snapshotTask(task) {
  return {
    id: task.id,
    status: task.status,
    pilotId: task.pilotId,
    tideWindow: task.tideWindow ? { ...task.tideWindow } : null,
    berthPlan: task.berthPlan,
    vessel: task.vessel ? { ...task.vessel } : null,
    district: task.district,
    requiredGrade: task.requiredGrade,
    history: task.history ? [...task.history] : []
  };
}

const ROLLBACK_RESTORABLE_FIELDS = [
  "status",
  "pilotId",
  "tideWindow",
  "berthPlan",
  "district",
  "requiredGrade",
  "vessel"
];

const CONFLICT_SEVERITY = {
  WARNING: "warning",
  ERROR: "error",
  INFO: "info"
};

const CONFLICT_TYPES = {
  LATER_EVENT_OVERWRITE: "later_event_overwrite",
  PENDING_CHANGE_REQUEST: "pending_change_request",
  PILOT_TIME_CONFLICT: "pilot_time_conflict",
  LATER_IMPORT_UPDATE: "later_import_update",
  LATER_APPROVAL: "later_approval",
  LATER_ASSIGN: "later_assign",
  EVENT_INVALIDATED: "event_invalidated",
  FIELD_STALE: "field_stale"
};

function computeFieldsToRestore(currentTask, beforeState) {
  const fields = [];
  for (const field of ROLLBACK_RESTORABLE_FIELDS) {
    if (beforeState[field] !== undefined) {
      const currentVal = currentTask[field];
      const restoreVal = beforeState[field];
      const currentJson = JSON.stringify(currentVal);
      const restoreJson = JSON.stringify(restoreVal);
      if (currentJson !== restoreJson) {
        fields.push({
          field,
          currentValue: deepClone(currentVal),
          restoredValue: deepClone(restoreVal)
        });
      }
    }
  }
  return fields;
}

async function getSubsequentEvents(taskId, targetEventTime) {
  const history = await getAuditHistory({
    objectId: taskId,
    objectType: AUDIT_OBJECT_TYPES.TASK
  });
  return history.events.filter((e) => new Date(e.timestamp) > new Date(targetEventTime));
}

async function detectCrossScenarioConflicts(db, task, targetEvent, subsequentEvents) {
  const conflicts = [];
  const targetTime = new Date(targetEvent.timestamp);

  const laterImports = subsequentEvents.filter((e) =>
    [AUDIT_ACTIONS.IMPORT_UPDATE, AUDIT_ACTIONS.IMPORT_CREATE].includes(e.action)
  );
  if (laterImports.length > 0) {
    conflicts.push({
      type: CONFLICT_TYPES.LATER_IMPORT_UPDATE,
      severity: CONFLICT_SEVERITY.WARNING,
      detail: `目标事件后存在 ${laterImports.length} 条导入更新操作`,
      eventIds: laterImports.map((e) => e.id),
      actions: laterImports.map((e) => e.action)
    });
  }

  const laterApprovals = subsequentEvents.filter((e) => {
    if (e.action !== AUDIT_ACTIONS.UPDATE) return false;
    return e.note && e.note.includes("变更审批通过");
  });
  if (laterApprovals.length > 0) {
    conflicts.push({
      type: CONFLICT_TYPES.LATER_APPROVAL,
      severity: CONFLICT_SEVERITY.ERROR,
      detail: `目标事件后存在 ${laterApprovals.length} 条审批通过的变更`,
      eventIds: laterApprovals.map((e) => e.id)
    });
  }

  const laterAssigns = subsequentEvents.filter((e) => e.action === AUDIT_ACTIONS.ASSIGN);
  if (laterAssigns.length > 0) {
    conflicts.push({
      type: CONFLICT_TYPES.LATER_ASSIGN,
      severity: CONFLICT_SEVERITY.WARNING,
      detail: `目标事件后存在 ${laterAssigns.length} 条派单操作`,
      eventIds: laterAssigns.map((e) => e.id)
    });
  }

  const pendingCRs = db.changeRequests.filter(
    (cr) => cr.taskId === task.id && cr.status === "pending"
  );
  if (pendingCRs.length > 0) {
    conflicts.push({
      type: CONFLICT_TYPES.PENDING_CHANGE_REQUEST,
      severity: CONFLICT_SEVERITY.ERROR,
      detail: `任务存在 ${pendingCRs.length} 个待审批变更申请`,
      changeRequestIds: pendingCRs.map((cr) => cr.id),
      changeRequestTypes: pendingCRs.map((cr) => cr.type)
    });
  }

  const proposedRollback = {};
  if (targetEvent.before) {
    if (targetEvent.before.tideWindow !== undefined) proposedRollback.tideWindow = targetEvent.before.tideWindow;
    if (targetEvent.before.berthPlan !== undefined) proposedRollback.berthPlan = targetEvent.before.berthPlan;
    if (targetEvent.before.status !== undefined) proposedRollback.status = targetEvent.before.status;
  }

  if (Object.keys(proposedRollback).length > 0) {
    const simulatedTask = { ...task };
    if (proposedRollback.tideWindow !== undefined) simulatedTask.tideWindow = proposedRollback.tideWindow;
    if (proposedRollback.berthPlan !== undefined) simulatedTask.berthPlan = proposedRollback.berthPlan;
    if (proposedRollback.status !== undefined) simulatedTask.status = proposedRollback.status;

    const effectivePilotId = simulatedTask.pilotId || task.pilotId;
    const effectiveStatus = simulatedTask.status !== undefined ? simulatedTask.status : task.status;
    const effectiveTideWindow = simulatedTask.tideWindow || task.tideWindow;

    if (effectivePilotId && effectiveTideWindow && isActiveTaskStatus(effectiveStatus)) {
      const window = {
        start: effectiveTideWindow.start,
        end: effectiveTideWindow.end
      };
      const otherActive = db.tasks.filter((t) => {
        if (t.id === task.id) return false;
        if (t.pilotId !== effectivePilotId) return false;
        if (!isActiveTaskStatus(t.status)) return false;
        return true;
      });
      for (const other of otherActive) {
        if (
          other.tideWindow &&
          timeOverlaps(window.start, window.end, other.tideWindow.start, other.tideWindow.end)
        ) {
          conflicts.push({
            type: CONFLICT_TYPES.PILOT_TIME_CONFLICT,
            severity: CONFLICT_SEVERITY.ERROR,
            detail: `回滚后引航员 ${effectivePilotId} 与任务 ${other.id} 时间冲突`,
            pilotId: effectivePilotId,
            conflictingTaskId: other.id
          });
        }
      }
    }
  }

  if (targetEvent.before) {
    const overwriteEvents = subsequentEvents.filter((e) => {
      if (!ROLLBACKABLE_ACTIONS.includes(e.action)) return false;
      if (!e.after || !targetEvent.before) return false;
      for (const field of ROLLBACK_RESTORABLE_FIELDS) {
        if (targetEvent.before[field] !== undefined && e.after[field] !== undefined) {
          const beforeVal = JSON.stringify(targetEvent.before[field]);
          const afterVal = JSON.stringify(e.after[field]);
          if (beforeVal !== afterVal) return true;
        }
      }
      return false;
    });
    if (overwriteEvents.length > 0) {
      conflicts.push({
        type: CONFLICT_TYPES.FIELD_STALE,
        severity: CONFLICT_SEVERITY.WARNING,
        detail: `回滚目标字段被后续 ${overwriteEvents.length} 个事件修改过`,
        eventIds: overwriteEvents.map((e) => e.id),
        actions: overwriteEvents.map((e) => e.action)
      });
    }
  }

  return conflicts;
}

export async function previewTaskRollback(db, taskId, auditEventId = null) {
  const taskIndex = db.tasks.findIndex((t) => t.id === taskId);
  if (taskIndex === -1) {
    return { success: false, error: "task_not_found", message: "任务不存在" };
  }

  const task = db.tasks[taskIndex];

  let targetEvent = null;

  if (auditEventId) {
    targetEvent = await getAuditEventById(auditEventId);
    if (!targetEvent) {
      return { success: false, error: "audit_event_not_found", message: "审计事件不存在" };
    }
    if (targetEvent.objectType !== AUDIT_OBJECT_TYPES.TASK || targetEvent.objectId !== taskId) {
      return { success: false, error: "audit_event_mismatch", message: "审计事件与任务不匹配" };
    }
    if (!targetEvent.rollbackable) {
      return { success: false, error: "not_rollbackable", message: "该审计事件不可回滚" };
    }
  } else {
    targetEvent = await getLatestRollbackableEvent(taskId, AUDIT_OBJECT_TYPES.TASK);
    if (!targetEvent) {
      return { success: false, error: "no_rollbackable_event", message: "没有可回滚的审计事件" };
    }
  }

  if (!targetEvent.before) {
    return { success: false, error: "no_before_data", message: "没有回滚所需的前置数据" };
  }

  const subsequentEvents = await getSubsequentEvents(taskId, targetEvent.timestamp);

  const fieldsToRestore = computeFieldsToRestore(task, targetEvent.before);

  const crossConflicts = await detectCrossScenarioConflicts(db, task, targetEvent, subsequentEvents);

  const affectedChangeRequests = db.changeRequests.filter((cr) => cr.taskId === taskId);

  const errorConflicts = crossConflicts.filter((c) => c.severity === CONFLICT_SEVERITY.ERROR);
  const warningConflicts = crossConflicts.filter((c) => c.severity === CONFLICT_SEVERITY.WARNING);

  const requiresForce = errorConflicts.length > 0;
  const canRollback = fieldsToRestore.length > 0;

  const previewToken = Buffer.from(
    JSON.stringify({
      taskId,
      auditEventId: targetEvent.id,
      timestamp: new Date().toISOString(),
      checksum: fieldsToRestore.length
    })
  ).toString("base64");

  return {
    success: true,
    taskId,
    targetEvent: {
      id: targetEvent.id,
      action: targetEvent.action,
      note: targetEvent.note,
      timestamp: targetEvent.timestamp,
      operator: targetEvent.operator
    },
    fieldsToRestore,
    affectedChangeRequests: affectedChangeRequests.map((cr) => ({
      id: cr.id,
      type: cr.type,
      status: cr.status,
      createdAt: cr.createdAt
    })),
    conflicts: crossConflicts,
    conflictSummary: {
      total: crossConflicts.length,
      errors: errorConflicts.length,
      warnings: warningConflicts.length
    },
    requiresForce,
    canRollback,
    previewToken,
    previewedAt: new Date().toISOString()
  };
}

export async function rollbackTask(
  db, taskId, auditEventId = null, operator = null, note = null, force = false, previewToken = null
) {
  const taskIndex = db.tasks.findIndex((t) => t.id === taskId);
  if (taskIndex === -1) {
    return { success: false, error: "task_not_found", message: "任务不存在" };
  }

  const task = db.tasks[taskIndex];
  const beforeRollback = snapshotTask(task);

  let targetEvent = null;

  if (auditEventId) {
    targetEvent = await getAuditEventById(auditEventId);
    if (!targetEvent) {
      return { success: false, error: "audit_event_not_found", message: "审计事件不存在" };
    }
    if (targetEvent.objectType !== AUDIT_OBJECT_TYPES.TASK || targetEvent.objectId !== taskId) {
      return { success: false, error: "audit_event_mismatch", message: "审计事件与任务不匹配" };
    }
    if (!targetEvent.rollbackable) {
      return { success: false, error: "not_rollbackable", message: "该审计事件不可回滚" };
    }
  } else {
    targetEvent = await getLatestRollbackableEvent(taskId, AUDIT_OBJECT_TYPES.TASK);
    if (!targetEvent) {
      return { success: false, error: "no_rollbackable_event", message: "没有可回滚的审计事件" };
    }
  }

  if (!targetEvent.before) {
    return { success: false, error: "no_before_data", message: "没有回滚所需的前置数据" };
  }

  const subsequentEvents = await getSubsequentEvents(taskId, targetEvent.timestamp);
  const crossConflicts = await detectCrossScenarioConflicts(db, task, targetEvent, subsequentEvents);
  const errorConflicts = crossConflicts.filter((c) => c.severity === CONFLICT_SEVERITY.ERROR);

  if (errorConflicts.length > 0 && !force) {
    return {
      success: false,
      error: "rollback_conflicts",
      message: `存在 ${errorConflicts.length} 个严重冲突，需使用 force=true 强制执行`,
      conflicts: crossConflicts,
      requiresForce: true
    };
  }

  const beforeState = targetEvent.before;

  if (beforeState.status !== undefined) {
    task.status = beforeState.status;
  }
  if (beforeState.pilotId !== undefined) {
    task.pilotId = beforeState.pilotId;
  }
  if (beforeState.tideWindow !== undefined) {
    task.tideWindow = beforeState.tideWindow ? { ...beforeState.tideWindow } : null;
  }
  if (beforeState.berthPlan !== undefined) {
    task.berthPlan = beforeState.berthPlan;
  }
  if (beforeState.district !== undefined) {
    task.district = beforeState.district;
  }
  if (beforeState.requiredGrade !== undefined) {
    task.requiredGrade = beforeState.requiredGrade;
  }
  if (beforeState.vessel !== undefined) {
    task.vessel = beforeState.vessel ? { ...beforeState.vessel } : null;
  }

  task.history.push({
    at: new Date().toISOString(),
    action: "rollback",
    note: note || `回滚到审计事件 ${targetEvent.id}（原操作: ${targetEvent.action}）`
  });

  await saveDb(db);

  const affectedCRs = db.changeRequests.filter((cr) => cr.taskId === taskId);

  const rollbackEvent = await recordAuditEvent({
    objectType: AUDIT_OBJECT_TYPES.TASK,
    objectId: taskId,
    action: AUDIT_ACTIONS.ROLLBACK,
    before: beforeRollback,
    after: snapshotTask(task),
    operator,
    note: note || `回滚审计事件 ${targetEvent.id}（原操作: ${targetEvent.action}）`,
    rollbackable: false,
    relatedAuditId: targetEvent.id
  });

  const relatedAuditIds = [targetEvent.id];
  for (const cr of affectedCRs) {
    await recordAuditEvent({
      objectType: AUDIT_OBJECT_TYPES.CHANGE_REQUEST,
      objectId: cr.id,
      action: AUDIT_ACTIONS.RELATED_STATUS_CHANGE,
      before: null,
      after: {
        rollbackAuditId: rollbackEvent.id,
        rollbackFrom: targetEvent.id,
        conflictStatus: cr.status
      },
      operator,
      note: `任务 ${taskId} 回滚联动：变更申请 ${cr.id}`,
      rollbackable: false,
      relatedAuditId: rollbackEvent.id
    });
  }

  return {
    success: true,
    task: deepClone(task),
    rollbackEvent,
    rolledBackFrom: targetEvent,
    conflictsResolved: crossConflicts,
    forced: force === true,
    affectedChangeRequestIds: affectedCRs.map((cr) => cr.id),
    relatedAuditIds
  };
}

export async function rollbackTaskAssign(db, taskId, operator = null, note = null) {
  const taskIndex = db.tasks.findIndex((t) => t.id === taskId);
  if (taskIndex === -1) {
    return { success: false, error: "task_not_found", message: "任务不存在" };
  }

  const task = db.tasks[taskIndex];
  if (!task.pilotId) {
    return { success: false, error: "task_not_assigned", message: "任务未分配引航员，无需回滚" };
  }

  const pendingCRs = db.changeRequests.filter(
    (cr) => cr.taskId === taskId && cr.status === "pending"
  );

  const beforeRollback = snapshotTask(task);

  task.pilotId = null;
  task.status = "pending";

  task.history.push({
    at: new Date().toISOString(),
    action: "unassigned",
    note: note || "回滚派单，取消引航员分配"
  });

  await saveDb(db);

  const rollbackEvent = await recordAuditEvent({
    objectType: AUDIT_OBJECT_TYPES.TASK,
    objectId: taskId,
    action: AUDIT_ACTIONS.UNASSIGN,
    before: beforeRollback,
    after: snapshotTask(task),
    operator,
    note: note || "回滚派单，取消引航员分配",
    rollbackable: true
  });

  return {
    success: true,
    task: deepClone(task),
    rollbackEvent,
    affectedChangeRequestIds: pendingCRs.map((cr) => cr.id)
  };
}

export async function rollbackTaskStatus(db, taskId, operator = null, note = null, force = false) {
  const taskIndex = db.tasks.findIndex((t) => t.id === taskId);
  if (taskIndex === -1) {
    return { success: false, error: "task_not_found", message: "任务不存在" };
  }

  const latestEvent = await getLatestRollbackableEvent(taskId, AUDIT_OBJECT_TYPES.TASK);
  if (!latestEvent || !latestEvent.before || latestEvent.before.status === undefined) {
    return { success: false, error: "no_rollbackable_status", message: "没有可回滚的状态变更" };
  }

  const task = db.tasks[taskIndex];

  const pendingCRs = db.changeRequests.filter(
    (cr) => cr.taskId === taskId && cr.status === "pending"
  );
  if (pendingCRs.length > 0 && !force) {
    return {
      success: false,
      error: "pending_change_requests",
      message: `任务存在待审批变更申请，需 force=true 强制执行`,
      changeRequestIds: pendingCRs.map((cr) => cr.id),
      requiresForce: true
    };
  }

  const beforeRollback = snapshotTask(task);

  const previousStatus = latestEvent.before.status;
  task.status = previousStatus;

  task.history.push({
    at: new Date().toISOString(),
    action: "rollback_status",
    note: note || `回滚状态到 ${previousStatus}`
  });

  await saveDb(db);

  const rollbackEvent = await recordAuditEvent({
    objectType: AUDIT_OBJECT_TYPES.TASK,
    objectId: taskId,
    action: AUDIT_ACTIONS.ROLLBACK,
    before: beforeRollback,
    after: snapshotTask(task),
    operator,
    note: note || `回滚状态到 ${previousStatus}`,
    rollbackable: false,
    relatedAuditId: latestEvent.id
  });

  return {
    success: true,
    task: deepClone(task),
    rollbackEvent,
    rolledBackFrom: latestEvent,
    affectedChangeRequestIds: pendingCRs.map((cr) => cr.id)
  };
}

export function getRollbackableActionTypes() {
  return [
    { action: AUDIT_ACTIONS.ASSIGN, objectType: AUDIT_OBJECT_TYPES.TASK, description: "任务派单" },
    { action: AUDIT_ACTIONS.STATUS_CHANGE, objectType: AUDIT_OBJECT_TYPES.TASK, description: "任务状态更新" },
    { action: AUDIT_ACTIONS.UPDATE, objectType: AUDIT_OBJECT_TYPES.TASK, description: "任务信息更新" },
    { action: AUDIT_ACTIONS.IMPORT_UPDATE, objectType: AUDIT_OBJECT_TYPES.TASK, description: "导入更新（不可直接回滚，需通过关联事件）" }
  ];
}

export { CONFLICT_TYPES, CONFLICT_SEVERITY, ROLLBACK_RESTORABLE_FIELDS };
