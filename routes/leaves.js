import { saveDb, listLeaveRecords, createLeaveRecord, cancelLeaveRecord, getLeaveRecord } from "../utils/db.js";
import { overlaps } from "../utils/time.js";
import { recordAuditEvent, AUDIT_OBJECT_TYPES, AUDIT_ACTIONS } from "../services/audit.js";

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
  return saveDb(db).then(() => {
    return recordAuditEvent({
      objectType: AUDIT_OBJECT_TYPES.LEAVE,
      objectId: record.id,
      action: AUDIT_ACTIONS.CREATE,
      after: record,
      operator: input.operator || null,
      note: input.reason || "创建休假记录",
      rollbackable: false
    }).then(() => send(res, 201, record));
  });
}

export function handleLeaveCancel(db, recordId, input, send, res) {
  const record = getLeaveRecord(db, recordId);
  if (!record) return send(res, 404, { error: "leave_not_found" });
  if (record.status === "cancelled") {
    return send(res, 409, { error: "leave_already_cancelled" });
  }
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
    }).then(() => send(res, 200, cancelled));
  });
}
