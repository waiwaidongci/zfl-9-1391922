import { loadDb, saveDb, loadAuditLog, saveAuditLog } from "../utils/db.js";
import { handleImportPreview, handleImportConfirm, handleImportSessionCancel } from "../routes/imports.js";
import { createImportSession, deleteImportSession, getImportSession } from "../services/import-session.js";

let passed = 0;
let failed = 0;

function assert(condition, message) {
  if (condition) {
    passed++;
    console.log(`  ✓ ${message}`);
  } else {
    failed++;
    console.log(`  ✗ ${message}`);
  }
}

function makeSend() {
  let capturedStatus;
  let capturedData;
  const send = (res, status, data) => {
    capturedStatus = status;
    capturedData = data;
  };
  const getStatus = () => capturedStatus;
  const getData = () => capturedData;
  return { send, getStatus, getData };
}

function deepClone(obj) {
  return JSON.parse(JSON.stringify(obj));
}

async function withCleanDb(fn) {
  const originalDb = await loadDb();
  const originalAudit = await loadAuditLog();
  try {
    await saveAuditLog({ events: [] });
    return await fn(originalDb);
  } finally {
    await saveDb(originalDb);
    await saveAuditLog(originalAudit);
  }
}

function makeNewRows(count) {
  return Array.from({ length: count }, (_, i) => ({
    vessel: { name: `导入测试船${i}`, type: "散货船" },
    district: "东港",
    tideWindow: { start: "2026-07-20T02:00:00.000Z", end: "2026-07-20T05:00:00.000Z" },
    requiredGrade: "B"
  }));
}

function makeRowWithExistingId(existingId) {
  return {
    id: existingId,
    vessel: { name: "已有任务更新船", type: "散货船" },
    district: "东港",
    tideWindow: { start: "2026-07-20T06:00:00.000Z", end: "2026-07-20T09:00:00.000Z" },
    requiredGrade: "B"
  };
}

function makeMixedRows() {
  return [
    ...makeNewRows(3),
    makeRowWithExistingId("T-260614-02"),
    ...makeNewRows(2)
  ];
}

async function runTests() {
  console.log("\n=== 导入任务预览与确认流程回归测试 ===\n");

  console.log("\n--- 1. 预览生成sessionId后仅提交selectedRows ---");
  await withCleanDb(async (originalDb) => {
    const db = deepClone(originalDb);
    const { send, getStatus, getData } = makeSend();
    const mockRes = {};

    const rows = makeMixedRows();

    handleImportPreview(db, { tasks: rows }, send, mockRes);
    assert(getStatus() === 200, `预览返回200，实际=${getStatus()}`);
    const previewData = getData();
    assert(typeof previewData.sessionId === "string" && previewData.sessionId.length > 0, "预览返回sessionId");
    assert(previewData.validCount > 0, `预览存在有效行，validCount=${previewData.validCount}`);

    const sessionId = previewData.sessionId;
    const validIndices = previewData.validRowIndices;
    assert(validIndices.length >= 5, `有效行数>=5，实际=${validIndices.length}`);

    const selectedRows = [validIndices[0], validIndices[2]];
    const confirmSend = makeSend();
    await handleImportConfirm(db, { sessionId, selectedRows }, confirmSend.send, mockRes);
    assert(confirmSend.getStatus() === 200, `确认提交返回200，实际=${confirmSend.getStatus()}`);
    const confirmData = confirmSend.getData();
    assert(confirmData.totalRequested === 2, `仅提交2行，实际=${confirmData.totalRequested}`);
    assert(confirmData.successCount === 2, `成功2行，实际=${confirmData.successCount}`);
    assert(confirmData.results.length === 2, `results长度为2，实际=${confirmData.results.length}`);

    const submittedIndices = confirmData.results.map((r) => r.rowIndex);
    assert(submittedIndices[0] === selectedRows[0] && submittedIndices[1] === selectedRows[1], "提交结果行索引与selectedRows一致");

    const newTaskCount = db.tasks.filter(
      (t) => !originalDb.tasks.some((ot) => ot.id === t.id)
    ).length;
    assert(newTaskCount === 2, `DB新增2个任务，实际=${newTaskCount}`);

    deleteImportSession(sessionId);
  });

  console.log("\n--- 2. 重复提交同一session返回409 ---");
  await withCleanDb(async (originalDb) => {
    const db = deepClone(originalDb);
    const mockRes = {};

    const rows = makeNewRows(2);

    const previewSend = makeSend();
    handleImportPreview(db, { tasks: rows }, previewSend.send, mockRes);
    const sessionId = previewSend.getData().sessionId;

    const confirm1Send = makeSend();
    await handleImportConfirm(db, { sessionId }, confirm1Send.send, mockRes);
    assert(confirm1Send.getStatus() === 200, `首次提交返回200，实际=${confirm1Send.getStatus()}`);
    assert(confirm1Send.getData().successCount > 0, "首次提交有成功记录");

    const sessionAfterFirst = getImportSession(sessionId);
    assert(sessionAfterFirst.status === "submitted", `首次提交后session状态为submitted，实际=${sessionAfterFirst.status}`);

    const confirm2Send = makeSend();
    await handleImportConfirm(db, { sessionId }, confirm2Send.send, mockRes);
    assert(confirm2Send.getStatus() === 409, `重复提交返回409，实际=${confirm2Send.getStatus()}`);
    assert(confirm2Send.getData().error === "already_submitted", `错误码为already_submitted，实际=${confirm2Send.getData().error}`);

    const confirm3Send = makeSend();
    await handleImportConfirm(db, { sessionId, selectedRows: [0] }, confirm3Send.send, mockRes);
    assert(confirm3Send.getStatus() === 409, `带selectedRows重复提交仍返回409，实际=${confirm3Send.getStatus()}`);

    const taskCountAfter = db.tasks.length;
    assert(taskCountAfter === originalDb.tasks.length + 2, `DB任务数=原始+2，实际=${taskCountAfter}，原始=${originalDb.tasks.length}`);

    deleteImportSession(sessionId);
  });

  console.log("\n--- 3. 取消后再提交返回410 ---");
  await withCleanDb(async (originalDb) => {
    const db = deepClone(originalDb);
    const mockRes = {};

    const rows = makeNewRows(3);

    const previewSend = makeSend();
    handleImportPreview(db, { tasks: rows }, previewSend.send, mockRes);
    const sessionId = previewSend.getData().sessionId;

    const cancelSend = makeSend();
    await handleImportSessionCancel(db, sessionId, cancelSend.send, mockRes);
    assert(cancelSend.getStatus() === 200, `取消返回200，实际=${cancelSend.getStatus()}`);
    assert(cancelSend.getData().status === "cancelled", `取消后状态为cancelled，实际=${cancelSend.getData().status}`);

    const sessionAfterCancel = getImportSession(sessionId);
    assert(sessionAfterCancel.status === "cancelled", `getImportSession确认状态为cancelled，实际=${sessionAfterCancel.status}`);

    const confirmSend = makeSend();
    await handleImportConfirm(db, { sessionId }, confirmSend.send, mockRes);
    assert(confirmSend.getStatus() === 410, `取消后提交返回410，实际=${confirmSend.getStatus()}`);
    assert(confirmSend.getData().error === "session_cancelled", `错误码为session_cancelled，实际=${confirmSend.getData().error}`);

    const confirmWithRowsSend = makeSend();
    await handleImportConfirm(db, { sessionId, selectedRows: [0] }, confirmWithRowsSend.send, mockRes);
    assert(confirmWithRowsSend.getStatus() === 410, `带selectedRows取消后提交也返回410，实际=${confirmWithRowsSend.getStatus()}`);

    assert(db.tasks.length === originalDb.tasks.length, `DB任务数未增加，仍为${originalDb.tasks.length}`);

    deleteImportSession(sessionId);
  });

  console.log("\n--- 4. overwrite=false遇到已有任务ID跳过 ---");
  await withCleanDb(async (originalDb) => {
    const db = deepClone(originalDb);
    const mockRes = {};

    const existingId = "T-260614-02";
    const existingTask = db.tasks.find((t) => t.id === existingId);
    assert(!!existingTask, `预置数据中存在任务${existingId}`);

    const rows = [
      makeRowWithExistingId(existingId),
      ...makeNewRows(2)
    ];

    const previewSend = makeSend();
    handleImportPreview(db, { tasks: rows }, previewSend.send, mockRes);
    const previewData = previewSend.getData();
    assert(getImportSession(previewData.sessionId) !== null, "预览创建session成功");
    const sessionId = previewData.sessionId;

    const duplicateIdRows = previewData.duplicateIdRows || [];
    assert(duplicateIdRows.length === 1, `duplicateIdRows含1条已有ID行，实际=${duplicateIdRows.length}`);
    assert(duplicateIdRows[0].id === existingId, `重复ID为${existingId}`);

    const confirmSend = makeSend();
    await handleImportConfirm(db, { sessionId, overwrite: false }, confirmSend.send, mockRes);
    assert(confirmSend.getStatus() === 200, `overwrite=false提交返回200，实际=${confirmSend.getStatus()}`);
    const confirmData = confirmSend.getData();

    const duplicateResult = confirmData.results.find((r) => r.taskId === existingId);
    assert(!!duplicateResult, `结果中包含已有ID行`);
    assert(duplicateResult.success === false, `已有ID行success=false`);
    assert(duplicateResult.code === "duplicate_id_skip", `已有ID行code=duplicate_id_skip，实际=${duplicateResult.code}`);

    assert(confirmData.failedCount === 1, `1行因重复ID失败，实际=${confirmData.failedCount}`);
    assert(confirmData.createdCount === 2, `2行新建成功，实际=${confirmData.createdCount}`);
    assert(confirmData.updatedCount === 0, `0行更新（overwrite=false跳过），实际=${confirmData.updatedCount}`);

    const existingTaskAfter = db.tasks.find((t) => t.id === existingId);
    assert(existingTaskAfter.district === existingTask.district, "已有任务district未被修改");
    assert(existingTaskAfter.vessel.name === existingTask.vessel.name, "已有任务vessel.name未被修改");

    deleteImportSession(sessionId);
  });

  console.log("\n--- 5. overwrite=false仅跳过已有ID行，其余行正常创建 ---");
  await withCleanDb(async (originalDb) => {
    const db = deepClone(originalDb);
    const mockRes = {};

    const rows = [
      makeRowWithExistingId("T-260614-01"),
      makeRowWithExistingId("T-260614-02"),
      ...makeNewRows(3)
    ];

    const previewSend = makeSend();
    handleImportPreview(db, { tasks: rows }, previewSend.send, mockRes);
    const sessionId = previewSend.getData().sessionId;

    const confirmSend = makeSend();
    await handleImportConfirm(db, { sessionId, overwrite: false }, confirmSend.send, mockRes);
    const confirmData = confirmSend.getData();
    assert(confirmSend.getStatus() === 200, "多行重复ID+新建行混合返回200");

    const failedResults = confirmData.results.filter((r) => !r.success);
    const successResults = confirmData.results.filter((r) => r.success);
    assert(failedResults.length === 2, `2行重复ID失败，实际=${failedResults.length}`);
    assert(successResults.length === 3, `3行新建成功，实际=${successResults.length}`);
    assert(failedResults.every((r) => r.code === "duplicate_id_skip"), "失败行均为duplicate_id_skip");

    assert(db.tasks.length === originalDb.tasks.length + 3, `DB新增3个任务，实际增加了${db.tasks.length - originalDb.tasks.length}`);

    for (const existingId of ["T-260614-01", "T-260614-02"]) {
      const task = db.tasks.find((t) => t.id === existingId);
      const original = originalDb.tasks.find((t) => t.id === existingId);
      assert(task.vessel.name === original.vessel.name, `任务${existingId}未被覆盖`);
    }

    deleteImportSession(sessionId);
  });

  console.log("\n--- 6. overwrite=true（默认）遇到已有任务ID执行更新 ---");
  await withCleanDb(async (originalDb) => {
    const db = deepClone(originalDb);
    const mockRes = {};

    const existingId = "T-260614-02";
    const rows = [
      makeRowWithExistingId(existingId),
      ...makeNewRows(1)
    ];

    const previewSend = makeSend();
    handleImportPreview(db, { tasks: rows }, previewSend.send, mockRes);
    const sessionId = previewSend.getData().sessionId;

    const confirmSend = makeSend();
    await handleImportConfirm(db, { sessionId }, confirmSend.send, mockRes);
    assert(confirmSend.getStatus() === 200, `默认overwrite=true返回200`);
    const confirmData = confirmSend.getData();

    assert(confirmData.updatedCount === 1, `1行更新成功，实际=${confirmData.updatedCount}`);
    assert(confirmData.createdCount === 1, `1行新建成功，实际=${confirmData.createdCount}`);

    const updatedTask = db.tasks.find((t) => t.id === existingId);
    assert(updatedTask.vessel.name === "已有任务更新船", "已有任务vessel.name已被覆盖更新");
    assert(updatedTask.district === "东港", "已有任务district已被覆盖更新");

    deleteImportSession(sessionId);
  });

  console.log("\n--- 7. selectedRows仅选已有ID行 + overwrite=false全部跳过 ---");
  await withCleanDb(async (originalDb) => {
    const db = deepClone(originalDb);
    const mockRes = {};

    const rows = [
      makeRowWithExistingId("T-260614-01"),
      makeRowWithExistingId("T-260614-02")
    ];

    const previewSend = makeSend();
    handleImportPreview(db, { tasks: rows }, previewSend.send, mockRes);
    const sessionId = previewSend.getData().sessionId;

    const confirmSend = makeSend();
    await handleImportConfirm(db, { sessionId, overwrite: false }, confirmSend.send, mockRes);
    assert(confirmSend.getStatus() === 200, "全部行被跳过也返回200");
    const confirmData = confirmSend.getData();

    assert(confirmData.failedCount === 2, `2行全部因重复ID失败，实际=${confirmData.failedCount}`);
    assert(confirmData.successCount === 0, `0行成功，实际=${confirmData.successCount}`);
    assert(confirmData.createdCount === 0, `0行新建，实际=${confirmData.createdCount}`);

    deleteImportSession(sessionId);
  });

  console.log("\n--- 8. 预览后selectedRows包含无效行索引被拒绝 ---");
  await withCleanDb(async (originalDb) => {
    const db = deepClone(originalDb);
    const mockRes = {};

    const rows = makeNewRows(3);

    const previewSend = makeSend();
    handleImportPreview(db, { tasks: rows }, previewSend.send, mockRes);
    const sessionId = previewSend.getData().sessionId;

    const confirmSend = makeSend();
    await handleImportConfirm(db, { sessionId, selectedRows: [0, 999] }, confirmSend.send, mockRes);
    assert(confirmSend.getStatus() === 400, `selectedRows含无效索引返回400，实际=${confirmSend.getStatus()}`);
    assert(confirmSend.getData().error === "invalid_row_selection", `错误码为invalid_row_selection`);
    assert(confirmSend.getData().invalidIndices.includes(999), "返回无效索引999");

    const sessionNotSubmitted = getImportSession(sessionId);
    assert(sessionNotSubmitted.status === "previewed", `无效索引提交失败后session仍为previewed`);

    deleteImportSession(sessionId);
  });

  console.log("\n--- 9. sessionId不存在时提交返回404 ---");
  await withCleanDb(async (originalDb) => {
    const db = deepClone(originalDb);
    const mockRes = {};

    const confirmSend = makeSend();
    await handleImportConfirm(db, { sessionId: "IMP-NONEXISTENT-12345" }, confirmSend.send, mockRes);
    assert(confirmSend.getStatus() === 404, `不存在的sessionId返回404，实际=${confirmSend.getStatus()}`);
    assert(confirmSend.getData().error === "session_not_found", `错误码为session_not_found`);
  });

  console.log("\n--- 10. 预览→确认完整链路验证审计日志写入 ---");
  await withCleanDb(async (originalDb) => {
    const db = deepClone(originalDb);
    const mockRes = {};

    const rows = makeNewRows(2);

    const previewSend = makeSend();
    handleImportPreview(db, { tasks: rows }, previewSend.send, mockRes);
    const sessionId = previewSend.getData().sessionId;

    const confirmSend = makeSend();
    await handleImportConfirm(db, { sessionId, operator: "回归测试员" }, confirmSend.send, mockRes);
    assert(confirmSend.getStatus() === 200, "完整链路确认提交返回200");

    const auditLog = await loadAuditLog();
    const importCreateEvents = auditLog.events.filter((e) => e.action === "import_create");
    assert(importCreateEvents.length === 2, `审计日志包含2条import_create事件，实际=${importCreateEvents.length}`);

    const sessionSubmitEvents = auditLog.events.filter((e) => e.action === "submit" && e.objectType === "importSession");
    assert(sessionSubmitEvents.length === 1, `审计日志包含1条importSession submit事件`);
    assert(sessionSubmitEvents[0].objectId === sessionId, "submit事件关联正确sessionId");

    deleteImportSession(sessionId);
  });

  console.log(`\n=== 测试结果: ${passed} 通过, ${failed} 失败 ===\n`);
  process.exit(failed > 0 ? 1 : 0);
}

runTests().catch((err) => {
  console.error("测试执行失败:", err);
  process.exit(1);
});
