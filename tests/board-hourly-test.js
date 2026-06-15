import { loadDb, saveDb, resetAllToSeed } from "../utils/db.js";
import { hourlyBuckets, overlaps } from "../utils/time.js";
import { buildBoard, buildDistrictBoard } from "../services/board.js";
import { handleBoardOverview, handleBoardDistrict } from "../routes/board.js";

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
  console.log("\n=== 调度看板12小时运力分桶视图测试 ===\n");

  console.log("--- 1. hourlyBuckets 工具函数 ---");
  {
    const buckets = hourlyBuckets("2026-06-14T00:00:00.000Z", 12);
    assert(Array.isArray(buckets), "返回数组");
    assert(buckets.length === 12, "默认12个分桶");
    assert(buckets[0].index === 0, "第一个桶 index=0");
    assert(buckets[11].index === 11, "第十二个桶 index=11");
    assert(buckets[0].hour === 0, "第一个桶 UTC 小时=0");
    assert(buckets[3].hour === 3, "第四个桶 UTC 小时=3");
    assert(buckets[0].start === "2026-06-14T00:00:00.000Z", "桶0起始时间正确");
    assert(buckets[0].end === "2026-06-14T01:00:00.000Z", "桶0结束时间正确");
    assert(buckets[11].start === "2026-06-14T11:00:00.000Z", "桶11起始时间正确");
    assert(buckets[11].end === "2026-06-14T12:00:00.000Z", "桶11结束时间正确");
    for (let i = 0; i < buckets.length - 1; i++) {
      assert(buckets[i].end === buckets[i + 1].start, `桶${i}与桶${i + 1}首尾相接`);
    }

    const customBuckets = hourlyBuckets("2026-06-14T08:00:00.000Z", 24);
    assert(customBuckets.length === 24, "支持自定义桶数量");
    assert(customBuckets[0].start === "2026-06-14T08:00:00.000Z", "自定义起始基准时间正确");
  }

  console.log("\n--- 2. buildBoard 全港区看板包含 hourlyCapacity ---");
  {
    const db = await resetDb();
    const board = buildBoard(db, "2026-06-14T00:00:00.000Z");
    assert(board.districts !== undefined, "看板包含 districts 数组");
    assert(board.districts.length === 3, "三个港区");
    for (const d of board.districts) {
      assert(d.hourlyCapacity !== undefined, `港区 ${d.district} 包含 hourlyCapacity`);
      assert(d.hourlyCapacity.length === 12, `港区 ${d.district} hourlyCapacity 共12桶`);
    }
  }

  console.log("\n--- 3. buildDistrictBoard 单港区看板 hourlyCapacity 结构完整性 ---");
  {
    const db = await resetDb();
    const district = buildDistrictBoard(db, "东港", "2026-06-14T00:00:00.000Z", "2026-06-14T12:00:00.000Z");
    const hc = district.hourlyCapacity;
    assert(Array.isArray(hc), "hourlyCapacity 是数组");
    assert(hc.length === 12, "hourlyCapacity 共12条");
    for (const bucket of hc) {
      assert(typeof bucket.index === "number", "bucket.index 为数字");
      assert(typeof bucket.hour === "number", "bucket.hour 为数字");
      assert(typeof bucket.start === "string", "bucket.start 为字符串");
      assert(typeof bucket.end === "string", "bucket.end 为字符串");
      assert(typeof bucket.taskCount === "number", "bucket.taskCount 为数字");
      assert(typeof bucket.peakOverlap === "number", "bucket.peakOverlap 为数字");
      assert(typeof bucket.availablePilots === "number", "bucket.availablePilots 为数字");
      assert(typeof bucket.totalPilots === "number", "bucket.totalPilots 为数字");
      assert(Array.isArray(bucket.gapCauses), "bucket.gapCauses 为数组");
      assert(bucket.taskCount >= 0, "taskCount 非负");
      assert(bucket.peakOverlap >= 0, "peakOverlap 非负");
      assert(bucket.availablePilots >= 0, "availablePilots 非负");
      assert(bucket.peakOverlap <= bucket.taskCount || bucket.taskCount === 0, "peakOverlap <= taskCount（无任务时除外）");
    }
  }

  console.log("\n--- 4. 东港小时分桶任务数正确性（T-260614-01 窗口 02:30~05:30） ---");
  {
    const db = await resetDb();
    const district = buildDistrictBoard(db, "东港", "2026-06-14T00:00:00.000Z", "2026-06-14T12:00:00.000Z");
    const hc = district.hourlyCapacity;
    const task = db.tasks.find((t) => t.id === "T-260614-01");
    assert(task !== undefined, "存在 T-260614-01");
    assert(task.district === "东港", "T-260614-01 属于东港");

    const expectedCounts = {
      0: 0, 1: 0,
      2: 1, 3: 1, 4: 1, 5: 1,
      6: 0, 7: 0, 8: 0, 9: 0, 10: 0, 11: 0
    };
    for (let i = 0; i < 12; i++) {
      const msg = `桶${i}(${hc[i].hour}时) 任务数=${hc[i].taskCount} 预期=${expectedCounts[i]}`;
      assert(hc[i].taskCount === expectedCounts[i], msg);
    }

    assert(hc[2].peakOverlap === 1, "桶2(02:00~03:00) 峰值重叠=1");
    assert(hc[3].peakOverlap === 1, "桶3(03:00~04:00) 峰值重叠=1");
  }

  console.log("\n--- 5. 北槽小时分桶任务数正确性（T-260614-02 窗口 10:00~13:00） ---");
  {
    const db = await resetDb();
    const district = buildDistrictBoard(db, "北槽", "2026-06-14T00:00:00.000Z", "2026-06-14T12:00:00.000Z");
    const hc = district.hourlyCapacity;
    const expectedCounts = {
      0: 0, 1: 0, 2: 0, 3: 0, 4: 0, 5: 0,
      6: 0, 7: 0, 8: 0, 9: 0, 10: 1, 11: 1
    };
    for (let i = 0; i < 12; i++) {
      const msg = `北槽桶${i}(${hc[i].hour}时) 任务数=${hc[i].taskCount} 预期=${expectedCounts[i]}`;
      assert(hc[i].taskCount === expectedCounts[i], msg);
    }
  }

  console.log("\n--- 6. 多任务重叠峰值重叠数计算 ---");
  {
    const db = await resetDb();
    db.tasks.push({
      id: "T-OVERLAP-01",
      vessel: { name: "测试船1", imo: "TEST001", type: "散货船", length: 200 },
      district: "东港",
      berthPlan: "靠泊D1",
      tideWindow: { start: "2026-06-14T03:00:00.000Z", end: "2026-06-14T06:00:00.000Z" },
      requiredGrade: "B",
      status: "pending",
      pilotId: null,
      history: []
    });
    db.tasks.push({
      id: "T-OVERLAP-02",
      vessel: { name: "测试船2", imo: "TEST002", type: "集装箱船", length: 250 },
      district: "东港",
      berthPlan: "靠泊D2",
      tideWindow: { start: "2026-06-14T03:30:00.000Z", end: "2026-06-14T05:00:00.000Z" },
      requiredGrade: "A",
      status: "assigned",
      pilotId: "P-03",
      history: []
    });
    await saveDb(db);

    const district = buildDistrictBoard(db, "东港", "2026-06-14T00:00:00.000Z", "2026-06-14T12:00:00.000Z");
    const hc = district.hourlyCapacity;

    assert(hc[3].taskCount === 3, "桶3(03:00~04:00) 任务数=3（T-260614-01+T-OVERLAP-01+T-OVERLAP-02）");
    assert(hc[3].peakOverlap === 3, "桶3 峰值重叠=3（三任务在03:30~04:00重叠）");
    assert(hc[4].taskCount === 3, "桶4(04:00~05:00) 任务数=3");
    assert(hc[4].peakOverlap === 3, "桶4 峰值重叠=3");
    assert(hc[5].taskCount === 2, "桶5(05:00~06:00) 任务数=2（T-260614-01+T-OVERLAP-01）");
    assert(hc[5].peakOverlap === 2, "桶5 峰值重叠=2");
  }

  console.log("\n--- 7. 每小时可用引航员数量计算 ---");
  {
    const db = await resetDb();
    const district = buildDistrictBoard(db, "东港", "2026-06-14T00:00:00.000Z", "2026-06-14T12:00:00.000Z");
    const hc = district.hourlyCapacity;

    const donggangPilots = db.pilots.filter((p) => p.districts.includes("东港"));
    for (const bucket of hc) {
      assert(bucket.totalPilots === donggangPilots.length, `桶${bucket.index} totalPilots=${donggangPilots.length}`);
      assert(bucket.availablePilots <= bucket.totalPilots, `桶${bucket.index} available<=total`);
    }

    let anyAvailable = false;
    for (const bucket of hc) {
      if (bucket.availablePilots > 0) {
        anyAvailable = true;
        break;
      }
    }
    assert(anyAvailable, "至少有一个小时桶存在可用引航员");
  }

  console.log("\n--- 8. 缺口原因 gapCauses - busy（P-01有任务占用） ---");
  {
    const db = await resetDb();
    const district = buildDistrictBoard(db, "东港", "2026-06-14T00:00:00.000Z", "2026-06-14T12:00:00.000Z");
    const hc = district.hourlyCapacity;

    for (let i = 2; i <= 5; i++) {
      const p01Gap = hc[i].gapCauses.find((g) => g.pilotId === "P-01");
      assert(p01Gap !== undefined, `桶${i} 中 P-01 在 gapCauses 中`);
      const busyReason = p01Gap.unavailableReasons.find((r) => r.code === "busy");
      assert(busyReason !== undefined, `桶${i} P-01 不可用原因为 busy`);
      assert(Array.isArray(busyReason.detail), "busy.detail 为数组");
      const hasTask = busyReason.detail.some((d) => d.taskId === "T-260614-01");
      assert(hasTask, `busy 原因包含 T-260614-01`);
    }

    const p01Bucket0 = hc[0].gapCauses.find((g) => g.pilotId === "P-01");
    if (p01Bucket0) {
      const busyReason0 = p01Bucket0.unavailableReasons.find((r) => r.code === "busy");
      assert(busyReason0 === undefined, "桶0(00:00) P-01 无 busy 原因（无任务重叠）");
    }
  }

  console.log("\n--- 9. 缺口原因 gapCauses - off_shift（不在值班时段） ---");
  {
    const db = await resetDb();
    const district = buildDistrictBoard(db, "西港", "2026-06-14T00:00:00.000Z", "2026-06-14T12:00:00.000Z");
    const hc = district.hourlyCapacity;

    for (let i = 0; i < 8; i++) {
      const p02Gap = hc[i].gapCauses.find((g) => g.pilotId === "P-02");
      if (p02Gap) {
        const offShiftReason = p02Gap.unavailableReasons.find((r) => r.code === "off_shift");
        assert(offShiftReason !== undefined, `西港桶${i} P-02 原因为 off_shift（其值班从08时开始）`);
      }
    }

    for (let i = 8; i < 12; i++) {
      const p02Gap = hc[i].gapCauses.find((g) => g.pilotId === "P-02");
      if (p02Gap) {
        const offShiftReason = p02Gap.unavailableReasons.find((r) => r.code === "off_shift");
        assert(offShiftReason === undefined, `西港桶${i} P-02 不在 off_shift 状态（值班时段内）`);
      }
    }
  }

  console.log("\n--- 10. 缺口原因 gapCauses - leave（请假冲突） ---");
  {
    const db = await resetDb();
    db.leaveRecords.push({
      id: "L-HOURLY-TEST",
      pilotId: "P-03",
      type: "sick",
      period: { start: "2026-06-14T04:00:00.000Z", end: "2026-06-14T08:00:00.000Z" },
      reason: "病假测试",
      status: "active",
      createdAt: new Date().toISOString()
    });
    await saveDb(db);

    const district = buildDistrictBoard(db, "东港", "2026-06-14T00:00:00.000Z", "2026-06-14T12:00:00.000Z");
    const hc = district.hourlyCapacity;

    for (let i = 4; i < 6; i++) {
      const p03Gap = hc[i].gapCauses.find((g) => g.pilotId === "P-03");
      assert(p03Gap !== undefined, `东港桶${i} P-03 在 gapCauses 中`);
      const offShiftReason = p03Gap.unavailableReasons.find((r) => r.code === "off_shift");
      assert(offShiftReason !== undefined, `东港桶${i} P-03 不在班次(06时开始上班)，原因为 off_shift`);
      const leaveReasonEarly = p03Gap.unavailableReasons.find((r) => r.code === "leave");
      assert(leaveReasonEarly === undefined, `东港桶${i} P-03 不在班次时不额外标记 leave`);
    }

    for (let i = 6; i < 8; i++) {
      const p03Gap = hc[i].gapCauses.find((g) => g.pilotId === "P-03");
      assert(p03Gap !== undefined, `东港桶${i} P-03 在 gapCauses 中`);
      const leaveReason = p03Gap.unavailableReasons.find((r) => r.code === "leave");
      assert(leaveReason !== undefined, `东港桶${i} P-03 在班次内且请假重叠，原因为 leave`);
      assert(Array.isArray(leaveReason.detail), "leave.detail 为数组");
      assert(leaveReason.detail.some((d) => d.leaveId === "L-HOURLY-TEST"), "leave 原因包含测试请假ID");
    }
  }

  console.log("\n--- 11. 旧字段向后兼容 - taskCounts / tidePressure / pilots 保留 ---");
  {
    const db = await resetDb();
    const board = buildBoard(db, "2026-06-14T00:00:00.000Z");
    assert(board.summary !== undefined, "summary 字段保留");
    assert(board.window !== undefined, "window 字段保留");
    assert(board.generatedAt !== undefined, "generatedAt 字段保留");
    for (const d of board.districts) {
      assert(d.taskCounts !== undefined, `${d.district} taskCounts 保留`);
      assert(d.tidePressure !== undefined, `${d.district} tidePressure 保留`);
      assert(d.pilots !== undefined, `${d.district} pilots 保留`);
      assert(typeof d.pilots.total === "number", `${d.district} pilots.total 存在`);
      assert(typeof d.pilots.available === "number", `${d.district} pilots.available 存在`);
    }
  }

  console.log("\n--- 12. 路由层输出 - handleBoardOverview 包含 hourlyCapacity ---");
  {
    const db = await resetDb();
    const { send, getStatus, getData } = makeSend();
    const searchParams = new URLSearchParams("date=2026-06-14T00:00:00.000Z");
    await handleBoardOverview(db, searchParams, send, {});
    assert(getStatus() === 200, "全港区看板返回 200");
    const data = getData();
    assert(data.districts !== undefined, "路由输出包含 districts");
    for (const d of data.districts) {
      assert(d.hourlyCapacity !== undefined, `路由输出 港区${d.district} 包含 hourlyCapacity`);
      assert(d.hourlyCapacity.length === 12, "路由输出 hourlyCapacity 共12桶");
      assert(d.taskCounts !== undefined, "路由输出 taskCounts 兼容保留");
      assert(d.tidePressure !== undefined, "路由输出 tidePressure 兼容保留");
      assert(d.pilots !== undefined, "路由输出 pilots 兼容保留");
    }
  }

  console.log("\n--- 13. 路由层输出 - handleBoardDistrict 单港区包含 hourlyCapacity ---");
  {
    const db = await resetDb();
    const { send, getStatus, getData } = makeSend();
    const searchParams = new URLSearchParams("date=2026-06-14T00:00:00.000Z");
    await handleBoardDistrict(db, "北槽", searchParams, send, {});
    assert(getStatus() === 200, "单港区看板返回 200");
    const data = getData();
    assert(data.generatedAt !== undefined, "单港区路由输出 generatedAt");
    assert(data.window !== undefined, "单港区路由输出 window");
    assert(data.district === "北槽", "单港区路由输出 district=北槽");
    assert(data.hourlyCapacity !== undefined, "单港区路由输出包含 hourlyCapacity");
    assert(data.hourlyCapacity.length === 12, "单港区路由输出 hourlyCapacity 共12桶");
    assert(data.taskCounts !== undefined, "单港区路由输出 taskCounts 兼容保留");
  }

  console.log("\n--- 14. 无效港区路由返回 400 兼容 ---");
  {
    const db = await resetDb();
    const { send, getStatus } = makeSend();
    const searchParams = new URLSearchParams();
    await handleBoardDistrict(db, "无效港区", searchParams, send, {});
    assert(getStatus() === 400, "无效港区返回 400（兼容）");
  }

  console.log("\n--- 15. 不同基准日期的小时桶正确性 ---");
  {
    const db = await resetDb();
    const base1 = "2026-06-14T06:00:00.000Z";
    const board1 = buildBoard(db, base1);
    const hc1 = board1.districts[0].hourlyCapacity;
    assert(hc1[0].start === "2026-06-14T06:00:00.000Z", "基准06时 桶0起始=06时");
    assert(hc1[11].end === "2026-06-14T18:00:00.000Z", "基准06时 桶11结束=18时");
    assert(hc1[0].hour === 6, "基准06时 桶0 hour=6");
    assert(hc1[6].hour === 12, "基准06时 桶6 hour=12");

    const base2 = "2026-06-15T22:00:00.000Z";
    const board2 = buildBoard(db, base2);
    const hc2 = board2.districts[0].hourlyCapacity;
    assert(hc2[0].start === "2026-06-15T22:00:00.000Z", "跨日基准 桶0起始正确");
    assert(hc2[2].start === "2026-06-16T00:00:00.000Z", "跨日基准 桶2跨到次日0时");
    assert(hc2[2].hour === 0, "跨日基准 桶2 hour=0（UTC）");
  }

  console.log(`\n=== 测试结果: ${passed} 通过, ${failed} 失败 ===\n`);
  process.exit(failed > 0 ? 1 : 0);
}

runTests().catch((err) => {
  console.error("测试执行失败:", err);
  process.exit(1);
});
