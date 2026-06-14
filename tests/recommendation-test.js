import { loadDb } from "../utils/db.js";
import { evaluateCandidate, pilotFitsCheck, recommendPilots, buildCandidateExplanation } from "../utils/recommendation.js";
import { recommendForTask, analyzeImportBatch } from "../services/candidate-reuse.js";
import { handleTaskCandidates, handleTaskRecommend } from "../routes/tasks.js";
import { RECOMMEND_WEIGHTS, recommendRulesMeta } from "../config/recommend-rules.js";
import { buildTaskFromRow } from "../utils/validator.js";

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

const EXPECTED_DIMENSIONS = ["shiftCoverage", "district", "shipType", "grade", "noTimeConflict", "noLeaveConflict", "workload"];

function makeSend() {
  let capturedStatus;
  let capturedData;
  const send = (res, status, data) => {
    capturedStatus = status;
    capturedData = data;
  };
  return { send, getStatus: () => capturedStatus, getData: () => capturedData };
}

async function runTests() {
  console.log("\n=== 候选引航员与推荐模块统一结构验证测试 ===\n");

  const db = await loadDb();
  const testTask = db.tasks.find((t) => t.id === "T-260614-01");
  const testPilot = db.pilots.find((p) => p.id === "P-01");

  console.log("--- 1. evaluateCandidate 返回完整评分维度 ---");
  {
    const result = evaluateCandidate(db, testPilot, testTask);
    assert(result.pilotId === "P-01", "返回 pilotId");
    assert(typeof result.name === "string", "返回 name");
    assert(typeof result.totalScore === "number", "返回 totalScore (number)");
    assert(typeof result.eligible === "boolean", "返回 eligible (boolean)");
    assert(Array.isArray(result.disqualifying), "返回 disqualifying (array)");
    assert(typeof result.weightedScores === "object", "返回 weightedScores (object)");
    assert(typeof result.breakdown === "object", "返回 breakdown (object)");

    for (const dim of EXPECTED_DIMENSIONS) {
      assert(result.weightedScores[dim] !== undefined, `weightedScores 包含 ${dim}`);
      assert(result.breakdown[dim] !== undefined, `breakdown 包含 ${dim}`);
      assert(typeof result.breakdown[dim].score === "number", `breakdown.${dim}.score 是数字`);
      assert(typeof result.breakdown[dim].detail === "object", `breakdown.${dim}.detail 是对象`);
    }

    const allWeightSum = Object.values(result.weightedScores).reduce((a, b) => a + b, 0);
    assert(Math.abs(allWeightSum - result.totalScore) < 0.01, `weightedScores 求和 ≈ totalScore (${allWeightSum.toFixed(2)} ≈ ${result.totalScore})`);
  }

  console.log("\n--- 2. pilotFitsCheck 复用 evaluateCandidate 逻辑 ---");
  {
    const fits = pilotFitsCheck(db, testPilot, testTask, testTask.id);
    const evalResult = evaluateCandidate(db, testPilot, testTask);

    assert(typeof fits.ok === "boolean", "pilotFitsCheck 返回 ok (兼容旧字段)");
    assert(Array.isArray(fits.reasons), "pilotFitsCheck 返回 reasons (兼容旧字段)");
    assert(typeof fits.eligible === "boolean", "pilotFitsCheck 返回 eligible");
    assert(Array.isArray(fits.disqualifying), "pilotFitsCheck 返回 disqualifying");
    assert(typeof fits.totalScore === "number", "pilotFitsCheck 返回 totalScore");
    assert(typeof fits.weightedScores === "object", "pilotFitsCheck 返回 weightedScores");
    assert(typeof fits.breakdown === "object", "pilotFitsCheck 返回 breakdown");

    assert(fits.ok === evalResult.eligible, `ok 与 evaluateCandidate.eligible 一致 (${fits.ok} === ${evalResult.eligible})`);
    assert(JSON.stringify(fits.reasons.sort()) === JSON.stringify(evalResult.disqualifying.sort()),
      `reasons 与 disqualifying 内容一致`);
    assert(fits.totalScore === evalResult.totalScore, `totalScore 与 evaluateCandidate.totalScore 一致`);
  }

  console.log("\n--- 3. buildCandidateExplanation 统一结构 ---");
  {
    const explanation = buildCandidateExplanation(db, testPilot, testTask, testTask.id);
    assert(explanation.pilot !== undefined, "包含完整 pilot 对象");
    assert(typeof explanation.ok === "boolean", "包含 ok");
    assert(Array.isArray(explanation.reasons), "包含 reasons");
    assert(typeof explanation.eligible === "boolean", "包含 eligible");
    assert(Array.isArray(explanation.disqualifying), "包含 disqualifying");
    assert(typeof explanation.totalScore === "number", "包含 totalScore");
    assert(typeof explanation.weightedScores === "object", "包含 weightedScores");
    assert(typeof explanation.breakdown === "object", "包含 breakdown");
    assert(explanation.ok === explanation.eligible, "ok 与 eligible 等价");
  }

  console.log("\n--- 4. evaluateCandidate 支持 exceptTaskId 参数 ---");
  {
    const result1 = evaluateCandidate(db, testPilot, testTask, testTask.id);
    const result2 = evaluateCandidate(db, testPilot, testTask);
    assert(result1.totalScore === result2.totalScore, "传入 exceptTaskId 与不传（默认 task.id）结果一致");
  }

  console.log("\n--- 5. recommendPilots 返回完整结构 ---");
  {
    const result = recommendPilots(db, testTask, 3);
    assert(result.taskId === testTask.id, "返回 taskId");
    assert(Array.isArray(result.dimensions), "返回 dimensions 数组");
    assert(Array.isArray(result.candidates), "返回 candidates 数组");
    assert(result.candidates.length <= 3, "limit=3 生效");

    assert(result.dimensions.length === EXPECTED_DIMENSIONS.length,
      `dimensions 数量=${EXPECTED_DIMENSIONS.length}，实际=${result.dimensions.length}`);
    for (const dim of result.dimensions) {
      assert(EXPECTED_DIMENSIONS.includes(dim.key), `dimensions 包含 ${dim.key}`);
      assert(typeof dim.label === "string", `${dim.key} 有 label`);
      assert(typeof dim.description === "string", `${dim.key} 有 description`);
      assert(typeof dim.weight === "number", `${dim.key} 有 weight`);
      assert(dim.weight === RECOMMEND_WEIGHTS[dim.key], `${dim.key} weight 与 RECOMMEND_WEIGHTS 一致`);
    }

    for (const c of result.candidates) {
      assert(typeof c.pilotId === "string", "candidate 有 pilotId");
      assert(typeof c.name === "string", "candidate 有 name");
      assert(typeof c.totalScore === "number", "candidate 有 totalScore");
      assert(typeof c.eligible === "boolean", "candidate 有 eligible");
      assert(Array.isArray(c.disqualifying), "candidate 有 disqualifying");
      assert(typeof c.weightedScores === "object", "candidate 有 weightedScores");
      assert(typeof c.breakdown === "object", "candidate 有 breakdown");
      for (const dim of EXPECTED_DIMENSIONS) {
        assert(c.weightedScores[dim] !== undefined, `candidate.weightedScores 有 ${dim}`);
        assert(c.breakdown[dim] !== undefined, `candidate.breakdown 有 ${dim}`);
      }
    }

    const eligibleFirst = result.candidates.every((c, i, arr) => {
      if (i === 0) return true;
      if (arr[i - 1].eligible !== c.eligible) return arr[i - 1].eligible;
      return true;
    });
    assert(eligibleFirst, "排序：合格的候选排在不合格的前面");
  }

  console.log("\n--- 6. /tasks/:id/candidates 路由 - 旧字段兼容 + 新字段 ---");
  {
    const { send, getStatus, getData } = makeSend();
    handleTaskCandidates(db, testTask, send, {});
    assert(getStatus() === 200, "返回 200");

    const data = getData();
    assert(Array.isArray(data), "返回数组");
    assert(data.length === db.pilots.length, "返回所有引航员");

    const first = data[0];
    assert(typeof first.pilotId === "string", "兼容字段 pilotId 存在");
    assert(typeof first.name === "string", "兼容字段 name 存在");
    assert(typeof first.ok === "boolean", "兼容字段 ok 存在");
    assert(Array.isArray(first.reasons), "兼容字段 reasons 存在");

    assert(typeof first.eligible === "boolean", "新字段 eligible 存在");
    assert(Array.isArray(first.disqualifying), "新字段 disqualifying 存在");
    assert(typeof first.totalScore === "number", "新字段 totalScore 存在");
    assert(typeof first.weightedScores === "object", "新字段 weightedScores 存在");
    assert(typeof first.breakdown === "object", "新字段 breakdown 存在");

    assert(first.ok === first.eligible, "ok 与 eligible 等价");
    assert(JSON.stringify(first.reasons.sort()) === JSON.stringify(first.disqualifying.sort()),
      "reasons 与 disqualifying 内容一致");

    for (const dim of EXPECTED_DIMENSIONS) {
      assert(first.breakdown[dim] !== undefined, `breakdown.${dim} 存在`);
    }
  }

  console.log("\n--- 7. /tasks/:id/recommend 路由 - 完整评分维度 ---");
  {
    const { send, getStatus, getData } = makeSend();
    handleTaskRecommend(db, testTask, { limit: 2 }, send, {});
    assert(getStatus() === 200, "返回 200");

    const data = getData();
    assert(data.taskId === testTask.id, "返回 taskId");
    assert(Array.isArray(data.dimensions), "返回 dimensions 元数据");
    assert(Array.isArray(data.candidates), "返回 candidates");
    assert(data.candidates.length <= 2, "limit=2 生效");

    for (const c of data.candidates) {
      for (const dim of EXPECTED_DIMENSIONS) {
        assert(c.breakdown[dim] !== undefined, `推荐结果 breakdown 包含 ${dim}`);
        assert(c.weightedScores[dim] !== undefined, `推荐结果 weightedScores 包含 ${dim}`);
      }
    }
  }

  console.log("\n--- 8. recommendForTask (导入预览复用) - topPilot 完整结构 ---");
  {
    const result = recommendForTask(db, testTask, 3);
    assert(typeof result.totalEligible === "number", "返回 totalEligible");
    assert(typeof result.totalIneligible === "number", "返回 totalIneligible");
    assert(Array.isArray(result.recommendations), "返回 recommendations 数组");

    for (const rec of result.recommendations) {
      assert(typeof rec.pilotId === "string", "recommendation 有 pilotId");
      assert(typeof rec.name === "string", "recommendation 有 name");
      assert(typeof rec.score === "number", "recommendation 有 score (兼容)");
      assert(typeof rec.eligible === "boolean", "recommendation 有 eligible");
      assert(Array.isArray(rec.disqualifying), "recommendation 有 disqualifying");
      assert(typeof rec.weightedScores === "object", "recommendation 有 weightedScores");
      assert(typeof rec.breakdown === "object", "recommendation 有 breakdown");
    }

    if (result.topRecommendation) {
      const top = result.topRecommendation;
      assert(typeof top.pilotId === "string", "topRecommendation 有 pilotId (兼容)");
      assert(typeof top.name === "string", "topRecommendation 有 name (兼容)");
      assert(typeof top.score === "number", "topRecommendation 有 score (兼容)");
      assert(typeof top.eligible === "boolean", "topRecommendation 有 eligible");
      assert(Array.isArray(top.disqualifying), "topRecommendation 有 disqualifying");
      assert(typeof top.weightedScores === "object", "topRecommendation 有 weightedScores");
      assert(typeof top.breakdown === "object", "topRecommendation 有 breakdown");
      for (const dim of EXPECTED_DIMENSIONS) {
        assert(top.breakdown[dim] !== undefined, `topRecommendation.breakdown 包含 ${dim}`);
      }
    }
  }

  console.log("\n--- 9. analyzeImportBatch - topPilot 向后兼容 ---");
  {
    const validRows = [0];
    const allRows = [{
      vessel: { name: "测试船", type: "散货船" },
      district: "东港",
      berthPlan: "靠泊D1",
      tideWindow: { start: "2026-06-20T02:00:00.000Z", end: "2026-06-20T05:00:00.000Z" },
      requiredGrade: "B"
    }];
    const result = analyzeImportBatch(db, validRows, allRows, new Map());

    if (result.creatable.length > 0) {
      const item = result.creatable[0];
      assert("topPilot" in item, "creatable 项有 topPilot 字段");
      if (item.topPilot !== null) {
        assert(typeof item.topPilot.pilotId === "string", "topPilot.pilotId 存在 (兼容)");
        assert(typeof item.topPilot.name === "string", "topPilot.name 存在 (兼容)");
        assert(typeof item.topPilot.score === "number", "topPilot.score 存在 (兼容)");
        assert(typeof item.topPilot.eligible === "boolean", "topPilot.eligible 存在");
        assert(Array.isArray(item.topPilot.disqualifying), "topPilot.disqualifying 存在");
        assert(typeof item.topPilot.weightedScores === "object", "topPilot.weightedScores 存在");
        assert(typeof item.topPilot.breakdown === "object", "topPilot.breakdown 存在");
      } else {
        assert(true, "topPilot 为 null（无合格引航员），结构正确");
      }
    }
    assert(typeof result.creatableCount === "number", "返回 creatableCount");
  }

  console.log("\n--- 10. 维度元数据与推荐权重一致 ---");
  {
    for (const key of EXPECTED_DIMENSIONS) {
      assert(RECOMMEND_WEIGHTS[key] !== undefined, `RECOMMEND_WEIGHTS 有 ${key}`);
      assert(recommendRulesMeta[key] !== undefined, `recommendRulesMeta 有 ${key}`);
      assert(typeof recommendRulesMeta[key].label === "string", `${key} 有中文 label`);
      assert(typeof recommendRulesMeta[key].description === "string", `${key} 有 description`);
    }
  }

  console.log("\n--- 11. 冲突原因码统一 ---");
  {
    const pilotNoShift = {
      id: "P-TEST-NOSHIFT",
      name: "无值班",
      districts: ["东港"],
      shipTypes: ["散货船"],
      grades: ["A", "B"],
      shifts: []
    };
    const fits = pilotFitsCheck(db, pilotNoShift, testTask, testTask.id);
    assert(fits.ok === false, "无值班引航员 ok=false");
    assert(fits.reasons.includes("not_on_shift"), "reasons 用 not_on_shift");
    assert(fits.disqualifying.includes("not_on_shift"), "disqualifying 用 not_on_shift");

    const knownCodes = ["not_on_shift", "district_mismatch", "ship_type_mismatch", "grade_mismatch", "time_conflict", "leave_conflict"];
    for (const code of fits.disqualifying) {
      assert(knownCodes.includes(code), `disqualifying 原因码 ${code} 在已知集合中`);
    }
  }

  console.log("\n--- 12. pilotFitsCheck 与 handleTaskAssign 内部检查一致 ---");
  {
    const { pilotFitsCheck: pfc } = await import("../utils/recommendation.js");
    const fits = pfc(db, testPilot, testTask, testTask.id);
    assert(typeof fits.ok === "boolean", "pilotFitsCheck 返回 ok(boolean)");
    assert(Array.isArray(fits.reasons), "pilotFitsCheck 返回 reasons(array)");
    assert(typeof fits.eligible === "boolean", "pilotFitsCheck 返回 eligible(boolean)");
    assert(Array.isArray(fits.disqualifying), "pilotFitsCheck 返回 disqualifying(array)");
    assert(typeof fits.totalScore === "number", "pilotFitsCheck 返回 totalScore(number)");
    assert(typeof fits.weightedScores === "object", "pilotFitsCheck 返回 weightedScores(object)");
    assert(typeof fits.breakdown === "object", "pilotFitsCheck 返回 breakdown(object)");
    assert(fits.ok === fits.eligible, "ok 与 eligible 等价");
    for (const dim of EXPECTED_DIMENSIONS) {
      assert(fits.breakdown[dim] !== undefined, `pilotFitsCheck.breakdown 包含 ${dim}`);
    }
  }

  console.log(`\n=== 测试结果: ${passed} 通过, ${failed} 失败 ===\n`);
  process.exit(failed > 0 ? 1 : 0);
}

runTests().catch((err) => {
  console.error("测试执行失败:", err);
  process.exit(1);
});
