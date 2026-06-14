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
