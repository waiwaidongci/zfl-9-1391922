import http from "node:http";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const dbPath = join(__dirname, "data", "pilot-station.json");
const port = Number(process.env.PORT || 3009);

const seed = {
  pilots: [
    { id: "P-01", name: "沈望", districts: ["东港", "北槽"], shipTypes: ["散货船", "集装箱船"], grades: ["A", "B"], shifts: [{ start: "2026-06-14T00:00:00.000Z", end: "2026-06-14T12:00:00.000Z" }] },
    { id: "P-02", name: "何澜", districts: ["西港"], shipTypes: ["油轮", "化学品船"], grades: ["A"], shifts: [{ start: "2026-06-14T08:00:00.000Z", end: "2026-06-14T20:00:00.000Z" }] }
  ],
  tasks: [
    {
      id: "T-260614-01",
      vessel: { name: "远泰7", imo: "IMO9311001", type: "散货船", length: 180 },
      district: "东港",
      berthPlan: "靠泊D3",
      tideWindow: { start: "2026-06-14T02:30:00.000Z", end: "2026-06-14T05:30:00.000Z" },
      requiredGrade: "B",
      status: "assigned",
      pilotId: "P-01",
      history: [{ at: "2026-06-13T16:00:00.000Z", action: "created", note: "初始申请" }]
    }
  ]
};

async function loadDb() {
  if (!existsSync(dbPath)) {
    await mkdir(dirname(dbPath), { recursive: true });
    await writeFile(dbPath, JSON.stringify(seed, null, 2));
  }
  return JSON.parse(await readFile(dbPath, "utf8"));
}

async function saveDb(db) {
  await writeFile(dbPath, JSON.stringify(db, null, 2));
}

function send(res, status, data) {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(data, null, 2));
}

async function body(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  return chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : {};
}

function overlaps(aStart, aEnd, bStart, bEnd) {
  return new Date(aStart) < new Date(bEnd) && new Date(bStart) < new Date(aEnd);
}

function taskWindow(task) {
  return { start: task.tideWindow.start, end: task.tideWindow.end };
}

function activeTasksForPilot(db, pilotId, exceptTaskId) {
  return db.tasks.filter((task) => task.pilotId === pilotId && task.id !== exceptTaskId && !["cancelled", "done"].includes(task.status));
}

function pilotFits(db, pilot, task, exceptTaskId) {
  const window = taskWindow(task);
  const onShift = pilot.shifts.some((shift) => overlaps(window.start, window.end, shift.start, shift.end));
  const noConflict = activeTasksForPilot(db, pilot.id, exceptTaskId).every((item) => {
    const other = taskWindow(item);
    return !overlaps(window.start, window.end, other.start, other.end);
  });
  return {
    pilot,
    ok: onShift && noConflict && pilot.districts.includes(task.district) && pilot.shipTypes.includes(task.vessel.type) && pilot.grades.includes(task.requiredGrade),
    reasons: [
      onShift ? null : "not_on_shift",
      noConflict ? null : "time_conflict",
      pilot.districts.includes(task.district) ? null : "district_mismatch",
      pilot.shipTypes.includes(task.vessel.type) ? null : "ship_type_mismatch",
      pilot.grades.includes(task.requiredGrade) ? null : "grade_mismatch"
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
        endpoints: ["GET /pilots", "POST /pilots", "GET /tasks", "POST /tasks", "GET /tasks/:id/candidates", "POST /tasks/:id/assign", "POST /tasks/:id/status"]
      });
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
      const task = { id: input.id || `T-${Date.now()}`, vessel: input.vessel, district: input.district, berthPlan: input.berthPlan, tideWindow: input.tideWindow, requiredGrade: input.requiredGrade, status: "pending", pilotId: null, history: [] };
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
        task.status = "assigned";
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

    send(res, 404, { error: "not_found" });
  } catch (error) {
    send(res, 500, { error: error.message });
  }
});

server.listen(port, () => {
  console.log(`Pilot station API listening on http://localhost:${port}`);
});
