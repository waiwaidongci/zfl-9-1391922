# 批量导入引航申请模块 API 文档

## 模块概览

批量导入引航申请模块提供三步式导入流程：

1. **预检 (Preview)** - `POST /import/tasks/preview`
   - 接收一组申请数据
   - 执行逐行校验、冲突检测、引航员推荐
   - 返回预检结果，不写入任何数据
   - 生成并返回 `sessionId` 用于后续提交

2. **提交 (Submit)** - `POST /import/tasks`
   - 使用预检返回的 `sessionId`
   - 支持部分提交（指定行号）
   - 处理重复 ID（跳过或更新）
   - 支持部分失败，返回每行详细结果

3. **会话查询** - `GET /import/sessions/:sessionId`
   - 查询导入会话状态和统计信息

---

## 数据格式

### 单条任务申请 (Row)

```json
{
  "id": "T-260615-100",
  "vessel": {
    "name": "远泰18",
    "imo": "IMO9311018",
    "type": "散货船",
    "length": 195
  },
  "district": "东港",
  "berthPlan": "靠泊D7",
  "tideWindow": {
    "start": "2026-06-15T02:00:00.000Z",
    "end": "2026-06-15T05:00:00.000Z"
  },
  "requiredGrade": "B",
  "note": "加急处理"
}
```

### 字段说明

| 字段 | 类型 | 必填 | 说明 |
|------|------|------|------|
| id | string | 否 | 任务ID，如提供需唯一；与现有数据重复会触发警告 |
| vessel.name | string | 是 | 船舶名称 |
| vessel.type | string | 是 | 船型：散货船/集装箱船/油轮/化学品船 |
| vessel.imo | string | 否 | IMO编号，格式 IMO+7位数字 |
| vessel.length | number | 否 | 船舶长度（米），0-1000 |
| district | string | 是 | 港区：东港/北槽/西港 |
| berthPlan | string | 否 | 泊位计划 |
| tideWindow.start | string | 是 | 潮汐窗口起始时间（ISO 8601） |
| tideWindow.end | string | 是 | 潮汐窗口结束时间（ISO 8601，晚于start） |
| requiredGrade | string | 是 | 资质等级：A/B |
| note | string | 否 | 备注信息 |

---

## 1. 预检接口

### POST /import/tasks/preview

对批量数据执行校验和分析，不写入数据库。

### 请求体

支持三种格式：

```json
{
  "tasks": [ ... ]
}
```

```json
{
  "rows": [ ... ]
}
```

```json
[ ... ]
```

### curl 示例

```bash
curl -X POST http://localhost:3009/import/tasks/preview \
  -H "Content-Type: application/json" \
  -d '{
    "tasks": [
      {
        "vessel": { "name": "远洋先锋", "type": "集装箱船", "imo": "IMO9600210", "length": 310 },
        "district": "北槽",
        "berthPlan": "靠泊N5",
        "tideWindow": {
          "start": "2026-06-16T08:00:00.000Z",
          "end": "2026-06-16T11:00:00.000Z"
        },
        "requiredGrade": "A",
        "note": "大型集装箱船"
      },
      {
        "id": "T-260614-01",
        "vessel": { "name": "远泰7号", "type": "散货船", "length": 180 },
        "district": "东港",
        "berthPlan": "靠泊D3",
        "tideWindow": {
          "start": "2026-06-15T02:30:00.000Z",
          "end": "2026-06-15T05:30:00.000Z"
        },
        "requiredGrade": "B"
      },
      {
        "vessel": { "name": "错误示例" },
        "district": "无效港区",
        "tideWindow": null,
        "requiredGrade": "C"
      }
    ]
  }'
```

### 响应示例 (200 OK)

```json
{
  "sessionId": "IMP-1718323200000-A1B2C3D4",
  "expiresAt": "2026-06-14T08:30:00.000Z",
  "totalCount": 3,
  "validCount": 2,
  "errorCount": 1,
  "warningCount": 1,
  "duplicateExistingIds": [
    { "rowIndex": 1, "id": "T-260614-01" }
  ],
  "batchDuplicateIds": [],
  "rowErrors": [
    {
      "rowIndex": 0,
      "valid": true,
      "errors": [],
      "warnings": []
    },
    {
      "rowIndex": 1,
      "valid": true,
      "errors": [],
      "warnings": [
        {
          "field": "id",
          "message": "任务ID T-260614-01 已存在，提交时将被跳过（如需更新请设置 updateMode=true）",
          "code": "duplicate_existing_id"
        }
      ]
    },
    {
      "rowIndex": 2,
      "valid": false,
      "errors": [
        { "field": "vessel", "message": "船舶信息不完整或船型无效，需提供 name 和有效的 type" },
        { "field": "district", "message": "无效的港区: 无效港区" },
        { "field": "tideWindow", "message": "潮汐窗口无效或缺失，需包含有效的 start 和 end 时间，且 start 必须早于 end" },
        { "field": "requiredGrade", "message": "无效的资质等级: C" }
      ],
      "warnings": []
    }
  ],
  "creatable": [
    {
      "rowIndex": 0,
      "taskId": "T-1718323200001-XYZ",
      "vesselName": "远洋先锋",
      "shipType": "集装箱船",
      "district": "北槽",
      "requiredGrade": "A",
      "tideWindow": { "start": "...", "end": "..." },
      "topPilot": { "pilotId": "P-03", "name": "周屿", "score": 0.92 },
      "eligiblePilotCount": 2
    }
  ],
  "conflicting": [
    {
      "rowIndex": 1,
      "taskId": "T-260614-01",
      "vesselName": "远泰7号",
      "district": "东港",
      "conflictCount": 1,
      "conflictSeverity": "high",
      "highSeverityCount": 1,
      "existingConflicts": [
        {
          "taskId": "T-260614-01",
          "vesselName": "远泰7",
          "district": "东港",
          "tideWindow": { "start": "...", "end": "..." },
          "status": "assigned",
          "pilotId": "P-01",
          "pilotName": "沈望",
          "overlap": { "start": "...", "end": "..." },
          "overlapMinutes": 180,
          "overlapRatio": 1.0,
          "severity": "high",
          "source": "existing"
        }
      ],
      "batchConflicts": [],
      "topPilot": { "pilotId": "P-01", "name": "沈望", "score": 0.85 }
    }
  ],
  "creatableCount": 1,
  "conflictingCount": 1,
  "noPilotCount": 0,
  "pilotSummary": {
    "totalPilots": 5,
    "availablePilots": 3,
    "overloadedPilots": 1,
    "idlePilots": 1,
    "districtBreakdown": {
      "东港": { "totalPilots": 3, "availablePilots": 2, "overloadedPilots": 1 },
      "北槽": { "totalPilots": 3, "availablePilots": 2, "overloadedPilots": 0 },
      "西港": { "totalPilots": 3, "availablePilots": 2, "overloadedPilots": 0 }
    },
    "pilots": [
      {
        "pilotId": "P-03",
        "name": "周屿",
        "districts": ["东港", "西港", "北槽"],
        "currentTaskCount": 0,
        "currentWorkloadHours": 0,
        "canTakeNewCount": 2,
        "overloaded": false,
        "topAssignableTasks": [
          { "taskId": "...", "vesselName": "远洋先锋", "score": 0.92 }
        ]
      }
    ]
  }
}
```

### 错误响应

| HTTP 状态码 | 错误码 | 说明 |
|------------|--------|------|
| 400 | invalid_input | 请求体格式错误，必须包含 tasks/rows 数组 |
| 400 | empty_batch | 导入数据为空 |
| 400 | batch_too_large | 单次导入超过 500 条 |

---

## 2. 提交接口

### POST /import/tasks

将预检通过的数据写入数据库。

### 请求体

```json
{
  "sessionId": "IMP-1718323200000-A1B2C3D4",
  "rows": [0, 1],
  "updateMode": false
}
```

### 字段说明

| 字段 | 类型 | 必填 | 默认值 | 说明 |
|------|------|------|--------|------|
| sessionId | string | 是 | - | 预检返回的会话ID |
| rows | number[] | 否 | 全部有效行 | 指定要提交的行索引，不填则提交所有有效行 |
| updateMode | boolean | 否 | false | true=ID重复时更新现有任务，false=跳过重复ID |

### curl 示例 - 提交全部

```bash
curl -X POST http://localhost:3009/import/tasks \
  -H "Content-Type: application/json" \
  -d '{
    "sessionId": "IMP-1718323200000-A1B2C3D4"
  }'
```

### curl 示例 - 部分提交 + 更新模式

```bash
curl -X POST http://localhost:3009/import/tasks \
  -H "Content-Type: application/json" \
  -d '{
    "sessionId": "IMP-1718323200000-A1B2C3D4",
    "rows": [0, 1],
    "updateMode": true
  }'
```

### 响应示例 - 全部成功 (200 OK)

```json
{
  "sessionId": "IMP-1718323200000-A1B2C3D4",
  "totalRequested": 2,
  "successCount": 2,
  "createdCount": 1,
  "updatedCount": 1,
  "failedCount": 0,
  "skippedCount": 0,
  "partialSuccess": false,
  "allSuccess": true,
  "results": [
    {
      "rowIndex": 0,
      "taskId": "T-1718323200001-XYZ",
      "status": "created",
      "success": true,
      "vesselName": "远洋先锋"
    },
    {
      "rowIndex": 1,
      "taskId": "T-260614-01",
      "status": "updated",
      "success": true,
      "vesselName": "远泰7号"
    }
  ]
}
```

### 响应示例 - 部分成功 (200 OK)

```json
{
  "sessionId": "IMP-1718323200000-A1B2C3D4",
  "totalRequested": 4,
  "successCount": 2,
  "createdCount": 2,
  "updatedCount": 0,
  "failedCount": 1,
  "skippedCount": 1,
  "partialSuccess": true,
  "allSuccess": false,
  "results": [
    {
      "rowIndex": 0,
      "taskId": "T-1718323200001-AAA",
      "status": "created",
      "success": true,
      "vesselName": "远洋先锋"
    },
    {
      "rowIndex": 1,
      "taskId": "T-260614-01",
      "success": false,
      "skipped": true,
      "status": "skipped",
      "error": "任务ID已存在，跳过: T-260614-01 (如需更新请设置 updateMode=true)",
      "conflictType": "existing_id"
    },
    {
      "rowIndex": 2,
      "taskId": "T-1718323200003-BBB",
      "status": "created",
      "success": true,
      "vesselName": "海昌号"
    },
    {
      "rowIndex": 3,
      "taskId": "T-1718323200004-CCC",
      "success": false,
      "error": "任务写入失败: 数据库异常"
    }
  ]
}
```

### 错误响应

| HTTP 状态码 | 错误码 | 说明 |
|------------|--------|------|
| 400 | missing_session_id | 请求缺少 sessionId |
| 400 | no_valid_rows | 没有可提交的有效行 |
| 404 | session_not_found | 会话不存在或已过期（30分钟有效） |
| 409 | already_submitted | 该会话已提交过，不可重复提交 |

---

## 3. 会话详情接口

### GET /import/sessions/:sessionId

查询导入会话的状态和统计信息。

### curl 示例

```bash
curl http://localhost:3009/import/sessions/IMP-1718323200000-A1B2C3D4
```

### 响应示例 - 已提交 (200 OK)

```json
{
  "id": "IMP-1718323200000-A1B2C3D4",
  "createdAt": "2026-06-14T08:00:00.000Z",
  "expiresAt": "2026-06-14T08:30:00.000Z",
  "status": "submitted",
  "preview": {
    "totalCount": 3,
    "validCount": 2,
    "errorCount": 1,
    "warningCount": 1,
    "creatableCount": 1,
    "conflictingCount": 1,
    "duplicateExistingIds": [
      { "rowIndex": 1, "id": "T-260614-01" }
    ],
    "batchDuplicateIds": []
  },
  "submission": {
    "submittedAt": "2026-06-14T08:05:30.000Z",
    "summary": {
      "totalRequested": 2,
      "successCount": 2,
      "createdCount": 1,
      "updatedCount": 1,
      "failedCount": 0,
      "skippedCount": 0
    },
    "rowCount": 2
  }
}
```

### 响应示例 - 未提交 (200 OK)

```json
{
  "id": "IMP-1718323200000-A1B2C3D4",
  "createdAt": "2026-06-14T08:00:00.000Z",
  "expiresAt": "2026-06-14T08:30:00.000Z",
  "status": "previewed",
  "preview": {
    "totalCount": 10,
    "validCount": 8,
    "errorCount": 2,
    "warningCount": 3,
    "creatableCount": 5,
    "conflictingCount": 3,
    "duplicateExistingIds": [],
    "batchDuplicateIds": []
  },
  "submission": null
}
```

### 会话状态说明

| 状态 | 说明 |
|------|------|
| previewed | 已预检，等待提交 |
| submitted | 已提交，任务已写入 |
| expired | 会话过期（超过30分钟） |
| cancelled | 已取消 |

---

## 完整示例场景

### 场景1: 批量创建新任务

```bash
# Step 1: 预检
SESSION_ID=$(curl -s -X POST http://localhost:3009/import/tasks/preview \
  -H "Content-Type: application/json" \
  -d '[
    {
      "vessel": { "name": "金洋号", "type": "集装箱船", "length": 250 },
      "district": "北槽",
      "berthPlan": "靠泊N1",
      "tideWindow": {
        "start": "2026-06-17T06:00:00.000Z",
        "end": "2026-06-17T09:00:00.000Z"
      },
      "requiredGrade": "A"
    },
    {
      "vessel": { "name": "银洋号", "type": "集装箱船", "length": 260 },
      "district": "北槽",
      "berthPlan": "靠泊N3",
      "tideWindow": {
        "start": "2026-06-17T10:00:00.000Z",
        "end": "2026-06-17T13:00:00.000Z"
      },
      "requiredGrade": "A"
    }
  ]' | python3 -c "import sys,json; print(json.load(sys.stdin)['sessionId'])")

echo "Session ID: $SESSION_ID"

# Step 2: 提交
curl -X POST http://localhost:3009/import/tasks \
  -H "Content-Type: application/json" \
  -d "{\"sessionId\": \"$SESSION_ID\"}"
```

### 场景2: 批量更新现有任务

```bash
# 预检时发现ID重复，提交时开启 updateMode=true
curl -X POST http://localhost:3009/import/tasks \
  -H "Content-Type: application/json" \
  -d '{
    "sessionId": "IMP-XXXXXXX",
    "updateMode": true,
    "rows": [1, 3, 5]
  }'
```

### 场景3: 预检后只提交无冲突的任务

```bash
# 预检响应中 creatable 数组的 rowIndex 就是无冲突的行
# 假设 creatable = [{rowIndex: 0}, {rowIndex: 2}, {rowIndex: 4}]
curl -X POST http://localhost:3009/import/tasks \
  -H "Content-Type: application/json" \
  -d '{
    "sessionId": "IMP-XXXXXXX",
    "rows": [0, 2, 4]
  }'
```

---

## 设计要点

### 预检不污染数据
- 预检阶段全程读取 `data/pilot-station.json`，不调用任何写入操作
- 所有分析结果存储在内存会话中，30分钟后自动清理
- 提交接口是唯一的写入入口

### 重复 ID 处理策略
| 情况 | 预检行为 | 默认提交行为 | updateMode=true |
|------|----------|------------|-----------------|
| 批次内重复 | 标记为错误，该行无效 | 不提交 | 不提交 |
| 与现有ID重复 | 警告，行仍有效 | 跳过并标记 skipped | 更新现有任务 |

### 部分失败处理
- 每行独立 try-catch，单行失败不影响其他行
- 返回结果中每行包含 `success` 状态和详细信息
- `partialSuccess` 标志位快速判断是否需要人工处理
- 即使部分行失败，已成功行仍会持久化

### 会话生命周期
- 创建时分配 30 分钟 TTL
- 提交后状态变为 `submitted`，不可再次提交
- 超过最大会话数（1000）时自动淘汰最旧会话
- 每 5 分钟自动清理过期会话
