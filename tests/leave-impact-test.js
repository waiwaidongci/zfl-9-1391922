import { loadDb, saveDb, resetAllToSeed } from "../utils/db.js";
import { handleLeaveCreate, handleLeaveCancel } from "../routes/leaves.js";
import { affectedActiveTasks } from "../utils/time.js";
import { findAlternativesForTask, evaluateCandidate } from "../utils/recommendation.js";
import { getAuditHistory, AUDIT_ACTIONS } from "../services/audit.js";

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
  return { send, getStatus: () => capturedStatus, getData: () => capturedData };
}

async function resetDb() {
  return resetAllToSeed();
}

async function runTests() {
  console.log("\n=== 请假影响分析与恢复功能测试 ===\n");

  console.log("--- 1. affectedActiveTasks 工具函数 ---");
  {
    const db = await resetDb();
    const tasks = affectedActiveTasks(db, "P-01", "2026-06-14T00:00:00.000Z", "2026-06-14T12:00:00.000Z");
    assert(Array.isArray(tasks), "返回数组");
    const t01 = tasks.find((t) => t.id === "T-260614-01");
    assert(t01 !== undefined, "P-01 的活跃任务 T-260614-01 被检测到（时间窗口重叠）");

    const tasksEmpty = affectedActiveTasks(db, "P-02", "2026-06-14T00:00:00.000Z", "2026-06-14T12:00:00.000Z");
    assert(tasksEmpty.length === 0, "P-02 在该时段无活跃任务");
  }

  console.log("\n--- 2. findAlternativesForTask 工具函数 ---");
  {
    const db = await resetDb();
    const task = db.tasks.find((t) => t.id === "T-260614-01");
    const alts = findAlternativesForTask(db, task, "P-01", 3);
    assert(Array.isArray(alts), "返回数组");
    assert(alts.length <= 3, "最多返回3名替代引航员");
    assert(alts.every((a) => a.pilotId !== "P-01"), "排除当前引航员 P-01");
    for (const alt of alts) {
      assert(typeof alt.pilotId === "string", "替代结果包含 pilotId");
      assert(typeof alt.name === "string", "替代结果包含 name");
      assert(typeof alt.eligible === "boolean", "替代结果包含 eligible");
      assert(typeof alt.totalScore === "number", "替代结果包含 totalScore");
      assert(Array.isArray(alt.disqualifying), "替代结果包含 disqualifying");
      assert(typeof alt.weightedScores === "object", "替代结果包含 weightedScores");
    }
  }

  console.log("\n--- 3. 创建请假 - 返回影响分析（含受影响任务、冲突原因、替代引航员） ---");
  {
    const db = await resetDb();
    const { send, getStatus, getData } = makeSend();

    const task04 = db.tasks.find((t) => t.id === "T-260614-04");
    task04.pilotId = "P-01";
    task04.status = "assigned";
    await saveDb(db);

    const input = {
      pilotId: "P-01",
      type: "vacation",
      period: { start: "2026-06-14T00:00:00.000Z", end: "2026-06-14T12:00:00.000Z" },
      reason: "创建请假影响测试"
    };

    await handleLeaveCreate(db, input, send, {});
    assert(getStatus() === 201, "创建请假返回 201");

    const data = getData();
    assert(data.impactAnalysis !== undefined, "响应包含 impactAnalysis");
    assert(typeof data.impactAnalysis.affectedCount === "number", "impactAnalysis 包含 affectedCount");
    assert(Array.isArray(data.impactAnalysis.affectedTasks), "impactAnalysis 包含 affectedTasks 数组");

    const affected = data.impactAnalysis.affectedTasks;
    const t01Item = affected.find((t) => t.taskId === "T-260614-01");
    assert(t01Item !== undefined, "受影响任务包含 T-260614-01（P-01已分配的活跃任务）");
    assert(t01Item.conflictReason === "leave_conflict", "冲突原因为 leave_conflict");
    assert(t01Item.overlapPeriod !== null, "包含 overlapPeriod");
    assert(typeof t01Item.overlapPeriod.start === "string", "overlapPeriod 有 start");
    assert(typeof t01Item.overlapPeriod.end === "string", "overlapPeriod 有 end");
    assert(Array.isArray(t01Item.alternatives), "受影响任务包含 alternatives 数组");
    assert(t01Item.alternatives.length <= 3, "替代引航员最多3名");
    assert(t01Item.alternatives.every((a) => a.pilotId !== "P-01"), "替代引航员不包含请假引航员");

    for (const alt of t01Item.alternatives) {
      assert(typeof alt.pilotId === "string", "替代引航员有 pilotId");
      assert(typeof alt.name === "string", "替代引航员有 name");
      assert(typeof alt.eligible === "boolean", "替代引航员有 eligible");
      assert(typeof alt.totalScore === "number", "替代引航员有 totalScore");
      assert(Array.isArray(alt.disqualifying), "替代引航员有 disqualifying");
    }
  }

  console.log("\n--- 4. 创建请假 - 无受影响活跃任务时 impactAnalysis 为空 ---");
  {
    const db = await resetDb();
    const { send, getStatus, getData } = makeSend();

    const input = {
      pilotId: "P-02",
      type: "vacation",
      period: { start: "2026-06-20T00:00:00.000Z", end: "2026-06-22T00:00:00.000Z" },
      reason: "无任务冲突请假"
    };

    await handleLeaveCreate(db, input, send, {});
    assert(getStatus() === 201, "创建请假返回 201");
    const data = getData();
    assert(data.impactAnalysis.affectedCount === 0, "无受影响任务时 affectedCount 为 0");
    assert(data.impactAnalysis.affectedTasks.length === 0, "无受影响任务时 affectedTasks 为空数组");
  }

  console.log("\n--- 5. 取消请假 - 返回恢复分析 ---");
  {
    const db = await resetDb();
    const { send, getStatus, getData } = makeSend();

    const leave = db.leaveRecords.find((l) => l.id === "L-260614-01");
    assert(leave !== undefined, "存在 P-01 的请假记录 L-260614-01");

    await handleLeaveCancel(db, "L-260614-01", { note: "取消请假恢复测试" }, send, {});
    assert(getStatus() === 200, "取消请假返回 200");

    const data = getData();
    assert(data.recoveryAnalysis !== undefined, "响应包含 recoveryAnalysis");
    assert(Array.isArray(data.recoveryAnalysis.recoveredTasks), "recoveryAnalysis 包含 recoveredTasks 数组");
    assert(typeof data.recoveryAnalysis.recoveredCount === "number", "recoveryAnalysis 包含 recoveredCount");

    const t04Recovered = data.recoveryAnalysis.recoveredTasks.find((t) => t.taskId === "T-260614-04");
    assert(t04Recovered !== undefined, "恢复任务包含 T-260614-04（该任务时间窗口在请假期间）");
    assert(typeof t04Recovered.nowEligible === "boolean", "恢复任务包含 nowEligible");
    assert(t04Recovered.previouslyDisqualifiedByLeave === true, "之前因请假被取消资格");
    assert(Array.isArray(t04Recovered.remainingDisqualifying), "恢复任务包含 remainingDisqualifying");
  }

  console.log("\n--- 6. 取消请假 - 无恢复任务时 recoveryAnalysis 为空 ---");
  {
    const db = await resetDb();
    const { send, getStatus, getData } = makeSend();

    db.leaveRecords.push({
      id: "L-TEST-NO-RECOVERY",
      pilotId: "P-02",
      type: "vacation",
      period: { start: "2026-06-20T00:00:00.000Z", end: "2026-06-22T00:00:00.000Z" },
      reason: "无恢复测试",
      status: "active",
      createdAt: new Date().toISOString()
    });
    await saveDb(db);

    await handleLeaveCancel(db, "L-TEST-NO-RECOVERY", { note: "取消" }, send, {});
    assert(getStatus() === 200, "取消请假返回 200");
    const data = getData();
    assert(data.recoveryAnalysis.recoveredTasks.length === 0, "无恢复任务时 recoveredTasks 为空");
    assert(data.recoveryAnalysis.recoveredCount === 0, "无恢复任务时 recoveredCount 为 0");
  }

  console.log("\n--- 7. 审计记录 - 请假创建和取消产生 leave_impact/leave_recovery 审计 ---");
  {
    const db = await resetDb();
    const { send, getStatus, getData } = makeSend();

    const input = {
      pilotId: "P-02",
      type: "vacation",
      period: { start: "2026-06-20T00:00:00.000Z", end: "2026-06-22T00:00:00.000Z" },
      reason: "审计测试请假"
    };

    await handleLeaveCreate(db, input, send, {});
    const createdData = getData();
    const leaveId = createdData.id;

    const createAudit = await getAuditHistory({ objectId: leaveId, action: AUDIT_ACTIONS.LEAVE_IMPACT });
    assert(createAudit.total >= 1, "创建请假后产生 leave_impact 审计事件");

    const { send: send2, getStatus: getStatus2, getData: getData2 } = makeSend();
    await handleLeaveCancel(db, leaveId, { note: "取消审计测试" }, send2, {});
    assert(getStatus2() === 200, "取消请假返回 200");

    const cancelAudit = await getAuditHistory({ objectId: leaveId, action: AUDIT_ACTIONS.LEAVE_RECOVERY });
    assert(cancelAudit.total >= 1, "取消请假后产生 leave_recovery 审计事件");
  }

  console.log("\n--- 8. 创建请假 - 受影响任务结构完整性 ---");
  {
    const db = await resetDb();
    const { send, getStatus, getData } = makeSend();

    const input = {
      pilotId: "P-01",
      type: "vacation",
      period: { start: "2026-06-14T00:00:00.000Z", end: "2026-06-14T12:00:00.000Z" },
      reason: "影响结构完整性测试"
    };

    await handleLeaveCreate(db, input, send, {});
    const data = getData();
    assert(data.impactAnalysis.affectedCount >= 1, "至少1个受影响任务");

    for (const item of data.impactAnalysis.affectedTasks) {
      assert(typeof item.taskId === "string", "受影响任务有 taskId");
      assert(typeof item.vessel === "object", "受影响任务有 vessel");
      assert(typeof item.district === "string", "受影响任务有 district");
      assert(typeof item.tideWindow === "object", "受影响任务有 tideWindow");
      assert(typeof item.status === "string", "受影响任务有 status");
      assert(item.conflictReason === "leave_conflict", "冲突原因为 leave_conflict");
    }
  }

  console.log("\n--- 9. 取消请假 - nowEligible 判断正确性 ---");
  {
    const db = await resetDb();
    const { send, getStatus, getData } = makeSend();

    const pilot = db.pilots.find((p) => p.id === "P-01");
    const task04 = db.tasks.find((t) => t.id === "T-260614-04");
    const evalBefore = evaluateCandidate(db, pilot, task04);
    assert(evalBefore.disqualifying.includes("leave_conflict"), "取消前 P-01 因请假冲突被取消资格");

    await handleLeaveCancel(db, "L-260614-01", { note: "nowEligible 验证" }, send, {});
    const data = getData();
    const t04Rec = data.recoveryAnalysis.recoveredTasks.find((t) => t.taskId === "T-260614-04");
    assert(t04Rec !== undefined, "T-260614-04 在恢复列表中");
    assert(t04Rec.previouslyDisqualifiedByLeave === true, "之前因请假被取消资格");

    const otherDisqualifying = t04Rec.remainingDisqualifying;
    assert(Array.isArray(otherDisqualifying), "remainingDisqualifying 为数组");
    if (otherDisqualifying.length === 0) {
      assert(t04Rec.nowEligible === true, "无其他取消资格原因时 nowEligible 为 true");
    } else {
      assert(t04Rec.nowEligible === false, `仍有其他取消资格原因(${otherDisqualifying.join(",")})时 nowEligible 为 false`);
    }
  }

  console.log("\n--- 10. 替代引航员排序正确性 ---");
  {
    const db = await resetDb();
    const task = db.tasks.find((t) => t.id === "T-260614-04");
    const alts = findAlternativesForTask(db, task, "P-01", 3);

    if (alts.length >= 2) {
      for (let i = 0; i < alts.length - 1; i++) {
        if (alts[i].eligible !== alts[i + 1].eligible) {
          assert(alts[i].eligible === true, "合格的排在前面");
        } else if (alts[i].eligible && alts[i + 1].eligible) {
          assert(alts[i].totalScore >= alts[i + 1].totalScore, "同合格时分数降序");
        }
      }
    }
    assert(true, "替代引航员排序验证完成");
  }

  console.log(`\n=== 测试结果: ${passed} 通过, ${failed} 失败 ===\n`);
  process.exit(failed > 0 ? 1 : 0);
}

runTests().catch((err) => {
  console.error("测试执行失败:", err);
  process.exit(1);
});
