import { createImportSession, getImportSession, updateImportSession, cancelImportSession, listImportSessions, cleanExpiredSessions, deleteImportSession, getSessionCount } from "../services/import-session.js";
import { validateSessionListParams, handleImportSessionList } from "../routes/imports.js";
import { loadDb } from "../utils/db.js";

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

function makeParams(obj) {
  const sp = new URLSearchParams();
  for (const [key, value] of Object.entries(obj)) {
    if (value !== null && value !== undefined) {
      sp.set(key, String(value));
    }
  }
  return sp;
}

function makePreviewResult(validCount, errorCount) {
  return {
    totalCount: validCount + errorCount,
    validCount,
    errorCount,
    warningCount: 0,
    validRowIndices: Array.from({ length: validCount }, (_, i) => i),
    rowErrors: [],
    rowWarnings: [],
    creatable: [],
    updatable: [],
    conflicting: [],
    creatableCount: 0,
    updatableCount: 0,
    conflictingCount: 0,
    conflictSummary: {},
    pilotSummary: {},
    duplicateIdsWithinBatch: [],
    duplicateIdRows: [],
    canConfirm: validCount > 0
  };
}

function makeRows(count) {
  return Array.from({ length: count }, (_, i) => ({
    vessel: { name: `测试船${i}`, type: "散货船" },
    district: "东港",
    tideWindow: { start: "2026-06-20T02:00:00.000Z", end: "2026-06-20T05:00:00.000Z" },
    requiredGrade: "B"
  }));
}

async function runTests() {
  console.log("\n=== 导入会话模块验证测试 ===\n");

  const db = await loadDb();
  const initialCount = getSessionCount();
  console.log(`初始会话数: ${initialCount}`);

  console.log("\n--- 1. listImportSessions 基础功能测试 ---");
  {
    const beforeClean = cleanExpiredSessions();

    const s1 = createImportSession(makeRows(5), makePreviewResult(4, 1));
    const s2 = createImportSession(makeRows(3), makePreviewResult(2, 1));
    const s3 = createImportSession(makeRows(10), makePreviewResult(10, 0));

    const result = listImportSessions();
    assert(result.total >= 3, `列表返回至少3条会话，实际=${result.total}`);
    assert(result.offset === 0, "默认 offset=0");
    assert(result.limit === 20, "默认 limit=20");
    assert(Array.isArray(result.sessions), "sessions 是数组");
    assert(result.sessions.length >= 3, "sessions 数组长度符合");

    const s1Summary = result.sessions.find((s) => s.id === s1.id);
    assert(s1Summary !== undefined, "列表中包含 s1");
    assert(s1Summary.createdAt === s1.createdAt, "s1 createdAt 正确");
    assert(s1Summary.expiresAt === s1.expiresAt, "s1 expiresAt 正确");
    assert(s1Summary.status === "previewed", "s1 初始状态为 previewed");
    assert(s1Summary.rowCount === 5, `s1 rowCount=5，实际=${s1Summary.rowCount}`);
    assert(s1Summary.validCount === 4, `s1 validCount=4，实际=${s1Summary.validCount}`);
    assert(s1Summary.errorCount === 1, `s1 errorCount=1，实际=${s1Summary.errorCount}`);
    assert(s1Summary.submittedAt === null, "s1 submittedAt 为 null");
    assert(s1Summary.cancelledAt === null, "s1 cancelledAt 为 null");

    assert(!("rows" in s1Summary), "列表摘要不包含完整 rows 数据");
    assert(!("preview" in s1Summary), "列表摘要不包含完整 preview 数据");

    deleteImportSession(s1.id);
    deleteImportSession(s2.id);
    deleteImportSession(s3.id);
  }

  console.log("\n--- 2. 按状态筛选测试 ---");
  {
    const sPreviewed = createImportSession(makeRows(2), makePreviewResult(2, 0));
    const sSubmitted = createImportSession(makeRows(3), makePreviewResult(3, 0));
    updateImportSession(sSubmitted.id, { status: "submitted", submittedAt: new Date().toISOString(), submittedRows: [] });
    const sCancelled = createImportSession(makeRows(4), makePreviewResult(3, 1));
    cancelImportSession(sCancelled.id);

    const allResult = listImportSessions();
    const previewedResult = listImportSessions({ status: "previewed" });
    const submittedResult = listImportSessions({ status: "submitted" });
    const cancelledResult = listImportSessions({ status: "cancelled" });

    assert(previewedResult.sessions.some((s) => s.id === sPreviewed.id), "previewed 筛选包含 sPreviewed");
    assert(!previewedResult.sessions.some((s) => s.id === sSubmitted.id), "previewed 筛选不包含 sSubmitted");
    assert(!previewedResult.sessions.some((s) => s.id === sCancelled.id), "previewed 筛选不包含 sCancelled");

    assert(submittedResult.sessions.some((s) => s.id === sSubmitted.id), "submitted 筛选包含 sSubmitted");
    assert(submittedResult.sessions.every((s) => s.status === "submitted"), "submitted 筛选结果全部为 submitted 状态");

    assert(cancelledResult.sessions.some((s) => s.id === sCancelled.id), "cancelled 筛选包含 sCancelled");
    assert(cancelledResult.sessions.every((s) => s.status === "cancelled"), "cancelled 筛选结果全部为 cancelled 状态");

    const sSubmittedInList = submittedResult.sessions.find((s) => s.id === sSubmitted.id);
    assert(sSubmittedInList.submittedAt !== null, "submitted 会话的 submittedAt 有值");

    const sCancelledInList = cancelledResult.sessions.find((s) => s.id === sCancelled.id);
    assert(sCancelledInList.cancelledAt !== null, "cancelled 会话的 cancelledAt 有值");

    deleteImportSession(sPreviewed.id);
    deleteImportSession(sSubmitted.id);
    deleteImportSession(sCancelled.id);
  }

  console.log("\n--- 3. 分页测试 ---");
  {
    const created = [];
    for (let i = 0; i < 15; i++) {
      created.push(createImportSession(makeRows(i + 1), makePreviewResult(i, 1)));
    }

    const page1 = listImportSessions({ limit: 5, offset: 0 });
    assert(page1.sessions.length === 5, `第1页返回5条，实际=${page1.sessions.length}`);
    assert(page1.total >= 15, `total >= 15，实际=${page1.total}`);
    assert(page1.limit === 5, "page1 limit=5");
    assert(page1.offset === 0, "page1 offset=0");

    const page2 = listImportSessions({ limit: 5, offset: 5 });
    assert(page2.sessions.length === 5, `第2页返回5条，实际=${page2.sessions.length}`);
    assert(page2.offset === 5, "page2 offset=5");

    const page1Ids = new Set(page1.sessions.map((s) => s.id));
    const page2Ids = new Set(page2.sessions.map((s) => s.id));
    const overlap = [...page1Ids].filter((id) => page2Ids.has(id));
    assert(overlap.length === 0, "分页之间无重叠");

    const page3 = listImportSessions({ limit: 5, offset: 10 });
    assert(page3.sessions.length === 5, `第3页返回5条，实际=${page3.sessions.length}`);

    const page4 = listImportSessions({ limit: 5, offset: 999 });
    assert(page4.sessions.length === 0, "超出范围的分页返回空数组");
    assert(page4.total >= 15, "超出范围时 total 仍正确");

    for (const s of created) {
      deleteImportSession(s.id);
    }
  }

  console.log("\n--- 4. 排序测试（按创建时间倒序） ---");
  {
    const timestamps = [];
    const created = [];
    for (let i = 0; i < 5; i++) {
      const s = createImportSession(makeRows(1), makePreviewResult(1, 0));
      created.push(s);
      timestamps.push(new Date(s.createdAt).getTime());
    }

    const result = listImportSessions({ limit: 20 });
    const resultTimes = result.sessions
      .filter((s) => created.some((c) => c.id === s.id))
      .map((s) => new Date(s.createdAt).getTime());

    let sortedDesc = true;
    for (let i = 1; i < resultTimes.length; i++) {
      if (resultTimes[i] > resultTimes[i - 1]) {
        sortedDesc = false;
        break;
      }
    }
    assert(sortedDesc, "会话按创建时间倒序排列");

    for (const s of created) {
      deleteImportSession(s.id);
    }
  }

  console.log("\n--- 5. 过期会话自动清理测试 ---");
  {
    const sNormal = createImportSession(makeRows(2), makePreviewResult(2, 0));

    const sExpired = createImportSession(makeRows(3), makePreviewResult(2, 1));
    sExpired.expiresAt = new Date(Date.now() - 10000).toISOString();
    const sessionsMap = await import("../services/import-session.js");
    const mod = await import("../services/import-session.js");

    const beforeCount = getSessionCount();
    const cleaned = cleanExpiredSessions();
    const afterCount = getSessionCount();
    assert(cleaned >= 1, `至少清理1个过期会话，实际=${cleaned}`);
    assert(afterCount <= beforeCount - 1, "清理后会话数减少");

    const fetchedExpired = getImportSession(sExpired.id);
    assert(fetchedExpired === null, "过期会话通过 getImportSession 返回 null");

    const listResult = listImportSessions();
    assert(!listResult.sessions.some((s) => s.id === sExpired.id), "列表不包含过期会话");

    deleteImportSession(sNormal.id);
  }

  console.log("\n--- 6. validateSessionListParams 参数验证测试 ---");
  {
    const v1 = validateSessionListParams(makeParams({}));
    assert(v1.valid === true, "空参数验证通过");
    assert(Object.keys(v1.params).length === 0, "空参数 params 为空");

    const v2 = validateSessionListParams(makeParams({ status: "previewed" }));
    assert(v2.valid === true, "status=previewed 验证通过");
    assert(v2.params.status === "previewed", "params.status 正确");

    const v3 = validateSessionListParams(makeParams({ status: "submitted" }));
    assert(v3.valid === true, "status=submitted 验证通过");

    const v4 = validateSessionListParams(makeParams({ status: "cancelled" }));
    assert(v4.valid === true, "status=cancelled 验证通过");

    const v5 = validateSessionListParams(makeParams({ status: "invalid_status" }));
    assert(v5.valid === false, "非法 status 验证失败");
    assert(v5.errors.some((e) => e.code === "invalid_status"), "含 invalid_status 错误");
    assert(v5.errors.some((e) => e.field === "status"), "错误字段为 status");

    const v6 = validateSessionListParams(makeParams({ limit: 10 }));
    assert(v6.valid === true, "limit=10 验证通过");
    assert(v6.params.limit === 10, "params.limit 正确");

    const v7 = validateSessionListParams(makeParams({ limit: 1 }));
    assert(v7.valid === true, "limit=1（最小值）验证通过");

    const v8 = validateSessionListParams(makeParams({ limit: 200 }));
    assert(v8.valid === true, "limit=200（最大值）验证通过");

    const v9 = validateSessionListParams(makeParams({ limit: 0 }));
    assert(v9.valid === false, "limit=0 验证失败");
    assert(v9.errors.some((e) => e.code === "invalid_limit"), "含 invalid_limit 错误");

    const v10 = validateSessionListParams(makeParams({ limit: 201 }));
    assert(v10.valid === false, "limit=201（超出最大值）验证失败");

    const v11 = validateSessionListParams(makeParams({ limit: "abc" }));
    assert(v11.valid === false, "limit=非数字验证失败");

    const v12 = validateSessionListParams(makeParams({ limit: 3.5 }));
    assert(v12.valid === false, "limit=非整数验证失败");

    const v13 = validateSessionListParams(makeParams({ offset: 0 }));
    assert(v13.valid === true, "offset=0 验证通过");
    assert(v13.params.offset === 0, "params.offset 正确");

    const v14 = validateSessionListParams(makeParams({ offset: 50 }));
    assert(v14.valid === true, "offset=50 验证通过");

    const v15 = validateSessionListParams(makeParams({ offset: -1 }));
    assert(v15.valid === false, "offset=-1（负数）验证失败");
    assert(v15.errors.some((e) => e.code === "invalid_offset"), "含 invalid_offset 错误");

    const v16 = validateSessionListParams(makeParams({ offset: "xyz" }));
    assert(v16.valid === false, "offset=非数字验证失败");

    const v17 = validateSessionListParams(makeParams({ status: "previewed", limit: 10, offset: 20 }));
    assert(v17.valid === true, "全部合法参数组合验证通过");
    assert(v17.params.status === "previewed", "组合 params.status 正确");
    assert(v17.params.limit === 10, "组合 params.limit 正确");
    assert(v17.params.offset === 20, "组合 params.offset 正确");

    const v18 = validateSessionListParams(makeParams({ status: "bad", limit: -5, offset: -10 }));
    assert(v18.valid === false, "全部非法参数组合验证失败");
    assert(v18.errors.length >= 3, "至少3个错误");
  }

  console.log("\n--- 7. handleImportSessionList 路由 mock 测试 ---");
  {
    let capturedStatus;
    let capturedData;
    const mockSend = (res, status, data) => {
      capturedStatus = status;
      capturedData = data;
    };
    const mockRes = {};

    const sA = createImportSession(makeRows(5), makePreviewResult(4, 1));
    const sB = createImportSession(makeRows(3), makePreviewResult(3, 0));
    updateImportSession(sB.id, { status: "submitted", submittedAt: new Date().toISOString(), submittedRows: [] });
    const sC = createImportSession(makeRows(2), makePreviewResult(1, 1));
    cancelImportSession(sC.id);

    handleImportSessionList(db, makeParams({}), mockSend, mockRes);
    assert(capturedStatus === 200, `无参数返回 200，实际=${capturedStatus}`);
    assert(capturedData.total >= 3, "无参数 total 正确");
    assert(capturedData.limit === 20, "无参数默认 limit=20");
    assert(Array.isArray(capturedData.sessions), "sessions 为数组");

    handleImportSessionList(db, makeParams({ status: "submitted" }), mockSend, mockRes);
    assert(capturedStatus === 200, `status=submitted 返回 200，实际=${capturedStatus}`);
    assert(capturedData.sessions.some((s) => s.id === sB.id), "submitted 筛选结果包含 sB");
    assert(capturedData.sessions.every((s) => s.status === "submitted"), "submitted 结果全部为 submitted");

    handleImportSessionList(db, makeParams({ status: "cancelled" }), mockSend, mockRes);
    assert(capturedData.sessions.some((s) => s.id === sC.id), "cancelled 筛选结果包含 sC");

    handleImportSessionList(db, makeParams({ limit: 2, offset: 0 }), mockSend, mockRes);
    assert(capturedStatus === 200, "分页参数返回 200");
    assert(capturedData.sessions.length <= 2, "limit=2 时结果不超过 2 条");

    handleImportSessionList(db, makeParams({ status: "invalid" }), mockSend, mockRes);
    assert(capturedStatus === 400, `非法 status 返回 400，实际=${capturedStatus}`);
    assert(capturedData.error === "invalid_params", "错误类型为 invalid_params");
    assert(Array.isArray(capturedData.errors), "含 errors 数组");

    handleImportSessionList(db, makeParams({ limit: 0 }), mockSend, mockRes);
    assert(capturedStatus === 400, "非法 limit 返回 400");

    handleImportSessionList(db, makeParams({ offset: -1 }), mockSend, mockRes);
    assert(capturedStatus === 400, "非法 offset 返回 400");

    handleImportSessionList(db, makeParams({ status: "previewed", limit: 10, offset: 0 }), mockSend, mockRes);
    assert(capturedStatus === 200, "组合合法参数返回 200");
    assert(capturedData.sessions.every((s) => s.status === "previewed"), "previewed 筛选结果全部正确");
    assert(capturedData.sessions.length <= 10, "limit=10 生效");

    deleteImportSession(sA.id);
    deleteImportSession(sB.id);
    deleteImportSession(sC.id);
  }

  console.log("\n--- 8. 会话摘要字段完整性测试 ---");
  {
    const s = createImportSession(makeRows(8), makePreviewResult(6, 2));

    const listResult = listImportSessions({ status: "previewed" });
    const summary = listResult.sessions.find((x) => x.id === s.id);

    assert("id" in summary, "摘要包含 id");
    assert("createdAt" in summary, "摘要包含 createdAt");
    assert("expiresAt" in summary, "摘要包含 expiresAt");
    assert("status" in summary, "摘要包含 status");
    assert("rowCount" in summary, "摘要包含 rowCount");
    assert("validCount" in summary, "摘要包含 validCount");
    assert("errorCount" in summary, "摘要包含 errorCount");
    assert("submittedAt" in summary, "摘要包含 submittedAt");
    assert("cancelledAt" in summary, "摘要包含 cancelledAt");

    const expectedKeys = ["id", "createdAt", "expiresAt", "status", "rowCount", "validCount", "errorCount", "submittedAt", "cancelledAt"];
    const actualKeys = Object.keys(summary);
    assert(actualKeys.length === expectedKeys.length, `摘要仅含 ${expectedKeys.length} 个字段，实际=${actualKeys.length}`);

    updateImportSession(s.id, { status: "submitted", submittedAt: new Date().toISOString(), submittedRows: [] });
    const listResult2 = listImportSessions({ status: "submitted" });
    const summary2 = listResult2.sessions.find((x) => x.id === s.id);
    assert(summary2.submittedAt !== null, "submitted 后 submittedAt 非空");
    assert(summary2.cancelledAt === null, "submitted 后 cancelledAt 仍为 null");

    cancelImportSession(s.id);
    deleteImportSession(s.id);
  }

  console.log("\n--- 9. 空会话列表测试 ---");
  {
    const beforeCount = getSessionCount();
    const cleanResult = cleanExpiredSessions();

    let capturedStatus;
    let capturedData;
    const mockSend = (res, status, data) => {
      capturedStatus = status;
      capturedData = data;
    };
    const mockRes = {};

    handleImportSessionList(db, makeParams({ status: "previewed" }), mockSend, mockRes);
    assert(capturedStatus === 200, "空列表也返回 200");
    assert(typeof capturedData.total === "number", "空列表也返回 total 数字");
    assert(Array.isArray(capturedData.sessions), "空列表 sessions 为数组");
  }

  console.log("\n--- 10. 服务层导出完整性检查 ---");
  {
    const svc = await import("../services/import-session.js");
    assert(typeof svc.createImportSession === "function", "导出 createImportSession");
    assert(typeof svc.getImportSession === "function", "导出 getImportSession");
    assert(typeof svc.updateImportSession === "function", "导出 updateImportSession");
    assert(typeof svc.cancelImportSession === "function", "导出 cancelImportSession");
    assert(typeof svc.deleteImportSession === "function", "导出 deleteImportSession");
    assert(typeof svc.listImportSessions === "function", "导出 listImportSessions");
    assert(typeof svc.cleanExpiredSessions === "function", "导出 cleanExpiredSessions");
    assert(typeof svc.getSessionCount === "function", "导出 getSessionCount");

    const routes = await import("../routes/imports.js");
    assert(typeof routes.handleImportPreview === "function", "导出 handleImportPreview");
    assert(typeof routes.handleImportConfirm === "function", "导出 handleImportConfirm");
    assert(typeof routes.handleImportSessionDetail === "function", "导出 handleImportSessionDetail");
    assert(typeof routes.handleImportSessionCancel === "function", "导出 handleImportSessionCancel");
    assert(typeof routes.handleImportSessionList === "function", "导出 handleImportSessionList");
    assert(typeof routes.validateSessionListParams === "function", "导出 validateSessionListParams");
  }

  console.log(`\n=== 测试结果: ${passed} 通过, ${failed} 失败 ===\n`);
  process.exit(failed > 0 ? 1 : 0);
}

runTests().catch((err) => {
  console.error("测试执行失败:", err);
  process.exit(1);
});
