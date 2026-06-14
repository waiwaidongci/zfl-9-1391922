import { saveDb } from "../utils/db.js";
import {
  DEFAULT_CHANGE_REQUEST_STATUS,
  ASSIGNED_TASK_STATUS,
  isValidChangeRequestType,
  CHANGE_REQUEST_TYPES,
  isActiveTaskStatus,
  PENDING_REQUEST_POLICIES,
  DEFAULT_PENDING_REQUEST_POLICY,
  isValidPendingRequestPolicy
} from "../config/scheduling-rules.js";
import { overlaps as timeOverlaps } from "../utils/time.js";
import { recordAuditEvent, AUDIT_OBJECT_TYPES, AUDIT_ACTIONS } from "../services/audit.js";

function addHistory(task, action, note) {
  task.history.push({ at: new Date().toISOString(), action, note });
}

function detectChangeType(input) {
  if (input.status === "cancelled") return "cancel";
  if (input.tideWindow) return "tide_window";
  if (input.berthPlan) return "berth_plan";
  return "other";
}

function snapshotTask(task) {
  return {
    status: task.status,
    tideWindow: task.tideWindow ? { ...task.tideWindow } : null,
    berthPlan: task.berthPlan,
    pilotId: task.pilotId
  };
}

export function checkConflicts(db, task, proposedChanges, excludeChangeRequestId) {
  const conflicts = [];
  const effectiveTask = { ...task };
  if (proposedChanges.tideWindow) effectiveTask.tideWindow = proposedChanges.tideWindow;
  if (proposedChanges.berthPlan) effectiveTask.berthPlan = proposedChanges.berthPlan;

  const pendingSameTask = db.changeRequests.filter((cr) => {
    if (excludeChangeRequestId && cr.id === excludeChangeRequestId) return false;
    return cr.taskId === task.id && cr.status === "pending";
  });
  if (pendingSameTask.length > 0) {
    conflicts.push({
      type: "pending_request_conflict",
      conflictingChangeRequestIds: pendingSameTask.map((cr) => cr.id),
      detail: `存在待审批的同任务变更申请：${pendingSameTask.map((cr) => cr.id).join(", ")}`
    });
  }

  if (proposedChanges.status === "cancelled") return { ok: conflicts.length === 0, conflicts };

  if (effectiveTask.tideWindow && task.pilotId) {
    const window = { start: effectiveTask.tideWindow.start, end: effectiveTask.tideWindow.end };
    const otherActive = db.tasks.filter((t) => {
      if (t.id === task.id) return false;
      if (t.pilotId !== task.pilotId) return false;
      if (!isActiveTaskStatus(t.status)) return false;
      return true;
    });
    for (const other of otherActive) {
      if (timeOverlaps(window.start, window.end, other.tideWindow.start, other.tideWindow.end)) {
        conflicts.push({
          type: "pilot_time_conflict",
          pilotId: task.pilotId,
          conflictingTaskId: other.id,
          detail: `引航员时间冲突：任务${other.id}(${other.tideWindow.start} ~ ${other.tideWindow.end})`
        });
      }
    }
  }

  if (effectiveTask.tideWindow && effectiveTask.berthPlan) {
    const berthConflicts = db.tasks.filter((t) => {
      if (t.id === task.id) return false;
      if (!t.berthPlan || t.berthPlan !== effectiveTask.berthPlan) return false;
      if (!isActiveTaskStatus(t.status)) return false;
      return true;
    });
    for (const other of berthConflicts) {
      if (timeOverlaps(
        effectiveTask.tideWindow.start,
        effectiveTask.tideWindow.end,
        other.tideWindow.start,
        other.tideWindow.end
      )) {
        conflicts.push({
          type: "berth_time_conflict",
          berthPlan: effectiveTask.berthPlan,
          conflictingTaskId: other.id,
          detail: `泊位时间冲突：任务${other.id}占用${effectiveTask.berthPlan}(${other.tideWindow.start} ~ ${other.tideWindow.end})`
        });
      }
    }
  }

  return { ok: conflicts.length === 0, conflicts };
}

export function handleChangeRequestList(db, searchParams, send, res) {
  let list = db.changeRequests;
  const status = searchParams.get("status");
  const taskId = searchParams.get("taskId");
  const type = searchParams.get("type");
  if (status) list = list.filter((cr) => cr.status === status);
  if (taskId) list = list.filter((cr) => cr.taskId === taskId);
  if (type) list = list.filter((cr) => cr.type === type);
  return send(res, 200, list);
}

export function handleChangeRequestDetail(db, id, send, res) {
  const cr = db.changeRequests.find((item) => item.id === id);
  if (!cr) return send(res, 404, { error: "change_request_not_found" });
  return send(res, 200, cr);
}

export function handleChangeRequestCreate(db, taskId, input, send, res) {
  const task = db.tasks.find((t) => t.id === taskId);
  if (!task) return send(res, 404, { error: "task_not_found" });
  if (task.status !== ASSIGNED_TASK_STATUS) {
    return send(res, 409, { error: "task_not_assigned", detail: "仅已分配(assigned)状态的任务需要走变更审批流程" });
  }
  const hasChange = input.tideWindow !== undefined || input.berthPlan !== undefined || input.status === "cancelled";
  if (!hasChange) {
    return send(res, 422, { error: "no_change_detected", detail: "变更申请需包含潮汐窗口、泊位计划或取消操作" });
  }
  if (input.status !== undefined && input.status !== "cancelled") {
    return send(res, 422, { error: "invalid_status_change", detail: "变更审批仅支持取消(cancelled)，其他状态变更请直接操作" });
  }
  const type = input.changeType || detectChangeType(input);
  if (!isValidChangeRequestType(type)) {
    return send(res, 422, { error: "invalid_change_type", detail: `类型必须为: ${CHANGE_REQUEST_TYPES.join(", ")}` });
  }

  const policy = input.pendingRequestPolicy || DEFAULT_PENDING_REQUEST_POLICY;
  if (!isValidPendingRequestPolicy(policy)) {
    return send(res, 422, { error: "invalid_policy", detail: `策略必须为: ${PENDING_REQUEST_POLICIES.join(", ")}` });
  }

  const pendingSameTask = db.changeRequests.filter((cr) => cr.taskId === task.id && cr.status === "pending");

  if (pendingSameTask.length > 0 && policy === "block") {
    return send(res, 409, {
      error: "pending_request_blocked",
      detail: `该任务已有 ${pendingSameTask.length} 个待审批变更申请，需先处理后再提交新申请`,
      pendingChangeRequestIds: pendingSameTask.map((cr) => cr.id)
    });
  }

  const proposedChanges = {};
  if (input.tideWindow !== undefined) proposedChanges.tideWindow = input.tideWindow;
  if (input.berthPlan !== undefined) proposedChanges.berthPlan = input.berthPlan;
  if (input.status !== undefined) proposedChanges.status = input.status;

  const conflictCheck = checkConflicts(db, task, proposedChanges);

  const auditPromises = [];
  let supersededIds = [];

  if (pendingSameTask.length > 0 && policy === "reject_existing") {
    const now = new Date().toISOString();
    supersededIds = pendingSameTask.map((cr) => cr.id);
    for (const oldCr of pendingSameTask) {
      const beforeSnapshot = JSON.parse(JSON.stringify(oldCr));
      oldCr.status = "superseded";
      oldCr.reason = `被新申请取代，策略: reject_existing`;
      oldCr.reviewedAt = now;
      oldCr.supersededBy = null;
      auditPromises.push(
        recordAuditEvent({
          objectType: AUDIT_OBJECT_TYPES.CHANGE_REQUEST,
          objectId: oldCr.id,
          action: AUDIT_ACTIONS.SUPERSEDE,
          before: beforeSnapshot,
          after: oldCr,
          operator: input.applicant || null,
          note: `同任务待审批治理：新申请创建，旧申请被取代，策略 reject_existing`,
          rollbackable: false
        })
      );
    }
    addHistory(
      task,
      "change_superseded",
      `同任务待审批治理：${pendingSameTask.length}个待审批申请被取代：${supersededIds.join(", ")}，策略: reject_existing`
    );
  }

  const now = new Date().toISOString();
  const cr = {
    id: input.id || `CR-${Date.now()}`,
    taskId: task.id,
    type,
    original: snapshotTask(task),
    proposed: proposedChanges,
    status: DEFAULT_CHANGE_REQUEST_STATUS,
    reason: null,
    applicant: input.applicant || null,
    approver: null,
    note: input.note || null,
    pendingRequestPolicy: policy,
    supersededChangeRequestIds: supersededIds.length > 0 ? supersededIds : null,
    conflictCheck,
    createdAt: now,
    reviewedAt: null
  };

  for (const oldCr of pendingSameTask) {
    if (oldCr.status === "superseded") {
      oldCr.supersededBy = cr.id;
    }
  }

  db.changeRequests.push(cr);
  return saveDb(db).then(() => {
    const createAuditPromise = recordAuditEvent({
      objectType: AUDIT_OBJECT_TYPES.CHANGE_REQUEST,
      objectId: cr.id,
      action: AUDIT_ACTIONS.CREATE,
      after: cr,
      operator: input.applicant || null,
      note: input.note || `创建变更申请 (策略: ${policy}${supersededIds.length > 0 ? `，取代 ${supersededIds.length} 个待审批申请` : ""})`,
      rollbackable: false
    });

    const relatedTaskAuditPromise = supersededIds.length > 0
      ? recordAuditEvent({
          objectType: AUDIT_OBJECT_TYPES.TASK,
          objectId: task.id,
          action: AUDIT_ACTIONS.RELATED_STATUS_CHANGE,
          before: null,
          after: { supersededChangeRequestIds: supersededIds, newChangeRequestId: cr.id, policy },
          operator: input.applicant || null,
          note: `同任务待审批治理：${supersededIds.length}个变更申请被取代，新申请 ${cr.id} 创建`,
          rollbackable: false
        })
      : Promise.resolve(null);

    return Promise.all([...auditPromises, createAuditPromise, relatedTaskAuditPromise]).then(() =>
      send(res, 201, cr)
    );
  });
}

export function handleChangeRequestRecheck(db, id, send, res) {
  const cr = db.changeRequests.find((item) => item.id === id);
  if (!cr) return send(res, 404, { error: "change_request_not_found" });
  const task = db.tasks.find((t) => t.id === cr.taskId);
  if (!task) return send(res, 404, { error: "task_not_found" });
  const beforeConflictCheck = cr.conflictCheck ? JSON.parse(JSON.stringify(cr.conflictCheck)) : null;
  cr.conflictCheck = checkConflicts(db, task, cr.proposed, cr.id);
  return saveDb(db).then(() => {
    return recordAuditEvent({
      objectType: AUDIT_OBJECT_TYPES.CHANGE_REQUEST,
      objectId: cr.id,
      action: AUDIT_ACTIONS.RECHECK,
      before: { conflictCheck: beforeConflictCheck },
      after: { conflictCheck: cr.conflictCheck },
      operator: null,
      note: "冲突复查",
      rollbackable: false
    }).then(() => send(res, 200, { id: cr.id, conflictCheck: cr.conflictCheck }));
  });
}

export function handleChangeRequestApprove(db, id, input, send, res) {
  const crIndex = db.changeRequests.findIndex((item) => item.id === id);
  if (crIndex === -1) return send(res, 404, { error: "change_request_not_found" });
  const cr = db.changeRequests[crIndex];
  if (cr.status !== "pending") {
    return send(res, 409, { error: "not_pending", detail: `当前状态为 ${cr.status}，仅 pending 可审批` });
  }
  const task = db.tasks.find((t) => t.id === cr.taskId);
  if (!task) return send(res, 404, { error: "task_not_found" });

  const latestConflictCheck = checkConflicts(db, task, cr.proposed, cr.id);
  cr.conflictCheck = latestConflictCheck;

  const beforeTaskSnapshot = JSON.parse(JSON.stringify(task));
  const beforeCrSnapshot = JSON.parse(JSON.stringify(cr));

  if (cr.proposed.tideWindow) {
    const old = task.tideWindow ? `${task.tideWindow.start}~${task.tideWindow.end}` : "无";
    const nw = `${cr.proposed.tideWindow.start}~${cr.proposed.tideWindow.end}`;
    addHistory(task, "change_approved", `变更审批通过[${cr.id}]：潮汐窗口 ${old} -> ${nw}`);
    task.tideWindow = cr.proposed.tideWindow;
  }
  if (cr.proposed.berthPlan) {
    addHistory(task, "change_approved", `变更审批通过[${cr.id}]：泊位计划 ${task.berthPlan} -> ${cr.proposed.berthPlan}`);
    task.berthPlan = cr.proposed.berthPlan;
  }
  if (cr.proposed.status === "cancelled") {
    addHistory(task, "change_approved", `变更审批通过[${cr.id}]：任务取消`);
    task.status = "cancelled";
  }

  cr.status = "approved";
  cr.reviewedAt = new Date().toISOString();
  cr.approver = input && input.approver ? input.approver : null;

  const auditPromises = [];
  const supersededIds = [];

  const otherPendingSameTask = db.changeRequests.filter(
    (other) => other.taskId === cr.taskId && other.id !== cr.id && other.status === "pending"
  );
  if (otherPendingSameTask.length > 0) {
    const now = new Date().toISOString();
    for (const otherCr of otherPendingSameTask) {
      const beforeOtherSnapshot = JSON.parse(JSON.stringify(otherCr));
      otherCr.status = "superseded";
      otherCr.reason = `同任务申请[${cr.id}]已审批通过，本申请自动失效`;
      otherCr.reviewedAt = now;
      otherCr.supersededBy = cr.id;
      supersededIds.push(otherCr.id);
      auditPromises.push(
        recordAuditEvent({
          objectType: AUDIT_OBJECT_TYPES.CHANGE_REQUEST,
          objectId: otherCr.id,
          action: AUDIT_ACTIONS.SUPERSEDE,
          before: beforeOtherSnapshot,
          after: otherCr,
          operator: input?.approver || null,
          note: `同任务申请[${cr.id}]审批通过，本申请自动失效(superseded)`,
          rollbackable: false
        })
      );
    }
    addHistory(
      task,
      "change_superseded",
      `审批通过[${cr.id}]：同任务 ${otherPendingSameTask.length} 个待审批申请自动失效：${supersededIds.join(", ")}`
    );
  }

  if (cr.supersededChangeRequestIds && cr.supersededChangeRequestIds.length > 0) {
    addHistory(
      task,
      "related_status_change",
      `审批通过[${cr.id}]：本申请创建时已取代的申请：${cr.supersededChangeRequestIds.join(", ")}`
    );
  }

  return saveDb(db).then(() => {
    return recordAuditEvent({
      objectType: AUDIT_OBJECT_TYPES.CHANGE_REQUEST,
      objectId: cr.id,
      action: AUDIT_ACTIONS.APPROVE,
      before: beforeCrSnapshot,
      after: cr,
      operator: input?.approver || null,
      note: `变更申请审批通过${supersededIds.length > 0 ? `，自动失效 ${supersededIds.length} 个同任务待审批申请` : ""}`,
      rollbackable: false
    }).then(() => {
      return recordAuditEvent({
        objectType: AUDIT_OBJECT_TYPES.TASK,
        objectId: task.id,
        action: AUDIT_ACTIONS.UPDATE,
        before: beforeTaskSnapshot,
        after: task,
        operator: input?.approver || null,
        note: `变更审批通过[${cr.id}]${supersededIds.length > 0 ? `，关联 ${supersededIds.length} 个申请被取代` : ""}`,
        rollbackable: true
      });
    }).then(() => {
      if (supersededIds.length > 0) {
        return recordAuditEvent({
          objectType: AUDIT_OBJECT_TYPES.TASK,
          objectId: task.id,
          action: AUDIT_ACTIONS.RELATED_STATUS_CHANGE,
          before: null,
          after: { approvedChangeRequestId: cr.id, supersededChangeRequestIds: supersededIds },
          operator: input?.approver || null,
          note: `审批联动：申请[${cr.id}]通过导致 ${supersededIds.length} 个同任务申请被取代`,
          rollbackable: false
        });
      }
      return Promise.resolve(null);
    }).then(() => {
      return Promise.all(auditPromises);
    }).then(() => send(res, 200, { changeRequest: cr, task, supersededChangeRequestIds: supersededIds }));
  });
}

export function handleChangeRequestReject(db, id, input, send, res) {
  const crIndex = db.changeRequests.findIndex((item) => item.id === id);
  if (crIndex === -1) return send(res, 404, { error: "change_request_not_found" });
  const cr = db.changeRequests[crIndex];
  if (cr.status !== "pending") {
    return send(res, 409, { error: "not_pending", detail: `当前状态为 ${cr.status}，仅 pending 可审批` });
  }
  if (!input || !input.reason) {
    return send(res, 422, { error: "reason_required", detail: "驳回需要提供原因" });
  }

  const beforeCrSnapshot = JSON.parse(JSON.stringify(cr));

  cr.status = "rejected";
  cr.reason = input.reason;
  cr.reviewedAt = new Date().toISOString();
  cr.approver = input.approver ? input.approver : null;

  const task = db.tasks.find((t) => t.id === cr.taskId);
  if (task) {
    addHistory(task, "change_rejected", `变更申请驳回[${cr.id}]：${input.reason}`);

    if (cr.supersededChangeRequestIds && cr.supersededChangeRequestIds.length > 0) {
      addHistory(
        task,
        "related_status_change",
        `驳回[${cr.id}]：本申请创建时已取代的申请保持 superseded 状态：${cr.supersededChangeRequestIds.join(", ")}`
      );
    }
  }

  const otherPendingSameTask = task
    ? db.changeRequests.filter(
        (other) => other.taskId === cr.taskId && other.id !== cr.id && other.status === "pending"
      )
    : [];

  return saveDb(db).then(() => {
    const rejectAuditPromise = recordAuditEvent({
      objectType: AUDIT_OBJECT_TYPES.CHANGE_REQUEST,
      objectId: cr.id,
      action: AUDIT_ACTIONS.REJECT,
      before: beforeCrSnapshot,
      after: cr,
      operator: input.approver || null,
      note: `变更申请驳回：${input.reason}${
        otherPendingSameTask.length > 0 ? `，同任务仍有 ${otherPendingSameTask.length} 个待审批申请` : ""
      }`,
      rollbackable: false
    });

    const relatedTaskAuditPromise = task
      ? recordAuditEvent({
          objectType: AUDIT_OBJECT_TYPES.TASK,
          objectId: task.id,
          action: AUDIT_ACTIONS.RELATED_STATUS_CHANGE,
          before: null,
          after: {
            rejectedChangeRequestId: cr.id,
            rejectedReason: input.reason,
            supersededChangeRequestIds: cr.supersededChangeRequestIds || [],
            remainingPendingIds: otherPendingSameTask.map((x) => x.id)
          },
          operator: input.approver || null,
          note: `驳回联动：申请[${cr.id}]被驳回${
            otherPendingSameTask.length > 0 ? `，同任务仍有 ${otherPendingSameTask.length} 个待审批申请` : ""
          }`,
          rollbackable: false
        })
      : Promise.resolve(null);

    return Promise.all([rejectAuditPromise, relatedTaskAuditPromise]).then(() =>
      send(res, 200, { ...cr, remainingPendingChangeRequestIds: otherPendingSameTask.map((x) => x.id) })
    );
  });
}
