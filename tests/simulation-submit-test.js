import { loadDb, saveDb, loadAuditLog } from "../utils/db.js";
import { submitSimulationAssignments } from "../services/simulation/index.js";
import { ASSIGNED_TASK_STATUS } from "../config/scheduling-rules.js";

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

function deepClone(obj) {
  return JSON.parse(JSON.stringify(obj));
}

async function resetDb(originalDb, originalAudit) {
  await saveDb(originalDb);
  const { writeFile } = await import("node:fs/promises");
  const { join } = await import("node:path");
  const { fileURLToPath } = await import("node:url");
  const { dirname } = await import("node:path");
  const __dirname = dirname(fileURLToPath(import.meta.url));
  const auditLogPath = join(__dirname, "..", "data", "audit-log.json");
  await writeFile(auditLogPath, JSON.stringify(originalAudit, null, 2));
}

async function runTests() {
  console.log("\n=== 仿真结果提交模块验证测试 ===\n");

  const originalDb = deepClone(await loadDb());
  const originalAudit = deepClone(await loadAuditLog());

  console.log("--- 1. 基本格式校验 ---");
  {
    const db = deepClone(originalDb);

    let result = await submitSimulationAssignments(db, { assignmentLog: null });
    assert(result.success === false && result.error === "invalid_assignment_log", "null assignmentLog 返回 invalid_assignment_log");
    assert(result.summary.total === 0, "错误时 summary.total=0");

    result = await submitSimulationAssignments(db, { assignmentLog: "not-array" });
    assert(result.success === false && result.error === "invalid_assignment_log", "非数组 assignmentLog 返回 invalid_assignment_log");

    result = await submitSimulationAssignments(db, { assignmentLog: [] });
    assert(result.success === false && result.error === "empty_assignment_log", "空数组返回 empty_assignment_log");

    const tooMany = Array.from({ length: 201 }, (_, i) => ({ taskId: `T-${i}`, pilotId: `P-${i}` }));
    result = await submitSimulationAssignments(db, { assignmentLog: tooMany });
    assert(result.success === false && result.error === "too_many_entries", "超过200条返回 too_many_entries");
  }

  console.log("\n--- 2. 条目格式校验 ---");
  {
    const db = deepClone(originalDb);
    const badEntries = [
      null,
      "string",
      123,
      [],
      {},
      { taskId: null, pilotId: "P-01" },
      { taskId: "", pilotId: "P-01" },
      { taskId: "T-001", pilotId: null },
      { taskId: "T-001", pilotId: "" }
    ];

    const result = await submitSimulationAssignments(db, { assignmentLog: badEntries });
    assert(result.success === false, "格式错误的条目整体失败");
    assert(result.error === "format_validation_failed", "错误类型为 format_validation_failed");
    assert(result.failed.length === badEntries.length, `所有${badEntries.length}条格式错误都被报告`);
    assert(result.failed.every((f) => f.code === "format_validation_failed"), "每条格式错误标记为 format_validation_failed");
  }

  console.log("\n--- 3. 批次内重复任务ID ---");
  {
    const db = deepClone(originalDb);
    const dupLog = [
      { taskId: "T-260614-02", pilotId: "P-03" },
      { taskId: "T-260614-03", pilotId: "P-02" },
      { taskId: "T-260614-02", pilotId: "P-01" }
    ];

    const result = await submitSimulationAssignments(db, { assignmentLog: dupLog });
    assert(result.failed.some((f) => f.code === "duplicate_task_in_batch"), "检测到批次内重复任务ID");
    assert(result.failed.some((f) => f.taskId === "T-260614-02"), "重复的任务ID被正确标记");
  }

  console.log("\n--- 4. 任务不存在校验 ---");
  {
    const db = deepClone(originalDb);
    const log = [{ taskId: "NONEXISTENT-TASK", pilotId: "P-01" }];
    const result = await submitSimulationAssignments(db, { assignmentLog: log });
    assert(result.failed.length === 1, "不存在的任务被拒绝");
    assert(result.failed[0].code === "task_not_found", "错误码为 task_not_found");
  }

  console.log("\n--- 5. 任务终态校验 ---");
  {
    const db = deepClone(originalDb);
    db.tasks.push({
      id: "T-TERMINAL-01",
      status: "cancelled",
      pilotId: null,
      district: "东港",
      vessel: { name: "取消船", type: "散货船" },
      tideWindow: { start: "2026-06-20T08:00:00.000Z", end: "2026-06-20T11:00:00.000Z" },
      requiredGrade: "B",
      history: []
    });
    db.tasks.push({
      id: "T-TERMINAL-02",
      status: "completed",
      pilotId: "P-01",
      district: "东港",
      vessel: { name: "完成船", type: "散货船" },
      tideWindow: { start: "2026-06-20T08:00:00.000Z", end: "2026-06-20T11:00:00.000Z" },
      requiredGrade: "B",
      history: []
    });

    const log = [
      { taskId: "T-TERMINAL-01", pilotId: "P-01" },
      { taskId: "T-TERMINAL-02", pilotId: "P-03" }
    ];
    const result = await submitSimulationAssignments(db, { assignmentLog: log });
    assert(result.failed.length === 2, "终态任务全部被拒绝");
    assert(result.failed.every((f) => f.code === "task_terminal_state"), "错误码为 task_terminal_state");
    assert(result.failed.every((f) => f.detail && f.detail.currentStatus), "包含当前状态详情");
  }

  console.log("\n--- 6. 引航员不存在校验 ---");
  {
    const db = deepClone(originalDb);
    const log = [{ taskId: "T-260614-02", pilotId: "NONEXISTENT-PILOT" }];
    const result = await submitSimulationAssignments(db, { assignmentLog: log });
    assert(result.failed.length === 1, "不存在的引航员被拒绝");
    assert(result.failed[0].code === "pilot_not_found", "错误码为 pilot_not_found");
  }

  console.log("\n--- 7. 重复提交保护（已分配给同一引航员） ---");
  {
    const db = deepClone(originalDb);
    const log = [{ taskId: "T-260614-01", pilotId: "P-01" }];
    const result = await submitSimulationAssignments(db, { assignmentLog: log });
    assert(result.failed.length === 1, "已分配给同一引航员的任务被拒绝");
    assert(result.failed[0].code === "already_assigned_same_pilot", "错误码为 already_assigned_same_pilot");
    assert(result.failed[0].detail && result.failed[0].detail.pilotName === "沈望", "包含引航员姓名详情");
  }

  console.log("\n--- 8. 引航员条件校验 - 休假冲突 ---");
  {
    const db = deepClone(originalDb);
    const log = [{ taskId: "T-260614-04", pilotId: "P-01" }];
    const result = await submitSimulationAssignments(db, { assignmentLog: log });
    assert(result.failed.length === 1, "休假冲突的引航员被拒绝");
    assert(result.failed[0].code === "pilot_not_available", "错误码为 pilot_not_available");
    assert(
      result.failed[0].detail &&
      result.failed[0].detail.disqualifying &&
      result.failed[0].detail.disqualifying.includes("leave_conflict"),
      "disqualifying 包含 leave_conflict"
    );
  }

  console.log("\n--- 9. 引航员条件校验 - 港区不匹配 ---");
  {
    const db = deepClone(originalDb);
    const log = [{ taskId: "T-260614-03", pilotId: "P-04" }];
    const result = await submitSimulationAssignments(db, { assignmentLog: log });
    assert(result.failed.length === 1, "港区不匹配的引航员被拒绝");
    assert(result.failed[0].code === "pilot_not_available", "错误码为 pilot_not_available");
    assert(
      result.failed[0].detail &&
      result.failed[0].detail.disqualifying &&
      result.failed[0].detail.disqualifying.includes("district_mismatch"),
      "disqualifying 包含 district_mismatch"
    );
  }

  console.log("\n--- 10. 成功提交单条任务 ---");
  {
    const db = deepClone(originalDb);
    const taskBefore = deepClone(db.tasks.find((t) => t.id === "T-260614-02"));
    const log = [{ taskId: "T-260614-02", pilotId: "P-03", step: 1, score: 5.0, pilotName: "周屿" }];

    const result = await submitSimulationAssignments(db, {
      assignmentLog: log,
      operator: "调度员A",
      note: "仿真派单测试"
    });

    assert(result.success === true, "单条成功提交返回 success=true");
    assert(result.partialSuccess === undefined || result.partialSuccess === false, "非部分成功");
    assert(result.summary.total === 1, "summary.total=1");
    assert(result.summary.succeeded === 1, "summary.succeeded=1");
    assert(result.summary.failed === 0, "summary.failed=0");
    assert(result.succeeded.length === 1, "succeeded 数组有1条");
    assert(result.succeeded[0].taskId === "T-260614-02", "成功的任务ID正确");
    assert(result.succeeded[0].pilotId === "P-03", "成功的引航员ID正确");
    assert(result.succeeded[0].pilotName === "周屿", "成功的引航员姓名正确");
    assert(result.succeeded[0].previousPilotId === taskBefore.pilotId, "记录了之前的 pilotId");
    assert(result.succeeded[0].previousStatus === taskBefore.status, "记录了之前的 status");

    const taskAfter = db.tasks.find((t) => t.id === "T-260614-02");
    assert(taskAfter.pilotId === "P-03", "真实任务 pilotId 被更新");
    assert(taskAfter.status === ASSIGNED_TASK_STATUS, `真实任务 status 更新为 ${ASSIGNED_TASK_STATUS}`);
    assert(taskAfter.history.length === taskBefore.history.length + 1, "history 增加了1条");
    assert(taskAfter.history[taskAfter.history.length - 1].action === "assigned", "history action 为 assigned");

    const audit = await loadAuditLog();
    const auditEntry = audit.events.find((e) => e.objectId === "T-260614-02" && e.action === "assign");
    assert(auditEntry !== undefined, "审计日志中写入了 assign 事件");
    assert(auditEntry.operator === "调度员A", "审计日志记录了操作人");
    assert(auditEntry.rollbackable === true, "审计事件可回滚");
    assert(auditEntry.before && auditEntry.after, "审计事件包含 before/after 快照");
  }

  console.log("\n--- 11. 成功提交多条任务 ---");
  {
    const db = deepClone(originalDb);
    db.pilots.find((p) => p.id === "P-02").shifts.push({
      start: "2026-06-15T04:00:00.000Z",
      end: "2026-06-15T12:00:00.000Z"
    });
    const log = [
      { taskId: "T-260614-02", pilotId: "P-03" },
      { taskId: "T-260614-03", pilotId: "P-02" }
    ];

    const result = await submitSimulationAssignments(db, { assignmentLog: log });
    assert(result.success === true, "多条成功提交返回 success=true");
    assert(result.summary.succeeded === 2, "2条全部成功");
    assert(result.summary.failed === 0, "0条失败");

    const t02 = db.tasks.find((t) => t.id === "T-260614-02");
    const t03 = db.tasks.find((t) => t.id === "T-260614-03");
    assert(t02.pilotId === "P-03" && t02.status === ASSIGNED_TASK_STATUS, "T-260614-02 被正确分配");
    assert(t03.pilotId === "P-02" && t03.status === ASSIGNED_TASK_STATUS, "T-260614-03 被正确分配");
  }

  console.log("\n--- 12. 部分成功场景（混合成功和失败） ---");
  {
    const db = deepClone(originalDb);
    db.pilots.find((p) => p.id === "P-05").shifts.push({
      start: "2026-06-17T00:00:00.000Z",
      end: "2026-06-17T12:00:00.000Z"
    });
    db.tasks.push({
      id: "T-PARTIAL-TEST",
      status: "pending",
      pilotId: null,
      district: "东港",
      vessel: { name: "部分测试船", type: "散货船" },
      tideWindow: { start: "2026-06-17T06:00:00.000Z", end: "2026-06-17T09:00:00.000Z" },
      requiredGrade: "B",
      history: []
    });
    const log = [
      { taskId: "T-260614-02", pilotId: "P-03" },
      { taskId: "T-260614-04", pilotId: "P-01" },
      { taskId: "NONEXISTENT", pilotId: "P-02" },
      { taskId: "T-PARTIAL-TEST", pilotId: "P-05" }
    ];

    const result = await submitSimulationAssignments(db, { assignmentLog: log });
    assert(result.partialSuccess === true, "存在部分成功标记");
    assert(result.summary.total === 4, "总共4条");
    assert(result.summary.succeeded === 2, "2条成功");
    assert(result.summary.failed === 2, "2条失败");

    const succeededIds = new Set(result.succeeded.map((s) => s.taskId));
    assert(succeededIds.has("T-260614-02"), "T-260614-02 成功");
    assert(succeededIds.has("T-PARTIAL-TEST"), "T-PARTIAL-TEST 成功");

    const failedCodes = result.failed.map((f) => f.code);
    assert(failedCodes.includes("pilot_not_available"), "包含 pilot_not_available 失败");
    assert(failedCodes.includes("task_not_found"), "包含 task_not_found 失败");

    const t02 = db.tasks.find((t) => t.id === "T-260614-02");
    const tpt = db.tasks.find((t) => t.id === "T-PARTIAL-TEST");
    assert(t02.pilotId === "P-03", "成功的任务已更新");
    assert(tpt.pilotId === "P-05", "成功的任务已更新");
  }

  console.log("\n--- 13. 全部失败场景 ---");
  {
    const db = deepClone(originalDb);
    const log = [
      { taskId: "T-260614-04", pilotId: "P-01" },
      { taskId: "NONEXISTENT-1", pilotId: "P-02" },
      { taskId: "T-260614-03", pilotId: "NONEXISTENT-PILOT" }
    ];

    const result = await submitSimulationAssignments(db, { assignmentLog: log });
    assert(result.success === false, "全部失败返回 success=false");
    assert(result.partialSuccess === undefined || result.partialSuccess === false, "不标记为部分成功");
    assert(result.summary.succeeded === 0, "0条成功");
    assert(result.summary.failed === 3, "3条失败");
  }

  console.log("\n--- 14. 路由层 handleSimulationSubmit 行为测试 ---");
  {
    const { handleSimulationSubmit } = await import("../routes/simulation.js");
    const db = deepClone(originalDb);

    let capturedStatus;
    let capturedData;
    const mockSend = (res, status, data) => {
      capturedStatus = status;
      capturedData = data;
    };
    const mockRes = {};

    await handleSimulationSubmit(db, {}, mockSend, mockRes);
    assert(capturedStatus === 400, "缺少 assignmentLog 返回 400");
    assert(capturedData.error === "missing_assignment_log", "错误码为 missing_assignment_log");

    await handleSimulationSubmit(db, { assignmentLog: [{ taskId: null, pilotId: "P-01" }] }, mockSend, mockRes);
    assert(capturedStatus === 400, "格式校验错误返回 400");
    assert(capturedData.error === "format_validation_failed", "格式校验错误码");

    await handleSimulationSubmit(db, { assignmentLog: [{ taskId: "NONEXISTENT", pilotId: "P-01" }] }, mockSend, mockRes);
    assert(capturedStatus === 409, "全部业务校验失败返回 409");

    await handleSimulationSubmit(db, { assignmentLog: [{ taskId: "T-260614-02", pilotId: "P-03" }] }, mockSend, mockRes);
    assert(capturedStatus === 200, "全部成功返回 200");
    assert(capturedData.success === true, "success=true");
  }

  console.log("\n--- 15. 路由层部分成功返回 207 ---");
  {
    const { handleSimulationSubmit } = await import("../routes/simulation.js");
    const db = deepClone(originalDb);

    let capturedStatus;
    let capturedData;
    const mockSend = (res, status, data) => {
      capturedStatus = status;
      capturedData = data;
    };
    const mockRes = {};

    await handleSimulationSubmit(db, {
      assignmentLog: [
        { taskId: "T-260614-02", pilotId: "P-03" },
        { taskId: "NONEXISTENT", pilotId: "P-01" }
      ]
    }, mockSend, mockRes);
    assert(capturedStatus === 207, "部分成功返回 HTTP 207");
    assert(capturedData.partialSuccess === true, "响应标记 partialSuccess");
    assert(capturedData.summary.succeeded === 1 && capturedData.summary.failed === 1, "1成功1失败");
  }

  await resetDb(originalDb, originalAudit);

  console.log(`\n=== 测试结果: ${passed} 通过, ${failed} 失败 ===\n`);
  process.exit(failed > 0 ? 1 : 0);
}

runTests().catch((err) => {
  console.error("测试执行失败:", err);
  process.exit(1);
});
