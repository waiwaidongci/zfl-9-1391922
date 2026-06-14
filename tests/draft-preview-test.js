import { loadDb } from "../utils/db.js";
import { previewDraft } from "../services/draft-preview.js";
import { validateDraftForSubmit, REQUIRED_TASK_FIELDS } from "../routes/drafts.js";

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
  console.log("\n=== 草稿预览模块验证测试 ===\n");

  const db = await loadDb();
  const originalTaskCount = db.tasks.length;
  const originalDraftCount = db.drafts.length;
  const completeDraft = db.drafts.find((d) => d.id === "D-260614-01");
  const incompleteDraft = db.drafts.find((d) => d.id === "D-260614-02");

  console.log("--- 1. 字段完整性验证 ---");
  {
    const missing1 = validateDraftForSubmit(completeDraft);
    assert(missing1.length === 0, `完整草稿 D-260614-01 无缺失字段，实际缺失=${missing1.length}`);

    const missing2 = validateDraftForSubmit(incompleteDraft);
    assert(missing2.length > 0, `不完整草稿 D-260614-02 有缺失字段，缺失=${missing2.join(",")}`);
    assert(missing2.includes("berthPlan"), "缺失字段包含 berthPlan");
    assert(missing2.includes("tideWindow.start/end") || missing2.includes("tideWindow"), "缺失字段包含 tideWindow");
  }

  console.log("\n--- 2. 必填字段常量 ---");
  {
    assert(Array.isArray(REQUIRED_TASK_FIELDS), "REQUIRED_TASK_FIELDS 是数组");
    assert(REQUIRED_TASK_FIELDS.includes("vessel"), "必填字段包含 vessel");
    assert(REQUIRED_TASK_FIELDS.includes("district"), "必填字段包含 district");
    assert(REQUIRED_TASK_FIELDS.includes("berthPlan"), "必填字段包含 berthPlan");
    assert(REQUIRED_TASK_FIELDS.includes("tideWindow"), "必填字段包含 tideWindow");
    assert(REQUIRED_TASK_FIELDS.includes("requiredGrade"), "必填字段包含 requiredGrade");
  }

  console.log("\n--- 3. 完整草稿预览 ---");
  {
    const result = previewDraft(db, completeDraft);

    assert(result.draftId === "D-260614-01", "返回草稿ID正确");
    assert(typeof result.previewedAt === "string", "包含预览时间戳");
    assert(result.canSubmit === true, "完整草稿 canSubmit=true");

    assert(result.fieldCompleteness.complete === true, "fieldCompleteness.complete=true");
    assert(result.fieldCompleteness.missingFields.length === 0, "missingFields 为空数组");
    assert(result.fieldCompleteness.requiredFields.length === REQUIRED_TASK_FIELDS.length, "requiredFields 数量正确");

    assert(result.fieldCompleteness.fieldStatus.vessel.present === true, "vessel 字段状态为 present");
    assert(result.fieldCompleteness.fieldStatus.district.present === true, "district 字段状态为 present");
    assert(result.fieldCompleteness.fieldStatus.berthPlan.present === true, "berthPlan 字段状态为 present");
    assert(result.fieldCompleteness.fieldStatus.tideWindow.present === true, "tideWindow 字段状态为 present");
    assert(result.fieldCompleteness.fieldStatus.requiredGrade.present === true, "requiredGrade 字段状态为 present");

    assert(typeof result.pilotRecommendation === "object", "包含 pilotRecommendation");
    assert(typeof result.pilotRecommendation.totalEligible === "number", "pilotRecommendation.totalEligible 为数字");
    assert(Array.isArray(result.pilotRecommendation.recommendations), "recommendations 为数组");
    assert(result.pilotRecommendation.recommendations.length <= 3, "推荐引航员不超过3个");

    assert(typeof result.pilotEligibility === "object", "包含 pilotEligibility");
    assert(result.pilotEligibility.totalPilots === db.pilots.length, "pilotEligibility.totalPilots 正确");
    assert(result.pilotEligibility.eligiblePilots + result.pilotEligibility.ineligiblePilots === db.pilots.length, "合格+不合格=总数");
    assert(result.pilotEligibility.breakdown.length === db.pilots.length, "breakdown 包含所有引航员");

    assert(Array.isArray(result.timeOverlapConflicts), "timeOverlapConflicts 为数组");
    assert(Array.isArray(result.leaveConflicts), "leaveConflicts 为数组");

    assert(Array.isArray(result.warnings), "warnings 为数组");
    assert(!result.warnings.some((w) => w.code === "incomplete_fields"), "完整草稿无 incomplete_fields 警告");
  }

  console.log("\n--- 4. 不完整草稿预览 ---");
  {
    const result = previewDraft(db, incompleteDraft);

    assert(result.canSubmit === false, "不完整草稿 canSubmit=false");
    assert(result.fieldCompleteness.complete === false, "fieldCompleteness.complete=false");
    assert(result.fieldCompleteness.missingFields.length > 0, "missingFields 非空");
    assert(result.fieldCompleteness.fieldStatus.tideWindow.present === false, "缺失 tideWindow 的 present=false");
    assert(typeof result.fieldCompleteness.fieldStatus.tideWindow.present === "boolean", "tideWindow.present 为布尔值");

    const missingVesselResult = previewDraft(db, {
      id: "D-TEST-MISSING-VESSEL",
      vessel: null,
      district: "东港",
      berthPlan: "靠泊D1",
      tideWindow: null,
      requiredGrade: "B"
    });
    assert(missingVesselResult.fieldCompleteness.fieldStatus.vessel.present === false, "缺失 vessel 的 present=false");
    assert(typeof missingVesselResult.fieldCompleteness.fieldStatus.vessel.present === "boolean", "vessel.present 为布尔值");

    assert(result.pilotRecommendation.totalEligible === 0, "不完整草稿无推荐合格引航员");
    assert(result.pilotRecommendation.recommendations.length === 0, "不完整草稿推荐列表为空");

    assert(result.timeOverlapConflicts.length === 0, "不完整草稿跳过时间冲突检查");
    assert(result.leaveConflicts.length === 0, "不完整草稿跳过休假冲突检查");

    const incompleteWarning = result.warnings.find((w) => w.code === "incomplete_fields");
    assert(incompleteWarning !== undefined, "存在 incomplete_fields 警告");
    assert(incompleteWarning.severity === "error", "incomplete_fields 严重级别为 error");
  }

  console.log("\n--- 5. 休假冲突检测 ---");
  {
    const leaveConflictDraft = {
      id: "D-TEST-LEAVE",
      vessel: { name: "休假冲突测试船", type: "散货船" },
      district: "东港",
      berthPlan: "靠泊D1",
      tideWindow: { start: "2026-06-17T02:00:00.000Z", end: "2026-06-17T05:00:00.000Z" },
      requiredGrade: "B",
      note: "测试 P-01 休假冲突"
    };
    const result = previewDraft(db, leaveConflictDraft);

    assert(result.leaveConflicts.length > 0, `P-01 在2026-06-17有休假，检测到 ${result.leaveConflicts.length} 个休假冲突`);
    const p01Leave = result.leaveConflicts.find((c) => c.pilotId === "P-01");
    assert(p01Leave !== undefined, "检测到 P-01 的休假冲突");
    assert(p01Leave.leaveType === "vacation", "休假类型为 vacation");
    assert(typeof p01Leave.leavePeriod === "object", "包含休假时间段");

    const leaveWarning = result.warnings.find((w) => w.code === "pilot_leave_conflict");
    assert(leaveWarning !== undefined, "存在 pilot_leave_conflict 警告");
  }

  console.log("\n--- 6. 同港区时间重叠检测 ---");
  {
    const overlapDraft = {
      id: "D-TEST-OVERLAP",
      vessel: { name: "时间重叠测试船", type: "散货船" },
      district: "东港",
      berthPlan: "靠泊D9",
      tideWindow: { start: "2026-06-14T03:00:00.000Z", end: "2026-06-14T06:00:00.000Z" },
      requiredGrade: "B",
      note: "与 T-260614-01 时间重叠"
    };
    const result = previewDraft(db, overlapDraft);

    assert(result.timeOverlapConflicts.length > 0, `与同港区任务存在时间重叠，检测到 ${result.timeOverlapConflicts.length} 个`);
    const t01Conflict = result.timeOverlapConflicts.find((c) => c.taskId === "T-260614-01");
    assert(t01Conflict !== undefined, "检测到与 T-260614-01 的重叠");
    assert(t01Conflict.district === "东港", "冲突任务在东港");
    assert(typeof t01Conflict.conflictType === "string", "包含 conflictType");

    const overlapWarning = result.warnings.find((w) => w.code === "district_time_overlap");
    assert(overlapWarning !== undefined, "存在 district_time_overlap 警告");
  }

  console.log("\n--- 7. 候选引航员推荐复用 ---");
  {
    const result = previewDraft(db, completeDraft);

    if (result.pilotRecommendation.topRecommendation) {
      const top = result.pilotRecommendation.topRecommendation;
      assert(typeof top.pilotId === "string", "topRecommendation.pilotId 为字符串");
      assert(typeof top.name === "string", "topRecommendation.name 为字符串");
      assert(typeof top.score === "number", "topRecommendation.score 为数字");
    }

    for (const rec of result.pilotRecommendation.recommendations) {
      assert(typeof rec.pilotId === "string", `推荐 ${rec.pilotId} 有 pilotId`);
      assert(typeof rec.name === "string", `推荐 ${rec.pilotId} 有 name`);
      assert(typeof rec.score === "number", `推荐 ${rec.pilotId} 有 score`);
    }

    for (const pilot of result.pilotEligibility.breakdown) {
      assert(typeof pilot.pilotId === "string", "breakdown 项有 pilotId");
      assert(typeof pilot.eligible === "boolean", "breakdown 项有 eligible(boolean)");
      assert(Array.isArray(pilot.disqualifying), "breakdown 项 disqualifying 为数组");
    }
  }

  console.log("\n--- 8. 预览不修改数据（无副作用） ---");
  {
    const result = previewDraft(db, completeDraft);
    assert(db.tasks.length === originalTaskCount, `预览后任务数不变 (${originalTaskCount})`);
    assert(db.drafts.length === originalDraftCount, `预览后草稿数不变 (${originalDraftCount})`);

    const stillExists = db.drafts.find((d) => d.id === completeDraft.id);
    assert(stillExists !== undefined, "预览后草稿仍存在于 db.drafts");

    const reloadedDb = await loadDb();
    assert(reloadedDb.tasks.length === originalTaskCount, "重新加载后任务数仍不变");
    assert(reloadedDb.drafts.length === originalDraftCount, "重新加载后草稿数仍不变");
  }

  console.log("\n--- 9. 路由 handleDraftPreview mock 测试 ---");
  {
    const { handleDraftPreview } = await import("../routes/drafts.js");

    let capturedStatus;
    let capturedData;
    const mockSend = (res, status, data) => {
      capturedStatus = status;
      capturedData = data;
    };
    const mockRes = {};

    handleDraftPreview(db, "D-260614-01", mockSend, mockRes);
    assert(capturedStatus === 200, `完整草稿预览返回 200，实际=${capturedStatus}`);
    assert(capturedData.canSubmit === true, "响应中 canSubmit=true");
    assert(capturedData.draftId === "D-260614-01", "响应中 draftId 正确");

    handleDraftPreview(db, "D-NOT-EXIST", mockSend, mockRes);
    assert(capturedStatus === 404, `不存在草稿返回 404，实际=${capturedStatus}`);
    assert(capturedData.error === "draft_not_found", "错误类型为 draft_not_found");
  }

  console.log("\n--- 10. 不同港区无时间重叠 ---");
  {
    const differentDistrictDraft = {
      id: "D-TEST-DIFF-DIST",
      vessel: { name: "跨港区测试船", type: "散货船" },
      district: "西港",
      berthPlan: "靠泊W9",
      tideWindow: { start: "2026-06-14T03:00:00.000Z", end: "2026-06-14T06:00:00.000Z" },
      requiredGrade: "B"
    };
    const result = previewDraft(db, differentDistrictDraft);
    const onlyDonggang = result.timeOverlapConflicts.filter(
      (c) => c.taskId === "T-260614-01"
    );
    assert(onlyDonggang.length === 0, "跨港区任务不产生时间重叠冲突（T-260614-01 在东港）");
  }

  console.log(`\n=== 测试结果: ${passed} 通过, ${failed} 失败 ===\n`);
  process.exit(failed > 0 ? 1 : 0);
}

runTests().catch((err) => {
  console.error("测试执行失败:", err);
  process.exit(1);
});
