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
  "activeTaskStatuses": ["pending", "assigned", "in_progress"]
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
