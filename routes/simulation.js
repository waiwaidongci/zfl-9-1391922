import { runSimulation } from "../services/simulation/index.js";

export function handleSimulationDispatch(db, input, send, res) {
  if (!input || !Array.isArray(input.tasks)) {
    return send(res, 400, { error: "missing_tasks", message: "请求体必须包含 tasks 数组" });
  }

  if (input.tasks.length === 0) {
    return send(res, 400, { error: "empty_tasks", message: "tasks 数组不能为空" });
  }

  if (input.tasks.length > 100) {
    return send(res, 400, { error: "too_many_tasks", message: "单次仿真任务数不能超过100" });
  }

  const tempShifts = Array.isArray(input.tempShifts) ? input.tempShifts : [];

  for (let i = 0; i < input.tasks.length; i++) {
    const task = input.tasks[i];
    if (!task.tideWindow || !task.tideWindow.start || !task.tideWindow.end) {
      return send(res, 400, { error: "invalid_task", message: `任务索引 ${i} 缺少有效的 tideWindow`, taskIndex: i });
    }
    if (!task.district) {
      return send(res, 400, { error: "invalid_task", message: `任务索引 ${i} 缺少 district`, taskIndex: i });
    }
    if (!task.vessel || !task.vessel.type) {
      return send(res, 400, { error: "invalid_task", message: `任务索引 ${i} 缺少 vessel.type`, taskIndex: i });
    }
    if (!task.requiredGrade) {
      return send(res, 400, { error: "invalid_task", message: `任务索引 ${i} 缺少 requiredGrade`, taskIndex: i });
    }
  }

  const result = runSimulation(db, { tasks: input.tasks, tempShifts });
  return send(res, 200, result);
}
