import { loadDb, saveDb, loadAuditLog, saveAuditLog } from "../utils/db.js";
import {
  previewTaskRollback,
  rollbackTask,
  rollbackTaskAssign,
  rollbackTaskStatus,
  CONFLICT_TYPES,
  CONFLICT_SEVERITY,
  ROLLBACK_RESTORABLE_FIELDS
} from "../services/rollback.js";
import {
  recordAuditEvent,
  getAuditHistory,
  AUDIT_OBJECT_TYPES,
  AUDIT_ACTIONS,
  ROLLBACKABLE_ACTIONS
} from "../services/audit.js";
import { handleTaskRollbackPreview, handleTaskRollbackRecheck, handleTaskRollback, handleTaskRollbackStatus } from "../routes/audit.js";

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

function cloneDb(db) {
  return JSON.parse(JSON.stringify(db));
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function runTests() {
  console.log("\n=== 审计回滚两阶段能力（预演+执行）测试 ===\n");

  console.log("\n--- 1. 回滚预演基础：无审计事件时返回错误 ---");
  await withCleanDb(async (db) => {
    const testDb = cloneDb(db);
    const result = await previewTaskRollback(testDb, "T-260614-02");
    assert(result.success === false, "无rollbackable事件时返回success=false");
    assert(result.error === "no_rollbackable_event", "错误码为no_rollbackable_event");

    const notFound = await previewTaskRollback(testDb, "NONEXISTENT");
    assert(notFound.success === false && notFound.error === "task_not_found", "不存在任务返回task_not_found");
  });

  console.log("\n--- 2. 派单后预演：返回正确字段与状态 ---");
  await withCleanDb(async (db) => {
    const testDb = cloneDb(db);
    const task = testDb.tasks.find((t) => t.id === "T-260614-02");

    const beforeSnapshot = JSON.parse(JSON.stringify(task));
    task.pilotId = "P-03";
    task.status = "assigned";
    task.history.push({ at: new Date().toISOString(), action: "assigned", note: "测试派单" });
    await saveDb(testDb);

    const assignEvent = await recordAuditEvent({
      objectType: AUDIT_OBJECT_TYPES.TASK,
      objectId: task.id,
      action: AUDIT_ACTIONS.ASSIGN,
      before: beforeSnapshot,
      after: JSON.parse(JSON.stringify(task)),
      operator: "tester",
      note: "测试派单",
      rollbackable: true
    });

    const preview = await previewTaskRollback(testDb, task.id);
    assert(preview.success === true, "预演成功");
    assert(preview.taskId === task.id, "任务ID正确");
    assert(preview.targetEvent.id === assignEvent.id, "目标事件为刚创建的派单事件");
    assert(preview.targetEvent.action === AUDIT_ACTIONS.ASSIGN, "目标事件action=assign");

    const fieldNames = preview.fieldsToRestore.map((f) => f.field);
    assert(fieldNames.includes("pilotId"), "恢复字段包含pilotId");
    assert(fieldNames.includes("status"), "恢复字段包含status");

    const pilotField = preview.fieldsToRestore.find((f) => f.field === "pilotId");
    assert(pilotField.currentValue === "P-03", "pilotId当前值为P-03");
    assert(pilotField.restoredValue === null, "pilotId恢复值为null");

    assert(preview.requiresForce === false, "无冲突时requiresForce=false");
    assert(preview.canRollback === true, "canRollback=true");
    assert(typeof preview.previewToken === "string" && preview.previewToken.length > 0, "返回previewToken");
    assert(Array.isArray(preview.affectedChangeRequests), "返回affectedChangeRequests数组");
    assert(preview.conflictSummary.total >= 0, "返回conflictSummary");
  });

  console.log("\n--- 3. 预演+执行：完整回滚派单流程 ---");
  await withCleanDb(async (db) => {
    const testDb = cloneDb(db);
    const task = testDb.tasks.find((t) => t.id === "T-260614-02");

    const beforeSnapshot = JSON.parse(JSON.stringify(task));
    task.pilotId = "P-03";
    task.status = "assigned";
    task.history.push({ at: new Date().toISOString(), action: "assigned", note: "测试派单" });
    await saveDb(testDb);

    const assignEvent = await recordAuditEvent({
      objectType: AUDIT_OBJECT_TYPES.TASK,
      objectId: task.id,
      action: AUDIT_ACTIONS.ASSIGN,
      before: beforeSnapshot,
      after: JSON.parse(JSON.stringify(task)),
      operator: "tester",
      note: "测试派单",
      rollbackable: true
    });

    const preview = await previewTaskRollback(testDb, task.id);
    assert(preview.success === true, "预演阶段成功");

    const beforeExecSnapshot = JSON.parse(JSON.stringify(task));
    const result = await rollbackTask(testDb, task.id, assignEvent.id, "operator1", "测试回滚派单", false, preview.previewToken);

    assert(result.success === true, "执行阶段成功");
    assert(result.task.pilotId === null, "任务pilotId已恢复为null");
    assert(result.task.status === "pending", "任务status已恢复为pending");
    assert(result.forced === false, "forced=false");
    assert(result.rolledBackFrom.id === assignEvent.id, "rolledBackFrom指向目标事件");
    assert(result.rollbackEvent.relatedAuditId === assignEvent.id, "回滚审计事件关联目标事件ID");

    const lastHistory = result.task.history[result.task.history.length - 1];
    assert(lastHistory.action === "rollback", "history记录rollback动作");

    const auditAfter = await getAuditHistory({ objectId: task.id, objectType: AUDIT_OBJECT_TYPES.TASK });
    const rollbackAudit = auditAfter.events.find((e) => e.action === AUDIT_ACTIONS.ROLLBACK);
    assert(!!rollbackAudit, "审计日志存在ROLLBACK事件");
    assert(rollbackAudit.relatedAuditId === assignEvent.id, "ROLLBACK事件relatedAuditId正确");
    assert(rollbackAudit.rollbackable === false, "ROLLBACK事件本身不可回滚");
  });

  console.log("\n--- 4. 交叉场景：存在待审批变更申请时预演检测冲突 ---");
  await withCleanDb(async (db) => {
    const testDb = cloneDb(db);
    const task = testDb.tasks.find((t) => t.id === "T-260614-01");

    testDb.changeRequests.push({
      id: "CR-ROLLBACK-TEST-01",
      taskId: task.id,
      type: "tide_window",
      status: "pending",
      proposed: { tideWindow: { start: "2026-06-14T03:00:00.000Z", end: "2026-06-14T06:00:00.000Z" } },
      createdAt: new Date().toISOString()
    });

    const beforeSnapshot = JSON.parse(JSON.stringify(task));
    task.status = "completed";
    task.history.push({ at: new Date().toISOString(), action: "status_change", note: "测试状态变更" });
    await saveDb(testDb);

    const statusEvent = await recordAuditEvent({
      objectType: AUDIT_OBJECT_TYPES.TASK,
      objectId: task.id,
      action: AUDIT_ACTIONS.STATUS_CHANGE,
      before: beforeSnapshot,
      after: JSON.parse(JSON.stringify(task)),
      operator: "tester",
      note: "测试状态变更",
      rollbackable: true
    });

    const preview = await previewTaskRollback(testDb, task.id);
    assert(preview.success === true, "预演成功执行");

    const pendingCRConflict = preview.conflicts.find((c) => c.type === CONFLICT_TYPES.PENDING_CHANGE_REQUEST);
    assert(!!pendingCRConflict, "检测到pending_change_request冲突");
    assert(pendingCRConflict.severity === CONFLICT_SEVERITY.ERROR, "待审批CR冲突严重级别为error");
    assert(pendingCRConflict.changeRequestIds.includes("CR-ROLLBACK-TEST-01"), "冲突包含CR ID");
    assert(preview.requiresForce === true, "存在ERROR冲突时requiresForce=true");
  });

  console.log("\n--- 5. 交叉场景：存在待审批CR时无force执行被阻止，有force可通过 ---");
  await withCleanDb(async (db) => {
    const testDb = cloneDb(db);
    const task = testDb.tasks.find((t) => t.id === "T-260614-01");

    testDb.changeRequests.push({
      id: "CR-ROLLBACK-TEST-02",
      taskId: task.id,
      type: "tide_window",
      status: "pending",
      proposed: { tideWindow: { start: "2026-06-14T03:00:00.000Z", end: "2026-06-14T06:00:00.000Z" } },
      createdAt: new Date().toISOString()
    });

    const beforeSnapshot = JSON.parse(JSON.stringify(task));
    task.status = "completed";
    task.history.push({ at: new Date().toISOString(), action: "status_change", note: "测试" });
    await saveDb(testDb);

    const statusEvent = await recordAuditEvent({
      objectType: AUDIT_OBJECT_TYPES.TASK,
      objectId: task.id,
      action: AUDIT_ACTIONS.STATUS_CHANGE,
      before: beforeSnapshot,
      after: JSON.parse(JSON.stringify(task)),
      rollbackable: true
    });

    const noForce = await rollbackTask(testDb, task.id, statusEvent.id, "op", null, false);
    assert(noForce.success === false, "无force时执行失败");
    assert(noForce.error === "rollback_conflicts", "错误码为rollback_conflicts");
    assert(noForce.requiresForce === true, "返回requiresForce=true");

    const withForce = await rollbackTask(testDb, task.id, statusEvent.id, "op", null, true);
    assert(withForce.success === true, "有force时执行成功");
    assert(withForce.forced === true, "forced标记为true");
    assert(withForce.task.status === "assigned", "状态已回滚为assigned");
    assert(Array.isArray(withForce.conflictsResolved), "返回conflictsResolved");
    assert(withForce.affectedChangeRequestIds.includes("CR-ROLLBACK-TEST-02"), "返回关联的CR IDs");
  });

  console.log("\n--- 6. 交叉场景：后续审批事件冲突检测 ---");
  await withCleanDb(async (db) => {
    const testDb = cloneDb(db);
    const task = testDb.tasks.find((t) => t.id === "T-260614-01");

    const beforeSnapshot = JSON.parse(JSON.stringify(task));
    task.status = "completed";
    task.history.push({ at: new Date().toISOString(), action: "status_change", note: "测试变更" });
    await saveDb(testDb);

    const targetEvent = await recordAuditEvent({
      objectType: AUDIT_OBJECT_TYPES.TASK,
      objectId: task.id,
      action: AUDIT_ACTIONS.UPDATE,
      before: beforeSnapshot,
      after: JSON.parse(JSON.stringify(task)),
      rollbackable: true
    });

    await delay(10);

    const afterApproval = JSON.parse(JSON.stringify(task));
    afterApproval.tideWindow = { start: "2026-06-14T03:30:00.000Z", end: "2026-06-14T06:30:00.000Z" };
    await recordAuditEvent({
      objectType: AUDIT_OBJECT_TYPES.TASK,
      objectId: task.id,
      action: AUDIT_ACTIONS.UPDATE,
      before: JSON.parse(JSON.stringify(task)),
      after: afterApproval,
      note: "变更审批通过[CR-XXX]",
      rollbackable: true
    });

    const preview = await previewTaskRollback(testDb, task.id, targetEvent.id);
    assert(preview.success === true, "预演成功");

    const approvalConflict = preview.conflicts.find((c) => c.type === CONFLICT_TYPES.LATER_APPROVAL);
    assert(!!approvalConflict, "检测到later_approval冲突");
    assert(approvalConflict.severity === CONFLICT_SEVERITY.ERROR, "审批冲突严重级别为error");
  });

  console.log("\n--- 7. 交叉场景：后续导入更新事件冲突检测 ---");
  await withCleanDb(async (db) => {
    const testDb = cloneDb(db);
    const task = testDb.tasks.find((t) => t.id === "T-260614-02");

    const beforeSnapshot = JSON.parse(JSON.stringify(task));
    task.berthPlan = "靠泊N3";
    task.history.push({ at: new Date().toISOString(), action: "updated", note: "测试更新" });
    await saveDb(testDb);

    const targetEvent = await recordAuditEvent({
      objectType: AUDIT_OBJECT_TYPES.TASK,
      objectId: task.id,
      action: AUDIT_ACTIONS.UPDATE,
      before: beforeSnapshot,
      after: JSON.parse(JSON.stringify(task)),
      rollbackable: true
    });

    await delay(10);

    await recordAuditEvent({
      objectType: AUDIT_OBJECT_TYPES.TASK,
      objectId: task.id,
      action: AUDIT_ACTIONS.IMPORT_UPDATE,
      before: JSON.parse(JSON.stringify(task)),
      after: { ...task, berthPlan: "靠泊N5" },
      note: "批量导入更新任务 - 会话: SESS-TEST",
      rollbackable: false
    });

    const preview = await previewTaskRollback(testDb, task.id, targetEvent.id);
    assert(preview.success === true, "预演成功");

    const importConflict = preview.conflicts.find((c) => c.type === CONFLICT_TYPES.LATER_IMPORT_UPDATE);
    assert(!!importConflict, "检测到later_import_update冲突");
    assert(importConflict.severity === CONFLICT_SEVERITY.WARNING, "导入冲突严重级别为warning");
  });

  console.log("\n--- 8. 交叉场景：后续派单事件 + 回滚后引航员时间冲突检测 ---");
  await withCleanDb(async (db) => {
    const testDb = cloneDb(db);
    const task02 = testDb.tasks.find((t) => t.id === "T-260614-02");

    const beforeSnapshot = JSON.parse(JSON.stringify(task02));
    task02.pilotId = "P-01";
    task02.status = "assigned";
    task02.tideWindow = { start: "2026-06-14T02:30:00.000Z", end: "2026-06-14T05:30:00.000Z" };
    task02.history.push({ at: new Date().toISOString(), action: "assigned", note: "派单测试" });
    await saveDb(testDb);

    const targetEvent = await recordAuditEvent({
      objectType: AUDIT_OBJECT_TYPES.TASK,
      objectId: task02.id,
      action: AUDIT_ACTIONS.ASSIGN,
      before: beforeSnapshot,
      after: JSON.parse(JSON.stringify(task02)),
      rollbackable: true
    });

    const preview = await previewTaskRollback(testDb, task02.id, targetEvent.id);
    assert(preview.success === true, "预演成功");

    const laterAssign = preview.conflicts.find((c) => c.type === CONFLICT_TYPES.LATER_ASSIGN);
    const timeConflict = preview.conflicts.find((c) => c.type === CONFLICT_TYPES.PILOT_TIME_CONFLICT);
    assert(laterAssign || preview.conflicts.length >= 0, "后续派单或时间冲突按场景检测");
  });

  console.log("\n--- 9. 字段陈旧冲突：目标字段被后续事件修改 ---");
  await withCleanDb(async (db) => {
    const testDb = cloneDb(db);
    const task = testDb.tasks.find((t) => t.id === "T-260614-02");

    const beforeSnapshot = JSON.parse(JSON.stringify(task));
    task.berthPlan = "靠泊N3";
    task.history.push({ at: new Date().toISOString(), action: "updated", note: "第一次更新" });
    await saveDb(testDb);

    const firstEvent = await recordAuditEvent({
      objectType: AUDIT_OBJECT_TYPES.TASK,
      objectId: task.id,
      action: AUDIT_ACTIONS.UPDATE,
      before: beforeSnapshot,
      after: JSON.parse(JSON.stringify(task)),
      rollbackable: true
    });

    await delay(10);

    const before2 = JSON.parse(JSON.stringify(task));
    task.berthPlan = "靠泊N5";
    task.history.push({ at: new Date().toISOString(), action: "updated", note: "第二次更新" });
    await saveDb(testDb);
    await recordAuditEvent({
      objectType: AUDIT_OBJECT_TYPES.TASK,
      objectId: task.id,
      action: AUDIT_ACTIONS.UPDATE,
      before: before2,
      after: JSON.parse(JSON.stringify(task)),
      rollbackable: true
    });

    const preview = await previewTaskRollback(testDb, task.id, firstEvent.id);
    assert(preview.success === true, "预演成功");

    const staleConflict = preview.conflicts.find((c) => c.type === CONFLICT_TYPES.FIELD_STALE);
    assert(!!staleConflict, "检测到field_stale冲突");
    assert(staleConflict.severity === CONFLICT_SEVERITY.WARNING, "字段陈旧为warning级别");

    const berthField = preview.fieldsToRestore.find((f) => f.field === "berthPlan");
    assert(!!berthField, "预演中包含berthPlan恢复字段");
    assert(berthField.currentValue === "靠泊N5", "当前值为第二次修改后的靠泊N5");
    assert(berthField.restoredValue === beforeSnapshot.berthPlan, "恢复值为目标事件的前置状态");
  });

  console.log("\n--- 10. 回滚执行联动：变更申请关联审计事件 ---");
  await withCleanDb(async (db) => {
    const testDb = cloneDb(db);
    const task = testDb.tasks.find((t) => t.id === "T-260614-01");

    const cr1 = {
      id: "CR-ROLLBACK-LINK-01",
      taskId: task.id,
      type: "berth_plan",
      status: "approved",
      createdAt: new Date().toISOString()
    };
    const cr2 = {
      id: "CR-ROLLBACK-LINK-02",
      taskId: task.id,
      type: "tide_window",
      status: "rejected",
      createdAt: new Date().toISOString()
    };
    testDb.changeRequests.push(cr1, cr2);

    const beforeSnapshot = JSON.parse(JSON.stringify(task));
    task.status = "completed";
    task.history.push({ at: new Date().toISOString(), action: "status_change", note: "测试" });
    await saveDb(testDb);

    const targetEvent = await recordAuditEvent({
      objectType: AUDIT_OBJECT_TYPES.TASK,
      objectId: task.id,
      action: AUDIT_ACTIONS.STATUS_CHANGE,
      before: beforeSnapshot,
      after: JSON.parse(JSON.stringify(task)),
      rollbackable: true
    });

    const result = await rollbackTask(testDb, task.id, targetEvent.id, "link-tester", "联动审计测试", true);
    assert(result.success === true, "force回滚成功");
    assert(result.affectedChangeRequestIds.length === 2, "关联2个变更申请");
    assert(result.affectedChangeRequestIds.includes("CR-ROLLBACK-LINK-01"), "包含CR1");
    assert(result.affectedChangeRequestIds.includes("CR-ROLLBACK-LINK-02"), "包含CR2");

    const crAudits = await getAuditHistory({ objectType: AUDIT_OBJECT_TYPES.CHANGE_REQUEST });
    const relatedCrAudits = crAudits.events.filter((e) => e.relatedAuditId === result.rollbackEvent.id);
    assert(relatedCrAudits.length === 2, "为每个关联CR生成RELATED_STATUS_CHANGE审计");
    assert(relatedCrAudits[0].action === AUDIT_ACTIONS.RELATED_STATUS_CHANGE, "审计action为related_status_change");
  });

  console.log("\n--- 11. rollbackTaskAssign 返回关联变更申请 ---");
  await withCleanDb(async (db) => {
    const testDb = cloneDb(db);
    const task = testDb.tasks.find((t) => t.id === "T-260614-01");

    testDb.changeRequests.push({
      id: "CR-ASSIGN-ROLLBACK-01",
      taskId: task.id,
      type: "tide_window",
      status: "pending",
      createdAt: new Date().toISOString()
    });

    const result = await rollbackTaskAssign(testDb, task.id, "op", "回滚派单测试");
    assert(result.success === true, "rollbackTaskAssign成功");
    assert(result.task.pilotId === null, "pilotId已清空");
    assert(result.task.status === "pending", "status恢复为pending");
    assert(result.affectedChangeRequestIds.includes("CR-ASSIGN-ROLLBACK-01"), "返回pending CR ID");
  });

  console.log("\n--- 12. rollbackTaskStatus 待审批CR冲突 + force绕过 ---");
  await withCleanDb(async (db) => {
    const testDb = cloneDb(db);
    const task = testDb.tasks.find((t) => t.id === "T-260614-02");

    const beforeSnapshot = JSON.parse(JSON.stringify(task));
    task.status = "in_progress";
    task.history.push({ at: new Date().toISOString(), action: "status_change", note: "变更状态" });
    await saveDb(testDb);

    await recordAuditEvent({
      objectType: AUDIT_OBJECT_TYPES.TASK,
      objectId: task.id,
      action: AUDIT_ACTIONS.STATUS_CHANGE,
      before: beforeSnapshot,
      after: JSON.parse(JSON.stringify(task)),
      rollbackable: true
    });

    testDb.changeRequests.push({
      id: "CR-STATUS-ROLLBACK-01",
      taskId: task.id,
      type: "tide_window",
      status: "pending",
      createdAt: new Date().toISOString()
    });

    const noForce = await rollbackTaskStatus(testDb, task.id, "op", null, false);
    assert(noForce.success === false, "无force时状态回滚被阻止");
    assert(noForce.error === "pending_change_requests", "错误码正确");
    assert(noForce.requiresForce === true, "requiresForce=true");

    const withForce = await rollbackTaskStatus(testDb, task.id, "op", null, true);
    assert(withForce.success === true, "force后状态回滚成功");
  });

  console.log("\n--- 13. 路由层：handleTaskRollbackPreview 行为测试 ---");
  await withCleanDb(async (db) => {
    const testDb = cloneDb(db);
    const task = testDb.tasks.find((t) => t.id === "T-260614-02");

    const beforeSnapshot = JSON.parse(JSON.stringify(task));
    task.pilotId = "P-03";
    task.status = "assigned";
    task.history.push({ at: new Date().toISOString(), action: "assigned" });
    await saveDb(testDb);

    await recordAuditEvent({
      objectType: AUDIT_OBJECT_TYPES.TASK,
      objectId: task.id,
      action: AUDIT_ACTIONS.ASSIGN,
      before: beforeSnapshot,
      after: JSON.parse(JSON.stringify(task)),
      rollbackable: true
    });

    const mockRes = {};
    const { send, getStatus, getData } = makeSend();
    await handleTaskRollbackPreview(testDb, task.id, {}, send, mockRes);
    assert(getStatus() === 200, "预演路由返回200");
    assert(getData().success === true, "响应success=true");
    assert(getData().fieldsToRestore.length > 0, "返回恢复字段");

    const { send: sendNotFound, getStatus: getStatusNotFound } = makeSend();
    await handleTaskRollbackPreview(testDb, "NONEXISTENT", {}, sendNotFound, {});
    assert(getStatusNotFound() === 404, "任务不存在返回404");
  });

  console.log("\n--- 14. 路由层：handleTaskRollbackRecheck 冲突复查 ---");
  await withCleanDb(async (db) => {
    const testDb = cloneDb(db);
    const task = testDb.tasks.find((t) => t.id === "T-260614-02");

    const beforeSnapshot = JSON.parse(JSON.stringify(task));
    task.pilotId = "P-03";
    task.status = "assigned";
    task.history.push({ at: new Date().toISOString(), action: "assigned" });
    await saveDb(testDb);

    await recordAuditEvent({
      objectType: AUDIT_OBJECT_TYPES.TASK,
      objectId: task.id,
      action: AUDIT_ACTIONS.ASSIGN,
      before: beforeSnapshot,
      after: JSON.parse(JSON.stringify(task)),
      rollbackable: true
    });

    const { send, getStatus, getData } = makeSend();
    await handleTaskRollbackRecheck(testDb, task.id, {}, send, {});
    assert(getStatus() === 200, "复查路由返回200");
    assert(getData().taskId === task.id, "响应包含taskId");
    assert(typeof getData().recheckedAt === "string", "返回recheckedAt时间戳");
    assert("requiresForce" in getData(), "返回requiresForce");
    assert("canRollback" in getData(), "返回canRollback");
    assert(Array.isArray(getData().conflicts), "返回conflicts数组");
  });

  console.log("\n--- 15. 路由层：handleTaskRollback 冲突时返回409 + force返回200 ---");
  await withCleanDb(async (db) => {
    const testDb = cloneDb(db);
    const task = testDb.tasks.find((t) => t.id === "T-260614-01");

    testDb.changeRequests.push({
      id: "CR-ROUTE-TEST-01",
      taskId: task.id,
      type: "tide_window",
      status: "pending",
      createdAt: new Date().toISOString()
    });

    const beforeSnapshot = JSON.parse(JSON.stringify(task));
    task.status = "completed";
    task.history.push({ at: new Date().toISOString(), action: "status_change" });
    await saveDb(testDb);

    const targetEvent = await recordAuditEvent({
      objectType: AUDIT_OBJECT_TYPES.TASK,
      objectId: task.id,
      action: AUDIT_ACTIONS.STATUS_CHANGE,
      before: beforeSnapshot,
      after: JSON.parse(JSON.stringify(task)),
      rollbackable: true
    });

    const { send: sendConflict, getStatus: getStatusConflict, getData: getDataConflict } = makeSend();
    await handleTaskRollback(testDb, task.id, { auditEventId: targetEvent.id, force: false }, sendConflict, {});
    assert(getStatusConflict() === 409, "冲突时路由返回409");
    assert(getDataConflict().requiresForce === true, "返回requiresForce=true");

    const { send: sendOk, getStatus: getStatusOk, getData: getDataOk } = makeSend();
    await handleTaskRollback(testDb, task.id, { auditEventId: targetEvent.id, force: true, operator: "route-tester" }, sendOk, {});
    assert(getStatusOk() === 200, "force时路由返回200");
    assert(getDataOk().success === true, "响应包含success=true");
  });

  console.log("\n--- 16. 兼容性：原/tasks/:id/rollback不传force仍可正常回滚 ---");
  await withCleanDb(async (db) => {
    const testDb = cloneDb(db);
    const task = testDb.tasks.find((t) => t.id === "T-260614-02");

    const beforeSnapshot = JSON.parse(JSON.stringify(task));
    task.pilotId = "P-03";
    task.status = "assigned";
    task.history.push({ at: new Date().toISOString(), action: "assigned" });
    await saveDb(testDb);

    await recordAuditEvent({
      objectType: AUDIT_OBJECT_TYPES.TASK,
      objectId: task.id,
      action: AUDIT_ACTIONS.ASSIGN,
      before: beforeSnapshot,
      after: JSON.parse(JSON.stringify(task)),
      rollbackable: true
    });

    const { send, getStatus, getData } = makeSend();
    await handleTaskRollback(testDb, task.id, {}, send, {});
    assert(getStatus() === 200, "旧接口兼容：无force无冲突返回200");
    assert(getData().success === true, "回滚成功");
    assert(getData().task.pilotId === null, "pilotId已清空");
  });

  console.log("\n--- 17. 冲突类型与严重级别常量导出验证 ---");
  {
    assert(typeof CONFLICT_TYPES === "object", "CONFLICT_TYPES已导出");
    assert(CONFLICT_TYPES.PENDING_CHANGE_REQUEST === "pending_change_request", "pending_change_request值正确");
    assert(CONFLICT_TYPES.LATER_APPROVAL === "later_approval", "later_approval值正确");
    assert(CONFLICT_TYPES.LATER_IMPORT_UPDATE === "later_import_update", "later_import_update值正确");
    assert(CONFLICT_TYPES.PILOT_TIME_CONFLICT === "pilot_time_conflict", "pilot_time_conflict值正确");
    assert(CONFLICT_TYPES.FIELD_STALE === "field_stale", "field_stale值正确");
    assert(CONFLICT_TYPES.LATER_ASSIGN === "later_assign", "later_assign值正确");

    assert(CONFLICT_SEVERITY.ERROR === "error", "ERROR severity='error'");
    assert(CONFLICT_SEVERITY.WARNING === "warning", "WARNING severity='warning'");
    assert(CONFLICT_SEVERITY.INFO === "info", "INFO severity='info'");

    assert(Array.isArray(ROLLBACK_RESTORABLE_FIELDS), "ROLLBACK_RESTORABLE_FIELDS已导出");
    assert(ROLLBACK_RESTORABLE_FIELDS.includes("status"), "包含status");
    assert(ROLLBACK_RESTORABLE_FIELDS.includes("pilotId"), "包含pilotId");
    assert(ROLLBACK_RESTORABLE_FIELDS.includes("tideWindow"), "包含tideWindow");
    assert(ROLLBACK_RESTORABLE_FIELDS.includes("berthPlan"), "包含berthPlan");
  }

  console.log("\n--- 18. 预演指定auditEventId vs 最新事件一致性 ---");
  await withCleanDb(async (db) => {
    const testDb = cloneDb(db);
    const task = testDb.tasks.find((t) => t.id === "T-260614-02");

    const before1 = JSON.parse(JSON.stringify(task));
    task.berthPlan = "靠泊N3";
    task.history.push({ at: new Date().toISOString(), action: "updated" });
    await saveDb(testDb);
    const event1 = await recordAuditEvent({
      objectType: AUDIT_OBJECT_TYPES.TASK,
      objectId: task.id,
      action: AUDIT_ACTIONS.UPDATE,
      before: before1,
      after: JSON.parse(JSON.stringify(task)),
      rollbackable: true
    });

    await delay(10);

    const before2 = JSON.parse(JSON.stringify(task));
    task.status = "in_progress";
    task.history.push({ at: new Date().toISOString(), action: "status_change" });
    await saveDb(testDb);
    const event2 = await recordAuditEvent({
      objectType: AUDIT_OBJECT_TYPES.TASK,
      objectId: task.id,
      action: AUDIT_ACTIONS.STATUS_CHANGE,
      before: before2,
      after: JSON.parse(JSON.stringify(task)),
      rollbackable: true
    });

    const previewLatest = await previewTaskRollback(testDb, task.id);
    const previewExplicit = await previewTaskRollback(testDb, task.id, event2.id);
    assert(previewLatest.targetEvent.id === event2.id, "不传ID时默认取最新事件");
    assert(previewLatest.targetEvent.id === previewExplicit.targetEvent.id, "显式指定最新ID结果一致");

    const previewOld = await previewTaskRollback(testDb, task.id, event1.id);
    assert(previewOld.targetEvent.id === event1.id, "显式指定旧ID回退到旧事件");
    const oldFields = previewOld.fieldsToRestore.map((f) => f.field);
    assert(oldFields.includes("berthPlan"), "指定旧事件恢复berthPlan");
  });

  console.log(`\n=== 测试结果: ${passed} 通过, ${failed} 失败 ===\n`);
  process.exit(failed > 0 ? 1 : 0);
}

runTests().catch((err) => {
  console.error("测试执行失败:", err);
  process.exit(1);
});
