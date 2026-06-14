import http from "node:http";
import { loadDb, saveDb } from "./utils/db.js";
import { handleShiftsCalendar } from "./routes/shifts.js";
import { handleDraftCreate, handleDraftList, handleDraftDetail, handleDraftUpdate, handleDraftSubmit } from "./routes/drafts.js";
import { handleConfigOptions, handleConfigValidate } from "./routes/config.js";
import { handleTaskList, handleTaskCreate, handleTaskCandidates, handleTaskAssign, handleTaskStatus, handleTaskRecommend } from "./routes/tasks.js";
import {
  handleChangeRequestList,
  handleChangeRequestDetail,
  handleChangeRequestCreate,
  handleChangeRequestRecheck,
  handleChangeRequestApprove,
  handleChangeRequestReject
} from "./routes/change-requests.js";
import {
  handleLeaveList,
  handleLeaveDetail,
  handleLeaveCreate,
  handleLeaveCancel
} from "./routes/leaves.js";

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
        endpoints: ["GET /config/options", "GET /config/validate", "GET /pilots", "POST /pilots", "GET /tasks", "POST /tasks", "GET /tasks/:id/candidates", "POST /tasks/:id/recommend", "POST /tasks/:id/assign", "POST /tasks/:id/status", "GET /shifts/calendar", "POST /drafts", "GET /drafts", "GET /drafts/:id", "PUT /drafts/:id", "POST /drafts/:id/submit", "GET /change-requests", "POST /tasks/:id/change-requests", "GET /change-requests/:id", "POST /change-requests/:id/recheck", "POST /change-requests/:id/approve", "POST /change-requests/:id/reject", "GET /leaves", "POST /leaves", "GET /leaves/:id", "POST /leaves/:id/cancel"]
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

    if (req.method === "GET" && url.pathname === "/change-requests") {
      return handleChangeRequestList(db, url.searchParams, send, res);
    }

    const taskCrMatch = url.pathname.match(/^\/tasks\/([^/]+)\/change-requests$/);
    if (taskCrMatch) {
      const [, taskId] = taskCrMatch;
      if (req.method === "POST") {
        const input = await body(req);
        return handleChangeRequestCreate(db, taskId, input, send, res);
      }
    }

    const crMatch = url.pathname.match(/^\/change-requests\/([^/]+)(?:\/([^/]+))?$/);
    if (crMatch) {
      const [, crId, crAction] = crMatch;
      if (req.method === "GET" && !crAction) return handleChangeRequestDetail(db, crId, send, res);
      if (req.method === "POST" && crAction === "recheck") {
        return handleChangeRequestRecheck(db, crId, send, res);
      }
      if (req.method === "POST" && crAction === "approve") {
        const input = await body(req);
        return handleChangeRequestApprove(db, crId, input, send, res);
      }
      if (req.method === "POST" && crAction === "reject") {
        const input = await body(req);
        return handleChangeRequestReject(db, crId, input, send, res);
      }
    }

    if (req.method === "GET" && url.pathname === "/leaves") {
      return handleLeaveList(db, url.searchParams, send, res);
    }

    if (req.method === "POST" && url.pathname === "/leaves") {
      const input = await body(req);
      return handleLeaveCreate(db, input, send, res);
    }

    const leaveMatch = url.pathname.match(/^\/leaves\/([^/]+)(?:\/([^/]+))?$/);
    if (leaveMatch) {
      const [, leaveId, leaveAction] = leaveMatch;
      if (req.method === "GET" && !leaveAction) return handleLeaveDetail(db, leaveId, send, res);
      if (req.method === "POST" && leaveAction === "cancel") {
        const input = await body(req);
        return handleLeaveCancel(db, leaveId, input, send, res);
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
