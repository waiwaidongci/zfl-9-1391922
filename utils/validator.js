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

function isValidImo(imo) {
  if (imo === undefined || imo === null || imo === "") return true;
  if (typeof imo !== "string") return false;
  return /^IMO\d{7}$/.test(imo) || /^\d{7}$/.test(imo);
}

function isValidLength(length) {
  if (length === undefined || length === null || length === "") return true;
  if (typeof length !== "number") return false;
  return length > 0 && length < 1000;
}

export function validateTaskRow(row, index, existingTaskIds = new Set()) {
  const errors = [];
  const warnings = [];

  if (!row || typeof row !== "object") {
    errors.push({ field: "row", message: "行数据格式错误，应为对象" });
    return { valid: false, errors, warnings, row: null, rowIndex: index };
  }

  if (row.id !== undefined && row.id !== null) {
    if (!isNonEmptyString(row.id)) {
      errors.push({ field: "id", message: "任务ID必须为非空字符串" });
    } else if (existingTaskIds.has(row.id)) {
      warnings.push({
        field: "id",
        message: `任务ID ${row.id} 已存在，提交时将被跳过（如需更新请设置 updateMode=true）`,
        code: "duplicate_existing_id"
      });
    }
  }

  if (!isValidVessel(row.vessel)) {
    errors.push({ field: "vessel", message: "船舶信息不完整或船型无效，需提供 name 和有效的 type" });
  } else {
    if (row.vessel.imo !== undefined && !isValidImo(row.vessel.imo)) {
      warnings.push({ field: "vessel.imo", message: "IMO号格式不规范，应为 IMO+7位数字 或 7位数字" });
    }
    if (row.vessel.length !== undefined && !isValidLength(row.vessel.length)) {
      warnings.push({ field: "vessel.length", message: "船舶长度格式不规范，应为大于0小于1000的数字" });
    }
  }

  if (!isNonEmptyString(row.district)) {
    errors.push({ field: "district", message: "港区不能为空" });
  } else if (!isValidDistrict(row.district)) {
    errors.push({ field: "district", message: `无效的港区: ${row.district}` });
  }

  if (!isValidTideWindow(row.tideWindow)) {
    errors.push({ field: "tideWindow", message: "潮汐窗口无效或缺失，需包含有效的 start 和 end 时间，且 start 必须早于 end" });
  } else {
    const windowStart = new Date(row.tideWindow.start);
    const now = new Date();
    if (windowStart < now) {
      const daysDiff = (now - windowStart) / (1000 * 60 * 60 * 24);
      if (daysDiff > 7) {
        warnings.push({ field: "tideWindow", message: "潮汐窗口起始时间已超过7天前，请确认数据准确性" });
      }
    }
    const windowDuration = new Date(row.tideWindow.end) - windowStart;
    const hours = windowDuration / (1000 * 60 * 60);
    if (hours > 48) {
      warnings.push({ field: "tideWindow", message: `潮汐窗口时长过长（${hours.toFixed(1)}小时），请确认数据准确性` });
    }
    if (hours < 0.5) {
      warnings.push({ field: "tideWindow", message: `潮汐窗口时长过短（${(hours * 60).toFixed(0)}分钟），请确认数据准确性` });
    }
  }

  if (!isNonEmptyString(row.requiredGrade)) {
    errors.push({ field: "requiredGrade", message: "资质等级不能为空" });
  } else if (!isValidGrade(row.requiredGrade)) {
    errors.push({ field: "requiredGrade", message: `无效的资质等级: ${row.requiredGrade}` });
  }

  if (row.berthPlan !== undefined && row.berthPlan !== null && typeof row.berthPlan !== "string") {
    errors.push({ field: "berthPlan", message: "泊位计划应为字符串" });
  }

  if (row.note !== undefined && row.note !== null && typeof row.note !== "string") {
    warnings.push({ field: "note", message: "备注应为字符串类型" });
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
    return { valid: false, error: "输入必须为数组" };
  }

  if (rows.length === 0) {
    return { valid: false, error: "导入数据不能为空" };
  }

  const results = rows.map((row, index) => validateTaskRow(row, index, existingTaskIds));
  const validRows = results.filter((r) => r.valid).map((r) => r.rowIndex);
  const errorRows = results.filter((r) => !r.valid).map((r) => r.rowIndex);

  const duplicateExistingIds = [];
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    if (row && row.id && existingTaskIds.has(row.id)) {
      duplicateExistingIds.push({ rowIndex: i, id: row.id });
    }
  }

  const idSet = new Map();
  const batchDuplicateIds = [];
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    if (row && row.id) {
      if (idSet.has(row.id)) {
        const firstIndex = idSet.get(row.id);
        batchDuplicateIds.push({ rowIndex: i, id: row.id, firstOccurrence: firstIndex });
        if (results[i].valid) {
          results[i].valid = false;
          results[i].errors.push({
            field: "id",
            message: `批次内重复ID: ${row.id}（首次出现在第 ${firstIndex} 行）`,
            code: "batch_duplicate_id"
          });
        }
      } else {
        idSet.set(row.id, i);
      }
    }
  }

  const updatedValidRows = results.filter((r) => r.valid).map((r) => r.rowIndex);

  return {
    totalCount: rows.length,
    validCount: updatedValidRows.length,
    errorCount: results.filter((r) => !r.valid).length,
    validRows: updatedValidRows,
    errorRows,
    rowResults: results,
    duplicateExistingIds,
    batchDuplicateIds
  };
}

export function buildTaskFromRow(row, defaultIdPrefix = "T") {
  return {
    id: row.id || `${defaultIdPrefix}-${Date.now()}-${Math.random().toString(36).slice(2, 6).toUpperCase()}`,
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
