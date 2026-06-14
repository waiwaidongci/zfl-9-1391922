import { saveDb } from "../utils/db.js";
import { validateTaskBatch, buildTaskFromRow } from "../utils/validator.js";
import { analyzeImportBatch } from "../services/candidate-reuse.js";
import { createImportSession, getImportSession, updateImportSession } from "../services/import-session.js";
import { DEFAULT_TASK_STATUS } from "../config/scheduling-rules.js";

function addHistory(task, action, note) {
  task.history.push({ at: new Date().toISOString(), action, note });
}

export function handleImportPreview(db, input, send, res) {
  const rows = input?.tasks || input?.rows || input;

  if (!Array.isArray(rows)) {
    return send(res, 400, { error: "invalid_input", message: "请求体必须包含 tasks 或 rows 数组" });
  }

  if (rows.length === 0) {
    return send(res, 400, { error: "empty_batch", message: "导入数据不能为空" });
  }

  if (rows.length > 500) {
    return send(res, 400, { error: "batch_too_large", message: "单次导入不能超过 500 条" });
  }

  const existingTaskIds = new Set(db.tasks.map((t) => t.id));
  const validation = validateTaskBatch(rows, existingTaskIds);

  const validRows = validation.validRows;
  const validRowData = validRows.map((i) => rows[i]);

  let analysis = null;
  if (validRows.length > 0) {
    analysis = analyzeImportBatch(db, validRows, rows);
  }

  const rowErrors = validation.rowResults
    .map((r) => ({
      rowIndex: r.rowIndex,
      valid: r.valid,
      errors: r.errors || [],
      warnings: r.warnings || []
    }));

  const previewResult = {
    totalCount: validation.totalCount,
    validCount: validation.validCount,
    errorCount: validation.errorCount,
    warningCount: validation.rowResults.reduce((sum, r) => sum + (r.warnings?.length || 0), 0),
    validRows: validation.validRows,
    duplicateExistingIds: validation.duplicateExistingIds || [],
    batchDuplicateIds: validation.batchDuplicateIds || [],
    rowErrors,
    creatable: analysis?.creatable || [],
    conflicting: analysis?.conflicting || [],
    creatableCount: analysis?.creatableCount || 0,
    conflictingCount: analysis?.conflictingCount || 0,
    pilotSummary: analysis?.pilotSummary || { totalPilots: 0, availablePilots: 0, pilots: [] }
  };

  const session = createImportSession(rows, previewResult);

  return send(res, 200, {
    sessionId: session.id,
    expiresAt: session.expiresAt,
    ...previewResult,
    validRows: undefined
  });
}

export function handleImportSubmit(db, input, send, res) {
  const sessionId = input?.sessionId;
  const selectedRowIndices = input?.rows || input?.selectedRows || null;
  const updateMode = input?.updateMode === true;

  if (!sessionId) {
    return send(res, 400, { error: "missing_session_id", message: "必须提供 sessionId" });
  }

  const session = getImportSession(sessionId);
  if (!session) {
    return send(res, 404, { error: "session_not_found", message: "导入会话不存在或已过期" });
  }

  if (session.status === "submitted") {
    return send(res, 409, { error: "already_submitted", message: "该会话已提交过" });
  }

  let rowIndicesToSubmit;
  if (selectedRowIndices && Array.isArray(selectedRowIndices) && selectedRowIndices.length > 0) {
    const validSet = new Set(session.preview.validRows || []);
    rowIndicesToSubmit = selectedRowIndices
      .filter((idx) => typeof idx === "number" && idx >= 0 && idx < session.rows.length)
      .filter((idx) => validSet.has(idx));
  } else {
    rowIndicesToSubmit = session.preview.validRows || [];
  }

  if (rowIndicesToSubmit.length === 0) {
    return send(res, 400, { error: "no_valid_rows", message: "没有可提交的有效行" });
  }

  const existingTaskIds = new Map(db.tasks.map((t, idx) => [t.id, idx]));
  const processedIds = new Set();
  const results = [];
  let successCount = 0;
  let failedCount = 0;
  let skippedCount = 0;
  let createdCount = 0;
  let updatedCount = 0;

  for (const rowIndex of rowIndicesToSubmit) {
    const row = session.rows[rowIndex];

    try {
      let task;
      let isUpdate = false;

      if (row.id) {
        if (processedIds.has(row.id)) {
          skippedCount++;
          results.push({
            rowIndex,
            taskId: row.id,
            success: false,
            skipped: true,
            status: "skipped",
            error: `批次内重复处理的任务ID: ${row.id}`
          });
          continue;
        }

        if (existingTaskIds.has(row.id)) {
          if (!updateMode) {
            skippedCount++;
            results.push({
              rowIndex,
              taskId: row.id,
              success: false,
              skipped: true,
              status: "skipped",
              error: `任务ID已存在，跳过: ${row.id} (如需更新请设置 updateMode=true)`,
              conflictType: "existing_id"
            });
            continue;
          }

          const existingIndex = existingTaskIds.get(row.id);
          if (existingIndex >= 0) {
            const existing = db.tasks[existingIndex];
            const builtTask = buildTaskFromRow(row);
            existing.vessel = builtTask.vessel;
            existing.district = builtTask.district;
            existing.berthPlan = builtTask.berthPlan;
            existing.tideWindow = builtTask.tideWindow;
            existing.requiredGrade = builtTask.requiredGrade;
            if (row.note) existing.note = row.note;
            addHistory(existing, "updated", row.note || "批量导入更新");
            task = existing;
            isUpdate = true;
            updatedCount++;
          }
        }

        if (!isUpdate) {
          processedIds.add(row.id);
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
        existingTaskIds.set(task.id, db.tasks.length - 1);
        if (task.id) processedIds.add(task.id);
        createdCount++;
      }

      successCount++;
      results.push({
        rowIndex,
        taskId: task.id,
        status: isUpdate ? "updated" : "created",
        success: true,
        vesselName: task.vessel?.name || ""
      });
    } catch (error) {
      failedCount++;
      results.push({
        rowIndex,
        taskId: row?.id || null,
        success: false,
        error: error.message,
        errorStack: process.env.NODE_ENV === "development" ? error.stack : undefined
      });
    }
  }

  const actualSkipped = rowIndicesToSubmit.length - successCount - failedCount;
  if (actualSkipped !== skippedCount) skippedCount = actualSkipped;

  updateImportSession(sessionId, {
    status: "submitted",
    submittedRows: results,
    submittedAt: new Date().toISOString(),
    summary: {
      totalRequested: rowIndicesToSubmit.length,
      successCount,
      createdCount,
      updatedCount,
      failedCount,
      skippedCount
    }
  });

  return saveDb(db).then(() => send(res, 200, {
    sessionId,
    totalRequested: rowIndicesToSubmit.length,
    successCount,
    createdCount,
    updatedCount,
    failedCount,
    skippedCount,
    partialSuccess: failedCount > 0 || skippedCount > 0,
    allSuccess: failedCount === 0 && skippedCount === 0,
    results
  }));
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
    preview: {
      totalCount: session.preview.totalCount,
      validCount: session.preview.validCount,
      errorCount: session.preview.errorCount,
      warningCount: session.preview.warningCount || 0,
      creatableCount: session.preview.creatableCount || 0,
      conflictingCount: session.preview.conflictingCount || 0,
      duplicateExistingIds: session.preview.duplicateExistingIds || [],
      batchDuplicateIds: session.preview.batchDuplicateIds || []
    },
    submission: session.status === "submitted" ? {
      submittedAt: session.submittedAt,
      summary: session.summary || null,
      rowCount: session.submittedRows?.length || 0
    } : null
  });
}
