import {
  RULE_WEIGHTS,
  gradeScore as ruleEngineGradeScore,
  shiftCoverageScore as ruleEngineShiftCoverageScore,
  workloadScore as ruleEngineWorkloadScore
} from "./rule-engine.js";

const RULE_TO_DIM = {
  shift_coverage: "shiftCoverage",
  district_match: "district",
  ship_type_match: "shipType",
  grade_match: "grade",
  no_time_conflict: "noTimeConflict",
  no_leave_conflict: "noLeaveConflict",
  workload: "workload"
};

const dimWeights = {};
for (const [ruleKey, weight] of Object.entries(RULE_WEIGHTS)) {
  const dimKey = RULE_TO_DIM[ruleKey];
  if (dimKey) dimWeights[dimKey] = weight;
}

export const RECOMMEND_WEIGHTS = dimWeights;

export const RECOMMEND_DIMENSIONS = Object.keys(RECOMMEND_WEIGHTS);

export function gradeScore(pilotGrade, requiredGrade) {
  return ruleEngineGradeScore(pilotGrade, requiredGrade);
}

export function shiftCoverageScore(overlapMinutes, taskMinutes) {
  return ruleEngineShiftCoverageScore(overlapMinutes, taskMinutes);
}

export function workloadScore(currentTaskCount) {
  return ruleEngineWorkloadScore(currentTaskCount);
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
