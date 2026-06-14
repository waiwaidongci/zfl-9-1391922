import http from "node:http";
import { loadDb, saveDb } from "./utils/db.js";
import { handleShiftsCalendar } from "./routes/shifts.js";
import { handleDraftCreate, handleDraftList, handleDraftDetail, handleDraftUpdate, handleDraftSubmit, handleDraftPreview } from "./routes/drafts.js";
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
import { handleBoardOverview, handleBoardDistrict } from "./routes/board.js";
import { handleImportPreview, handleImportConfirm, handleImportSessionDetail, handleImportSessionCancel, handleImportSessionList } from "./routes/imports.js";
import { handleSimulationDispatch } from "./routes/simulation.js";
import {
  handleAuditHistory,
  handleAuditEventDetail,
  handleAuditLatestRollbackable,
  handleTaskRollback,
  handleTaskRollbackAssign,
  handleTaskRollbackStatus,
  handleRollbackableTypes
} from "./routes/audit.js";
import { recordAuditEvent, AUDIT_OBJECT_TYPES, AUDIT_ACTIONS } from "./services/audit.js";

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
        endpoints: ["GET /config/options", "GET /config/validate", "GET /pilots", "POST /pilots", "GET /tasks", "POST /tasks", "GET /tasks/:id/candidates", "POST /tasks/:id/recommend", "POST /tasks/:id/assign", "POST /tasks/:id/status", "POST /tasks/:id/rollback", "POST /tasks/:id/rollback/assign", "POST /tasks/:id/rollback/status", "GET /audit", "GET /audit/:id", "GET /audit/rollbackable/:objectType/:objectId", "GET /audit/rollbackable-types", "GET /shifts/calendar", "GET /board", "GET /board/:district", "POST /drafts", "GET /drafts", "GET /drafts/:id", "PUT /drafts/:id", "POST /drafts/:id/preview", "POST /drafts/:id/submit", "GET /change-requests", "POST /tasks/:id/change-requests", "GET /change-requests/:id", "POST /change-requests/:id/recheck", "POST /change-requests/:id/approve", "POST /change-requests/:id/reject", "GET /leaves", "POST /leaves", "GET /leaves/:id", "POST /leaves/:id/cancel", "POST /import/tasks", "POST /import/tasks/confirm", "GET /import/sessions", "GET /import/sessions/:sessionId", "POST /import/sessions/:sessionId/cancel", "POST /simulation/dispatch"]
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

    if (req.method === "GET" && url.pathname === "/board") {
      return handleBoardOverview(db, url.searchParams, send, res);
    }

    const boardMatch = url.pathname.match(/^\/board\/([^/]+)$/);
    if (boardMatch && req.method === "GET") {
      const [, district] = boardMatch;
      return handleBoardDistrict(db, decodeURIComponent(district), url.searchParams, send, res);
    }

    if (req.method === "GET" && url.pathname === "/pilots") return send(res, 200, db.pilots);

    if (req.method === "POST" && url.pathname === "/pilots") {
      const input = await body(req);
      const pilot = { id: input.id || `P-${Date.now()}`, name: input.name, districts: input.districts || [], shipTypes: input.shipTypes || [], grades: input.grades || [], shifts: input.shifts || [] };
      db.pilots.push(pilot);
      await saveDb(db);
      await recordAuditEvent({
        objectType: AUDIT_OBJECT_TYPES.PILOT,
        objectId: pilot.id,
        action: AUDIT_ACTIONS.CREATE,
        after: pilot,
        operator: input.operator || null,
        note: input.note || "新增引航员",
        rollbackable: false
      });
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

      if (req.method === "POST" && action === "rollback") {
        const input = await body(req);
        return handleTaskRollback(db, id, input, send, res);
      }
    }

    const taskRollbackMatch = url.pathname.match(/^\/tasks\/([^/]+)\/rollback\/([^/]+)$/);
    if (taskRollbackMatch) {
      const [, taskId, rollbackAction] = taskRollbackMatch;
      const task = db.tasks.find((item) => item.id === taskId);
      if (!task) return send(res, 404, { error: "task_not_found" });

      if (req.method === "POST" && rollbackAction === "assign") {
        const input = await body(req);
        return handleTaskRollbackAssign(db, taskId, input, send, res);
      }

      if (req.method === "POST" && rollbackAction === "status") {
        const input = await body(req);
        return handleTaskRollbackStatus(db, taskId, input, send, res);
      }
    }

    if (req.method === "GET" && url.pathname === "/audit") {
      return handleAuditHistory(db, url.searchParams, send, res);
    }

    if (req.method === "GET" && url.pathname === "/audit/rollbackable-types") {
      return handleRollbackableTypes(send, res);
    }

    const auditRollbackableMatch = url.pathname.match(/^\/audit\/rollbackable\/([^/]+)\/([^/]+)$/);
    if (auditRollbackableMatch && req.method === "GET") {
      const [, objectType, objectId] = auditRollbackableMatch;
      return handleAuditLatestRollbackable(db, decodeURIComponent(objectType), decodeURIComponent(objectId), send, res);
    }

    const auditMatch = url.pathname.match(/^\/audit\/([^/]+)$/);
    if (auditMatch && req.method === "GET") {
      const [, auditId] = auditMatch;
      if (auditId === "rollbackable-types") return send(res, 404, { error: "not_found" });
      return handleAuditEventDetail(db, auditId, send, res);
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
      if (req.method === "POST" && draftAction === "preview") {
        return handleDraftPreview(db, draftId, send, res);
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

    if (req.method === "POST" && url.pathname === "/import/tasks") {
      const input = await body(req);
      return handleImportPreview(db, input, send, res);
    }

    if (req.method === "POST" && url.pathname === "/import/tasks/confirm") {
      const input = await body(req);
      return handleImportConfirm(db, input, send, res);
    }

    if (req.method === "GET" && url.pathname === "/import/sessions") {
      return handleImportSessionList(db, url.searchParams, send, res);
    }

    const importSessionMatch = url.pathname.match(/^\/import\/sessions\/([^/]+)(?:\/([^/]+))?$/);
    if (importSessionMatch) {
      const [, sessionId, sessionAction] = importSessionMatch;
      if (req.method === "GET" && !sessionAction) {
        return handleImportSessionDetail(db, decodeURIComponent(sessionId), send, res);
      }
      if (req.method === "POST" && sessionAction === "cancel") {
        return handleImportSessionCancel(db, decodeURIComponent(sessionId), send, res);
      }
    }

    if (req.method === "POST" && url.pathname === "/simulation/dispatch") {
      const input = await body(req);
      return handleSimulationDispatch(db, input, send, res);
    }

    send(res, 404, { error: "not_found" });
  } catch (error) {
    send(res, 500, { error: error.message });
  }
});

server.listen(port, () => {
  console.log(`Pilot station API listening on http://localhost:${port}`);
});
