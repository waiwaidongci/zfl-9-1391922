import { saveDb } from "../utils/db.js";
import {
  recordAuditEvent,
  getAuditEventById,
  getLatestRollbackableEvent,
  AUDIT_OBJECT_TYPES,
  AUDIT_ACTIONS
} from "./audit.js";

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

export async function rollbackTask(db, taskId, auditEventId = null, operator = null, note = null) {
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

  task.history.push({
    at: new Date().toISOString(),
    action: "rollback",
    note: note || `回滚到审计事件 ${targetEvent.id}（原操作: ${targetEvent.action}）`
  });

  await saveDb(db);

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

  return {
    success: true,
    task: deepClone(task),
    rollbackEvent,
    rolledBackFrom: targetEvent
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
    rollbackEvent
  };
}

export async function rollbackTaskStatus(db, taskId, operator = null, note = null) {
  const taskIndex = db.tasks.findIndex((t) => t.id === taskId);
  if (taskIndex === -1) {
    return { success: false, error: "task_not_found", message: "任务不存在" };
  }

  const latestEvent = await getLatestRollbackableEvent(taskId, AUDIT_OBJECT_TYPES.TASK);
  if (!latestEvent || !latestEvent.before || latestEvent.before.status === undefined) {
    return { success: false, error: "no_rollbackable_status", message: "没有可回滚的状态变更" };
  }

  const task = db.tasks[taskIndex];
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
    rolledBackFrom: latestEvent
  };
}

export function getRollbackableActionTypes() {
  return [
    { action: AUDIT_ACTIONS.ASSIGN, objectType: AUDIT_OBJECT_TYPES.TASK, description: "任务派单" },
    { action: AUDIT_ACTIONS.STATUS_CHANGE, objectType: AUDIT_OBJECT_TYPES.TASK, description: "任务状态更新" },
    { action: AUDIT_ACTIONS.UPDATE, objectType: AUDIT_OBJECT_TYPES.TASK, description: "任务信息更新" }
  ];
}
