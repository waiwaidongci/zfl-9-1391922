import http from "node:http";
import { loadDb, saveDb } from "./utils/db.js";
import { overlaps, taskWindow, activeTasksForPilot } from "./utils/time.js";
import { handleShiftsCalendar } from "./routes/shifts.js";
import { handleDraftCreate, handleDraftList, handleDraftDetail, handleDraftUpdate, handleDraftSubmit } from "./routes/drafts.js";
import { handleConfigOptions, handleConfigValidate } from "./routes/config.js";
import { isValidDistrict, isValidShipType, isValidGrade, DEFAULT_TASK_STATUS, ASSIGNED_TASK_STATUS } from "./config/scheduling-rules.js";

const port = Number(process.env.PORT || 3009);

function send(res, status, data) {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(data, null, 2));
}

async function body(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  return chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : {};
}

function pilotFits(db, pilot, task, exceptTaskId) {
  const window = taskWindow(task);
  const onShift = pilot.shifts.some((shift) => overlaps(window.start, window.end, shift.start, shift.end));
  const noConflict = activeTasksForPilot(db, pilot.id, exceptTaskId).every((item) => {
    const other = taskWindow(item);
    return !overlaps(window.start, window.end, other.start, other.end);
  });
  const districtMatch = isValidDistrict(task.district) && pilot.districts.includes(task.district);
  const shipTypeMatch = isValidShipType(task.vessel.type) && pilot.shipTypes.includes(task.vessel.type);
  const gradeMatch = isValidGrade(task.requiredGrade) && pilot.grades.includes(task.requiredGrade);
  return {
    pilot,
    ok: onShift && noConflict && districtMatch && shipTypeMatch && gradeMatch,
    reasons: [
      onShift ? null : "not_on_shift",
      noConflict ? null : "time_conflict",
      districtMatch ? null : "district_mismatch",
      shipTypeMatch ? null : "ship_type_mismatch",
      gradeMatch ? null : "grade_mismatch"
    ].filter(Boolean)
  };
}

function addHistory(task, action, note) {
  task.history.push({ at: new Date().toISOString(), action, note });
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://${req.headers.host}`);
    const db = await loadDb();

    if (req.method === "GET" && url.pathname === "/") {
      return send(res, 200, {
        service: "港口引航站申请和排班API",
        endpoints: ["GET /config/options", "GET /config/validate", "GET /pilots", "POST /pilots", "GET /tasks", "POST /tasks", "GET /tasks/:id/candidates", "POST /tasks/:id/assign", "POST /tasks/:id/status", "GET /shifts/calendar", "POST /drafts", "GET /drafts", "GET /drafts/:id", "PUT /drafts/:id", "POST /drafts/:id/submit"]
      });
    }

    if (req.method === "GET" && url.pathname === "/config/options") {
      return handleConfigOptions(send, res);
    }

    if (req.method === "GET" && url.pathname === "/config/validate") {
      return handleConfigValidate(db, url.searchParams, send, res);
    }

    if (req.method === "GET" && url.pathname === "/shifts/calendar") {
      return handleShiftsCalendar(db, url.searchParams, send, res);
    }

    if (req.method === "GET" && url.pathname === "/pilots") return send(res, 200, db.pilots);

    if (req.method === "POST" && url.pathname === "/pilots") {
      const input = await body(req);
      const pilot = { id: input.id || `P-${Date.now()}`, name: input.name, districts: input.districts || [], shipTypes: input.shipTypes || [], grades: input.grades || [], shifts: input.shifts || [] };
      db.pilots.push(pilot);
      await saveDb(db);
      return send(res, 201, pilot);
    }

    if (req.method === "GET" && url.pathname === "/tasks") {
      const status = url.searchParams.get("status");
      const district = url.searchParams.get("district");
      let tasks = db.tasks;
      if (status) tasks = tasks.filter((task) => task.status === status);
      if (district) tasks = tasks.filter((task) => task.district === district);
      return send(res, 200, tasks);
    }

    if (req.method === "POST" && url.pathname === "/tasks") {
      const input = await body(req);
      const task = { id: input.id || `T-${Date.now()}`, vessel: input.vessel, district: input.district, berthPlan: input.berthPlan, tideWindow: input.tideWindow, requiredGrade: input.requiredGrade, status: DEFAULT_TASK_STATUS, pilotId: null, history: [] };
      addHistory(task, "created", input.note || "新建引航申请");
      db.tasks.push(task);
      await saveDb(db);
      return send(res, 201, task);
    }

    const match = url.pathname.match(/^\/tasks\/([^/]+)\/([^/]+)$/);
    if (match) {
      const [, id, action] = match;
      const task = db.tasks.find((item) => item.id === id);
      if (!task) return send(res, 404, { error: "task_not_found" });

      if (req.method === "GET" && action === "candidates") {
        const candidates = db.pilots.map((pilot) => pilotFits(db, pilot, task, task.id));
        return send(res, 200, candidates.map((item) => ({ pilotId: item.pilot.id, name: item.pilot.name, ok: item.ok, reasons: item.reasons })));
      }

      if (req.method === "POST" && action === "assign") {
        const input = await body(req);
        const pilot = db.pilots.find((item) => item.id === input.pilotId);
        if (!pilot) return send(res, 404, { error: "pilot_not_found" });
        const fit = pilotFits(db, pilot, task, task.id);
        if (!fit.ok) return send(res, 409, { error: "pilot_not_available", reasons: fit.reasons });
        task.pilotId = pilot.id;
        task.status = ASSIGNED_TASK_STATUS;
        addHistory(task, "assigned", `分配给${pilot.name}`);
        await saveDb(db);
        return send(res, 200, task);
      }

      if (req.method === "POST" && action === "status") {
        const input = await body(req);
        task.status = input.status;
        if (input.tideWindow) task.tideWindow = input.tideWindow;
        if (input.berthPlan) task.berthPlan = input.berthPlan;
        addHistory(task, input.status, input.note || "状态更新");
        await saveDb(db);
        return send(res, 200, task);
      }
    }

    if (req.method === "POST" && url.pathname === "/drafts") {
      const input = await body(req);
      return handleDraftCreate(db, input, send, res);
    }

    if (req.method === "GET" && url.pathname === "/drafts") {
      return handleDraftList(db, url.searchParams, send, res);
    }

    const draftMatch = url.pathname.match(/^\/drafts\/([^/]+)(?:\/([^/]+))?$/);
    if (draftMatch) {
      const [, draftId, draftAction] = draftMatch;
      if (req.method === "GET" && !draftAction) return handleDraftDetail(db, draftId, send, res);
      if (req.method === "PUT" && !draftAction) {
        const input = await body(req);
        return handleDraftUpdate(db, draftId, input, send, res);
      }
      if (req.method === "POST" && draftAction === "submit") {
        const input = await body(req);
        return handleDraftSubmit(db, draftId, input, send, res);
      }
    }

    send(res, 404, { error: "not_found" });
  } catch (error) {
    send(res, 500, { error: error.message });
  }
});

server.listen(port, () => {
  console.log(`Pilot station API listening on http://localhost:${port}`);
});
