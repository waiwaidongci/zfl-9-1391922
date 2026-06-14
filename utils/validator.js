import { isValidDistrict, isValidShipType, isValidGrade } from "../config/scheduling-rules.js";

function isNonEmptyString(value) {
  return typeof value === "string" && value.trim().length > 0;
}

function isValidDateString(value) {
  if (typeof value !== "string") return false;
  const d = new Date(value);
  return !isNaN(d.getTime());
}

function isValidVessel(vessel) {
  if (!vessel || typeof vessel !== "object") return false;
  return isNonEmptyString(vessel.name) &&
    isNonEmptyString(vessel.type) &&
    isValidShipType(vessel.type);
}

function isValidTideWindow(window) {
  if (!window || typeof window !== "object") return false;
  if (!isValidDateString(window.start) || !isValidDateString(window.end)) return false;
  return new Date(window.start) < new Date(window.end);
}

const ID_PATTERN = /^[A-Za-z0-9_-]+$/;

function validateVesselDetail(vessel) {
  const warnings = [];
  if (vessel && typeof vessel === "object") {
    if (vessel.imo !== undefined && vessel.imo !== null && vessel.imo !== "") {
      if (typeof vessel.imo !== "string" || !/^IMO\d{7}$/.test(vessel.imo)) {
        warnings.push({ field: "vessel.imo", message: "IMO编号格式建议为 IMO+7位数字", code: "imo_format_warning" });
      }
    }
    if (vessel.length !== undefined && vessel.length !== null) {
      if (typeof vessel.length !== "number" || vessel.length <= 0 || vessel.length > 500) {
        warnings.push({ field: "vessel.length", message: "船舶长度应在0-500米范围内", code: "length_range_warning" });
      }
    }
  }
  return warnings;
}

function validateTideWindowDetail(window) {
  const warnings = [];
  if (window && typeof window === "object" && isValidDateString(window.start) && isValidDateString(window.end)) {
    const start = new Date(window.start);
    const end = new Date(window.end);
    const durationMs = end - start;
    const durationHours = durationMs / (1000 * 60 * 60);
    if (durationHours < 0.5) {
      warnings.push({ field: "tideWindow", message: "潮汐窗口时长不足30分钟", code: "short_window_warning" });
    }
    if (durationHours > 24) {
      warnings.push({ field: "tideWindow", message: "潮汐窗口时长超过24小时", code: "long_window_warning" });
    }
    const now = new Date();
    const daysAhead = (start - now) / (1000 * 60 * 60 * 24);
    if (daysAhead > 30) {
      warnings.push({ field: "tideWindow.start", message: "潮汐窗口起始时间距当前超过30天", code: "far_future_warning" });
    }
  }
  return warnings;
}

export function validateTaskRow(row, index, existingTaskIds = new Set()) {
  const errors = [];
  const warnings = [];

  if (!row || typeof row !== "object" || Array.isArray(row)) {
    errors.push({ field: "row", message: "行数据格式错误，应为对象", code: "invalid_row_format" });
    return { valid: false, errors, warnings, rowIndex: index };
  }

  if (row.id !== undefined && row.id !== null) {
    if (typeof row.id !== "string") {
      errors.push({ field: "id", message: `任务ID必须为字符串，实际为 ${typeof row.id}`, code: "id_not_string" });
    } else if (row.id.trim() === "") {
      errors.push({ field: "id", message: "任务ID不能为空白字符串", code: "empty_id" });
    } else if (!ID_PATTERN.test(row.id)) {
      errors.push({ field: "id", message: `任务ID格式无效: ${row.id}，仅允许字母、数字、下划线和连字符`, code: "invalid_id_format" });
    } else if (row.id.length > 64) {
      errors.push({ field: "id", message: "任务ID长度不能超过64个字符", code: "id_too_long" });
    } else if (existingTaskIds.has(row.id)) {
      warnings.push({ field: "id", message: `任务ID ${row.id} 已存在，确认提交时将更新已有任务`, code: "duplicate_id" });
    }
  }

  if (!row.vessel || typeof row.vessel !== "object" || Array.isArray(row.vessel)) {
    errors.push({ field: "vessel", message: "船舶信息缺失", code: "missing_vessel" });
  } else {
    if (!isNonEmptyString(row.vessel.name)) {
      errors.push({ field: "vessel.name", message: "船名不能为空", code: "missing_vessel_name" });
    }
    if (!isNonEmptyString(row.vessel.type)) {
      errors.push({ field: "vessel.type", message: "船型不能为空", code: "missing_vessel_type" });
    } else if (!isValidShipType(row.vessel.type)) {
      errors.push({ field: "vessel.type", message: `无效的船型: ${row.vessel.type}`, code: "invalid_vessel_type" });
    }
    warnings.push(...validateVesselDetail(row.vessel));
  }

  if (!isNonEmptyString(row.district)) {
    errors.push({ field: "district", message: "港区不能为空", code: "missing_district" });
  } else if (!isValidDistrict(row.district)) {
    errors.push({ field: "district", message: `无效的港区: ${row.district}`, code: "invalid_district" });
  }

  if (!row.tideWindow || typeof row.tideWindow !== "object" || Array.isArray(row.tideWindow)) {
    errors.push({ field: "tideWindow", message: "潮汐窗口缺失", code: "missing_tide_window" });
  } else {
    if (!isValidDateString(row.tideWindow.start)) {
      errors.push({ field: "tideWindow.start", message: "潮汐窗口起始时间无效", code: "invalid_window_start" });
    }
    if (!isValidDateString(row.tideWindow.end)) {
      errors.push({ field: "tideWindow.end", message: "潮汐窗口结束时间无效", code: "invalid_window_end" });
    }
    if (isValidDateString(row.tideWindow.start) && isValidDateString(row.tideWindow.end)) {
      if (new Date(row.tideWindow.start) >= new Date(row.tideWindow.end)) {
        errors.push({ field: "tideWindow", message: "潮汐窗口结束时间必须晚于起始时间", code: "window_end_before_start" });
      }
    }
    warnings.push(...validateTideWindowDetail(row.tideWindow));
  }

  if (!isNonEmptyString(row.requiredGrade)) {
    errors.push({ field: "requiredGrade", message: "资质等级不能为空", code: "missing_grade" });
  } else if (!isValidGrade(row.requiredGrade)) {
    errors.push({ field: "requiredGrade", message: `无效的资质等级: ${row.requiredGrade}`, code: "invalid_grade" });
  }

  if (row.berthPlan !== undefined && row.berthPlan !== null && typeof row.berthPlan !== "string") {
    errors.push({ field: "berthPlan", message: `泊位计划应为字符串，实际为 ${typeof row.berthPlan}`, code: "invalid_berth_plan" });
  }

  if (row.note !== undefined && row.note !== null && typeof row.note !== "string") {
    errors.push({ field: "note", message: `备注应为字符串，实际为 ${typeof row.note}`, code: "invalid_note" });
  }

  return {
    valid: errors.length === 0,
    errors,
    warnings,
    rowIndex: index
  };
}

export function validateTaskBatch(rows, existingTaskIds = new Set()) {
  if (!Array.isArray(rows)) {
    return { valid: false, error: "输入必须为数组", code: "not_array" };
  }

  if (rows.length === 0) {
    return { valid: false, error: "导入数据不能为空", code: "empty_batch" };
  }

  if (rows.length > 200) {
    return { valid: false, error: "单次导入行数不能超过200条", code: "batch_too_large" };
  }

  const results = rows.map((row, index) => validateTaskRow(row, index, existingTaskIds));
  const validRows = results.filter((r) => r.valid).map((r) => r.rowIndex);
  const errorRows = results.filter((r) => !r.valid).map((r) => r.rowIndex);

  const idSet = new Set();
  const duplicateIdsWithinBatch = [];
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    if (row && row.id) {
      if (idSet.has(row.id)) {
        duplicateIdsWithinBatch.push({ rowIndex: i, id: row.id });
        if (results[i].valid) {
          results[i].valid = false;
          results[i].errors.push({ field: "id", message: `批次内重复ID: ${row.id}`, code: "batch_duplicate_id" });
        }
      } else {
        idSet.add(row.id);
      }
    }
  }

  const allWarnings = results.flatMap((r) => r.warnings.map((w) => ({ ...w, rowIndex: r.rowIndex })));

  return {
    totalCount: rows.length,
    validCount: results.filter((r) => r.valid).length,
    errorCount: results.filter((r) => !r.valid).length,
    warningCount: allWarnings.length,
    validRows,
    errorRows,
    rowResults: results,
    duplicateIdsWithinBatch,
    allWarnings
  };
}

let _idCounter = 0;

export function buildTaskFromRow(row, defaultIdPrefix = "T") {
  let id;
  if (row.id) {
    id = row.id;
  } else {
    _idCounter++;
    id = `${defaultIdPrefix}-${Date.now()}-${_idCounter.toString(36).toUpperCase()}-${Math.random().toString(36).slice(2, 6).toUpperCase()}`;
  }
  return {
    id,
    vessel: {
      name: row.vessel?.name || "",
      imo: row.vessel?.imo || "",
      type: row.vessel?.type || "",
      length: row.vessel?.length || null
    },
    district: row.district,
    berthPlan: row.berthPlan || null,
    tideWindow: {
      start: row.tideWindow?.start || "",
      end: row.tideWindow?.end || ""
    },
    requiredGrade: row.requiredGrade,
    note: row.note || ""
  };
}
