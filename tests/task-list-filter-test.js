import { loadDb } from "../utils/db.js";
import { filterTasks } from "../routes/tasks.js";
import { validateTaskListParams } from "../utils/validator.js";

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

async function runTests() {
  console.log("\n=== 任务列表筛选模块验证测试 ===\n");

  const db = await loadDb();
  const allTasks = db.tasks;
  const totalCount = allTasks.length;

  console.log(`测试数据：共 ${totalCount} 条任务`);
  console.log(`  - T-260614-01: 东港, assigned, 引航员P-01, 船名"远泰7", 窗口2026-06-14T02:30~05:30`);
  console.log(`  - T-260614-02: 北槽, pending, 无引航员, 船名"海盛号", 窗口2026-06-14T10:00~13:00`);
  console.log(`  - T-260614-03: 西港, pending, 无引航员, 船名"远泰9", 窗口2026-06-15T06:00~09:00`);
  console.log(`  - T-260614-04: 东港, pending, 无引航员, 船名"长江明珠", 窗口2026-06-17T02:00~05:00`);
  console.log(`  - T-260614-05: 北槽, pending, 无引航员, 船名"海洋之星", 窗口2026-06-15T08:00~11:00`);
  console.log("");

  console.log("--- 1. 基础筛选（原有功能兼容性） ---");
  {
    const r1 = filterTasks(allTasks, {});
    assert(r1.length === totalCount, `无筛选时返回全部 ${totalCount} 条，实际=${r1.length}`);

    const r2 = filterTasks(allTasks, { status: "pending" });
    const expectedPending = allTasks.filter((t) => t.status === "pending").length;
    assert(r2.length === expectedPending, `按status=pending筛选应返回${expectedPending}条，实际=${r2.length}`);
    assert(r2.every((t) => t.status === "pending"), "pending筛选结果状态全部为pending");

    const r3 = filterTasks(allTasks, { district: "东港" });
    const expectedDonggang = allTasks.filter((t) => t.district === "东港").length;
    assert(r3.length === expectedDonggang, `按district=东港筛选应返回${expectedDonggang}条，实际=${r3.length}`);
    assert(r3.every((t) => t.district === "东港"), "东港筛选结果港区全部为东港");

    const r4 = filterTasks(allTasks, { status: "pending", district: "北槽" });
    assert(r4.length === 2, `pending+北槽筛选应返回2条，实际=${r4.length}`);
    assert(r4.some((t) => t.id === "T-260614-02"), "包含T-260614-02");
    assert(r4.some((t) => t.id === "T-260614-05"), "包含T-260614-05");
  }

  console.log("\n--- 2. 活跃任务筛选（activeOnly） ---");
  {
    const r1 = filterTasks(allTasks, { activeOnly: true });
    assert(r1.length === totalCount, `当前数据无cancelled/completed/done，activeOnly=true返回全部${totalCount}条，实际=${r1.length}`);

    const testTasks = [
      ...JSON.parse(JSON.stringify(allTasks)),
      { id: "T-COMPLETED", status: "completed", vessel: { name: "完成船" }, district: "东港", tideWindow: { start: "2026-06-10T00:00:00.000Z", end: "2026-06-10T03:00:00.000Z" } },
      { id: "T-CANCELLED", status: "cancelled", vessel: { name: "取消船" }, district: "东港", tideWindow: { start: "2026-06-10T00:00:00.000Z", end: "2026-06-10T03:00:00.000Z" } },
      { id: "T-DONE", status: "done", vessel: { name: "办结船" }, district: "东港", tideWindow: { start: "2026-06-10T00:00:00.000Z", end: "2026-06-10T03:00:00.000Z" } }
    ];
    const r2 = filterTasks(testTasks, { activeOnly: true });
    assert(r2.length === totalCount, `活跃任务筛选排除completed/cancelled/done，应返回${totalCount}条，实际=${r2.length}`);
    assert(!r2.some((t) => t.id === "T-COMPLETED"), "不含completed任务");
    assert(!r2.some((t) => t.id === "T-CANCELLED"), "不含cancelled任务");
    assert(!r2.some((t) => t.id === "T-DONE"), "不含done任务");

    const r3 = filterTasks(testTasks, { activeOnly: false });
    assert(r3.length === testTasks.length, "activeOnly=false不筛选，返回全部");
  }

  console.log("\n--- 3. 引航员ID筛选（pilotId） ---");
  {
    const r1 = filterTasks(allTasks, { pilotId: "P-01" });
    assert(r1.length === 1, `pilotId=P-01应返回1条，实际=${r1.length}`);
    assert(r1[0].id === "T-260614-01", "返回任务为T-260614-01（已分配给P-01）");

    const r2 = filterTasks(allTasks, { pilotId: "P-999" });
    assert(r2.length === 0, "不存在的引航员ID返回0条");

    const r3 = filterTasks(allTasks, { pilotId: null });
    assert(r3.length === totalCount, "pilotId为null时不筛选");
  }

  console.log("\n--- 4. 船名关键词筛选（vesselName） ---");
  {
    const r1 = filterTasks(allTasks, { vesselName: "远泰" });
    assert(r1.length === 2, `vesselName="远泰"应匹配2条，实际=${r1.length}`);
    assert(r1.some((t) => t.id === "T-260614-01"), "包含远泰7");
    assert(r1.some((t) => t.id === "T-260614-03"), "包含远泰9");

    const r2 = filterTasks(allTasks, { vesselName: "YUANTAI" });
    assert(r2.length === 0, `vesselName="YUANTAI"（拼音）不匹配，返回0条，实际=${r2.length}`);

    const r3 = filterTasks(allTasks, { vesselName: "海盛" });
    assert(r3.length === 1, `vesselName="海盛"应匹配1条，实际=${r3.length}`);
    assert(r3[0].id === "T-260614-02", "匹配海盛号");

    const r4 = filterTasks(allTasks, { vesselName: "星" });
    assert(r4.length === 1, `vesselName="星"应匹配海洋之星1条，实际=${r4.length}`);
    assert(r4[0].id === "T-260614-05", "匹配海洋之星");
  }

  console.log("\n--- 5. 潮汐窗口筛选（tideWindow） ---");
  {
    const r1 = filterTasks(allTasks, {
      tideWindow: { start: "2026-06-14T00:00:00.000Z", end: "2026-06-15T00:00:00.000Z" }
    });
    assert(r1.length === 2, `6月14日当天窗口内的任务应有2条，实际=${r1.length}`);
    assert(r1.some((t) => t.id === "T-260614-01"), "包含T-260614-01（14日02:30~05:30）");
    assert(r1.some((t) => t.id === "T-260614-02"), "包含T-260614-02（14日10:00~13:00）");

    const r2 = filterTasks(allTasks, {
      tideWindow: { start: "2026-06-15T00:00:00.000Z", end: "2026-06-16T00:00:00.000Z" }
    });
    assert(r2.length === 2, `6月15日当天窗口内的任务应有2条，实际=${r2.length}`);
    assert(r2.some((t) => t.id === "T-260614-03"), "包含T-260614-03（15日06:00~09:00）");
    assert(r2.some((t) => t.id === "T-260614-05"), "包含T-260614-05（15日08:00~11:00）");

    const r3 = filterTasks(allTasks, {
      tideWindow: { start: "2026-06-15T07:00:00.000Z", end: null }
    });
    assert(r3.length === 3, `tideWindowStart=15日07:00（只给起始），应匹配3条，实际=${r3.length}`);
    assert(r3.some((t) => t.id === "T-260614-03"), "包含T-260614-03（结束09:00>07:00）");
    assert(r3.some((t) => t.id === "T-260614-05"), "包含T-260614-05（结束11:00>07:00）");
    assert(r3.some((t) => t.id === "T-260614-04"), "包含T-260614-04（17日，结束更晚）");

    const r4 = filterTasks(allTasks, {
      tideWindow: { start: null, end: "2026-06-15T07:00:00.000Z" }
    });
    assert(r4.length === 3, `tideWindowEnd=15日07:00（只给结束），应匹配3条，实际=${r4.length}`);
    assert(r4.some((t) => t.id === "T-260614-01"), "包含T-260614-01（14日）");
    assert(r4.some((t) => t.id === "T-260614-02"), "包含T-260614-02（14日）");
    assert(r4.some((t) => t.id === "T-260614-03"), "包含T-260614-03（起始06:00<07:00）");

    const r5 = filterTasks(allTasks, {
      tideWindow: { start: "2026-06-14T04:00:00.000Z", end: "2026-06-14T11:00:00.000Z" }
    });
    assert(r5.length === 2, `窗口04:00~11:00，重叠T-260614-01和T-260614-02，共2条，实际=${r5.length}`);

    const r6 = filterTasks(allTasks, {
      tideWindow: { start: "2026-06-14T06:00:00.000Z", end: "2026-06-14T09:00:00.000Z" }
    });
    assert(r6.length === 0, `完全在两个任务窗口间隙（06:00~09:00），返回0条，实际=${r6.length}`);
  }

  console.log("\n--- 6. 多条件组合筛选 ---");
  {
    const r1 = filterTasks(allTasks, {
      district: "东港",
      activeOnly: true,
      vesselName: "远泰"
    });
    assert(r1.length === 1, `东港+活跃+船名含"远泰"应返回1条，实际=${r1.length}`);
    assert(r1[0].id === "T-260614-01", "匹配T-260614-01");

    const r2 = filterTasks(allTasks, {
      district: "北槽",
      tideWindow: { start: "2026-06-14T00:00:00.000Z", end: "2026-06-16T00:00:00.000Z" }
    });
    assert(r2.length === 2, `北槽+14~16日窗口应返回2条，实际=${r2.length}`);
    assert(r2.some((t) => t.id === "T-260614-02"), "包含T-260614-02");
    assert(r2.some((t) => t.id === "T-260614-05"), "包含T-260614-05");

    const r3 = filterTasks(allTasks, {
      pilotId: "P-01",
      status: "assigned"
    });
    assert(r3.length === 1, `P-01+assigned返回1条，实际=${r3.length}`);
    assert(r3[0].id === "T-260614-01", "匹配T-260614-01");

    const r4 = filterTasks(allTasks, {
      pilotId: "P-01",
      status: "pending"
    });
    assert(r4.length === 0, "P-01+pending返回0条（P-01的任务是assigned）");
  }

  console.log("\n--- 7. 参数验证（validateTaskListParams） ---");
  {
    const v1 = validateTaskListParams(makeParams({}));
    assert(v1.valid === true, "空参数验证通过");
    assert(Object.keys(v1.filters).length === 0, "空参数filters为空对象");

    const v2 = validateTaskListParams(makeParams({ status: "pending", district: "东港" }));
    assert(v2.valid === true, "合法status和district验证通过");
    assert(v2.filters.status === "pending", "filters.status=pending");
    assert(v2.filters.district === "东港", "filters.district=东港");

    const v3 = validateTaskListParams(makeParams({ status: "invalid_status" }));
    assert(v3.valid === false, "非法status验证失败");
    assert(v3.errors.some((e) => e.code === "invalid_status"), "含invalid_status错误");

    const v4 = validateTaskListParams(makeParams({ district: "南极" }));
    assert(v4.valid === false, "非法district验证失败");
    assert(v4.errors.some((e) => e.code === "invalid_district"), "含invalid_district错误");

    const v5 = validateTaskListParams(makeParams({
      tideWindowStart: "2026-06-14T00:00:00.000Z",
      tideWindowEnd: "2026-06-15T00:00:00.000Z"
    }));
    assert(v5.valid === true, "合法潮汐窗口范围验证通过");
    assert(v5.filters.tideWindow.start === "2026-06-14T00:00:00.000Z", "filters.tideWindow.start正确");
    assert(v5.filters.tideWindow.end === "2026-06-15T00:00:00.000Z", "filters.tideWindow.end正确");

    const v6 = validateTaskListParams(makeParams({
      tideWindowStart: "invalid-date",
      tideWindowEnd: "2026-06-15T00:00:00.000Z"
    }));
    assert(v6.valid === false, "非法起始时间验证失败");
    assert(v6.errors.some((e) => e.code === "invalid_tide_window_start"), "含invalid_tide_window_start错误");

    const v7 = validateTaskListParams(makeParams({
      tideWindowStart: "2026-06-15T00:00:00.000Z",
      tideWindowEnd: "2026-06-14T00:00:00.000Z"
    }));
    assert(v7.valid === false, "潮汐窗口时间反序验证失败");
    assert(v7.errors.some((e) => e.code === "tide_window_end_before_start"), "含tide_window_end_before_start错误");

    const v8 = validateTaskListParams(makeParams({ pilotId: "P-01" }));
    assert(v8.valid === true, "合法pilotId验证通过");
    assert(v8.filters.pilotId === "P-01", "filters.pilotId正确");

    const v9 = validateTaskListParams(makeParams({ pilotId: "   " }));
    assert(v9.valid === false, "空白pilotId验证失败");
    assert(v9.errors.some((e) => e.code === "empty_pilot_id"), "含empty_pilot_id错误");

    const v10 = validateTaskListParams(makeParams({ vesselName: "远泰" }));
    assert(v10.valid === true, "合法vesselName验证通过");
    assert(v10.filters.vesselName === "远泰", "filters.vesselName正确");

    const v11 = validateTaskListParams(makeParams({ vesselName: "" }));
    assert(v11.valid === false, "空vesselName验证失败");
    assert(v11.errors.some((e) => e.code === "empty_vessel_name"), "含empty_vessel_name错误");

    const v12 = validateTaskListParams(makeParams({ activeOnly: "true" }));
    assert(v12.valid === true, "activeOnly=true验证通过");
    assert(v12.filters.activeOnly === true, "filters.activeOnly=true");

    const v13 = validateTaskListParams(makeParams({ activeOnly: "yes" }));
    assert(v13.valid === true, "activeOnly=yes验证通过");
    assert(v13.filters.activeOnly === true, "filters.activeOnly=true（yes映射）");

    const v14 = validateTaskListParams(makeParams({ activeOnly: "false" }));
    assert(v14.valid === true, "activeOnly=false验证通过");
    assert(v14.filters.activeOnly === false, "filters.activeOnly=false");

    const v15 = validateTaskListParams(makeParams({ activeOnly: "invalid" }));
    assert(v15.valid === false, "非法activeOnly值验证失败");
    assert(v15.errors.some((e) => e.code === "invalid_active_only"), "含invalid_active_only错误");

    const v16 = validateTaskListParams(makeParams({
      status: "pending",
      district: "东港",
      tideWindowStart: "2026-06-14T00:00:00.000Z",
      tideWindowEnd: "2026-06-15T00:00:00.000Z",
      pilotId: "P-01",
      vesselName: "远泰",
      activeOnly: "true"
    }));
    assert(v16.valid === true, "全部合法参数组合验证通过");
    assert(v16.filters.status === "pending", "组合参数filters.status正确");
    assert(v16.filters.district === "东港", "组合参数filters.district正确");
    assert(v16.filters.tideWindow !== undefined, "组合参数filters.tideWindow存在");
    assert(v16.filters.pilotId === "P-01", "组合参数filters.pilotId正确");
    assert(v16.filters.vesselName === "远泰", "组合参数filters.vesselName正确");
    assert(v16.filters.activeOnly === true, "组合参数filters.activeOnly正确");
  }

  console.log("\n--- 8. 路由集成（handleTaskList mock测试） ---");
  {
    const { handleTaskList } = await import("../routes/tasks.js");

    let capturedStatus;
    let capturedData;
    const mockSend = (res, status, data) => {
      capturedStatus = status;
      capturedData = data;
    };
    const mockRes = {};

    handleTaskList(db, makeParams({ status: "pending", district: "东港" }), mockSend, mockRes);
    assert(capturedStatus === 200, `合法参数返回200，实际=${capturedStatus}`);
    assert(Array.isArray(capturedData), "返回数组类型");
    assert(capturedData.length === 1, `pending+东港返回1条，实际=${capturedData.length}`);
    assert(capturedData[0].id === "T-260614-04", "返回T-260614-04");

    handleTaskList(db, makeParams({ pilotId: "P-01", activeOnly: "true" }), mockSend, mockRes);
    assert(capturedStatus === 200, `pilotId+activeOnly返回200，实际=${capturedStatus}`);
    assert(capturedData.length === 1, "P-01+活跃返回1条");
    assert(capturedData[0].id === "T-260614-01", "返回T-260614-01");

    handleTaskList(db, makeParams({
      tideWindowStart: "2026-06-14T00:00:00.000Z",
      tideWindowEnd: "2026-06-15T00:00:00.000Z",
      vesselName: "远"
    }), mockSend, mockRes);
    assert(capturedStatus === 200, `窗口+船名返回200，实际=${capturedStatus}`);
    assert(capturedData.length === 1, `6月14日窗口内船名含"远"返回1条，实际=${capturedData.length}`);
    assert(capturedData[0].id === "T-260614-01", "返回T-260614-01");

    handleTaskList(db, makeParams({ status: "invalid" }), mockSend, mockRes);
    assert(capturedStatus === 400, `非法参数返回400，实际=${capturedStatus}`);
    assert(capturedData.error === "invalid_filters", "错误类型为invalid_filters");
    assert(Array.isArray(capturedData.errors), "含errors数组");
  }

  console.log(`\n=== 测试结果: ${passed} 通过, ${failed} 失败 ===\n`);
  process.exit(failed > 0 ? 1 : 0);
}

runTests().catch((err) => {
  console.error("测试执行失败:", err);
  process.exit(1);
});
