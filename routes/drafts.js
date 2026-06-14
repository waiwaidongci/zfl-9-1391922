import { saveDb } from "../utils/db.js";
import { DEFAULT_TASK_STATUS } from "../config/scheduling-rules.js";
import { recordAuditEvent, AUDIT_OBJECT_TYPES, AUDIT_ACTIONS } from "../services/audit.js";

const REQUIRED_TASK_FIELDS = ["vessel", "district", "berthPlan", "tideWindow", "requiredGrade"];

function validateDraftForSubmit(draft) {
  const missing = [];
  for (const field of REQUIRED_TASK_FIELDS) {
    if (draft[field] === undefined || draft[field] === null || draft[field] === "") {
      missing.push(field);
    }
  }
  if (draft.vessel && (typeof draft.vessel !== "object" || !draft.vessel.name)) {
    missing.push("vessel.name");
  }
  if (draft.tideWindow && (typeof draft.tideWindow !== "object" || !draft.tideWindow.start || !draft.tideWindow.end)) {
    missing.push("tideWindow.start/end");
  }
  return missing;
}

export function handleDraftCreate(db, input, send, res) {
  const now = new Date().toISOString();
  const draft = {
    id: input.id || `D-${Date.now()}`,
    vessel: input.vessel || null,
    district: input.district || null,
    berthPlan: input.berthPlan || null,
    tideWindow: input.tideWindow || null,
    requiredGrade: input.requiredGrade || null,
    note: input.note || null,
    createdAt: now,
    updatedAt: now
  };
  db.drafts.push(draft);
  return saveDb(db).then(() => {
    return recordAuditEvent({
      objectType: AUDIT_OBJECT_TYPES.DRAFT,
      objectId: draft.id,
      action: AUDIT_ACTIONS.CREATE,
      after: draft,
      operator: input.operator || null,
      note: input.note || "新建草稿",
      rollbackable: false
    }).then(() => send(res, 201, draft));
  });
}

export function handleDraftList(db, searchParams, send, res) {
  let drafts = db.drafts;
  const district = searchParams.get("district");
  if (district) drafts = drafts.filter((d) => d.district === district);
  return send(res, 200, drafts);
}

export function handleDraftDetail(db, id, send, res) {
  const draft = db.drafts.find((d) => d.id === id);
  if (!draft) return send(res, 404, { error: "draft_not_found" });
  return send(res, 200, draft);
}

export function handleDraftUpdate(db, id, input, send, res) {
  const draft = db.drafts.find((d) => d.id === id);
  if (!draft) return send(res, 404, { error: "draft_not_found" });
  const beforeSnapshot = JSON.parse(JSON.stringify(draft));
  if (input.vessel !== undefined) draft.vessel = input.vessel;
  if (input.district !== undefined) draft.district = input.district;
  if (input.berthPlan !== undefined) draft.berthPlan = input.berthPlan;
  if (input.tideWindow !== undefined) draft.tideWindow = input.tideWindow;
  if (input.requiredGrade !== undefined) draft.requiredGrade = input.requiredGrade;
  if (input.note !== undefined) draft.note = input.note;
  draft.updatedAt = new Date().toISOString();
  return saveDb(db).then(() => {
    return recordAuditEvent({
      objectType: AUDIT_OBJECT_TYPES.DRAFT,
      objectId: draft.id,
      action: AUDIT_ACTIONS.UPDATE,
      before: beforeSnapshot,
      after: draft,
      operator: input.operator || null,
      note: input.note || "更新草稿",
      rollbackable: false
    }).then(() => send(res, 200, draft));
  });
}

export function handleDraftSubmit(db, id, input, send, res) {
  const draftIndex = db.drafts.findIndex((d) => d.id === id);
  if (draftIndex === -1) return send(res, 404, { error: "draft_not_found" });
  const draft = db.drafts[draftIndex];
  const missing = validateDraftForSubmit(draft);
  if (missing.length > 0) return send(res, 422, { error: "incomplete_draft", missing });
  const draftSnapshot = JSON.parse(JSON.stringify(draft));
  const task = {
    id: input.taskId || `T-${Date.now()}`,
    vessel: draft.vessel,
    district: draft.district,
    berthPlan: draft.berthPlan,
    tideWindow: draft.tideWindow,
    requiredGrade: draft.requiredGrade,
    status: DEFAULT_TASK_STATUS,
    pilotId: null,
    history: []
  };
  task.history.push({ at: new Date().toISOString(), action: "created", note: draft.note || input.note || `由草稿${draft.id}提交` });
  db.tasks.push(task);
  db.drafts.splice(draftIndex, 1);
  return saveDb(db).then(() => {
    return recordAuditEvent({
      objectType: AUDIT_OBJECT_TYPES.DRAFT,
      objectId: draft.id,
      action: AUDIT_ACTIONS.SUBMIT,
      before: draftSnapshot,
      after: null,
      operator: input.operator || null,
      note: `草稿提交为任务 ${task.id}`,
      rollbackable: false
    }).then(() => {
      return recordAuditEvent({
        objectType: AUDIT_OBJECT_TYPES.TASK,
        objectId: task.id,
        action: AUDIT_ACTIONS.CREATE,
        after: task,
        operator: input.operator || null,
        note: `由草稿${draft.id}提交创建`,
        rollbackable: false
      });
    }).then(() => send(res, 201, { submitted: draft.id, task }));
  });
}
