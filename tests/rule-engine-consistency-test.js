import { loadDb } from "../utils/db.js";
import { evaluateCandidate } from "../utils/recommendation.js";
import { createSimulationSnapshot } from "../services/simulation/model.js";
import { evaluateSimCandidate } from "../services/simulation/rule-engine.js";
import { HARD_RULES, DISQUALIFY_MAP } from "../config/rule-engine.js";

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

function arraysEqualAsSet(a, b) {
  if (a.length !== b.length) return false;
  const setA = new Set(a);
  for (const item of b) {
    if (!setA.has(item)) return false;
  }
  return true;
}

async function runTests() {
  console.log("\n=== 规则引擎一致性回归测试：真实 assign vs 仿真 ===\n");

  const db = await loadDb();
  const snapshot = createSimulationSnapshot(db);

  console.log("--- 1. 硬规则与 disqualifying 命名统一验证 ---");
  {
    const expectedDisqualifyKeys = ["not_on_shift", "district_mismatch", "ship_type_mismatch", "grade_mismatch", "time_conflict", "leave_conflict"];
    const actualKeys = Object.values(DISQUALIFY_MAP);
    assert(actualKeys.length === expectedDisqualifyKeys.length,
      `disqualifying 命名数量=${expectedDisqualifyKeys.length}，实际=${actualKeys.length}`);
    for (const key of expectedDisqualifyKeys) {
      assert(actualKeys.includes(key), `disqualifying 包含 ${key}`);
    }
    assert(HARD_RULES.length === 6, `硬规则数量=6，实际=${HARD_RULES.length}`);
  }

  console.log("\n--- 2. 全量引航员 × 任务 eligible 一致性 ---");
  {
    let mismatchCount = 0;
    for (const task of db.tasks) {
      for (const pilot of db.pilots) {
        const realResult = evaluateCandidate(db, pilot, task, task.id);

        const simPilot = snapshot.pilots.find((p) => p.id === pilot.id);
        const simTask = snapshot.tasks.find((t) => t.id === task.id);
        const simResult = evaluateSimCandidate(snapshot, simPilot, simTask);

        if (realResult.eligible !== simResult.eligible) {
          mismatchCount++;
          console.log(`    不一致: pilot=${pilot.id}, task=${task.id}, real=${realResult.eligible}, sim=${simResult.eligible}`);
        }
      }
    }
    assert(mismatchCount === 0,
      `所有引航员×任务组合的 eligible 一致，不一致数=${mismatchCount}`);
  }

  console.log("\n--- 3. 全量引航员 × 任务 disqualifying 一致性 ---");
  {
    let mismatchCount = 0;
    for (const task of db.tasks) {
      for (const pilot of db.pilots) {
        const realResult = evaluateCandidate(db, pilot, task, task.id);

        const simPilot = snapshot.pilots.find((p) => p.id === pilot.id);
        const simTask = snapshot.tasks.find((t) => t.id === task.id);
        const simResult = evaluateSimCandidate(snapshot, simPilot, simTask);

        if (!arraysEqualAsSet(realResult.disqualifying, simResult.disqualifying)) {
          mismatchCount++;
          console.log(`    不一致: pilot=${pilot.id}, task=${task.id}, real=[${realResult.disqualifying.join(",")}], sim=[${simResult.disqualifying.join(",")}]`);
        }
      }
    }
    assert(mismatchCount === 0,
      `所有引航员×任务组合的 disqualifying 一致，不一致数=${mismatchCount}`);
  }

  console.log("\n--- 4. 等级规则一致性验证 ---");
  {
    const testCases = [
      { pilotId: "P-03", requiredGrade: "B", expectedEligible: true, desc: "A级引航员可承担B级任务" },
      { pilotId: "P-03", requiredGrade: "A", expectedEligible: true, desc: "A级引航员可承担A级任务" },
      { pilotId: "P-04", requiredGrade: "A", expectedEligible: false, desc: "B级引航员不可承担A级任务" },
      { pilotId: "P-04", requiredGrade: "B", expectedEligible: false, desc: "B级引航员+港区不匹配应不合格" },
      { pilotId: "P-01", requiredGrade: "B", expectedEligible: true, desc: "A+B级引航员可承担B级任务" },
    ];

    for (const tc of testCases) {
      const pilot = db.pilots.find((p) => p.id === tc.pilotId);
      const task = {
        id: `GRADE-TEST-${tc.pilotId}-${tc.requiredGrade}`,
        vessel: { name: "测试船", type: "散货船" },
        district: pilot.districts[0],
        tideWindow: { start: "2026-06-14T08:00:00.000Z", end: "2026-06-14T11:00:00.000Z" },
        requiredGrade: tc.requiredGrade,
        status: "pending",
        pilotId: null,
        history: []
      };

      const realResult = evaluateCandidate(db, pilot, task, task.id);
      const simPilot = { ...pilot, shifts: [...pilot.shifts], districts: [...pilot.districts], shipTypes: [...pilot.shipTypes], grades: [...pilot.grades] };
      const simSnapshot = { pilots: [simPilot], tasks: [], leaveRecords: [] };
      const simResult = evaluateSimCandidate(simSnapshot, simPilot, task);

      assert(realResult.eligible === tc.expectedEligible,
        `[真实] ${tc.desc}: pilot=${tc.pilotId}, grade=${tc.requiredGrade}, eligible=${realResult.eligible}`);
      assert(simResult.eligible === tc.expectedEligible,
        `[仿真] ${tc.desc}: pilot=${tc.pilotId}, grade=${tc.requiredGrade}, eligible=${simResult.eligible}`);
      assert(realResult.eligible === simResult.eligible,
        `[一致] ${tc.desc}: real=${realResult.eligible}, sim=${simResult.eligible}`);

      const realHasGradeMismatch = realResult.disqualifying.includes("grade_mismatch");
      const simHasGradeMismatch = simResult.disqualifying.includes("grade_mismatch");
      assert(realHasGradeMismatch === simHasGradeMismatch,
        `grade_mismatch 一致: real=${realHasGradeMismatch}, sim=${simHasGradeMismatch}`);
    }
  }

  console.log("\n--- 5. 休假冲突规则一致性验证 ---");
  {
    const pilot = db.pilots.find((p) => p.id === "P-01");
    const task = {
      id: "LEAVE-TEST-01",
      vessel: { name: "休假测试船", type: "散货船" },
      district: "东港",
      tideWindow: { start: "2026-06-17T02:00:00.000Z", end: "2026-06-17T05:00:00.000Z" },
      requiredGrade: "B",
      status: "pending",
      pilotId: null,
      history: []
    };

    const realResult = evaluateCandidate(db, pilot, task, task.id);
    const simPilot = snapshot.pilots.find((p) => p.id === "P-01");
    const simResult = evaluateSimCandidate(snapshot, simPilot, task);

    assert(realResult.eligible === false, `[真实] P-01在休假期间任务eligible=false，实际=${realResult.eligible}`);
    assert(simResult.eligible === false, `[仿真] P-01在休假期间任务eligible=false，实际=${simResult.eligible}`);
    assert(realResult.eligible === simResult.eligible,
      `休假冲突eligible一致: real=${realResult.eligible}, sim=${simResult.eligible}`);

    const realHasLeave = realResult.disqualifying.includes("leave_conflict");
    const simHasLeave = simResult.disqualifying.includes("leave_conflict");
    assert(realHasLeave === true && simHasLeave === true,
      `两者都包含 leave_conflict: real=${realHasLeave}, sim=${simHasLeave}`);

    const taskNoLeave = {
      ...task,
      id: "LEAVE-TEST-02",
      tideWindow: { start: "2026-06-14T08:00:00.000Z", end: "2026-06-14T11:00:00.000Z" }
    };
    const realResult2 = evaluateCandidate(db, pilot, taskNoLeave, taskNoLeave.id);
    const simResult2 = evaluateSimCandidate(snapshot, simPilot, taskNoLeave);

    assert(realResult2.eligible === true,
      `[真实] P-01在非休假期间任务eligible=true，实际=${realResult2.eligible}`);
    assert(simResult2.eligible === true,
      `[仿真] P-01在非休假期间任务eligible=true，实际=${simResult2.eligible}`);
    assert(!realResult2.disqualifying.includes("leave_conflict"),
      `[真实] 非休假期间不含 leave_conflict`);
    assert(!simResult2.disqualifying.includes("leave_conflict"),
      `[仿真] 非休假期间不含 leave_conflict`);
  }

  console.log("\n--- 6. 时间冲突规则一致性验证 ---");
  {
    const pilot = db.pilots.find((p) => p.id === "P-01");
    const taskWithConflict = {
      id: "TIME-CONFLICT-TEST-01",
      vessel: { name: "时间冲突测试船", type: "散货船" },
      district: "东港",
      tideWindow: { start: "2026-06-14T03:00:00.000Z", end: "2026-06-14T06:00:00.000Z" },
      requiredGrade: "B",
      status: "pending",
      pilotId: null,
      history: []
    };

    const realResult = evaluateCandidate(db, pilot, taskWithConflict, taskWithConflict.id);
    const simPilot = snapshot.pilots.find((p) => p.id === "P-01");
    const simResult = evaluateSimCandidate(snapshot, simPilot, taskWithConflict);

    assert(realResult.eligible === false,
      `[真实] 与已有任务(T-260614-01)时间冲突eligible=false，实际=${realResult.eligible}`);
    assert(simResult.eligible === false,
      `[仿真] 与已有任务时间冲突eligible=false，实际=${simResult.eligible}`);
    assert(realResult.eligible === simResult.eligible,
      `时间冲突eligible一致: real=${realResult.eligible}, sim=${simResult.eligible}`);

    const realHasTimeConflict = realResult.disqualifying.includes("time_conflict");
    const simHasTimeConflict = simResult.disqualifying.includes("time_conflict");
    assert(realHasTimeConflict === true && simHasTimeConflict === true,
      `两者都包含 time_conflict: real=${realHasTimeConflict}, sim=${simHasTimeConflict}`);

    const taskNoConflict = {
      ...taskWithConflict,
      id: "TIME-CONFLICT-TEST-02",
      tideWindow: { start: "2026-06-14T08:00:00.000Z", end: "2026-06-14T11:00:00.000Z" }
    };
    const realResult2 = evaluateCandidate(db, pilot, taskNoConflict, taskNoConflict.id);
    const simResult2 = evaluateSimCandidate(snapshot, simPilot, taskNoConflict);

    assert(realResult2.eligible === true,
      `[真实] 无时间冲突任务eligible=true，实际=${realResult2.eligible}`);
    assert(simResult2.eligible === true,
      `[仿真] 无时间冲突任务eligible=true，实际=${simResult2.eligible}`);
    assert(!realResult2.disqualifying.includes("time_conflict"),
      `[真实] 无冲突时不含 time_conflict`);
    assert(!simResult2.disqualifying.includes("time_conflict"),
      `[仿真] 无冲突时不含 time_conflict`);
  }

  console.log("\n--- 7. 总分一致性验证 ---");
  {
    let mismatchCount = 0;
    for (const task of db.tasks) {
      for (const pilot of db.pilots) {
        const realResult = evaluateCandidate(db, pilot, task, task.id);

        const simPilot = snapshot.pilots.find((p) => p.id === pilot.id);
        const simTask = snapshot.tasks.find((t) => t.id === task.id);
        const simResult = evaluateSimCandidate(snapshot, simPilot, simTask);

        if (Math.abs(realResult.totalScore - simResult.totalScore) > 0.01) {
          mismatchCount++;
          console.log(`    总分不一致: pilot=${pilot.id}, task=${task.id}, real=${realResult.totalScore}, sim=${simResult.totalScore}`);
        }
      }
    }
    assert(mismatchCount === 0,
      `所有引航员×任务组合的 totalScore 一致，不一致数=${mismatchCount}`);
  }

  console.log("\n--- 8. 排名一致性验证 ---");
  {
    for (const task of db.tasks) {
      const realCandidates = db.pilots
        .map((pilot) => evaluateCandidate(db, pilot, task, task.id))
        .sort((a, b) => {
          if (b.eligible !== a.eligible) return b.eligible ? 1 : -1;
          if (b.totalScore !== a.totalScore) return b.totalScore - a.totalScore;
          return a.name.localeCompare(b.name);
        });

      const simCandidates = snapshot.pilots
        .map((pilot) => evaluateSimCandidate(snapshot, pilot, task))
        .sort((a, b) => {
          if (b.eligible !== a.eligible) return b.eligible ? 1 : -1;
          if (b.totalScore !== a.totalScore) return b.totalScore - a.totalScore;
          return a.name.localeCompare(b.name);
        });

      const realOrder = realCandidates.map((c) => c.pilotId).join(",");
      const simOrder = simCandidates.map((c) => c.pilotId).join(",");
      assert(realOrder === simOrder,
        `任务 ${task.id} 排名一致: [${realOrder}]`);
    }
  }

  console.log("\n--- 9. submitSimulationAssignments 与真实 assign 条件一致 ---");
  {
    const { submitSimulationAssignments } = await import("../services/simulation/index.js");

    const testTask = {
      id: "CONSISTENCY-SUBMIT-01",
      vessel: { name: "一致性测试船", type: "散货船" },
      district: "东港",
      tideWindow: { start: "2026-06-17T02:00:00.000Z", end: "2026-06-17T05:00:00.000Z" },
      requiredGrade: "B",
      status: "pending",
      pilotId: null,
      history: [{ at: "2026-06-14T00:00:00.000Z", action: "created", note: "测试" }]
    };

    const testDb = {
      pilots: db.pilots.map((p) => ({ ...p, shifts: [...p.shifts], districts: [...p.districts], shipTypes: [...p.shipTypes], grades: [...p.grades] })),
      tasks: [...db.tasks.map((t) => ({ ...t, vessel: { ...t.vessel }, tideWindow: t.tideWindow ? { ...t.tideWindow } : null, history: [...t.history] })), testTask],
      leaveRecords: db.leaveRecords.map((l) => ({ ...l, period: { ...l.period } })),
      drafts: [],
      changeRequests: []
    };

    const pilotOnLeave = testDb.pilots.find((p) => p.id === "P-01");
    const realFit = (await import("../utils/recommendation.js")).pilotFitsCheck(testDb, pilotOnLeave, testTask, testTask.id);

    const submitResult = await submitSimulationAssignments(testDb, {
      assignmentLog: [{ taskId: testTask.id, pilotId: "P-01" }]
    });

    assert(submitResult.failed.length === 1, "仿真提交对休假冲突的引航员返回失败");
    assert(submitResult.failed[0].code === "pilot_not_available", "失败码为 pilot_not_available");
    assert(submitResult.failed[0].detail.disqualifying.includes("leave_conflict"),
      "disqualifying 包含 leave_conflict");
    assert(realFit.ok === false, "真实 pilotFitsCheck 也返回不通过");
    assert(realFit.disqualifying.includes("leave_conflict"),
      "真实 disqualifying 也包含 leave_conflict");
    assert(arraysEqualAsSet(submitResult.failed[0].detail.disqualifying, realFit.disqualifying),
      "仿真提交与真实 assign 的 disqualifying 完全一致");
  }

  console.log("\n--- 10. 启动链路验证：模块加载与规则引擎初始化 ---");
  {
    const ruleEngine = await import("../config/rule-engine.js");
    assert(typeof ruleEngine.evaluateCandidateCore === "function", "规则引擎导出 evaluateCandidateCore 函数");
    assert(Array.isArray(ruleEngine.HARD_RULES), "规则引擎导出 HARD_RULES 数组");
    assert(typeof ruleEngine.DISQUALIFY_MAP === "object", "规则引擎导出 DISQUALIFY_MAP 对象");
    assert(typeof ruleEngine.RULE_WEIGHTS === "object", "规则引擎导出 RULE_WEIGHTS 对象");
    assert(typeof ruleEngine.gradeScore === "function", "规则引擎导出 gradeScore 函数");
    assert(typeof ruleEngine.shiftCoverageScore === "function", "规则引擎导出 shiftCoverageScore 函数");
    assert(typeof ruleEngine.workloadScore === "function", "规则引擎导出 workloadScore 函数");
    assert(typeof ruleEngine.bestGrade === "function", "规则引擎导出 bestGrade 函数");

    const recModule = await import("../utils/recommendation.js");
    assert(typeof recModule.evaluateCandidate === "function", "推荐模块导出 evaluateCandidate");
    assert(typeof recModule.pilotFitsCheck === "function", "推荐模块导出 pilotFitsCheck");
    assert(typeof recModule.findAlternativesForTask === "function", "推荐模块导出 findAlternativesForTask");
    assert(typeof recModule.recommendPilots === "function", "推荐模块导出 recommendPilots");

    const simModule = await import("../services/simulation/rule-engine.js");
    assert(typeof simModule.evaluateSimCandidate === "function", "仿真模块导出 evaluateSimCandidate");
    assert(typeof simModule.rankCandidates === "function", "仿真模块导出 rankCandidates");

    const testPilot = db.pilots[0];
    const testTask = db.tasks[0];
    const coreResult = ruleEngine.evaluateCandidateCore(testPilot, testTask, {
      activeTasks: [],
      leaveConflicts: []
    });
    assert(coreResult.pilotId === testPilot.id, "启动后核心评估函数正常工作");
    assert(typeof coreResult.eligible === "boolean", "核心评估返回 eligible");
    assert(Array.isArray(coreResult.disqualifying), "核心评估返回 disqualifying");
    assert(typeof coreResult.totalScore === "number", "核心评估返回 totalScore");
    assert(Array.isArray(coreResult.rules), "核心评估返回 rules 数组");
    assert(coreResult.rules.length === 7, "核心评估返回 7 条规则");
  }

  console.log("\n--- 11. 请假影响全链路一致性验证 ---");
  {
    const { findAlternativesForTask } = await import("../utils/recommendation.js");

    const testTask = {
      id: "LEAVE-CHAIN-01",
      vessel: { name: "请假链路测试船", type: "散货船" },
      district: "东港",
      tideWindow: { start: "2026-06-17T02:00:00.000Z", end: "2026-06-17T05:00:00.000Z" },
      requiredGrade: "B",
      status: "pending",
      pilotId: null,
      history: []
    };

    const pilot = db.pilots.find((p) => p.id === "P-01");

    const realBefore = evaluateCandidate(db, pilot, testTask, testTask.id);
    const simSnapshotBefore = createSimulationSnapshot(db);
    const simPilotBefore = simSnapshotBefore.pilots.find((p) => p.id === "P-01");
    const simBefore = evaluateSimCandidate(simSnapshotBefore, simPilotBefore, testTask);

    assert(realBefore.eligible === false && simBefore.eligible === false,
      "请假前两者都因值班不在岗不合格");
    assert(realBefore.disqualifying.includes("not_on_shift") === simBefore.disqualifying.includes("not_on_shift"),
      "请假前 not_on_shift disqualifying 一致");
    assert(realBefore.disqualifying.includes("leave_conflict") === simBefore.disqualifying.includes("leave_conflict"),
      "请假前 leave_conflict disqualifying 一致");

    const realAlts = findAlternativesForTask(db, testTask, "P-01", 3);
    const simCandidates = simSnapshotBefore.pilots
      .filter((p) => p.id !== "P-01")
      .map((p) => evaluateSimCandidate(simSnapshotBefore, p, testTask))
      .sort((a, b) => {
        if (b.eligible !== a.eligible) return b.eligible ? 1 : -1;
        if (b.totalScore !== a.totalScore) return b.totalScore - a.totalScore;
        return a.name.localeCompare(b.name);
      })
      .slice(0, 3);

    assert(realAlts.length === simCandidates.length,
      `替代引航员数量一致: real=${realAlts.length}, sim=${simCandidates.length}`);
    for (let i = 0; i < realAlts.length; i++) {
      assert(realAlts[i].pilotId === simCandidates[i].pilotId,
        `第${i + 1}名替代引航员一致: ${realAlts[i].pilotId} vs ${simCandidates[i].pilotId}`);
      assert(realAlts[i].eligible === simCandidates[i].eligible,
        `第${i + 1}名替代引航员 eligible 一致`);
      assert(Math.abs(realAlts[i].totalScore - simCandidates[i].totalScore) < 0.01,
        `第${i + 1}名替代引航员 totalScore 一致`);
    }

    const newLeave = {
      id: "L-CHAIN-TEST-01",
      pilotId: "P-01",
      type: "vacation",
      period: { start: "2026-06-14T00:00:00.000Z", end: "2026-06-20T00:00:00.000Z" },
      reason: "链路测试请假",
      status: "active",
      createdAt: new Date().toISOString()
    };

    const testDb = {
      pilots: db.pilots.map((p) => ({ ...p, shifts: [...p.shifts], districts: [...p.districts], shipTypes: [...p.shipTypes], grades: [...p.grades] })),
      tasks: [...db.tasks.map((t) => ({ ...t, vessel: { ...t.vessel }, tideWindow: t.tideWindow ? { ...t.tideWindow } : null, history: [...t.history] })), testTask],
      leaveRecords: [...db.leaveRecords.map((l) => ({ ...l, period: { ...l.period } })), newLeave]
    };

    const task01 = testDb.tasks.find((t) => t.id === "T-260614-01");
    const realAfter = evaluateCandidate(testDb, pilot, task01, task01.id);

    const simSnapshotAfter = {
      pilots: testDb.pilots.map((p) => ({ ...p, shifts: [...p.shifts], districts: [...p.districts], shipTypes: [...p.shipTypes], grades: [...p.grades] })),
      tasks: testDb.tasks.map((t) => ({ ...t, vessel: { ...t.vessel }, tideWindow: t.tideWindow ? { ...t.tideWindow } : null, history: [...t.history] })),
      leaveRecords: testDb.leaveRecords.map((l) => ({ ...l, period: { ...l.period } }))
    };
    const simPilotAfter = simSnapshotAfter.pilots.find((p) => p.id === "P-01");
    const simAfter = evaluateSimCandidate(simSnapshotAfter, simPilotAfter, task01);

    assert(realAfter.disqualifying.includes("leave_conflict"),
      "新增请假后真实评估包含 leave_conflict");
    assert(simAfter.disqualifying.includes("leave_conflict"),
      "新增请假后仿真评估包含 leave_conflict");
    assert(arraysEqualAsSet(realAfter.disqualifying, simAfter.disqualifying),
      "新增请假后 disqualifying 完全一致");
    assert(Math.abs(realAfter.totalScore - simAfter.totalScore) < 0.01,
      "新增请假后 totalScore 一致");
    assert(realAfter.eligible === simAfter.eligible,
      "新增请假后 eligible 一致");

    const realAltsAfter = findAlternativesForTask(testDb, task01, "P-01", 3);
    const simAltsAfter = simSnapshotAfter.pilots
      .filter((p) => p.id !== "P-01")
      .map((p) => evaluateSimCandidate(simSnapshotAfter, p, task01))
      .sort((a, b) => {
        if (b.eligible !== a.eligible) return b.eligible ? 1 : -1;
        if (b.totalScore !== a.totalScore) return b.totalScore - a.totalScore;
        return a.name.localeCompare(b.name);
      })
      .slice(0, 3);

    assert(realAltsAfter.length === simAltsAfter.length,
      `请假后替代引航员数量一致: real=${realAltsAfter.length}, sim=${simAltsAfter.length}`);
    for (let i = 0; i < realAltsAfter.length; i++) {
      assert(realAltsAfter[i].pilotId === simAltsAfter[i].pilotId,
        `请假后第${i + 1}名替代引航员一致`);
      assert(realAltsAfter[i].eligible === simAltsAfter[i].eligible,
        `请假后第${i + 1}名替代引航员 eligible 一致`);
    }

    const realNonLeaveDisq = realAfter.disqualifying.filter((d) => d !== "leave_conflict");
    const simNonLeaveDisq = simAfter.disqualifying.filter((d) => d !== "leave_conflict");
    assert(arraysEqualAsSet(realNonLeaveDisq, simNonLeaveDisq),
      "过滤 leave_conflict 后剩余 disqualifying 一致");
  }

  console.log(`\n=== 测试结果: ${passed} 通过, ${failed} 失败 ===\n`);
  process.exit(failed > 0 ? 1 : 0);
}

runTests().catch((err) => {
  console.error("测试执行失败:", err);
  process.exit(1);
});
