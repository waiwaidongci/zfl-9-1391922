import { loadAuditLog, saveAuditLog } from "../utils/db.js";

export const AUDIT_OBJECT_TYPES = {
  PILOT: "pilot",
  TASK: "task",
  CHANGE_REQUEST: "changeRequest",
  DRAFT: "draft",
  LEAVE: "leaveRecord",
  IMPORT_SESSION: "importSession"
};

export const AUDIT_ACTIONS = {
  CREATE: "create",
  UPDATE: "update",
  DELETE: "delete",
  ASSIGN: "assign",
  UNASSIGN: "unassign",
  STATUS_CHANGE: "status_change",
  APPROVE: "approve",
  REJECT: "reject",
  RECHECK: "recheck",
  SUBMIT: "submit",
  CANCEL: "cancel",
  ROLLBACK: "rollback",
  IMPORT_CREATE: "import_create",
  IMPORT_UPDATE: "import_update",
  LEAVE_IMPACT: "leave_impact",
  LEAVE_RECOVERY: "leave_recovery",
  AUTO_REJECT: "auto_reject",
  SUPERSEDE: "supersede",
  RELATED_STATUS_CHANGE: "related_status_change"
};

export const ROLLBACKABLE_ACTIONS = [
  AUDIT_ACTIONS.ASSIGN,
  AUDIT_ACTIONS.STATUS_CHANGE,
  AUDIT_ACTIONS.UPDATE
];

let _auditEventLock = Promise.resolve();

function generateAuditId() {
  return `AUD-${Date.now()}-${Math.random().toString(36).slice(2, 8).toUpperCase()}`;
}

function deepClone(obj) {
  return obj ? JSON.parse(JSON.stringify(obj)) : null;
}

export async function recordAuditEvent({
  objectType,
  objectId,
  action,
  before = null,
  after = null,
  operator = null,
  note = null,
  rollbackable = false,
  relatedAuditId = null
}) {
  const prevLock = _auditEventLock;
  let releaseLock;
  _auditEventLock = new Promise((resolve) => {
    releaseLock = resolve;
  });
  try {
    await prevLock;
    const auditLog = await loadAuditLog();

    const event = {
      id: generateAuditId(),
      objectType,
      objectId,
      action,
      before: deepClone(before),
      after: deepClone(after),
      operator,
      note,
      rollbackable,
      relatedAuditId,
      timestamp: new Date().toISOString()
    };

    auditLog.events.push(event);
    await saveAuditLog(auditLog);

    return event;
  } finally {
    releaseLock();
  }
}

export async function getAuditHistory({ objectId, objectType, action, limit = 50, offset = 0 } = {}) {
  const auditLog = await loadAuditLog();
  let events = [...auditLog.events];

  if (objectId) {
    events = events.filter((e) => e.objectId === objectId);
  }
  if (objectType) {
    events = events.filter((e) => e.objectType === objectType);
  }
  if (action) {
    events = events.filter((e) => e.action === action);
  }

  events.sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));

  const total = events.length;
  const paginated = events.slice(offset, offset + limit);

  return {
    total,
    offset,
    limit,
    events: paginated
  };
}

export async function getAuditEventById(auditId) {
  const auditLog = await loadAuditLog();
  return auditLog.events.find((e) => e.id === auditId) || null;
}

export async function getPreviousRollbackableEvent(objectId, objectType, beforeAuditId = null) {
  const auditLog = await loadAuditLog();
  let events = auditLog.events.filter(
    (e) => e.objectId === objectId && e.objectType === objectType && e.rollbackable === true
  );

  if (beforeAuditId) {
    const beforeEvent = events.find((e) => e.id === beforeAuditId);
    if (beforeEvent) {
      const beforeTime = new Date(beforeEvent.timestamp).getTime();
      events = events.filter((e) => new Date(e.timestamp).getTime() < beforeTime);
    }
  }

  events.sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));
  return events[0] || null;
}

export async function getLatestRollbackableEvent(objectId, objectType) {
  return getPreviousRollbackableEvent(objectId, objectType);
}
