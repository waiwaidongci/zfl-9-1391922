export const RECOMMEND_WEIGHTS = {
  shiftCoverage: 25,
  district: 20,
  shipType: 15,
  grade: 20,
  noTimeConflict: 15,
  noLeaveConflict: 10,
  workload: 5
};

export const RECOMMEND_DIMENSIONS = Object.keys(RECOMMEND_WEIGHTS);

export function gradeScore(pilotGrade, requiredGrade) {
  const rank = { A: 2, B: 1 };
  const pilotRank = rank[pilotGrade] ?? 0;
  const requiredRank = rank[requiredGrade] ?? 99;
  if (pilotRank >= requiredRank) return 1;
  return 0;
}

export function shiftCoverageScore(overlapMinutes, taskMinutes) {
  if (taskMinutes <= 0) return 0;
  return Math.min(1, overlapMinutes / taskMinutes);
}

export function workloadScore(currentTaskCount) {
  if (currentTaskCount === 0) return 1;
  if (currentTaskCount === 1) return 0.7;
  if (currentTaskCount === 2) return 0.4;
  return 0.1;
}

export const recommendRulesMeta = {
  shiftCoverage: { label: "值班覆盖", description: "任务时间段与引航员值班表的重叠比例" },
  district: { label: "港区匹配", description: "引航员是否具备该港区作业资质" },
  shipType: { label: "船型匹配", description: "引航员是否具备该船型引航资质" },
  grade: { label: "资质等级", description: "引航员资质等级是否满足任务要求" },
  noTimeConflict: { label: "任务冲突", description: "任务时间段是否与引航员已有任务冲突" },
  noLeaveConflict: { label: "休假冲突", description: "任务时间段是否与引航员休假/停用冲突" },
  workload: { label: "工作负载", description: "引航员当前进行中的任务数量" }
};
