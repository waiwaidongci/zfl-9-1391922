import { saveDb } from "../utils/db.js";
import { recommendPilots, pilotFitsCheck } from "../utils/recommendation.js";
import { DEFAULT_TASK_STATUS, ASSIGNED_TASK_STATUS, isActiveTaskStatus } from "../config/scheduling-rules.js";
import { handleChangeRequestCreate } from "./change-requests.js";
import { recordAuditEvent, AUDIT_OBJECT_TYPES, AUDIT_ACTIONS } from "../services/audit.js";
import { validateTaskListParams } from "../utils/validator.js";
import { overlaps } from "../utils/time.js";

function addHistory(task, action, note) {
  task.history.push({ at: new Date().toISOString(), action, note });
}

export function filterTasks(tasks, filters) {
  let result = tasks;

  if (filters.status !== undefined && filters.status !== null) {
    result = result.filter((task) => task.status === filters.status);
  }

  if (filters.district !== undefined && filters.district !== null) {
    result = result.filter((task) => task.district === filters.district);
  }

  if (filters.activeOnly === true) {
    result = result.filter((task) => isActiveTaskStatus(task.status));
  }

  if (filters.pilotId !== undefined && filters.pilotId !== null) {
    result = result.filter((task) => task.pilotId === filters.pilotId);
  }

  if (filters.vesselName !== undefined && filters.vesselName !== null) {
    const keyword = filters.vesselName.toLowerCase();
    result = result.filter((task) =>
      task.vessel && task.vessel.name && task.vessel.name.toLowerCase().includes(keyword)
    );
  }

  if (filters.tideWindow !== undefined && filters.tideWindow !== null) {
    const { start: filterStart, end: filterEnd } = filters.tideWindow;
    result = result.filter((task) => {
      if (!task.tideWindow || !task.tideWindow.start || !task.tideWindow.end) return false;
      const taskStart = task.tideWindow.start;
      const taskEnd = task.tideWindow.end;

      if (filterStart && filterEnd) {
        return overlaps(filterStart, filterEnd, taskStart, taskEnd);
      }
      if (filterStart) {
        return new Date(taskEnd) > new Date(filterStart);
      }
      if (filterEnd) {
        return new Date(taskStart) < new Date(filterEnd);
      }
      return true;
    });
  }

  return result;
}

export function handleTaskList(db, searchParams, send, res) {
  const validation = validateTaskListParams(searchParams);
  if (!validation.valid) {
    return send(res, 400, {
      error: "invalid_filters",
      message: "筛选参数无效",
      errors: validation.errors
    });
  }

  const tasks = filterTasks(db.tasks, validation.filters);
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
