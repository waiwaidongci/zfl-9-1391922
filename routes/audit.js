import {
  getAuditHistory,
  getAuditEventById,
  getLatestRollbackableEvent,
  AUDIT_OBJECT_TYPES,
  AUDIT_ACTIONS
} from "../services/audit.js";
import {
  rollbackTask,
  rollbackTaskAssign,
  rollbackTaskStatus,
  getRollbackableActionTypes
} from "../services/rollback.js";

export function handleAuditHistory(db, searchParams, send, res) {
  const objectId = searchParams.get("objectId");
  const objectType = searchParams.get("objectType");
  const action = searchParams.get("action");
  const limit = parseInt(searchParams.get("limit") || "50", 10);
  const offset = parseInt(searchParams.get("offset") || "0", 10);

  return getAuditHistory({ objectId, objectType, action, limit, offset }).then((result) =>
    send(res, 200, result)
  );
}

export function handleAuditEventDetail(db, auditId, send, res) {
  return getAuditEventById(auditId).then((event) => {
    if (!event) return send(res, 404, { error: "audit_event_not_found" });
    return send(res, 200, event);
  });
}

export function handleAuditLatestRollbackable(db, objectType, objectId, send, res) {
  return getLatestRollbackableEvent(objectId, objectType).then((event) => {
    if (!event) return send(res, 404, { error: "no_rollbackable_event", message: "没有可回滚的审计事件" });
    return send(res, 200, event);
  });
}

export async function handleTaskRollback(db, taskId, input, send, res) {
  const task = db.tasks.find((t) => t.id === taskId);
  if (!task) return send(res, 404, { error: "task_not_found" });

  const auditEventId = input && input.auditEventId ? input.auditEventId : null;
  const operator = input && input.operator ? input.operator : null;
  const note = input && input.note ? input.note : null;

  const result = await rollbackTask(db, taskId, auditEventId, operator, note);

  if (!result.success) {
    return send(res, 400, { error: result.error, message: result.message });
  }

  return send(res, 200, result);
}

export async function handleTaskRollbackAssign(db, taskId, input, send, res) {
  const task = db.tasks.find((t) => t.id === taskId);
  if (!task) return send(res, 404, { error: "task_not_found" });

  const operator = input && input.operator ? input.operator : null;
  const note = input && input.note ? input.note : null;

  const result = await rollbackTaskAssign(db, taskId, operator, note);

  if (!result.success) {
    return send(res, 400, { error: result.error, message: result.message });
  }

  return send(res, 200, result);
}

export async function handleTaskRollbackStatus(db, taskId, input, send, res) {
  const task = db.tasks.find((t) => t.id === taskId);
  if (!task) return send(res, 404, { error: "task_not_found" });

  const operator = input && input.operator ? input.operator : null;
  const note = input && input.note ? input.note : null;

  const result = await rollbackTaskStatus(db, taskId, operator, note);

  if (!result.success) {
    return send(res, 400, { error: result.error, message: result.message });
  }

  return send(res, 200, result);
}

export function handleRollbackableTypes(send, res) {
  return send(res, 200, {
    objectTypes: Object.values(AUDIT_OBJECT_TYPES),
    actions: Object.values(AUDIT_ACTIONS),
    rollbackableTypes: getRollbackableActionTypes()
  });
}
