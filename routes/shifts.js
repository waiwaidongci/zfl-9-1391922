import { dayRange, intervalsInDay, subtractIntervals, overlaps } from "../utils/time.js";

function buildPilotCalendar(pilot, tasks, dayStart, dayEnd, districtFilter) {
  const relevantShifts = pilot.shifts.filter((s) => overlaps(s.start, s.end, dayStart, dayEnd));
  if (districtFilter && !pilot.districts.includes(districtFilter) && relevantShifts.length === 0) return null;
  const shiftsOnDay = intervalsInDay(relevantShifts, dayStart, dayEnd);
  const relevantTasks = tasks.filter((task) => task.pilotId === pilot.id && overlaps(task.tideWindow.start, task.tideWindow.end, dayStart, dayEnd));
  if (districtFilter) {
    const districtTasks = relevantTasks.filter((t) => t.district === districtFilter);
    const districtShifts = pilot.districts.includes(districtFilter) ? shiftsOnDay : [];
    if (districtTasks.length === 0 && districtShifts.length === 0) return null;
  }
  const tasksOnDay = relevantTasks
    .filter((t) => !districtFilter || t.district === districtFilter)
    .map((task) => ({
      taskId: task.id,
      vessel: task.vessel.name,
      district: task.district,
      berthPlan: task.berthPlan,
      status: task.status,
      start: task.tideWindow.start,
      end: task.tideWindow.end
    }))
    .sort((a, b) => new Date(a.start) - new Date(b.start));
  const busyIntervals = tasksOnDay.map((t) => ({ start: t.start, end: t.end }));
  const idleIntervals = subtractIntervals(shiftsOnDay, busyIntervals);
  return {
    pilotId: pilot.id,
    name: pilot.name,
    districts: pilot.districts,
    shifts: shiftsOnDay,
    tasks: tasksOnDay,
    idle: idleIntervals
  };
}

export function handleShiftsCalendar(db, searchParams, send, res) {
  const dateParam = searchParams.get("date");
  const district = searchParams.get("district");
  const { start: dayStart, end: dayEnd, dateKey } = dayRange(dateParam);
  const allTasks = db.tasks.filter((t) => !["cancelled", "done"].includes(t.status));
  const pilots = db.pilots
    .map((pilot) => buildPilotCalendar(pilot, allTasks, dayStart, dayEnd, district))
    .filter(Boolean);
  return send(res, 200, {
    date: dateKey,
    district: district || null,
    pilots
  });
}
