import http from "node:http";
import { loadDb, saveDb } from "./utils/db.js";
import { handleShiftsCalendar } from "./routes/shifts.js";
import { handleDraftCreate, handleDraftList, handleDraftDetail, handleDraftUpdate, handleDraftSubmit } from "./routes/drafts.js";
import { handleConfigOptions, handleConfigValidate } from "./routes/config.js";
import { handleTaskList, handleTaskCreate, handleTaskCandidates, handleTaskAssign, handleTaskStatus, handleTaskRecommend } from "./routes/tasks.js";

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

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://${req.headers.host}`);
    const db = await loadDb();

    if (req.method === "GET" && url.pathname === "/") {
      return send(res, 200, {
        service: "港口引航站申请和排班API",
        endpoints: ["GET /config/options", "GET /config/validate", "GET /pilots", "POST /pilots", "GET /tasks", "POST /tasks", "GET /tasks/:id/candidates", "POST /tasks/:id/recommend", "POST /tasks/:id/assign", "POST /tasks/:id/status", "GET /shifts/calendar", "POST /drafts", "GET /drafts", "GET /drafts/:id", "PUT /drafts/:id", "POST /drafts/:id/submit"]
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
      return handleTaskList(db, url.searchParams, send, res);
    }

    if (req.method === "POST" && url.pathname === "/tasks") {
      const input = await body(req);
      return handleTaskCreate(db, input, send, res);
    }

    const match = url.pathname.match(/^\/tasks\/([^/]+)\/([^/]+)$/);
    if (match) {
      const [, id, action] = match;
      const task = db.tasks.find((item) => item.id === id);
      if (!task) return send(res, 404, { error: "task_not_found" });

      if (req.method === "GET" && action === "candidates") {
        return handleTaskCandidates(db, task, send, res);
      }

      if (req.method === "POST" && action === "recommend") {
        const input = await body(req);
        return handleTaskRecommend(db, task, input, send, res);
      }

      if (req.method === "POST" && action === "assign") {
        const input = await body(req);
        return handleTaskAssign(db, task, input, send, res);
      }

      if (req.method === "POST" && action === "status") {
        const input = await body(req);
        return handleTaskStatus(db, task, input, send, res);
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
