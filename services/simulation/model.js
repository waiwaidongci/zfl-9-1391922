export function createSimulationSnapshot(db, { tempShifts = [] } = {}) {
  const snapshot = {
    pilots: db.pilots.map((p) => ({
      ...p,
      shifts: [...p.shifts.map((s) => ({ ...s }))],
      districts: [...p.districts],
      shipTypes: [...p.shipTypes],
      grades: [...p.grades]
    })),
    tasks: db.tasks.map((t) => ({
      ...t,
      vessel: { ...t.vessel },
      tideWindow: t.tideWindow ? { ...t.tideWindow } : null,
      history: t.history ? t.history.map((h) => ({ ...h })) : []
    })),
    leaveRecords: db.leaveRecords.map((l) => ({
      ...l,
      period: { ...l.period }
    }))
  };

  if (tempShifts.length > 0) {
    mergeTempShifts(snapshot, tempShifts);
  }

  return snapshot;
}

function mergeTempShifts(snapshot, tempShifts) {
  for (const ts of tempShifts) {
    const pilot = snapshot.pilots.find((p) => p.id === ts.pilotId);
    if (!pilot) {
      snapshot.pilots.push({
        id: ts.pilotId,
        name: ts.name || ts.pilotId,
        districts: ts.districts || [],
        shipTypes: ts.shipTypes || [],
        grades: ts.grades || [],
        shifts: ts.shifts ? ts.shifts.map((s) => ({ ...s })) : []
      });
      continue;
    }
    if (ts.shifts) {
      for (const shift of ts.shifts) {
        pilot.shifts.push({ ...shift });
      }
    }
    if (ts.districts) {
      for (const d of ts.districts) {
        if (!pilot.districts.includes(d)) pilot.districts.push(d);
      }
    }
    if (ts.shipTypes) {
      for (const st of ts.shipTypes) {
        if (!pilot.shipTypes.includes(st)) pilot.shipTypes.push(st);
      }
    }
    if (ts.grades) {
      for (const g of ts.grades) {
        if (!pilot.grades.includes(g)) pilot.grades.push(g);
      }
    }
  }
}

export function addSimTask(snapshot, task) {
  snapshot.tasks.push({
    ...task,
    vessel: { ...task.vessel },
    tideWindow: task.tideWindow ? { ...task.tideWindow } : null,
    status: task.status || "pending",
    pilotId: task.pilotId || null,
    history: task.history ? task.history.map((h) => ({ ...h })) : []
  });
}

export function assignSimTask(snapshot, taskId, pilotId) {
  const task = snapshot.tasks.find((t) => t.id === taskId);
  if (!task) return null;
  task.pilotId = pilotId;
  task.status = "assigned";
  return task;
}
