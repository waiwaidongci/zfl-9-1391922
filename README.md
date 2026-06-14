# 港口引航站申请和排班API

运行：

```bash
npm start
```

默认端口是`3009`，数据保存在`data/pilot-station.json`。候选引航员接口会检查值班、港区、船型、资质和时间冲突。

## 配置模块

排班规则配置集中在 `config/scheduling-rules.js`，包含港区、船型、资质等级和任务状态等常量，以及验证函数。后续创建引航员和任务时可复用这些配置选项。

### 获取配置选项

```bash
curl "http://localhost:3009/config/options"
```

返回所有可用的配置选项：

```json
{
  "districts": ["东港", "北槽", "西港"],
  "shipTypes": ["散货船", "集装箱船", "油轮", "化学品船"],
  "grades": ["A", "B"],
  "taskStatuses": ["pending", "assigned", "in_progress", "completed", "cancelled", "done"],
  "activeTaskStatuses": ["pending", "assigned", "in_progress"],
  "changeRequestStatuses": ["pending", "approved", "rejected"],
  "changeRequestTypes": ["tide_window", "berth_plan", "cancel", "other"]
}
```

### 验证配置值

```bash
curl "http://localhost:3009/config/validate?district=东港&grade=C"
```

返回验证结果：

```json
{
  "district": { "value": "东港", "valid": true },
  "grade": { "value": "C", "valid": false }
}
```

## 任务变更审批模块

**核心规则**：已分配（`assigned`）状态的任务，修改**潮汐窗口**、**泊位计划**或**取消任务**时，不能直接生效，必须先创建变更申请，待审批通过后才会更新原任务。

### 数据模型

变更申请（changeRequest）包含以下字段：

| 字段 | 说明 |
|------|------|
| `id` | 变更申请ID，如 `CR-xxxx` |
| `taskId` | 关联的任务ID |
| `type` | 变更类型：`tide_window` / `berth_plan` / `cancel` / `other` |
| `original` | 变更前的任务快照（状态、潮汐窗口、泊位、引航员） |
| `proposed` | 拟变更的内容（`tideWindow` / `berthPlan` / `status`） |
| `status` | 申请状态：`pending` / `approved` / `rejected` |
| `reason` | 驳回原因（仅驳回时填写） |
| `applicant` / `approver` | 申请人/审批人 |
| `conflictCheck` | 冲突检测结果 `{ ok, conflicts[] }` |
| `createdAt` / `reviewedAt` | 创建/审批时间 |

---

### 1. 创建变更申请

可以直接调用变更申请创建接口，**或者**通过原有 `POST /tasks/:id/status` 接口触发（系统自动检测到是已分配任务并发起审批）。

```bash
curl -X POST "http://localhost:3009/tasks/T-260614-01/change-requests" \
  -H "Content-Type: application/json" \
  -d '{
    "tideWindow": {
      "start": "2026-06-14T04:00:00.000Z",
      "end": "2026-06-14T07:00:00.000Z"
    },
    "applicant": "调度员小王",
    "note": "船期延误，需推迟潮汐窗口"
  }'
```

**返回示例（201 Created）**：

```json
{
  "id": "CR-1718325600000",
  "taskId": "T-260614-01",
  "type": "tide_window",
  "original": {
    "status": "assigned",
    "tideWindow": { "start": "2026-06-14T02:30:00.000Z", "end": "2026-06-14T05:30:00.000Z" },
    "berthPlan": "靠泊D3",
    "pilotId": "P-01"
  },
  "proposed": {
    "tideWindow": { "start": "2026-06-14T04:00:00.000Z", "end": "2026-06-14T07:00:00.000Z" }
  },
  "status": "pending",
  "reason": null,
  "applicant": "调度员小王",
  "approver": null,
  "note": "船期延误，需推迟潮汐窗口",
  "conflictCheck": {
    "ok": true,
    "conflicts": []
  },
  "createdAt": "2026-06-14T03:00:00.000Z",
  "reviewedAt": null
}
```

**其他创建示例**：

修改泊位计划：
```bash
curl -X POST "http://localhost:3009/tasks/T-260614-01/change-requests" \
  -H "Content-Type: application/json" \
  -d '{ "berthPlan": "靠泊D5", "applicant": "调度员小王" }'
```

取消任务：
```bash
curl -X POST "http://localhost:3009/tasks/T-260614-01/change-requests" \
  -H "Content-Type: application/json" \
  -d '{ "status": "cancelled", "applicant": "调度员小王", "note": "船舶故障，取消靠泊" }'
```

通过原有 status 接口自动触发审批（已分配任务）：
```bash
curl -X POST "http://localhost:3009/tasks/T-260614-01/status" \
  -H "Content-Type: application/json" \
  -d '{ "berthPlan": "靠泊D5", "note": "临时换泊位" }'
```

---

### 2. 查询变更申请列表

```bash
# 查询所有
curl "http://localhost:3009/change-requests"

# 按状态筛选
curl "http://localhost:3009/change-requests?status=pending"

# 按任务筛选
curl "http://localhost:3009/change-requests?taskId=T-260614-01"

# 按类型筛选
curl "http://localhost:3009/change-requests?type=tide_window"
```

---

### 3. 查询单个变更申请详情

```bash
curl "http://localhost:3009/change-requests/CR-1718325600000"
```

---

### 4. 冲突复查

审批前可手动触发重新检查冲突，检测最新的引航员时间和泊位占用情况：

```bash
curl -X POST "http://localhost:3009/change-requests/CR-1718325600000/recheck"
```

**冲突检测覆盖三类问题**：
1. **引航员时间冲突**：同一引航员在新潮汐窗口内是否有其他活跃任务
2. **泊位时间冲突**：新泊位在新潮汐窗口内是否被其他任务占用
3. **同任务待审批冲突**：同一任务是否已有其他待审批的变更申请

**有冲突时返回示例**：
```json
{
  "id": "CR-1718325600000",
  "conflictCheck": {
    "ok": false,
    "conflicts": [
      {
        "type": "pilot_time_conflict",
        "pilotId": "P-01",
        "conflictingTaskId": "T-260614-05",
        "detail": "引航员时间冲突：任务T-260614-05(2026-06-14T05:00:00.000Z ~ 2026-06-14T08:00:00.000Z)"
      },
      {
        "type": "berth_time_conflict",
        "berthPlan": "靠泊D5",
        "conflictingTaskId": "T-260614-08",
        "detail": "泊位时间冲突：任务T-260614-08占用靠泊D5(...)"
      }
    ]
  }
}
```

> **注意**：即使存在冲突，审批接口仍允许强制通过，但冲突结果会记录在案供审批人参考。

---

### 5. 审批通过

通过后会**立即更新原任务**并在 `history` 中追加变更记录：

```bash
curl -X POST "http://localhost:3009/change-requests/CR-1718325600000/approve" \
  -H "Content-Type: application/json" \
  -d '{ "approver": "值班主任老李" }'
```

**返回示例（200 OK）**：

```json
{
  "changeRequest": {
    "id": "CR-1718325600000",
    "status": "approved",
    "reviewedAt": "2026-06-14T03:30:00.000Z",
    "approver": "值班主任老李",
    "conflictCheck": { "ok": true, "conflicts": [] }
  },
  "task": {
    "id": "T-260614-01",
    "tideWindow": { "start": "2026-06-14T04:00:00.000Z", "end": "2026-06-14T07:00:00.000Z" },
    "history": [
      { "at": "...", "action": "created", "note": "初始申请" },
      {
        "at": "2026-06-14T03:30:00.000Z",
        "action": "change_approved",
        "note": "变更审批通过[CR-1718325600000]：潮汐窗口 2026-06-14T02:30:00.000Z~2026-06-14T05:30:00.000Z -> 2026-06-14T04:00:00.000Z~2026-06-14T07:00:00.000Z"
      }
    ]
  }
}
```

---

### 6. 审批驳回

驳回必须提供原因，原因会写入原任务的 `history`：

```bash
curl -X POST "http://localhost:3009/change-requests/CR-1718325600000/reject" \
  -H "Content-Type: application/json" \
  -d '{
    "approver": "值班主任老李",
    "reason": "新窗口与P-01的T-260614-05任务冲突，请协调后重新提交"
  }'
```

**返回示例（200 OK）**：

```json
{
  "id": "CR-1718325600000",
  "status": "rejected",
  "reason": "新窗口与P-01的T-260614-05任务冲突，请协调后重新提交",
  "reviewedAt": "2026-06-14T03:35:00.000Z",
  "approver": "值班主任老李"
}
```

同时任务 T-260614-01 的 history 会追加：
```json
{
  "at": "2026-06-14T03:35:00.000Z",
  "action": "change_rejected",
  "note": "变更申请驳回[CR-1718325600000]：新窗口与P-01的T-260614-05任务冲突，请协调后重新提交"
}
```

---

### 状态流转图

```
           创建               审批通过
 pending ---------> approved ---------> 任务更新 + history
    |
    | 审批驳回(需原因)
    v
 rejected ---------> 任务history记录驳回原因
```

## 港区任务看板

按港区实时聚合任务状态、潮汐窗口压力和可用引航员数量，支持指定基准日期。

### 1. 全港区看板

```bash
# 默认从当前时间开始未来12小时
curl "http://localhost:3009/board"

# 指定基准日期时间
curl "http://localhost:3009/board?date=2026-06-14T08:00:00.000Z"
```

**返回示例**：

```json
{
  "generatedAt": "2026-06-14T08:00:00.000Z",
  "window": {
    "start": "2026-06-14T08:00:00.000Z",
    "end": "2026-06-14T20:00:00.000Z"
  },
  "summary": {
    "totalTasks": 5,
    "taskCounts": {
      "pending": 3,
      "assigned": 1,
      "in_progress": 0,
      "done": 0,
      "cancelled": 0
    },
    "districts": 3
  },
  "districts": [
    {
      "district": "东港",
      "taskCounts": {
        "pending": 1,
        "assigned": 1,
        "in_progress": 0,
        "done": 0,
        "cancelled": 0
      },
      "tidePressure": {
        "level": "low",
        "peakTasks": 1,
        "totalTasks": 1,
        "window": { "start": "...", "end": "..." }
      },
      "pilots": {
        "total": 3,
        "available": 2,
        "availablePilots": [
          { "pilotId": "P-03", "name": "周屿", "grades": ["A"], "shipTypes": ["散货船", "集装箱船", "油轮"] }
        ]
      }
    }
  ]
}
```

**字段说明**：

| 字段 | 说明 |
|------|------|
| `generatedAt` | 看板生成时间 |
| `window` | 未来12小时时间窗口 |
| `summary.taskCounts` | 全港区各状态任务总数 |
| `districts[].taskCounts` | 各港区五种状态（pending/assigned/in_progress/done/cancelled）任务数量 |
| `districts[].tidePressure.level` | 潮汐窗口压力等级：low / medium / high |
| `districts[].tidePressure.peakTasks` | 窗口内峰值并发任务数 |
| `districts[].tidePressure.totalTasks` | 窗口内总任务数 |
| `districts[].pilots.total` | 该港区总引航员数 |
| `districts[].pilots.available` | 该港区可用引航员数（值班、无休假、无任务冲突） |
| `districts[].pilots.availablePilots` | 可用引航员详情列表 |

---

### 2. 单港区看板详情

```bash
curl "http://localhost:3009/board/东港"
curl "http://localhost:3009/board/北槽?date=2026-06-14T10:00:00.000Z"
```

港区名为 URL 编码的中文，返回结构与全港区看板中单个 `districts` 条目一致，外加 `generatedAt` 和 `window`。

---

### 3. 潮汐压力等级判定规则

| 等级 | 条件 |
|------|------|
| `high` | 峰值任务 ≥ 5 或 总任务 ≥ 10 |
| `medium` | 峰值任务 ≥ 3 或 总任务 ≥ 5 |
| `low` | 其他情况 |

### 4. 可用引航员判定

引航员需同时满足：
- 属于该港区（`districts` 包含）
- 在未来12小时内有值班时段
- 无休假冲突
- 无已分配的活跃任务时间冲突

---

## 批量导入引航申请模块

支持一次性提交多条引航申请数据，先做预检（不污染数据文件），返回逐行校验错误、可创建任务、可能冲突任务和推荐引航员摘要，确认后再真正写入。

### 核心流程

```
POST /import/tasks (预检) ──→ 返回 sessionId + 预检结果
        │
        ▼
  用户审查预检结果
        │
        ├── POST /import/tasks/confirm (确认提交)
        │       └── 真正写入 tasks，返回逐行结果
        │
        └── POST /import/sessions/:sessionId/cancel (取消)
                └── 作废会话，不写入任何数据
```

### 关键规则

- **预检不写数据**：`POST /import/tasks` 仅在内存中创建会话，绝不修改 `data/pilot-station.json`
- **会话有效期**：30分钟，过期自动清理
- **重复ID处理**：若导入行ID与已有任务ID相同，默认覆盖更新（`overwrite: true`），设为 `false` 则跳过该行
- **部分失败**：提交时逐行处理，某行失败不影响其他行，最终返回全部结果
- **单次上限**：200条

---

### 1. 预检导入（POST /import/tasks）

接收一组申请数据，做校验和冲突分析，返回预检结果和会话ID。

```bash
curl -X POST "http://localhost:3009/import/tasks" \
  -H "Content-Type: application/json" \
  -d '{
    "tasks": [
      {
        "vessel": { "name": "金海轮", "type": "散货船", "imo": "IMO9311003", "length": 190 },
        "district": "东港",
        "berthPlan": "靠泊D7",
        "tideWindow": { "start": "2026-06-18T02:00:00.000Z", "end": "2026-06-18T05:00:00.000Z" },
        "requiredGrade": "B",
        "note": "东港散货船批量导入"
      },
      {
        "vessel": { "name": "华星号", "type": "油轮", "imo": "IMO9412005", "length": 230 },
        "district": "西港",
        "berthPlan": "靠泊W4",
        "tideWindow": { "start": "2026-06-18T06:00:00.000Z", "end": "2026-06-18T09:00:00.000Z" },
        "requiredGrade": "A",
        "note": "西港油轮批量导入"
      },
      {
        "vessel": { "name": "", "type": "无效船型" },
        "district": "南极",
        "tideWindow": { "start": "invalid" },
        "requiredGrade": "C"
      }
    ]
  }'
```

**返回示例（200 OK）**：

```json
{
  "sessionId": "IMP-1718325600000-A1B2C3D4",
  "previewedAt": "2026-06-14T09:00:00.000Z",
  "expiresAt": "2026-06-14T09:30:00.000Z",
  "status": "previewed",
  "totalCount": 3,
  "validCount": 2,
  "errorCount": 1,
  "warningCount": 0,
  "validRowIndices": [0, 1],
  "canConfirm": true,
  "rowErrors": [
    {
      "rowIndex": 2,
      "errors": [
        { "field": "vessel.name", "message": "船名不能为空", "code": "missing_vessel_name" },
        { "field": "vessel.type", "message": "无效的船型: 无效船型", "code": "invalid_vessel_type" },
        { "field": "district", "message": "无效的港区: 南极", "code": "invalid_district" },
        { "field": "tideWindow.start", "message": "潮汐窗口起始时间无效", "code": "invalid_window_start" },
        { "field": "tideWindow.end", "message": "潮汐窗口结束时间无效", "code": "invalid_window_end" },
        { "field": "requiredGrade", "message": "无效的资质等级: C", "code": "invalid_grade" }
      ],
      "warnings": []
    }
  ],
  "rowWarnings": [],
  "creatable": [
    {
      "rowIndex": 0,
      "taskId": "T-1718325600000-EFGH",
      "vesselName": "金海轮",
      "district": "东港",
      "tideWindow": { "start": "2026-06-18T02:00:00.000Z", "end": "2026-06-18T05:00:00.000Z" },
      "topPilot": { "pilotId": "P-01", "name": "沈望", "score": 85.0 },
      "eligiblePilotCount": 2
    }
  ],
  "updatable": [
    {
      "rowIndex": 1,
      "taskId": "T-260614-01",
      "vesselName": "华星号",
      "district": "西港",
      "tideWindow": { "start": "2026-06-18T06:00:00.000Z", "end": "2026-06-18T09:00:00.000Z" },
      "topPilot": { "pilotId": "P-02", "name": "何澜", "score": 90.0 },
      "eligiblePilotCount": 1,
      "existingTask": {
        "id": "T-260614-01",
        "vesselName": "远泰7",
        "district": "东港",
        "tideWindow": { "start": "2026-06-14T02:30:00.000Z", "end": "2026-06-14T05:30:00.000Z" },
        "status": "assigned",
        "pilotId": "P-01"
      }
    }
  ],
  "conflicting": [],
  "creatableCount": 1,
  "updatableCount": 1,
  "conflictingCount": 0,
  "conflictSummary": {
    "totalConflictingTasks": 0,
    "totalUpdatableTasks": 1,
    "byDistrict": [],
    "totalIdConflicts": 1,
    "totalExistingConflicts": 0,
    "totalBatchConflicts": 0,
    "canAutoCreate": 1,
    "canAutoUpdate": 1,
    "needsResolution": 0
  },
  "pilotSummary": {
    "totalPilots": 5,
    "availablePilots": 4,
    "freePilots": 1,
    "busyPilots": 0,
    "pilots": []
  },
  "duplicateIdsWithinBatch": [],
  "duplicateIdRows": [
    { "rowIndex": 1, "id": "T-260614-01" }
  ]
}
```

**响应字段**：

| 字段 | 类型 | 说明 |
|------|------|------|
| `sessionId` | string | 会话ID，确认提交时需回传 |
| `previewedAt` | string(ISO) | 预检时间 |
| `expiresAt` | string(ISO) | 会话过期时间 |
| `status` | string | 会话状态：`previewed` |
| `totalCount` | number | 总行数 |
| `validCount` | number | 校验通过行数 |
| `errorCount` | number | 校验失败行数 |
| `warningCount` | number | 警告总数 |
| `validRowIndices` | number[] | 校验通过的行索引列表 |
| `canConfirm` | boolean | 是否有可确认提交的有效行 |
| `rowErrors` | array | 逐行错误详情 |
| `rowWarnings` | array | 逐行警告详情 |
| `creatable` | array | 可直接创建的任务列表 |
| `conflicting` | array | 存在冲突的任务列表（含冲突详情和解决建议） |
| `creatableCount` | number | 可创建任务数 |
| `conflictingCount` | number | 冲突任务数 |
| `conflictSummary` | object | 冲突摘要（按港区统计） |
| `pilotSummary` | object | 引航员工作负载摘要 |
| `duplicateIdsWithinBatch` | array | 批次内重复ID列表 |

**请求体格式**：

| 字段 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `tasks` | array | 是 | 申请数据数组，每项为一条任务（也支持顶层字段名 `rows`，或直接传数组） |
| `tasks[].id` | string | 否 | 指定任务ID，仅允许字母、数字、`_`、`-`，最长64字符，不提供则自动生成 |
| `tasks[].vessel.name` | string | 是 | 船名 |
| `tasks[].vessel.type` | string | 是 | 船型（散货船/集装箱船/油轮/化学品船） |
| `tasks[].vessel.imo` | string | 否 | IMO编号（建议格式：IMO+7位数字） |
| `tasks[].vessel.length` | number | 否 | 船舶长度（米，0~500） |
| `tasks[].district` | string | 是 | 港区（东港/北槽/西港） |
| `tasks[].berthPlan` | string | 否 | 泊位计划 |
| `tasks[].tideWindow.start` | string | 是 | 潮汐窗口起始时间（ISO 8601） |
| `tasks[].tideWindow.end` | string | 是 | 潮汐窗口结束时间（ISO 8601） |
| `tasks[].requiredGrade` | string | 是 | 资质等级（A/B） |
| `tasks[].note` | string | 否 | 备注（必须为字符串，如提供） |

**校验规则**：
- 错误（`rowErrors`）：阻断该行，不会进入可创建/冲突列表
- 警告（`rowWarnings`）：不阻断，但提示潜在问题（如IMO格式异常、窗口过短/过长、时间过远）
- 任务ID格式：仅允许 `[A-Za-z0-9_-]`，最长64字符，类型必须为字符串
- 批次内重复ID：标记为错误（`batch_duplicate_id`）
- 与已有任务重复ID：标记为警告（`duplicate_id`），确认提交时可选择覆盖或跳过
- `note`/`berthPlan` 字段：如提供则必须为字符串类型

**请求级错误码（400）**：

| code | 说明 |
|------|------|
| `body_not_object` | 请求体不是JSON对象 |
| `tasks_null` | `tasks` 字段为 null |
| `tasks_not_array` | `tasks` 字段不是数组 |
| `rows_null` | `rows` 字段为 null |
| `rows_not_array` | `rows` 字段不是数组 |
| `missing_tasks_field` | 请求体不含 `tasks` 或 `rows` 字段 |
| `empty_batch` | 数组为空 |
| `batch_too_large` | 数组超过200条 |

**行级错误码**：

| code | 说明 |
|------|------|
| `invalid_row_format` | 行数据不是对象 |
| `id_not_string` | 任务ID不是字符串 |
| `empty_id` | 任务ID为空白字符串 |
| `invalid_id_format` | 任务ID含非法字符 |
| `id_too_long` | 任务ID超过64字符 |
| `batch_duplicate_id` | 批次内重复ID |
| `duplicate_id` | 与已有任务ID重复（警告级） |
| `missing_vessel` | 船舶信息缺失 |
| `missing_vessel_name` | 船名为空 |
| `missing_vessel_type` | 船型为空 |
| `invalid_vessel_type` | 无效的船型 |
| `missing_district` | 港区为空 |
| `invalid_district` | 无效的港区 |
| `missing_tide_window` | 潮汐窗口缺失 |
| `invalid_window_start` | 起始时间无效 |
| `invalid_window_end` | 结束时间无效 |
| `window_end_before_start` | 结束时间早于起始时间 |
| `missing_grade` | 资质等级为空 |
| `invalid_grade` | 无效的资质等级 |
| `invalid_berth_plan` | 泊位计划不是字符串 |
| `invalid_note` | 备注不是字符串 |

---

### 2. 确认提交（POST /import/tasks/confirm）

用预检返回的 `sessionId` 确认提交，真正写入任务数据。

```bash
# 提交全部有效行（默认覆盖已有任务）
curl -X POST "http://localhost:3009/import/tasks/confirm" \
  -H "Content-Type: application/json" \
  -d '{
    "sessionId": "IMP-1718325600000-A1B2C3D4"
  }'
```

```bash
# 仅提交指定行，且不覆盖已有任务
curl -X POST "http://localhost:3009/import/tasks/confirm" \
  -H "Content-Type: application/json" \
  -d '{
    "sessionId": "IMP-1718325600000-A1B2C3D4",
    "rows": [0, 1],
    "overwrite": false
  }'
```

**返回示例（200 OK）**：

```json
{
  "sessionId": "IMP-1718325600000-A1B2C3D4",
  "totalRequested": 2,
  "successCount": 2,
  "createdCount": 2,
  "updatedCount": 0,
  "failedCount": 0,
  "results": [
    {
      "rowIndex": 0,
      "taskId": "T-1718325600000-EFGH",
      "status": "created",
      "success": true
    },
    {
      "rowIndex": 1,
      "taskId": "T-1718325600001-IJKL",
      "status": "created",
      "success": true
    }
  ]
}
```

**请求体格式**：

| 字段 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `sessionId` | string | 是 | 预检返回的会话ID |
| `rows` | number[] | 否 | 指定提交的行索引，不提供则提交全部有效行 |
| `overwrite` | boolean | 否 | 是否覆盖已有任务（默认 true） |

**错误码**：

| HTTP状态 | error | 说明 |
|----------|-------|------|
| 400 | `missing_session_id` | 未提供 sessionId |
| 400 | `no_valid_rows` | 无可提交的有效行 |
| 404 | `session_not_found` | 会话不存在或已过期 |
| 409 | `already_submitted` | 会话已提交过 |
| 410 | `session_cancelled` | 会话已取消 |

---

### 3. 查询会话详情（GET /import/sessions/:sessionId）

```bash
curl "http://localhost:3009/import/sessions/IMP-1718325600000-A1B2C3D4"
```

**返回示例**：

```json
{
  "id": "IMP-1718325600000-A1B2C3D4",
  "createdAt": "2026-06-14T09:00:00.000Z",
  "expiresAt": "2026-06-14T09:30:00.000Z",
  "status": "submitted",
  "totalCount": 3,
  "validCount": 2,
  "errorCount": 1,
  "creatableCount": 2,
  "conflictingCount": 0,
  "canConfirm": false,
  "submittedAt": "2026-06-14T09:05:00.000Z",
  "cancelledAt": null,
  "submittedResults": [
    { "rowIndex": 0, "taskId": "T-1718325600000-EFGH", "status": "created", "success": true },
    { "rowIndex": 1, "taskId": "T-260614-01", "status": "updated", "success": true }
  ]
}
```

---

### 4. 取消会话（POST /import/sessions/:sessionId/cancel）

```bash
curl -X POST "http://localhost:3009/import/sessions/IMP-1718325600000-A1B2C3D4/cancel"
```

**返回示例（200 OK）**：

```json
{
  "id": "IMP-1718325600000-A1B2C3D4",
  "status": "cancelled",
  "cancelledAt": "2026-06-14T09:10:00.000Z",
  "message": "导入会话已取消"
}
```

> 已提交的会话不可取消（返回 409）。

---

### 5. 冲突判定与解决建议

当导入行与已有任务或批次内其他行在**同一港区**且**潮汐窗口重叠**时，标记为冲突：

| 冲突类型 | conflictType | 说明 |
|----------|-------------|------|
| 已分配引航员的任务冲突 | `pilot_assigned` | 同港区同时间段已有引航员在执行任务 |
| 港区时间冲突 | `district_time` | 同港区同时间段已有未分配的任务 |
| 批次内冲突 | `batch_conflict` | 导入批次内多条行相互冲突 |

每条冲突附带解决建议（`resolutions`）：

| suggestion | 说明 |
|------------|------|
| `reassign_or_reschedule` | 重新分配引航员或调整时间窗口 |
| `reschedule_batch_row` | 错开批次内行的潮汐窗口 |
| `reschedule_or_coordinate` | 调整窗口或与调度协调 |

---

### 6. 引航员工作负载摘要

预检结果中的 `pilotSummary` 展示每位引航员的当前负载和导入后预估：

| 字段 | 说明 |
|------|------|
| `workloadLevel` | 负载等级：`free`(0任务) / `normal`(1任务) / `busy`(2任务) / `overloaded`(3+任务) |
| `canTakeNewCount` | 可承接的导入任务数（基于资质和空闲时段评估） |
| `totalAfterImport` | 导入后预估总任务数 |

---

### 完整调用示例

```bash
# 步骤1：预检
SESSION_ID=$(curl -s -X POST "http://localhost:3009/import/tasks" \
  -H "Content-Type: application/json" \
  -d '{
    "tasks": [
      {
        "vessel": { "name": "金海轮", "type": "散货船" },
        "district": "东港",
        "tideWindow": { "start": "2026-06-20T02:00:00.000Z", "end": "2026-06-20T05:00:00.000Z" },
        "requiredGrade": "B"
      },
      {
        "vessel": { "name": "华星号", "type": "油轮" },
        "district": "西港",
        "tideWindow": { "start": "2026-06-20T06:00:00.000Z", "end": "2026-06-20T09:00:00.000Z" },
        "requiredGrade": "A"
      }
    ]
  }' | python3 -c "import sys,json; print(json.load(sys.stdin)['sessionId'])")

echo "Session ID: $SESSION_ID"

# 步骤2：确认提交
curl -X POST "http://localhost:3009/import/tasks/confirm" \
  -H "Content-Type: application/json" \
  -d "{\"sessionId\": \"$SESSION_ID\"}"

# 步骤3：查看会话状态
curl "http://localhost:3009/import/sessions/$SESSION_ID"
```

---

## 接口调用示例

### 查询值班日历

查询指定日期所有引航员的值班区间、已分配任务和空闲时间段：

```bash
curl "http://localhost:3009/shifts/calendar?date=2026-06-14"
```

按港区筛选（例如查询东港的值班安排）：

```bash
curl "http://localhost:3009/shifts/calendar?date=2026-06-14&district=东港"
```

`date` 参数格式为 `YYYY-MM-DD`，不传时默认为当天；`district` 为可选参数。

返回示例：

```json
{
  "date": "2026-06-14",
  "district": "东港",
  "pilots": [
    {
      "pilotId": "P-01",
      "name": "沈望",
      "districts": ["东港", "北槽"],
      "shifts": [
        { "start": "2026-06-14T00:00:00.000Z", "end": "2026-06-14T12:00:00.000Z" }
      ],
      "tasks": [
        {
          "taskId": "T-260614-01",
          "vessel": "远泰7",
          "district": "东港",
          "berthPlan": "靠泊D3",
          "status": "assigned",
          "start": "2026-06-14T02:30:00.000Z",
          "end": "2026-06-14T05:30:00.000Z"
        }
      ],
      "idle": [
        { "start": "2026-06-14T00:00:00.000Z", "end": "2026-06-14T02:30:00.000Z" },
        { "start": "2026-06-14T05:30:00.000Z", "end": "2026-06-14T12:00:00.000Z" }
      ]
    }
  ]
}
```

---

## 审计追踪与回滚模块

所有写操作（引航员、任务、派单、状态更新、审批、导入提交等）都会记录成统一审计事件，支持按对象ID查询审计历史，并支持任务状态更新和派单的回滚。

### 数据模型

审计事件（audit event）存储在 `data/audit-log.json`，结构如下：

| 字段 | 类型 | 说明 |
|------|------|------|
| `id` | string | 审计事件ID，如 `AUD-xxxx` |
| `objectType` | string | 对象类型：`pilot` / `task` / `changeRequest` / `draft` / `leaveRecord` / `importSession` |
| `objectId` | string | 对象ID |
| `action` | string | 操作类型：`create` / `update` / `assign` / `unassign` / `status_change` / `approve` / `reject` / `submit` / `cancel` / `rollback` / `import_create` / `import_update` |
| `before` | object | 操作前数据快照（可为 null） |
| `after` | object | 操作后数据快照（可为 null） |
| `operator` | string | 操作人（可为 null） |
| `note` | string | 备注 |
| `rollbackable` | boolean | 是否可回滚 |
| `relatedAuditId` | string | 关联审计事件ID（如回滚关联原事件） |
| `timestamp` | string | 时间戳（ISO 8601） |

---

### 1. 查询审计历史

支持按对象ID、对象类型、操作类型筛选，支持分页。

```bash
# 查询所有审计记录
curl "http://localhost:3009/audit"

# 按任务ID查询
curl "http://localhost:3009/audit?objectId=T-260614-01"

# 按对象类型查询
curl "http://localhost:3009/audit?objectType=task"

# 按操作类型查询
curl "http://localhost:3009/audit?action=assign"

# 分页查询
curl "http://localhost:3009/audit?limit=20&offset=0"
```

**返回示例**：

```json
{
  "total": 5,
  "offset": 0,
  "limit": 50,
  "events": [
    {
      "id": "AUD-1718325600000-ABC123",
      "objectType": "task",
      "objectId": "T-260614-01",
      "action": "assign",
      "before": { "id": "T-260614-01", "status": "pending", "pilotId": null },
      "after": { "id": "T-260614-01", "status": "assigned", "pilotId": "P-01" },
      "operator": "调度员小王",
      "note": "分配给沈望",
      "rollbackable": true,
      "relatedAuditId": null,
      "timestamp": "2026-06-14T03:00:00.000Z"
    }
  ]
}
```

---

### 2. 查询单个审计事件详情

```bash
curl "http://localhost:3009/audit/AUD-1718325600000-ABC123"
```

---

### 3. 获取可回滚类型

```bash
curl "http://localhost:3009/audit/rollbackable-types"
```

**返回示例**：

```json
{
  "objectTypes": ["pilot", "task", "changeRequest", "draft", "leaveRecord", "importSession"],
  "actions": ["create", "update", "assign", "unassign", "status_change", "approve", "reject", "submit", "cancel", "rollback", "import_create", "import_update"],
  "rollbackableTypes": [
    { "action": "assign", "objectType": "task", "description": "任务派单" },
    { "action": "status_change", "objectType": "task", "description": "任务状态更新" },
    { "action": "update", "objectType": "task", "description": "任务信息更新" }
  ]
}
```

---

### 4. 查询对象最新可回滚事件

```bash
curl "http://localhost:3009/audit/rollbackable/task/T-260614-01"
```

返回该对象最近的一条可回滚审计事件，没有则返回 404。

---

### 5. 任务回滚

#### 5.1 回滚到上一版本

自动找到最近的可回滚事件并回滚：

```bash
curl -X POST "http://localhost:3009/tasks/T-260614-01/rollback" \
  -H "Content-Type: application/json" \
  -d '{
    "operator": "值班主任老李",
    "note": "操作失误，需要回滚"
  }'
```

**返回示例（200 OK）**：

```json
{
  "success": true,
  "task": {
    "id": "T-260614-01",
    "status": "pending",
    "pilotId": null
  },
  "rollbackEvent": {
    "id": "AUD-xxxx",
    "action": "rollback",
    "objectType": "task",
    "objectId": "T-260614-01",
    "rollbackable": false,
    "relatedAuditId": "AUD-yyyy",
    "timestamp": "..."
  },
  "rolledBackFrom": {
    "id": "AUD-yyyy",
    "action": "assign",
    "rollbackable": true
  }
}
```

#### 5.2 回滚指定审计事件

指定要回滚到的审计事件ID：

```bash
curl -X POST "http://localhost:3009/tasks/T-260614-01/rollback" \
  -H "Content-Type: application/json" \
  -d '{
    "auditEventId": "AUD-1718325600000-ABC123",
    "operator": "值班主任老李"
  }'
```

#### 5.3 回滚派单（专用接口）

专门用于取消派单，将任务状态重置为 pending，引航员置空：

```bash
curl -X POST "http://localhost:3009/tasks/T-260614-01/rollback/assign" \
  -H "Content-Type: application/json" \
  -d '{
    "operator": "值班主任老李",
    "note": "引航员临时有事，取消分配"
  }'
```

#### 5.4 回滚状态更新（专用接口）

专门用于回滚最近一次状态变更：

```bash
curl -X POST "http://localhost:3009/tasks/T-260614-01/rollback/status" \
  -H "Content-Type: application/json" \
  -d '{
    "operator": "值班主任老李",
    "note": "状态更新有误"
  }'
```

---

### 回滚说明

- **回滚本身也会写入审计事件**，动作类型为 `rollback`，且 `rollbackable` 为 `false`（不可回滚的回滚）
- 回滚事件会通过 `relatedAuditId` 关联被回滚的原审计事件
- 任务的 `history` 字段也会追加回滚记录
- 目前支持回滚的操作类型：任务派单（`assign`）、任务状态更新（`status_change`）、任务信息更新（`update`）

---

### 审计覆盖的写操作

| 操作 | 对象类型 | 动作类型 | 可回滚 |
|------|----------|----------|--------|
| 新增引航员 | pilot | create | 否 |
| 创建任务 | task | create | 否 |
| 任务派单 | task | assign | 是 |
| 任务状态更新 | task | status_change | 是 |
| 任务信息更新 | task | update | 是 |
| 创建变更申请 | changeRequest | create | 否 |
| 变更审批通过 | changeRequest / task | approve / update | 任务更新可回滚 |
| 变更审批驳回 | changeRequest | reject | 否 |
| 批量导入创建 | task | import_create | 否 |
| 批量导入更新 | task | import_update | 否 |
