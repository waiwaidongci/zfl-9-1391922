import { validateDraftForSubmit, REQUIRED_TASK_FIELDS } from "../routes/drafts.js";
import { findConflictingExistingTasks, recommendForTask } from "./candidate-reuse.js";
import { evaluateCandidate } from "../utils/recommendation.js";
import { DEFAULT_TASK_STATUS } from "../config/scheduling-rules.js";

function buildTaskFromDraft(draft) {
  return {
    id: draft.id || `preview-${Date.now()}`,
    vessel: draft.vessel,
    district: draft.district,
    berthPlan: draft.berthPlan,
    tideWindow: draft.tideWindow,
    requiredGrade: draft.requiredGrade,
    status: DEFAULT_TASK_STATUS,
    pilotId: null,
    history: []
  };
}

function findLeaveConflictsForTask(db, task) {
  if (!task.tideWindow || !task.tideWindow.start || !task.tideWindow.end) return [];
  const conflicts = [];
  for (const pilot of db.pilots) {
    const pilotLeaves = db.leaveRecords.filter(
      (r) => r.pilotId === pilot.id && r.status === "active"
    );
    for (const leave of pilotLeaves) {
      const ws = new Date(task.tideWindow.start);
      const we = new Date(task.tideWindow.end);
      const ls = new Date(leave.period.start);
      const le = new Date(leave.period.end);
      if (ws < le && ls < we) {
        conflicts.push({
          pilotId: pilot.id,
          pilotName: pilot.name,
          leaveId: leave.id,
          leaveType: leave.type,
          leavePeriod: leave.period,
          leaveReason: leave.reason || null
        });
      }
    }
  }
  return conflicts;
}

function summarizePilotEligibility(db, task) {
  if (!task.vessel || !task.district || !task.tideWindow || !task.requiredGrade) {
    return { totalPilots: db.pilots.length, eligiblePilots: 0, ineligiblePilots: db.pilots.length, breakdown: [] };
  }
  const results = db.pilots.map((pilot) => evaluateCandidate(db, pilot, task));
  const eligible = results.filter((r) => r.eligible);
  const ineligible = results.filter((r) => !r.eligible);
  const breakdown = results.map((r) => ({
    pilotId: r.pilotId,
    name: r.name,
    eligible: r.eligible,
    score: r.totalScore,
    disqualifying: r.disqualifying
  }));
  return {
    totalPilots: db.pilots.length,
    eligiblePilots: eligible.length,
    ineligiblePilots: ineligible.length,
    breakdown
  };
}

export function previewDraft(db, draft) {
  const missingFields = validateDraftForSubmit(draft);
  const isComplete = missingFields.length === 0;

  const fieldCompleteness = {
    complete: isComplete,
    missingFields,
    requiredFields: [...REQUIRED_TASK_FIELDS],
    fieldStatus: {}
  };

  for (const field of REQUIRED_TASK_FIELDS) {
    if (field === "vessel") {
      fieldCompleteness.fieldStatus[field] = {
        present: draft.vessel && typeof draft.vessel === "object" && !!draft.vessel.name,
        detail: draft.vessel ? {
          hasName: !!draft.vessel?.name,
          hasType: !!draft.vessel?.type
        } : null
      };
    } else if (field === "tideWindow") {
      fieldCompleteness.fieldStatus[field] = {
        present: draft.tideWindow && typeof draft.tideWindow === "object" &&
          !!draft.tideWindow.start && !!draft.tideWindow.end,
        detail: draft.tideWindow ? {
          hasStart: !!draft.tideWindow?.start,
          hasEnd: !!draft.tideWindow?.end
        } : null
      };
    } else {
      fieldCompleteness.fieldStatus[field] = {
        present: draft[field] !== undefined && draft[field] !== null && draft[field] !== ""
      };
    }
  }

  const task = buildTaskFromDraft(draft);

  const pilotRecommendation = isComplete
    ? recommendForTask(db, task, 3)
    : { totalEligible: 0, totalIneligible: 0, recommendations: [], topRecommendation: null };

  const pilotEligibility = summarizePilotEligibility(db, task);

  const timeOverlapConflicts = isComplete
    ? findConflictingExistingTasks(db, task)
    : [];

  const leaveConflicts = isComplete
    ? findLeaveConflictsForTask(db, task)
    : [];

  const warnings = [];
  if (timeOverlapConflicts.length > 0) {
    warnings.push({
      code: "district_time_overlap",
      message: `与 ${timeOverlapConflicts.length} 个同港区活跃任务存在时间重叠`,
      severity: "warning"
    });
  }
  if (leaveConflicts.length > 0) {
    warnings.push({
      code: "pilot_leave_conflict",
      message: `${leaveConflicts.length} 名引航员在此任务窗口内有休假`,
      severity: "warning"
    });
  }
  if (!isComplete) {
    warnings.push({
      code: "incomplete_fields",
      message: `草稿缺少 ${missingFields.length} 个必填字段`,
      severity: "error"
    });
  }

  const canSubmit = isComplete;

  return {
    draftId: draft.id,
    previewedAt: new Date().toISOString(),
    canSubmit,
    fieldCompleteness,
    pilotRecommendation,
    pilotEligibility,
    timeOverlapConflicts,
    leaveConflicts,
    warnings
  };
}
