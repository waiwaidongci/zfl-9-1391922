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
  previewTaskRollback,
  validatePreviewToken,
  getRollbackableActionTypes,
  getPreviewTokenConfig,
  CONFLICT_TYPES,
  CONFLICT_SEVERITY
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

export async function handleTaskRollbackPreview(db, taskId, input, send, res) {
  const task = db.tasks.find((t) => t.id === taskId);
  if (!task) return send(res, 404, { error: "task_not_found" });

  const auditEventId = input && input.auditEventId ? input.auditEventId : null;

  const result = await previewTaskRollback(db, taskId, auditEventId);

  if (!result.success) {
    const statusMap = {
      task_not_found: 404,
      audit_event_not_found: 404,
      audit_event_mismatch: 400,
      not_rollbackable: 400,
      no_rollbackable_event: 404,
      no_before_data: 400
    };
    return send(res, statusMap[result.error] || 400, { error: result.error, message: result.message });
  }

  return send(res, 200, result);
}

export async function handleTaskRollbackRecheck(db, taskId, input, send, res) {
  const task = db.tasks.find((t) => t.id === taskId);
  if (!task) return send(res, 404, { error: "task_not_found" });

  const auditEventId = input && input.auditEventId ? input.auditEventId : null;

  const result = await previewTaskRollback(db, taskId, auditEventId);

  if (!result.success) {
    const statusMap = {
      task_not_found: 404,
      audit_event_not_found: 404,
      audit_event_mismatch: 400,
      not_rollbackable: 400,
      no_rollbackable_event: 404,
      no_before_data: 400
    };
    return send(res, statusMap[result.error] || 400, { error: result.error, message: result.message });
  }

  return send(res, 200, {
    taskId,
    auditEventId: result.targetEvent?.id || null,
    recheckedAt: new Date().toISOString(),
    conflicts: result.conflicts,
    conflictSummary: result.conflictSummary,
    requiresForce: result.requiresForce,
    canRollback: result.canRollback
  });
}

export async function handleTaskRollback(db, taskId, input, send, res) {
  const task = db.tasks.find((t) => t.id === taskId);
  if (!task) return send(res, 404, { error: "task_not_found" });

  const auditEventId = input && input.auditEventId ? input.auditEventId : null;
  const operator = input && input.operator ? input.operator : null;
  const note = input && input.note ? input.note : null;
  const force = input && input.force === true;
  const previewToken = input && input.previewToken ? input.previewToken : null;

  const result = await rollbackTask(db, taskId, auditEventId, operator, note, force, previewToken);

  if (!result.success) {
    if (result.error === "rollback_conflicts") {
      return send(res, 409, {
        error: result.error,
        message: result.message,
        conflicts: result.conflicts,
        requiresForce: result.requiresForce
      });
    }
    if (result.error === "preview_token_expired") {
      return send(res, 410, {
        error: result.error,
        message: result.message,
        expiresAt: result.expiresAt,
        ageMs: result.ageMs,
        requiresRecheck: result.requiresRecheck
      });
    }
    if (result.error && result.error.startsWith("preview_token_")) {
      return send(res, 400, {
        error: result.error,
        message: result.message,
        expiresAt: result.expiresAt,
        ageMs: result.ageMs,
        requiresRecheck: result.requiresRecheck
      });
    }
    const statusMap = {
      task_not_found: 404,
      audit_event_not_found: 404,
      audit_event_mismatch: 400,
      not_rollbackable: 400,
      no_rollbackable_event: 404,
      no_before_data: 400,
      pending_change_requests: 409
    };
    return send(res, statusMap[result.error] || 400, {
      error: result.error,
      message: result.message,
      ...(result.requiresForce !== undefined && { requiresForce: result.requiresForce }),
      ...(result.changeRequestIds && { changeRequestIds: result.changeRequestIds })
    });
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
    const statusMap = {
      task_not_found: 404,
      task_not_assigned: 400
    };
    return send(res, statusMap[result.error] || 400, { error: result.error, message: result.message });
  }

  return send(res, 200, result);
}

export async function handleTaskRollbackStatus(db, taskId, input, send, res) {
  const task = db.tasks.find((t) => t.id === taskId);
  if (!task) return send(res, 404, { error: "task_not_found" });

  const operator = input && input.operator ? input.operator : null;
  const note = input && input.note ? input.note : null;
  const force = input && input.force === true;

  const result = await rollbackTaskStatus(db, taskId, operator, note, force);

  if (!result.success) {
    if (result.error === "pending_change_requests") {
      return send(res, 409, {
        error: result.error,
        message: result.message,
        changeRequestIds: result.changeRequestIds,
        requiresForce: result.requiresForce
      });
    }
    const statusMap = {
      task_not_found: 404,
      no_rollbackable_status: 404
    };
    return send(res, statusMap[result.error] || 400, { error: result.error, message: result.message });
  }

  return send(res, 200, result);
}

export function handleRollbackableTypes(send, res) {
  return send(res, 200, {
    objectTypes: Object.values(AUDIT_OBJECT_TYPES),
    actions: Object.values(AUDIT_ACTIONS),
    rollbackableTypes: getRollbackableActionTypes(),
    conflictTypes: CONFLICT_TYPES,
    conflictSeverity: CONFLICT_SEVERITY,
    previewToken: getPreviewTokenConfig()
  });
}
