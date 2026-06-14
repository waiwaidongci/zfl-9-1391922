import { saveDb, listLeaveRecords, createLeaveRecord, cancelLeaveRecord, getLeaveRecord } from "../utils/db.js";
import { overlaps, affectedActiveTasks, intersectInterval } from "../utils/time.js";
import { recordAuditEvent, AUDIT_OBJECT_TYPES, AUDIT_ACTIONS } from "../services/audit.js";
import { findAlternativesForTask, evaluateCandidate } from "../utils/recommendation.js";

const LEAVE_TYPES = ["vacation", "disabled"];

function validatePeriod(period) {
  if (!period || typeof period !== "object") return "period_required";
  if (!period.start || !period.end) return "period_start_end_required";
  if (new Date(period.start) >= new Date(period.end)) return "period_invalid_range";
  return null;
}

function overlappingActiveLeaves(db, pilotId, start, end, exceptRecordId) {
  return db.leaveRecords.filter((r) => {
    if (r.pilotId !== pilotId) return false;
    if (r.status !== "active") return false;
    if (exceptRecordId && r.id === exceptRecordId) return false;
    return overlaps(start, end, r.period.start, r.period.end);
  });
}

export function handleLeaveList(db, searchParams, send, res) {
  const pilotId = searchParams.get("pilotId") || undefined;
  const status = searchParams.get("status") || undefined;
  const includeCancelled = searchParams.get("includeCancelled") === "true";
  const records = listLeaveRecords(db, { pilotId, status, includeCancelled });
  return send(res, 200, records);
}

export function handleLeaveDetail(db, recordId, send, res) {
  const record = getLeaveRecord(db, recordId);
  if (!record) return send(res, 404, { error: "leave_not_found" });
  return send(res, 200, record);
}

export function handleLeaveCreate(db, input, send, res) {
  if (!input.pilotId) return send(res, 400, { error: "pilot_id_required" });
  const pilot = db.pilots.find((p) => p.id === input.pilotId);
  if (!pilot) return send(res, 404, { error: "pilot_not_found" });
  if (input.type && !LEAVE_TYPES.includes(input.type)) {
    return send(res, 400, { error: "invalid_leave_type", allowedTypes: LEAVE_TYPES });
  }
  const periodErr = validatePeriod(input.period);
  if (periodErr) return send(res, 400, { error: periodErr });
  const overlapsList = overlappingActiveLeaves(db, input.pilotId, input.period.start, input.period.end);
  if (overlapsList.length > 0) {
    return send(res, 409, {
      error: "leave_period_overlap",
      overlappingWith: overlapsList.map((r) => r.id)
    });
  }
  const record = createLeaveRecord(db, input);

  const impacted = affectedActiveTasks(db, input.pilotId, input.period.start, input.period.end);
  const impactAnalysis = {
    affectedTasks: impacted.map((task) => {
      const overlapPeriod = intersectInterval(
        input.period.start, input.period.end,
        task.tideWindow.start, task.tideWindow.end
      );
      const alternatives = findAlternativesForTask(db, task, input.pilotId, 3);
      return {
        taskId: task.id,
        vessel: task.vessel,
        district: task.district,
        tideWindow: task.tideWindow,
        status: task.status,
        conflictReason: "leave_conflict",
        overlapPeriod,
        alternatives
      };
    }),
    affectedCount: impacted.length
  };

  return saveDb(db).then(() => {
    return recordAuditEvent({
      objectType: AUDIT_OBJECT_TYPES.LEAVE,
      objectId: record.id,
      action: AUDIT_ACTIONS.CREATE,
      after: record,
      operator: input.operator || null,
      note: input.reason || "创建休假记录",
      rollbackable: false
    }).then(() =>
      recordAuditEvent({
        objectType: AUDIT_OBJECT_TYPES.LEAVE,
        objectId: record.id,
        action: AUDIT_ACTIONS.LEAVE_IMPACT,
        after: { affectedTaskIds: impactAnalysis.affectedTasks.map((t) => t.taskId), affectedCount: impactAnalysis.affectedCount },
        operator: input.operator || null,
        note: `请假影响分析：${impactAnalysis.affectedCount}个活跃任务受影响`,
        rollbackable: false
      }).then(() => send(res, 201, { ...record, impactAnalysis }))
    );
  });
}

export function handleLeaveCancel(db, recordId, input, send, res) {
  const record = getLeaveRecord(db, recordId);
  if (!record) return send(res, 404, { error: "leave_not_found" });
  if (record.status === "cancelled") {
    return send(res, 409, { error: "leave_already_cancelled" });
  }

  const pilotId = record.pilotId;
  const leaveStart = record.period.start;
  const leaveEnd = record.period.end;
  const pilot = db.pilots.find((p) => p.id === pilotId);

  const tasksInWindow = db.tasks.filter((task) => {
    if (!task.tideWindow || !task.tideWindow.start || !task.tideWindow.end) return false;
    return overlaps(leaveStart, leaveEnd, task.tideWindow.start, task.tideWindow.end);
  });

  const recoveryAnalysis = pilot ? {
    recoveredTasks: tasksInWindow.map((task) => {
      const evaluation = evaluateCandidate(db, pilot, task);
      const wasDisqualifiedByLeave = evaluation.disqualifying.includes("leave_conflict") ||
        evaluation.breakdown.noLeaveConflict.detail.conflictingLeaves.some((l) => l.id === recordId);
      return {
        taskId: task.id,
        vessel: task.vessel,
        district: task.district,
        tideWindow: task.tideWindow,
        status: task.status,
        nowEligible: wasDisqualifiedByLeave && evaluation.disqualifying.filter((d) => d !== "leave_conflict").length === 0,
        previouslyDisqualifiedByLeave: wasDisqualifiedByLeave,
        remainingDisqualifying: evaluation.disqualifying.filter((d) => d !== "leave_conflict")
      };
    }).filter((t) => t.previouslyDisqualifiedByLeave),
    recoveredCount: 0
  } : { recoveredTasks: [], recoveredCount: 0 };
  recoveryAnalysis.recoveredCount = recoveryAnalysis.recoveredTasks.filter((t) => t.nowEligible).length;

  const beforeSnapshot = JSON.parse(JSON.stringify(record));
  const cancelled = cancelLeaveRecord(db, recordId, input && input.note);
  return saveDb(db).then(() => {
    return recordAuditEvent({
      objectType: AUDIT_OBJECT_TYPES.LEAVE,
      objectId: recordId,
      action: AUDIT_ACTIONS.CANCEL,
      before: beforeSnapshot,
      after: cancelled,
      operator: (input && input.operator) || null,
      note: (input && input.note) || "取消休假记录",
      rollbackable: false
    }).then(() =>
      recordAuditEvent({
        objectType: AUDIT_OBJECT_TYPES.LEAVE,
        objectId: recordId,
        action: AUDIT_ACTIONS.LEAVE_RECOVERY,
        after: { recoveredTaskIds: recoveryAnalysis.recoveredTasks.map((t) => t.taskId), recoveredCount: recoveryAnalysis.recoveredCount },
        operator: (input && input.operator) || null,
        note: `请假恢复分析：${recoveryAnalysis.recoveredCount}个任务可能重新满足条件`,
        rollbackable: false
      }).then(() => send(res, 200, { ...cancelled, recoveryAnalysis }))
    );
  });
}
