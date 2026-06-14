import { overlaps } from "../../utils/time.js";
import { isActiveTaskStatus } from "../../config/scheduling-rules.js";

export function detectConflictsForTask(snapshot, task) {
  const conflicts = [];
  const window = task.tideWindow;

  if (!window) {
    conflicts.push({ type: "missing_tide_window", message: "任务缺少潮汐窗口信息" });
    return conflicts;
  }

  const districtPilots = snapshot.pilots.filter((p) => p.districts.includes(task.district));
  if (districtPilots.length === 0) {
    conflicts.push({
      type: "no_pilot_for_district",
      message: `没有引航员具备 ${task.district} 港区资质`,
      detail: { district: task.district }
    });
  }

  const typePilots = snapshot.pilots.filter((p) => p.shipTypes.includes(task.vessel.type));
  if (typePilots.length === 0) {
    conflicts.push({
      type: "no_pilot_for_ship_type",
      message: `没有引航员具备 ${task.vessel.type} 船型资质`,
      detail: { shipType: task.vessel.type }
    });
  }

  const gradePilots = snapshot.pilots.filter((p) => p.grades.includes(task.requiredGrade));
  if (gradePilots.length === 0) {
    conflicts.push({
      type: "no_pilot_for_grade",
      message: `没有引航员满足 ${task.requiredGrade} 资质等级要求`,
      detail: { requiredGrade: task.requiredGrade }
    });
  }

  const onShiftPilots = snapshot.pilots.filter((p) =>
    p.shifts.some((s) => overlaps(window.start, window.end, s.start, s.end))
  );
  if (onShiftPilots.length === 0) {
    conflicts.push({
      type: "no_pilot_on_shift",
      message: "任务时间窗口内无引航员值班",
      detail: { tideWindow: window }
    });
  }

  const overlappingTasks = snapshot.tasks.filter(
    (t) => t.id !== task.id && t.tideWindow && isActiveTaskStatus(t.status) &&
      overlaps(window.start, window.end, t.tideWindow.start, t.tideWindow.end) &&
      t.district === task.district
  );
  if (overlappingTasks.length > 0) {
    conflicts.push({
      type: "district_time_overlap",
      message: `同港区有 ${overlappingTasks.length} 个时间重叠的活跃任务`,
      detail: { overlappingTaskIds: overlappingTasks.map((t) => t.id) }
    });
  }

  return conflicts;
}

export function detectConflictsForPilot(snapshot, pilot, task) {
  const conflicts = [];
  const window = task.tideWindow;
  if (!window) return conflicts;

  const onShift = pilot.shifts.some((s) => overlaps(window.start, window.end, s.start, s.end));
  if (!onShift) {
    conflicts.push({ type: "not_on_shift", message: "引航员不在该时间段值班" });
  }

  if (!pilot.districts.includes(task.district)) {
    conflicts.push({ type: "district_mismatch", message: `引航员不具备 ${task.district} 港区资质` });
  }

  if (!pilot.shipTypes.includes(task.vessel.type)) {
    conflicts.push({ type: "ship_type_mismatch", message: `引航员不具备 ${task.vessel.type} 船型资质` });
  }

  const gradeOk = pilot.grades.includes(task.requiredGrade);
  if (!gradeOk) {
    conflicts.push({ type: "grade_mismatch", message: `引航员等级不满足 ${task.requiredGrade} 要求` });
  }

  const leaveConflicts = snapshot.leaveRecords.filter(
    (l) => l.pilotId === pilot.id && l.status === "active" && overlaps(window.start, window.end, l.period.start, l.period.end)
  );
  if (leaveConflicts.length > 0) {
    conflicts.push({
      type: "leave_conflict",
      message: `引航员有 ${leaveConflicts.length} 条休假/停用记录冲突`,
      detail: { leaveIds: leaveConflicts.map((l) => l.id), leaveTypes: leaveConflicts.map((l) => l.type) }
    });
  }

  const taskConflicts = snapshot.tasks.filter(
    (t) => t.pilotId === pilot.id && t.id !== task.id && isActiveTaskStatus(t.status) &&
      t.tideWindow && overlaps(window.start, window.end, t.tideWindow.start, t.tideWindow.end)
  );
  if (taskConflicts.length > 0) {
    conflicts.push({
      type: "time_conflict",
      message: `引航员有 ${taskConflicts.length} 个时间冲突的活跃任务`,
      detail: { conflictingTaskIds: taskConflicts.map((t) => t.id) }
    });
  }

  return conflicts;
}

export function explainUnassigned(snapshot, task) {
  const taskConflicts = detectConflictsForTask(snapshot, task);
  const pilotConflictSummary = [];

  for (const pilot of snapshot.pilots) {
    const pilotConflicts = detectConflictsForPilot(snapshot, pilot, task);
    if (pilotConflicts.length > 0) {
      pilotConflictSummary.push({
        pilotId: pilot.id,
        name: pilot.name,
        conflictTypes: pilotConflicts.map((c) => c.type),
        conflicts: pilotConflicts
      });
    }
  }

  const globalReasons = taskConflicts.map((c) => c.type);
  const pilotSpecificReasons = new Set();
  for (const ps of pilotConflictSummary) {
    for (const ct of ps.conflictTypes) {
      pilotSpecificReasons.add(ct);
    }
  }

  return {
    taskId: task.id,
    globalConflicts: taskConflicts,
    pilotConflictSummary,
    summary: [...globalReasons, ...pilotSpecificReasons]
  };
}
