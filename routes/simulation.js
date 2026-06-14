import { runSimulation, submitSimulationAssignments } from "../services/simulation/index.js";
import { validateTaskRow } from "../utils/validator.js";
import { isValidDistrict, isValidShipType, isValidGrade } from "../config/scheduling-rules.js";

function isNonEmptyString(value) {
  return typeof value === "string" && value.trim().length > 0;
}

function isValidDateString(value) {
  if (typeof value !== "string") return false;
  const d = new Date(value);
  return !isNaN(d.getTime());
}

const ID_PATTERN = /^[A-Za-z0-9_-]+$/;

function validateSimTask(task, index, existingTaskIds, batchDupIndices) {
  const errors = [];

  if (!task || typeof task !== "object" || Array.isArray(task)) {
    return { valid: false, errors: [{ field: "row", message: `任务索引 ${index} 数据格式错误，应为对象`, code: "invalid_row_format" }] };
  }

  if (task.id === undefined || task.id === null) {
    errors.push({ field: "id", message: `任务索引 ${index}: 任务ID必填`, code: "missing_id" });
  } else if (typeof task.id !== "string") {
    errors.push({ field: "id", message: `任务索引 ${index}: 任务ID必须为字符串，实际为 ${typeof task.id}`, code: "id_not_string" });
  } else if (task.id.trim() === "") {
    errors.push({ field: "id", message: `任务索引 ${index}: 任务ID不能为空白字符串`, code: "empty_id" });
  } else if (!ID_PATTERN.test(task.id)) {
    errors.push({ field: "id", message: `任务索引 ${index}: 任务ID格式无效: ${task.id}，仅允许字母、数字、下划线和连字符`, code: "invalid_id_format" });
  } else if (task.id.length > 64) {
    errors.push({ field: "id", message: `任务索引 ${index}: 任务ID长度不能超过64个字符`, code: "id_too_long" });
  } else if (existingTaskIds.has(task.id)) {
    errors.push({ field: "id", message: `任务索引 ${index}: 任务ID ${task.id} 与已有真实任务ID冲突`, code: "existing_id_conflict" });
  }

  if (!task.tideWindow || typeof task.tideWindow !== "object" || Array.isArray(task.tideWindow)) {
    errors.push({ field: "tideWindow", message: `任务索引 ${index} 缺少有效的 tideWindow`, code: "missing_tide_window" });
  } else {
    if (!isValidDateString(task.tideWindow.start)) {
      errors.push({ field: "tideWindow.start", message: `任务索引 ${index}: 潮汐窗口起始时间无效`, code: "invalid_window_start" });
    }
    if (!isValidDateString(task.tideWindow.end)) {
      errors.push({ field: "tideWindow.end", message: `任务索引 ${index}: 潮汐窗口结束时间无效`, code: "invalid_window_end" });
    }
    if (isValidDateString(task.tideWindow.start) && isValidDateString(task.tideWindow.end)) {
      if (new Date(task.tideWindow.start) >= new Date(task.tideWindow.end)) {
        errors.push({ field: "tideWindow", message: `任务索引 ${index}: 潮汐窗口结束时间必须晚于起始时间`, code: "window_end_before_start" });
      }
    }
  }

  if (!isNonEmptyString(task.district)) {
    errors.push({ field: "district", message: `任务索引 ${index} 缺少 district`, code: "missing_district" });
  } else if (!isValidDistrict(task.district)) {
    errors.push({ field: "district", message: `任务索引 ${index}: 无效的港区: ${task.district}`, code: "invalid_district" });
  }

  if (!task.vessel || typeof task.vessel !== "object" || Array.isArray(task.vessel)) {
    errors.push({ field: "vessel", message: `任务索引 ${index} 缺少 vessel`, code: "missing_vessel" });
  } else {
    if (!isNonEmptyString(task.vessel.name)) {
      errors.push({ field: "vessel.name", message: `任务索引 ${index} 缺少 vessel.name`, code: "missing_vessel_name" });
    }
    if (!isNonEmptyString(task.vessel.type)) {
      errors.push({ field: "vessel.type", message: `任务索引 ${index} 缺少 vessel.type`, code: "missing_vessel_type" });
    } else if (!isValidShipType(task.vessel.type)) {
      errors.push({ field: "vessel.type", message: `任务索引 ${index}: 无效的船型: ${task.vessel.type}`, code: "invalid_vessel_type" });
    }
  }

  if (!isNonEmptyString(task.requiredGrade)) {
    errors.push({ field: "requiredGrade", message: `任务索引 ${index} 缺少 requiredGrade`, code: "missing_grade" });
  } else if (!isValidGrade(task.requiredGrade)) {
    errors.push({ field: "requiredGrade", message: `任务索引 ${index}: 无效的资质等级: ${task.requiredGrade}`, code: "invalid_grade" });
  }

  return { valid: errors.length === 0, errors };
}

export function handleSimulationDispatch(db, input, send, res) {
  if (!input || !Array.isArray(input.tasks)) {
    return send(res, 400, { error: "missing_tasks", message: "请求体必须包含 tasks 数组" });
  }

  if (input.tasks.length === 0) {
    return send(res, 400, { error: "empty_tasks", message: "tasks 数组不能为空" });
  }

  if (input.tasks.length > 100) {
    return send(res, 400, { error: "too_many_tasks", message: "单次仿真任务数不能超过100" });
  }

  const tempShifts = Array.isArray(input.tempShifts) ? input.tempShifts : [];

  const existingTaskIds = new Set(db.tasks.map((t) => t.id));
  const batchIdSet = new Set();
  const batchDupIndices = new Set();

  for (let i = 0; i < input.tasks.length; i++) {
    const task = input.tasks[i];
    if (task && task.id) {
      if (batchIdSet.has(task.id)) {
        batchDupIndices.add(i);
      } else {
        batchIdSet.add(task.id);
      }
    }
  }

  const validationErrors = [];

  for (let i = 0; i < input.tasks.length; i++) {
    const task = input.tasks[i];
    if (batchDupIndices.has(i)) {
      validationErrors.push({
        taskIndex: i,
        field: "id",
        message: `批次内重复ID: ${task.id}`,
        code: "batch_duplicate_id"
      });
    }
    const result = validateSimTask(task, i, existingTaskIds, batchDupIndices);
    if (!result.valid) {
      validationErrors.push(...result.errors);
    }
  }

  if (validationErrors.length > 0) {
    return send(res, 400, { error: "validation_failed", message: "任务校验失败", errors: validationErrors });
  }

  const result = runSimulation(db, { tasks: input.tasks, tempShifts });
  return send(res, 200, result);
}

export async function handleSimulationSubmit(db, input, send, res) {
  if (!input || !Array.isArray(input.assignmentLog)) {
    return send(res, 400, {
      error: "missing_assignment_log",
      message: "请求体必须包含 assignmentLog 数组"
    });
  }

  const operator = typeof input.operator === "string" && input.operator.trim().length > 0
    ? input.operator
    : null;
  const note = typeof input.note === "string" && input.note.trim().length > 0
    ? input.note
    : null;

  try {
    const result = await submitSimulationAssignments(db, {
      assignmentLog: input.assignmentLog,
      operator,
      note
    });

    if (result.error === "invalid_assignment_log" || result.error === "empty_assignment_log" || result.error === "too_many_entries") {
      return send(res, 400, result);
    }

    if (result.error === "format_validation_failed") {
      return send(res, 400, result);
    }

    if (result.success) {
      return send(res, 200, result);
    }

    if (result.partialSuccess) {
      return send(res, 207, result);
    }

    return send(res, 409, result);
  } catch (err) {
    console.error("[handleSimulationSubmit] 处理异常:", err);
    return send(res, 500, {
      error: "internal_error",
      message: err.message || "服务器内部错误"
    });
  }
}
