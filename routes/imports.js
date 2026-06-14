import { saveDb } from "../utils/db.js";
import { validateTaskBatch, buildTaskFromRow } from "../utils/validator.js";
import { analyzeImportBatch } from "../services/candidate-reuse.js";
import { createImportSession, getImportSession, updateImportSession, cancelImportSession, listImportSessions } from "../services/import-session.js";
import { DEFAULT_TASK_STATUS } from "../config/scheduling-rules.js";
import { recordAuditEvent, AUDIT_OBJECT_TYPES, AUDIT_ACTIONS } from "../services/audit.js";

function addHistory(task, action, note) {
  task.history.push({ at: new Date().toISOString(), action, note });
}

function extractRows(input) {
  if (input == null || typeof input !== "object") {
    return { rows: null, error: { error: "invalid_input", message: "请求体必须为JSON对象，包含 tasks 数组", code: "body_not_object" } };
  }
  if (Array.isArray(input)) {
    return { rows: input, error: null };
  }
  if ("tasks" in input) {
    if (input.tasks == null) {
      return { rows: null, error: { error: "invalid_input", message: "tasks 字段不能为 null", code: "tasks_null" } };
    }
    if (!Array.isArray(input.tasks)) {
      return { rows: null, error: { error: "invalid_input", message: `tasks 字段必须为数组，实际为 ${typeof input.tasks}`, code: "tasks_not_array" } };
    }
    return { rows: input.tasks, error: null };
  }
  if ("rows" in input) {
    if (input.rows == null) {
      return { rows: null, error: { error: "invalid_input", message: "rows 字段不能为 null", code: "rows_null" } };
    }
    if (!Array.isArray(input.rows)) {
      return { rows: null, error: { error: "invalid_input", message: `rows 字段必须为数组，实际为 ${typeof input.rows}`, code: "rows_not_array" } };
    }
    return { rows: input.rows, error: null };
  }
  return { rows: null, error: { error: "invalid_input", message: "请求体必须包含 tasks 或 rows 字段", code: "missing_tasks_field" } };
}

export function handleImportPreview(db, input, send, res) {
  const { rows, error: extractError } = extractRows(input);
  if (extractError) {
    return send(res, 400, extractError);
  }

  const existingTaskIds = new Set(db.tasks.map((t) => t.id));
  const validation = validateTaskBatch(rows, existingTaskIds);

  if (validation.valid === false) {
    return send(res, 400, { error: "batch_validation_failed", message: validation.error, code: validation.code });
  }

  const validRows = validation.validRows;
  const duplicateIdRows = validation.duplicateIdRows || [];
  const duplicateIdRowMap = new Map(duplicateIdRows.map((d) => [d.rowIndex, d]));

  let analysis = null;
  if (validRows.length > 0) {
    analysis = analyzeImportBatch(db, validRows, rows, duplicateIdRowMap);
  }

  const rowErrors = validation.rowResults
    .filter((r) => !r.valid)
    .map((r) => ({
      rowIndex: r.rowIndex,
      errors: r.errors,
      warnings: r.warnings || []
    }));

  const rowWarnings = validation.rowResults
    .filter((r) => r.valid && r.warnings && r.warnings.length > 0)
    .map((r) => ({
      rowIndex: r.rowIndex,
      warnings: r.warnings
    }));

  const conflictSummary = analysis?.conflictSummary || {
    totalConflictingTasks: 0,
    totalUpdatableTasks: 0,
    byDistrict: [],
    totalIdConflicts: duplicateIdRows.length,
    totalExistingConflicts: 0,
    totalBatchConflicts: 0,
    canAutoCreate: validation.validCount - duplicateIdRows.length,
    canAutoUpdate: duplicateIdRows.length,
    needsResolution: 0
  };

  const pilotSummary = analysis?.pilotSummary || { totalPilots: db.pilots.length, availablePilots: 0, freePilots: 0, busyPilots: 0, pilots: [] };

  const previewResult = {
    totalCount: validation.totalCount,
    validCount: validation.validCount,
    errorCount: validation.errorCount,
    warningCount: validation.warningCount || 0,
    validRowIndices: validRows,
    rowErrors,
    rowWarnings,
    creatable: analysis?.creatable || [],
    updatable: analysis?.updatable || [],
    conflicting: analysis?.conflicting || [],
    creatableCount: analysis?.creatableCount || 0,
    updatableCount: analysis?.updatableCount || 0,
    conflictingCount: analysis?.conflictingCount || 0,
    conflictSummary,
    pilotSummary,
    duplicateIdsWithinBatch: validation.duplicateIdsWithinBatch || [],
    duplicateIdRows,
    canConfirm: validation.validCount > 0
  };

  const session = createImportSession(rows, previewResult);
  const previewedAt = session.createdAt;

  return send(res, 200, {
    sessionId: session.id,
    previewedAt,
    expiresAt: session.expiresAt,
    status: session.status,
    ...previewResult
  });
}

export function handleImportConfirm(db, input, send, res) {
  if (input == null || typeof input !== "object" || Array.isArray(input)) {
    return send(res, 400, { error: "invalid_input", message: "请求体必须为JSON对象，包含 sessionId", code: "body_not_object" });
  }

  const sessionId = input.sessionId;
  if (sessionId == null || typeof sessionId !== "string" || sessionId.trim() === "") {
    return send(res, 400, { error: "missing_session_id", message: "必须提供非空字符串 sessionId", code: "session_id_empty" });
  }

  const overwrite = input.overwrite !== false;

  const selectedRowIndices = input.rows ?? input.selectedRows ?? null;
  if (selectedRowIndices != null && !Array.isArray(selectedRowIndices)) {
    return send(res, 400, { error: "invalid_rows", message: "rows / selectedRows 必须为数组", code: "rows_not_array" });
  }
  if (Array.isArray(selectedRowIndices)) {
    for (let i = 0; i < selectedRowIndices.length; i++) {
      if (typeof selectedRowIndices[i] !== "number" || !Number.isInteger(selectedRowIndices[i]) || selectedRowIndices[i] < 0) {
        return send(res, 400, { error: "invalid_row_index", message: `rows[${i}] 必须为非负整数，实际为 ${JSON.stringify(selectedRowIndices[i])}`, code: "row_index_invalid" });
      }
    }
  }

  const session = getImportSession(sessionId);
  if (!session) {
    return send(res, 404, { error: "session_not_found", message: "导入会话不存在或已过期" });
  }

  if (session.status === "submitted") {
    return send(res, 409, { error: "already_submitted", message: "该会话已提交过" });
  }

  if (session.status === "cancelled") {
    return send(res, 410, { error: "session_cancelled", message: "该会话已取消" });
  }

  let rowIndicesToSubmit;
  if (Array.isArray(selectedRowIndices) && selectedRowIndices.length > 0) {
    const validSet = new Set(session.preview.validRowIndices);
    const outOfRange = selectedRowIndices.filter((idx) => !validSet.has(idx));
    if (outOfRange.length > 0) {
      return send(res, 400, { error: "invalid_row_selection", message: `行索引 ${outOfRange.join(", ")} 不在有效行范围内`, code: "row_out_of_valid_range", invalidIndices: outOfRange });
    }
    rowIndicesToSubmit = [...selectedRowIndices];
  } else {
    rowIndicesToSubmit = [...session.preview.validRowIndices];
  }

  if (rowIndicesToSubmit.length === 0) {
    return send(res, 400, { error: "no_valid_rows", message: "没有可提交的有效行" });
  }

  const existingTaskIds = new Set(db.tasks.map((t) => t.id));
  const results = [];
  const auditSnapshots = [];
  let successCount = 0;
  let failedCount = 0;
  let createdCount = 0;
  let updatedCount = 0;

  for (const rowIndex of rowIndicesToSubmit) {
    const row = session.rows[rowIndex];

    try {
      let task;
      let isUpdate = false;
      let beforeSnapshot = null;

      if (row.id && existingTaskIds.has(row.id)) {
        if (!overwrite) {
          results.push({
            rowIndex,
            taskId: row.id,
            success: false,
            error: "任务ID已存在且未启用覆盖模式",
            code: "duplicate_id_skip"
          });
          failedCount++;
          continue;
        }

        const existingIndex = db.tasks.findIndex((t) => t.id === row.id);
        if (existingIndex >= 0) {
          const existing = db.tasks[existingIndex];
          beforeSnapshot = JSON.parse(JSON.stringify(existing));
          const builtTask = buildTaskFromRow(row);
          existing.vessel = builtTask.vessel;
          existing.district = builtTask.district;
          existing.berthPlan = builtTask.berthPlan;
          existing.tideWindow = builtTask.tideWindow;
          existing.requiredGrade = builtTask.requiredGrade;
          if (builtTask.note) existing.note = builtTask.note;
          addHistory(existing, "updated", row.note || "批量导入更新");
          task = existing;
          isUpdate = true;
        }
      }

      if (!task) {
        const builtTask = buildTaskFromRow(row);
        task = {
          ...builtTask,
          status: DEFAULT_TASK_STATUS,
          pilotId: null,
          history: []
        };
        addHistory(task, "created", row.note || "批量导入创建");
        db.tasks.push(task);
        existingTaskIds.add(task.id);
      }

      auditSnapshots.push({ task, isUpdate, beforeSnapshot });

      successCount++;
      if (isUpdate) {
        updatedCount++;
      } else {
        createdCount++;
      }
      results.push({
        rowIndex,
        taskId: task.id,
        status: isUpdate ? "updated" : "created",
        success: true
      });
    } catch (error) {
      failedCount++;
      results.push({
        rowIndex,
        success: false,
        error: error.message,
        code: "submit_error"
      });
    }
  }

  const beforeSessionSnapshot = JSON.parse(JSON.stringify(session));
  const submittedAt = new Date().toISOString();
  const submittedSession = updateImportSession(sessionId, {
    status: "submitted",
    submittedRows: results,
    submittedAt
  });

  return saveDb(db).then(async () => {
    for (const snapshot of auditSnapshots) {
      const { task, isUpdate, beforeSnapshot } = snapshot;
      await recordAuditEvent({
        objectType: AUDIT_OBJECT_TYPES.TASK,
        objectId: task.id,
        action: isUpdate ? AUDIT_ACTIONS.IMPORT_UPDATE : AUDIT_ACTIONS.IMPORT_CREATE,
        before: beforeSnapshot,
        after: task,
        operator: null,
        note: `批量导入${isUpdate ? "更新" : "创建"}任务 - 会话: ${sessionId}`,
        rollbackable: false
      });
    }

    await recordAuditEvent({
      objectType: AUDIT_OBJECT_TYPES.IMPORT_SESSION,
      objectId: sessionId,
      action: AUDIT_ACTIONS.SUBMIT,
      before: beforeSessionSnapshot,
      after: submittedSession,
      operator: input.operator || null,
      note: `导入会话提交：成功 ${successCount} 条，失败 ${failedCount} 条`,
      rollbackable: false
    });

    return send(res, 200, {
      sessionId,
      submittedAt,
      totalRequested: rowIndicesToSubmit.length,
      successCount,
      createdCount,
      updatedCount,
      failedCount,
      results
    });
  });
}

export function handleImportSessionDetail(db, sessionId, send, res) {
  const session = getImportSession(sessionId);
  if (!session) {
    return send(res, 404, { error: "session_not_found", message: "导入会话不存在或已过期" });
  }

  return send(res, 200, {
    id: session.id,
    createdAt: session.createdAt,
    expiresAt: session.expiresAt,
    status: session.status,
    totalCount: session.metadata.rowCount,
    validCount: session.metadata.validCount,
    errorCount: session.metadata.errorCount,
    creatableCount: session.preview.creatableCount,
    updatableCount: session.preview.updatableCount || 0,
    conflictingCount: session.preview.conflictingCount,
    canConfirm: session.preview.canConfirm,
    submittedAt: session.submittedAt || null,
    cancelledAt: session.cancelledAt || null,
    submittedResults: session.status === "submitted" ? session.submittedRows : null
  });
}

export function handleImportSessionCancel(db, sessionId, send, res) {
  const result = cancelImportSession(sessionId);
  if (!result) {
    return send(res, 404, { error: "session_not_found", message: "导入会话不存在或已过期" });
  }
  if (result.error === "already_submitted") {
    return send(res, 409, { error: "already_submitted", message: "已提交的会话不能取消" });
  }
  return recordAuditEvent({
    objectType: AUDIT_OBJECT_TYPES.IMPORT_SESSION,
    objectId: sessionId,
    action: AUDIT_ACTIONS.CANCEL,
    after: result,
    operator: null,
    note: "取消导入会话",
    rollbackable: false
  }).then(() => send(res, 200, {
    id: result.id,
    status: result.status,
    cancelledAt: result.cancelledAt,
    message: "导入会话已取消"
  }));
}

const VALID_SESSION_STATUSES = ["previewed", "submitted", "cancelled"];

export function validateSessionListParams(searchParams) {
  const errors = [];
  const params = {};

  const status = searchParams.get("status");
  if (status !== null && status !== undefined && status !== "") {
    if (!VALID_SESSION_STATUSES.includes(status)) {
      errors.push({
        field: "status",
        message: `无效的会话状态: ${status}，有效值: ${VALID_SESSION_STATUSES.join(", ")}`,
        code: "invalid_status"
      });
    } else {
      params.status = status;
    }
  }

  const limitRaw = searchParams.get("limit");
  if (limitRaw !== null && limitRaw !== undefined && limitRaw !== "") {
    const limit = Number(limitRaw);
    if (!Number.isInteger(limit) || limit < 1 || limit > 200) {
      errors.push({
        field: "limit",
        message: "limit 必须为 1~200 之间的整数",
        code: "invalid_limit"
      });
    } else {
      params.limit = limit;
    }
  }

  const offsetRaw = searchParams.get("offset");
  if (offsetRaw !== null && offsetRaw !== undefined && offsetRaw !== "") {
    const offset = Number(offsetRaw);
    if (!Number.isInteger(offset) || offset < 0) {
      errors.push({
        field: "offset",
        message: "offset 必须为非负整数",
        code: "invalid_offset"
      });
    } else {
      params.offset = offset;
    }
  }

  return {
    valid: errors.length === 0,
    errors,
    params
  };
}

export function handleImportSessionList(db, searchParams, send, res) {
  const validation = validateSessionListParams(searchParams);
  if (!validation.valid) {
    return send(res, 400, {
      error: "invalid_params",
      message: "查询参数无效",
      errors: validation.errors
    });
  }

  const result = listImportSessions(validation.params);
  return send(res, 200, result);
}
