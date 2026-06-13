export const DISTRICTS = ["东港", "北槽", "西港"];

export const SHIP_TYPES = ["散货船", "集装箱船", "油轮", "化学品船"];

export const GRADES = ["A", "B"];

export const TASK_STATUSES = ["pending", "assigned", "in_progress", "completed", "cancelled", "done"];

export const ACTIVE_TASK_STATUSES = TASK_STATUSES.filter((s) => !["cancelled", "done", "completed"].includes(s));

export const DEFAULT_TASK_STATUS = "pending";

export const ASSIGNED_TASK_STATUS = "assigned";

export const schedulingOptions = {
  districts: DISTRICTS,
  shipTypes: SHIP_TYPES,
  grades: GRADES,
  taskStatuses: TASK_STATUSES,
  activeTaskStatuses: ACTIVE_TASK_STATUSES
};

export function isValidDistrict(value) {
  return DISTRICTS.includes(value);
}

export function isValidShipType(value) {
  return SHIP_TYPES.includes(value);
}

export function isValidGrade(value) {
  return GRADES.includes(value);
}

export function isValidTaskStatus(value) {
  return TASK_STATUSES.includes(value);
}

export function isActiveTaskStatus(value) {
  return ACTIVE_TASK_STATUSES.includes(value);
}
