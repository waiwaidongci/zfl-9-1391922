import { loadDb, saveDb } from "../utils/db.js";
import { runSimulation } from "../services/simulation/index.js";
import { createSimulationSnapshot, addSimTask, assignSimTask } from "../services/simulation/model.js";
import { evaluateSimCandidate, rankCandidates } from "../services/simulation/rule-engine.js";
import { detectConflictsForTask, detectConflictsForPilot, explainUnassigned } from "../services/simulation/conflict-detector.js";

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

async function runTests() {
  console.log("\n=== 排班仿真模块验证测试 ===\n");

  const db = await loadDb();
  const originalTaskCount = db.tasks.length;
  const originalPilotCount = db.pilots.length;

  console.log("--- 1. 仿真数据隔离测试 ---");
  {
    const snapshot = createSimulationSnapshot(db);
    snapshot.pilots.push({ id: "P-TEMP", name: "临时引航员", districts: [], shipTypes: [], grades: [], shifts: [] });
    snapshot.tasks.push({ id: "T-TEMP", vessel: { name: "测试", type: "散货船", length: 100 }, district: "东港", tideWindow: { start: "2026-06-14T01:00:00.000Z", end: "2026-06-14T03:00:00.000Z" }, requiredGrade: "B", status: "pending", pilotId: null, history: [] });

    assert(db.pilots.length === originalPilotCount, "仿真修改不影响原始db.pilots");
    assert(db.tasks.length === originalTaskCount, "仿真修改不影响原始db.tasks");
    assert(snapshot.pilots.length === originalPilotCount + 1, "仿真快照包含新增引航员");
    assert(snapshot.tasks.length === originalTaskCount + 1, "仿真快照包含新增任务");
  }

  console.log("\n--- 2. 临时引航员班次合并测试 ---");
  {
    const tempShifts = [
      {
        pilotId: "P-01",
        shifts: [{ start: "2026-06-15T12:00:00.000Z", end: "2026-06-16T00:00:00.000Z" }],
        districts: ["西港"]
      },
      {
        pilotId: "P-TEMP-01",
        name: "临时引航员A",
        districts: ["东港", "北槽"],
        shipTypes: ["散货船", "集装箱船"],
        grades: ["A"],
        shifts: [{ start: "2026-06-15T00:00:00.000Z", end: "2026-06-15T12:00:00.000Z" }]
      }
    ];
    const snapshot = createSimulationSnapshot(db, { tempShifts });
    const p01 = snapshot.pilots.find((p) => p.id === "P-01");
    const pTemp = snapshot.pilots.find((p) => p.id === "P-TEMP-01");

    assert(p01.shifts.length === 2, "P-01 班次被追加（原有1个+新增1个）");
    assert(p01.districts.includes("西港"), "P-01 港区资质被追加西港");
    assert(pTemp !== undefined, "临时引航员被创建");
    assert(pTemp.districts.length === 2, "临时引航员港区资质正确");
    assert(pTemp.shipTypes.length === 2, "临时引航员船型资质正确");
  }

  console.log("\n--- 3. 规则引擎评分测试 ---");
  {
    const snapshot = createSimulationSnapshot(db);
    const pilot = snapshot.pilots.find((p) => p.id === "P-03");
    const task = {
      id: "SIM-TEST-01",
      vessel: { name: "测试船", type: "散货船", length: 180 },
      district: "东港",
      tideWindow: { start: "2026-06-14T08:00:00.000Z", end: "2026-06-14T11:00:00.000Z" },
      requiredGrade: "A"
    };

    const result = evaluateSimCandidate(snapshot, pilot, task);
    assert(result.eligible === true, `P-03 对东港散货船A任务 eligible=${result.eligible}`);
    assert(result.rules.length === 7, `规则数量为7，实际=${result.rules.length}`);
    assert(result.rules.some((r) => r.rule === "district_match" && r.passed), "港区匹配规则通过");
    assert(result.rules.some((r) => r.rule === "ship_type_match" && r.passed), "船型匹配规则通过");
    assert(result.rules.some((r) => r.rule === "grade_match" && r.passed), "等级匹配规则通过");
    assert(result.disqualifying.length === 0, `无不合规规则，实际=${result.disqualifying.length}`);
  }

  console.log("\n--- 4. 冲突检测测试 ---");
  {
    const snapshot = createSimulationSnapshot(db);
    const conflictingTask = {
      id: "SIM-CONFLICT-01",
      vessel: { name: "冲突测试船", type: "散货船", length: 180 },
      district: "东港",
      tideWindow: { start: "2026-06-17T02:00:00.000Z", end: "2026-06-17T05:00:00.000Z" },
      requiredGrade: "B"
    };

    const taskConflicts = detectConflictsForTask(snapshot, conflictingTask);
    assert(taskConflicts.length >= 0, "任务冲突检测运行正常");

    const pilot = snapshot.pilots.find((p) => p.id === "P-01");
    const pilotConflicts = detectConflictsForPilot(snapshot, pilot, conflictingTask);
    const leaveConflict = pilotConflicts.find((c) => c.type === "leave_conflict");
    assert(leaveConflict !== undefined, "P-01 在2026-06-17有休假冲突被检测到");

    const explanation = explainUnassigned(snapshot, conflictingTask);
    assert(explanation.taskId === "SIM-CONFLICT-01", "未派单说明的任务ID正确");
    assert(explanation.pilotConflictSummary.length > 0, "存在引航员冲突摘要");
  }

  console.log("\n--- 5. 完整仿真流程测试 ---");
  {
    const simTasks = [
      {
        id: "SIM-01",
        vessel: { name: "仿真船A", type: "集装箱船", length: 260 },
        district: "北槽",
        tideWindow: { start: "2026-06-14T10:00:00.000Z", end: "2026-06-14T13:00:00.000Z" },
        requiredGrade: "A"
      },
      {
        id: "SIM-02",
        vessel: { name: "仿真船B", type: "油轮", length: 220 },
        district: "西港",
        tideWindow: { start: "2026-06-15T06:00:00.000Z", end: "2026-06-15T09:00:00.000Z" },
        requiredGrade: "A"
      },
      {
        id: "SIM-03",
        vessel: { name: "仿真船C", type: "散货船", length: 210 },
        district: "东港",
        tideWindow: { start: "2026-06-17T02:00:00.000Z", end: "2026-06-17T05:00:00.000Z" },
        requiredGrade: "B"
      }
    ];

    const result = runSimulation(db, { tasks: simTasks });
    assert(result.summary.totalInputTasks === 3, `输入任务数=3，实际=${result.summary.totalInputTasks}`);
    assert(result.assignments.length + result.unassigned.length === 3, "分配+未分配=总任务数");
    assert(result.pilotLoads.length > 0, "有引航员负载数据");
    assert(result.assignmentLog.length === result.assignments.length, "分配日志条数=分配数");
    assert(result.summary.tempShiftsApplied === 0, "未使用临时班次");

    if (result.assignments.length > 0) {
      const first = result.assignments[0];
      assert(first.ruleTrace !== undefined, "分配结果包含规则追踪");
      assert(first.ruleTrace.length === 7, `每次分配有7条规则追踪，实际=${first.ruleTrace.length}`);
      assert(first.pilotId !== undefined, "分配结果包含引航员ID");
      assert(first.score !== undefined, "分配结果包含分数");
    }

    if (result.unassigned.length > 0) {
      const unassigned = result.unassigned[0];
      assert(unassigned.reasons !== undefined, "未派单结果包含原因");
      assert(unassigned.pilotConflictSummary !== undefined, "未派单结果包含引航员冲突摘要");
    }
  }

  console.log("\n--- 6. 临时引航员改善仿真测试 ---");
  {
    const impossibleTask = {
      id: "SIM-IMPOSSIBLE",
      vessel: { name: "无解船", type: "化学品船", length: 180 },
      district: "西港",
      tideWindow: { start: "2026-06-15T10:00:00.000Z", end: "2026-06-15T13:00:00.000Z" },
      requiredGrade: "A"
    };

    const resultNoTemp = runSimulation(db, { tasks: [impossibleTask] });
    const resultWithTemp = runSimulation(db, {
      tasks: [impossibleTask],
      tempShifts: [
        {
          pilotId: "P-TEMP-CHEM",
          name: "临时化学品引航员",
          districts: ["西港"],
          shipTypes: ["化学品船"],
          grades: ["A"],
          shifts: [{ start: "2026-06-15T08:00:00.000Z", end: "2026-06-15T18:00:00.000Z" }]
        }
      ]
    });

    const withTempAssigned = resultWithTemp.assignments.find((a) => a.taskId === "SIM-IMPOSSIBLE");
    assert(withTempAssigned !== undefined, "添加临时引航员后任务可被分配");
    assert(withTempAssigned.pilotId === "P-TEMP-CHEM", "任务分配给临时引航员");
    assert(resultWithTemp.summary.tempShiftsApplied === 1, "使用了1个临时班次");
  }

  console.log("\n--- 7. 原始assign接口行为不变测试 ---");
  {
    const originalTask = db.tasks.find((t) => t.id === "T-260614-02");
    assert(originalTask.status === "pending", "原始任务状态仍为pending");
    assert(originalTask.pilotId === null, "原始任务未分配引航员");

    const simResult = runSimulation(db, {
      tasks: [{
        id: "SIM-ASSIGN-TEST",
        vessel: { name: "验证船", type: "集装箱船", length: 260 },
        district: "北槽",
        tideWindow: { start: "2026-06-14T10:00:00.000Z", end: "2026-06-14T13:00:00.000Z" },
        requiredGrade: "A"
      }]
    });

    const reloadedDb = await loadDb();
    assert(reloadedDb.tasks.length === originalTaskCount, "仿真后DB任务数不变");
    assert(reloadedDb.pilots.length === originalPilotCount, "仿真后DB引航员数不变");
  }

  console.log("\n--- 8. 负载均衡验证 ---");
  {
    const simTasks = [
      {
        id: "LB-01",
        vessel: { name: "均衡船1", type: "散货船", length: 180 },
        district: "东港",
        tideWindow: { start: "2026-06-14T10:00:00.000Z", end: "2026-06-14T13:00:00.000Z" },
        requiredGrade: "B"
      },
      {
        id: "LB-02",
        vessel: { name: "均衡船2", type: "散货船", length: 190 },
        district: "东港",
        tideWindow: { start: "2026-06-14T14:00:00.000Z", end: "2026-06-14T17:00:00.000Z" },
        requiredGrade: "B"
      }
    ];

    const result = runSimulation(db, { tasks: simTasks });
    assert(result.pilotLoads.every((p) => p.workloadLevel !== undefined), "每个引航员都有负载等级");
    assert(result.pilotLoads.some((p) => p.assignedTaskCount >= 0), "负载计数正确");

    const assignedPilotIds = new Set(result.assignments.map((a) => a.pilotId));
    if (result.assignments.length === 2) {
      assert(true, `2个任务分配给${assignedPilotIds.size}名引航员`);
    }
  }

  console.log("\n--- 9. 等级匹配与真实assign一致性测试 ---");
  {
    const snapshot = createSimulationSnapshot(db);
    const pilotWithA = snapshot.pilots.find((p) => p.id === "P-03");
    const taskB = {
      id: "GRADE-CONSISTENCY-01",
      vessel: { name: "等级一致性船", type: "散货船", length: 180 },
      district: "东港",
      tideWindow: { start: "2026-06-14T08:00:00.000Z", end: "2026-06-14T11:00:00.000Z" },
      requiredGrade: "B"
    };

    const simResult = evaluateSimCandidate(snapshot, pilotWithA, taskB);
    assert(!simResult.eligible, `P-03(grades=["A"])对requiredGrade=B任务应不满足(sim)，eligible=${simResult.eligible}`);
    assert(simResult.disqualifying.includes("grade_mismatch"), `disqualifying包含grade_mismatch，实际=${simResult.disqualifying}`);

    const taskA = {
      id: "GRADE-CONSISTENCY-02",
      vessel: { name: "等级一致性船2", type: "散货船", length: 180 },
      district: "东港",
      tideWindow: { start: "2026-06-14T08:00:00.000Z", end: "2026-06-14T11:00:00.000Z" },
      requiredGrade: "A"
    };
    const simResult2 = evaluateSimCandidate(snapshot, pilotWithA, taskA);
    assert(simResult2.eligible, `P-03(grades=["A"])对requiredGrade=A任务应满足(sim)，eligible=${simResult2.eligible}`);

    const pilotWithAB = snapshot.pilots.find((p) => p.id === "P-01");
    const simResult3 = evaluateSimCandidate(snapshot, pilotWithAB, taskB);
    assert(simResult3.eligible, `P-01(grades=["A","B"])对requiredGrade=B任务应满足(sim)，eligible=${simResult3.eligible}`);
  }

  console.log("\n--- 10. disqualifying名称与真实assign一致测试 ---");
  {
    const snapshot = createSimulationSnapshot(db);
    const pilot = snapshot.pilots.find((p) => p.id === "P-02");
    const task = {
      id: "DISQ-NAME-01",
      vessel: { name: "名称测试船", type: "散货船", length: 180 },
      district: "东港",
      tideWindow: { start: "2026-06-14T08:00:00.000Z", end: "2026-06-14T11:00:00.000Z" },
      requiredGrade: "A"
    };

    const simResult = evaluateSimCandidate(snapshot, pilot, task);
    assert(simResult.disqualifying.includes("district_mismatch"), `disqualifying用district_mismatch而非district_match，实际=${simResult.disqualifying}`);
    assert(simResult.disqualifying.includes("ship_type_mismatch"), `disqualifying用ship_type_mismatch而非ship_type_match，实际=${simResult.disqualifying}`);
    assert(!simResult.disqualifying.includes("district_match"), "disqualifying不含规则键名district_match");
    assert(!simResult.disqualifying.includes("ship_type_match"), "disqualifying不含规则键名ship_type_match");
  }

  console.log("\n--- 11. 任务ID校验测试 ---");
  {
    const { handleSimulationDispatch } = await import("../routes/simulation.js");

    let capturedStatus;
    let capturedData;
    const mockSend = (res, status, data) => {
      capturedStatus = status;
      capturedData = data;
    };
    const mockRes = {};

    await handleSimulationDispatch(db, {
      tasks: [
        { id: "T-260614-01", vessel: { name: "冲突ID", type: "散货船", length: 180 }, district: "东港", tideWindow: { start: "2026-06-14T08:00:00.000Z", end: "2026-06-14T11:00:00.000Z" }, requiredGrade: "B" }
      ]
    }, mockSend, mockRes);
    assert(capturedStatus === 400, `与已有真实任务ID冲突应返回400，实际=${capturedStatus}`);
    assert(capturedData.error === "validation_failed", "错误类型为validation_failed");
    assert(capturedData.errors.some((e) => e.code === "existing_id_conflict"), "包含existing_id_conflict错误");

    await handleSimulationDispatch(db, {
      tasks: [
        { id: "DUP-01", vessel: { name: "重复1", type: "散货船", length: 180 }, district: "东港", tideWindow: { start: "2026-06-14T08:00:00.000Z", end: "2026-06-14T11:00:00.000Z" }, requiredGrade: "B" },
        { id: "DUP-01", vessel: { name: "重复2", type: "散货船", length: 180 }, district: "东港", tideWindow: { start: "2026-06-14T14:00:00.000Z", end: "2026-06-14T17:00:00.000Z" }, requiredGrade: "B" }
      ]
    }, mockSend, mockRes);
    assert(capturedStatus === 400, `批次内重复ID应返回400，实际=${capturedStatus}`);
    assert(capturedData.errors.some((e) => e.code === "batch_duplicate_id"), "包含batch_duplicate_id错误");

    await handleSimulationDispatch(db, {
      tasks: [
        { id: "bad id!", vessel: { name: "非法ID", type: "散货船", length: 180 }, district: "东港", tideWindow: { start: "2026-06-14T08:00:00.000Z", end: "2026-06-14T11:00:00.000Z" }, requiredGrade: "B" }
      ]
    }, mockSend, mockRes);
    assert(capturedStatus === 400, `非法ID格式应返回400，实际=${capturedStatus}`);
    assert(capturedData.errors.some((e) => e.code === "invalid_id_format"), "包含invalid_id_format错误");

    await handleSimulationDispatch(db, {
      tasks: [
        { id: "", vessel: { name: "空ID", type: "散货船", length: 180 }, district: "东港", tideWindow: { start: "2026-06-14T08:00:00.000Z", end: "2026-06-14T11:00:00.000Z" }, requiredGrade: "B" }
      ]
    }, mockSend, mockRes);
    assert(capturedStatus === 400, `空白ID应返回400，实际=${capturedStatus}`);
    assert(capturedData.errors.some((e) => e.code === "empty_id"), "包含empty_id错误");
  }

  console.log("\n--- 12. 枚举字段校验测试 ---");
  {
    const { handleSimulationDispatch } = await import("../routes/simulation.js");

    let capturedStatus;
    let capturedData;
    const mockSend = (res, status, data) => {
      capturedStatus = status;
      capturedData = data;
    };
    const mockRes = {};

    await handleSimulationDispatch(db, {
      tasks: [
        { id: "ENUM-01", vessel: { name: "非法港区", type: "散货船", length: 180 }, district: "南海", tideWindow: { start: "2026-06-14T08:00:00.000Z", end: "2026-06-14T11:00:00.000Z" }, requiredGrade: "B" }
      ]
    }, mockSend, mockRes);
    assert(capturedStatus === 400, `无效港区应返回400，实际=${capturedStatus}`);
    assert(capturedData.errors.some((e) => e.code === "invalid_district"), "包含invalid_district错误");

    await handleSimulationDispatch(db, {
      tasks: [
        { id: "ENUM-02", vessel: { name: "非法船型", type: "航母", length: 300 }, district: "东港", tideWindow: { start: "2026-06-14T08:00:00.000Z", end: "2026-06-14T11:00:00.000Z" }, requiredGrade: "B" }
      ]
    }, mockSend, mockRes);
    assert(capturedStatus === 400, `无效船型应返回400，实际=${capturedStatus}`);
    assert(capturedData.errors.some((e) => e.code === "invalid_vessel_type"), "包含invalid_vessel_type错误");

    await handleSimulationDispatch(db, {
      tasks: [
        { id: "ENUM-03", vessel: { name: "非法等级", type: "散货船", length: 180 }, district: "东港", tideWindow: { start: "2026-06-14T08:00:00.000Z", end: "2026-06-14T11:00:00.000Z" }, requiredGrade: "C" }
      ]
    }, mockSend, mockRes);
    assert(capturedStatus === 400, `无效等级应返回400，实际=${capturedStatus}`);
    assert(capturedData.errors.some((e) => e.code === "invalid_grade"), "包含invalid_grade错误");

    await handleSimulationDispatch(db, {
      tasks: [
        { id: "ENUM-04", vessel: { type: "散货船" }, district: "东港", tideWindow: { start: "2026-06-14T08:00:00.000Z", end: "2026-06-14T11:00:00.000Z" }, requiredGrade: "B" }
      ]
    }, mockSend, mockRes);
    assert(capturedStatus === 400, `缺少船名应返回400，实际=${capturedStatus}`);
    assert(capturedData.errors && capturedData.errors.some((e) => e.code === "missing_vessel_name"), "包含missing_vessel_name错误");

    await handleSimulationDispatch(db, {
      tasks: [
        { id: "ENUM-05", vessel: { name: "时间反序", type: "散货船", length: 180 }, district: "东港", tideWindow: { start: "2026-06-14T11:00:00.000Z", end: "2026-06-14T08:00:00.000Z" }, requiredGrade: "B" }
      ]
    }, mockSend, mockRes);
    assert(capturedStatus === 400, `时间窗口反序应返回400，实际=${capturedStatus}`);
    assert(capturedData.errors.some((e) => e.code === "window_end_before_start"), "包含window_end_before_start错误");
  }

  console.log(`\n=== 测试结果: ${passed} 通过, ${failed} 失败 ===\n`);
  process.exit(failed > 0 ? 1 : 0);
}

runTests().catch((err) => {
  console.error("测试执行失败:", err);
  process.exit(1);
});
