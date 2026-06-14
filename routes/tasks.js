import { saveDb } from "../utils/db.js";
import { recommendPilots, pilotFitsCheck } from "../utils/recommendation.js";
import { DEFAULT_TASK_STATUS, ASSIGNED_TASK_STATUS } from "../config/scheduling-rules.js";
import { handleChangeRequestCreate } from "./change-requests.js";
import { recordAuditEvent, AUDIT_OBJECT_TYPES, AUDIT_ACTIONS } from "../services/audit.js";

function addHistory(task, action, note) {
  task.history.push({ at: new Date().toISOString(), action, note });
}

export function handleTaskList(db, searchParams, send, res) {
  const status = searchParams.get("status");
  const district = searchParams.get("district");
  let tasks = db.tasks;
  if (status) tasks = tasks.filter((task) => task.status === status);
  if (district) tasks = tasks.filter((task) => task.district === district);
  return send(res, 200, tasks);
}

export function handleTaskCreate(db, input, send, res) {
  const task = {
    id: input.id || `T-${Date.now()}`,
    vessel: input.vessel,
    district: input.district,
    berthPlan: input.berthPlan,
    tideWindow: input.tideWindow,
    requiredGrade: input.requiredGrade,
    status: DEFAULT_TASK_STATUS,
    pilotId: null,
    history: []
  };
  addHistory(task, "created", input.note || "新建引航申请");
  db.tasks.push(task);
  return saveDb(db).then(() => {
    return recordAuditEvent({
      objectType: AUDIT_OBJECT_TYPES.TASK,
      objectId: task.id,
      action: AUDIT_ACTIONS.CREATE,
      after: task,
      operator: input.operator || null,
      note: input.note || "新建引航申请",
      rollbackable: false
    }).then(() => send(res, 201, task));
  });
}

export function handleTaskCandidates(db, task, send, res) {
  const candidates = db.pilots.map((pilot) => pilotFitsCheck(db, pilot, task, task.id));
  return send(res, 200, candidates.map((item) => ({
    pilotId: item.pilot.id,
    name: item.pilot.name,
    ok: item.ok,
    reasons: item.reasons
  })));
}

export function handleTaskAssign(db, task, input, send, res) {
  const pilot = db.pilots.find((item) => item.id === input.pilotId);
  if (!pilot) return send(res, 404, { error: "pilot_not_found" });
  const fit = pilotFitsCheck(db, pilot, task, task.id);
  if (!fit.ok) return send(res, 409, { error: "pilot_not_available", reasons: fit.reasons });

  const before = { ...task };
  const beforeSnapshot = JSON.parse(JSON.stringify(task));

  task.pilotId = pilot.id;
  task.status = ASSIGNED_TASK_STATUS;
  addHistory(task, "assigned", `分配给${pilot.name}`);

  return saveDb(db).then(() => {
    return recordAuditEvent({
      objectType: AUDIT_OBJECT_TYPES.TASK,
      objectId: task.id,
      action: AUDIT_ACTIONS.ASSIGN,
      before: beforeSnapshot,
      after: task,
      operator: input.operator || null,
      note: input.note || `分配给${pilot.name}`,
      rollbackable: true
    }).then(() => send(res, 200, task));
  });
}

export function handleTaskStatus(db, task, input, send, res) {
  const requiresApproval = task.status === ASSIGNED_TASK_STATUS &&
    (input.tideWindow !== undefined || input.berthPlan !== undefined || input.status === "cancelled");
  if (requiresApproval) {
    return handleChangeRequestCreate(db, task.id, input, send, res);
  }

  const beforeSnapshot = JSON.parse(JSON.stringify(task));
  const hasStatusChange = !!input.status;
  const hasUpdate = input.status || input.tideWindow || input.berthPlan;

  if (input.status) task.status = input.status;
  if (input.tideWindow) task.tideWindow = input.tideWindow;
  if (input.berthPlan) task.berthPlan = input.berthPlan;
  addHistory(task, input.status || "updated", input.note || "状态更新");

  if (!hasUpdate) {
    return send(res, 200, task);
  }

  return saveDb(db).then(() => {
    return recordAuditEvent({
      objectType: AUDIT_OBJECT_TYPES.TASK,
      objectId: task.id,
      action: hasStatusChange ? AUDIT_ACTIONS.STATUS_CHANGE : AUDIT_ACTIONS.UPDATE,
      before: beforeSnapshot,
      after: task,
      operator: input.operator || null,
      note: input.note || "状态更新",
      rollbackable: true
    }).then(() => send(res, 200, task));
  });
}

export function handleTaskRecommend(db, task, input, send, res) {
  const limit = input && typeof input.limit === "number" ? input.limit : null;
  const result = recommendPilots(db, task, limit);
  return send(res, 200, result);
}
