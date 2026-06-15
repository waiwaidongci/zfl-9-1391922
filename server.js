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
import { handleSimulationDispatch, handleSimulationSubmit } from "./routes/simulation.js";
import {
  handleAuditHistory,
  handleAuditEventDetail,
  handleAuditLatestRollbackable,
  handleTaskRollback,
  handleTaskRollbackAssign,
  handleTaskRollbackStatus,
  handleTaskRollbackPreview,
  handleTaskRollbackRecheck,
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

function compilePattern(pattern) {
  const keys = [];
  const regex = new RegExp(
    "^" +
      pattern.replace(/:([^/]+)/g, (_, name) => {
        keys.push(name);
        return "([^/]+)";
      }) +
      "$"
  );
  return { regex, keys };
}

function matchRoute(pattern, pathname) {
  const { regex, keys } = compilePattern(pattern);
  const m = pathname.match(regex);
  if (!m) return null;
  const params = {};
  keys.forEach((k, i) => {
    params[k] = decodeURIComponent(m[i + 1]);
  });
  return params;
}

const routes = [
  {
    group: "基础信息",
    endpoints: [
      {
        method: "GET",
        pattern: "/",
        handler: (ctx) => {
          return send(ctx.res, 200, {
            service: "港口引航站申请和排班API",
            endpoints: ["GET /config/options", "GET /config/validate", "GET /pilots", "POST /pilots", "GET /tasks", "POST /tasks", "GET /tasks/:id/candidates", "POST /tasks/:id/recommend", "POST /tasks/:id/assign", "POST /tasks/:id/status", "POST /tasks/:id/rollback", "POST /tasks/:id/rollback/preview", "POST /tasks/:id/rollback/recheck", "POST /tasks/:id/rollback/assign", "POST /tasks/:id/rollback/status", "GET /audit", "GET /audit/:id", "GET /audit/rollbackable/:objectType/:objectId", "GET /audit/rollbackable-types", "GET /shifts/calendar", "GET /board", "GET /board/:district", "POST /drafts", "GET /drafts", "GET /drafts/:id", "PUT /drafts/:id", "POST /drafts/:id/preview", "POST /drafts/:id/submit", "GET /change-requests", "POST /tasks/:id/change-requests", "GET /change-requests/:id", "POST /change-requests/:id/recheck", "POST /change-requests/:id/approve", "POST /change-requests/:id/reject", "GET /leaves", "POST /leaves", "GET /leaves/:id", "POST /leaves/:id/cancel", "POST /import/tasks", "POST /import/tasks/confirm", "GET /import/sessions", "GET /import/sessions/:sessionId", "POST /import/sessions/:sessionId/cancel", "POST /simulation/dispatch", "POST /simulation/submit"]
          });
        }
      },
      {
        method: "GET",
        pattern: "/config/options",
        handler: (ctx) => handleConfigOptions(send, ctx.res)
      },
      {
        method: "GET",
        pattern: "/config/validate",
        handler: (ctx) => handleConfigValidate(ctx.db, ctx.url.searchParams, send, ctx.res)
      },
      {
        method: "GET",
        pattern: "/shifts/calendar",
        handler: (ctx) => handleShiftsCalendar(ctx.db, ctx.url.searchParams, send, ctx.res)
      }
    ]
  },
  {
    group: "看板",
    endpoints: [
      {
        method: "GET",
        pattern: "/board",
        handler: (ctx) => handleBoardOverview(ctx.db, ctx.url.searchParams, send, ctx.res)
      },
      {
        method: "GET",
        pattern: "/board/:district",
        handler: (ctx) => handleBoardDistrict(ctx.db, ctx.params.district, ctx.url.searchParams, send, ctx.res)
      }
    ]
  },
  {
    group: "引航员",
    endpoints: [
      {
        method: "GET",
        pattern: "/pilots",
        handler: (ctx) => send(ctx.res, 200, ctx.db.pilots)
      },
      {
        method: "POST",
        pattern: "/pilots",
        needBody: true,
        handler: async (ctx) => {
          const input = ctx.body;
          const pilot = { id: input.id || `P-${Date.now()}`, name: input.name, districts: input.districts || [], shipTypes: input.shipTypes || [], grades: input.grades || [], shifts: input.shifts || [] };
          ctx.db.pilots.push(pilot);
          await saveDb(ctx.db);
          await recordAuditEvent({
            objectType: AUDIT_OBJECT_TYPES.PILOT,
            objectId: pilot.id,
            action: AUDIT_ACTIONS.CREATE,
            after: pilot,
            operator: input.operator || null,
            note: input.note || "新增引航员",
            rollbackable: false
          });
          return send(ctx.res, 201, pilot);
        }
      }
    ]
  },
  {
    group: "任务 tasks",
    endpoints: [
      {
        method: "GET",
        pattern: "/tasks",
        handler: (ctx) => handleTaskList(ctx.db, ctx.url.searchParams, send, ctx.res)
      },
      {
        method: "POST",
        pattern: "/tasks",
        needBody: true,
        handler: async (ctx) => handleTaskCreate(ctx.db, ctx.body, send, ctx.res)
      },
      {
        method: "GET",
        pattern: "/tasks/:id/candidates",
        handler: (ctx) => {
          const task = ctx.db.tasks.find((item) => item.id === ctx.params.id);
          if (!task) return send(ctx.res, 404, { error: "task_not_found" });
          return handleTaskCandidates(ctx.db, task, send, ctx.res);
        }
      },
      {
        method: "POST",
        pattern: "/tasks/:id/recommend",
        needBody: true,
        handler: async (ctx) => {
          const task = ctx.db.tasks.find((item) => item.id === ctx.params.id);
          if (!task) return send(ctx.res, 404, { error: "task_not_found" });
          return handleTaskRecommend(ctx.db, task, ctx.body, send, ctx.res);
        }
      },
      {
        method: "POST",
        pattern: "/tasks/:id/assign",
        needBody: true,
        handler: async (ctx) => {
          const task = ctx.db.tasks.find((item) => item.id === ctx.params.id);
          if (!task) return send(ctx.res, 404, { error: "task_not_found" });
          return handleTaskAssign(ctx.db, task, ctx.body, send, ctx.res);
        }
      },
      {
        method: "POST",
        pattern: "/tasks/:id/status",
        needBody: true,
        handler: async (ctx) => {
          const task = ctx.db.tasks.find((item) => item.id === ctx.params.id);
          if (!task) return send(ctx.res, 404, { error: "task_not_found" });
          return handleTaskStatus(ctx.db, task, ctx.body, send, ctx.res);
        }
      }
    ]
  },
  {
    group: "任务回滚 rollback",
    endpoints: [
      {
        method: "POST",
        pattern: "/tasks/:id/rollback",
        needBody: true,
        handler: async (ctx) => handleTaskRollback(ctx.db, ctx.params.id, ctx.body, send, ctx.res)
      },
      {
        method: "POST",
        pattern: "/tasks/:id/rollback/assign",
        needBody: true,
        handler: async (ctx) => {
          const task = ctx.db.tasks.find((item) => item.id === ctx.params.id);
          if (!task) return send(ctx.res, 404, { error: "task_not_found" });
          return handleTaskRollbackAssign(ctx.db, ctx.params.id, ctx.body, send, ctx.res);
        }
      },
      {
        method: "POST",
        pattern: "/tasks/:id/rollback/status",
        needBody: true,
        handler: async (ctx) => {
          const task = ctx.db.tasks.find((item) => item.id === ctx.params.id);
          if (!task) return send(ctx.res, 404, { error: "task_not_found" });
          return handleTaskRollbackStatus(ctx.db, ctx.params.id, ctx.body, send, ctx.res);
        }
      },
      {
        method: "POST",
        pattern: "/tasks/:id/rollback/preview",
        needBody: true,
        handler: async (ctx) => {
          const task = ctx.db.tasks.find((item) => item.id === ctx.params.id);
          if (!task) return send(ctx.res, 404, { error: "task_not_found" });
          return handleTaskRollbackPreview(ctx.db, ctx.params.id, ctx.body, send, ctx.res);
        }
      },
      {
        method: "POST",
        pattern: "/tasks/:id/rollback/recheck",
        needBody: true,
        handler: async (ctx) => {
          const task = ctx.db.tasks.find((item) => item.id === ctx.params.id);
          if (!task) return send(ctx.res, 404, { error: "task_not_found" });
          return handleTaskRollbackRecheck(ctx.db, ctx.params.id, ctx.body, send, ctx.res);
        }
      }
    ]
  },
  {
    group: "审计 audit",
    endpoints: [
      {
        method: "GET",
        pattern: "/audit",
        handler: (ctx) => handleAuditHistory(ctx.db, ctx.url.searchParams, send, ctx.res)
      },
      {
        method: "GET",
        pattern: "/audit/rollbackable-types",
        handler: (ctx) => handleRollbackableTypes(send, ctx.res)
      },
      {
        method: "GET",
        pattern: "/audit/rollbackable/:objectType/:objectId",
        handler: (ctx) => handleAuditLatestRollbackable(ctx.db, ctx.params.objectType, ctx.params.objectId, send, ctx.res)
      },
      {
        method: "GET",
        pattern: "/audit/:auditId",
        handler: (ctx) => {
          if (ctx.params.auditId === "rollbackable-types") return send(ctx.res, 404, { error: "not_found" });
          return handleAuditEventDetail(ctx.db, ctx.params.auditId, send, ctx.res);
        }
      }
    ]
  },
  {
    group: "草稿 drafts",
    endpoints: [
      {
        method: "POST",
        pattern: "/drafts",
        needBody: true,
        handler: async (ctx) => handleDraftCreate(ctx.db, ctx.body, send, ctx.res)
      },
      {
        method: "GET",
        pattern: "/drafts",
        handler: (ctx) => handleDraftList(ctx.db, ctx.url.searchParams, send, ctx.res)
      },
      {
        method: "GET",
        pattern: "/drafts/:draftId",
        handler: (ctx) => handleDraftDetail(ctx.db, ctx.params.draftId, send, ctx.res)
      },
      {
        method: "PUT",
        pattern: "/drafts/:draftId",
        needBody: true,
        handler: async (ctx) => handleDraftUpdate(ctx.db, ctx.params.draftId, ctx.body, send, ctx.res)
      },
      {
        method: "POST",
        pattern: "/drafts/:draftId/preview",
        handler: (ctx) => handleDraftPreview(ctx.db, ctx.params.draftId, send, ctx.res)
      },
      {
        method: "POST",
        pattern: "/drafts/:draftId/submit",
        needBody: true,
        handler: async (ctx) => handleDraftSubmit(ctx.db, ctx.params.draftId, ctx.body, send, ctx.res)
      }
    ]
  },
  {
    group: "变更申请 change-requests",
    endpoints: [
      {
        method: "GET",
        pattern: "/change-requests",
        handler: (ctx) => handleChangeRequestList(ctx.db, ctx.url.searchParams, send, ctx.res)
      },
      {
        method: "POST",
        pattern: "/tasks/:id/change-requests",
        needBody: true,
        handler: async (ctx) => handleChangeRequestCreate(ctx.db, ctx.params.id, ctx.body, send, ctx.res)
      },
      {
        method: "GET",
        pattern: "/change-requests/:crId",
        handler: (ctx) => handleChangeRequestDetail(ctx.db, ctx.params.crId, send, ctx.res)
      },
      {
        method: "POST",
        pattern: "/change-requests/:crId/recheck",
        handler: (ctx) => handleChangeRequestRecheck(ctx.db, ctx.params.crId, send, ctx.res)
      },
      {
        method: "POST",
        pattern: "/change-requests/:crId/approve",
        needBody: true,
        handler: async (ctx) => handleChangeRequestApprove(ctx.db, ctx.params.crId, ctx.body, send, ctx.res)
      },
      {
        method: "POST",
        pattern: "/change-requests/:crId/reject",
        needBody: true,
        handler: async (ctx) => handleChangeRequestReject(ctx.db, ctx.params.crId, ctx.body, send, ctx.res)
      }
    ]
  },
  {
    group: "请假 leaves",
    endpoints: [
      {
        method: "GET",
        pattern: "/leaves",
        handler: (ctx) => handleLeaveList(ctx.db, ctx.url.searchParams, send, ctx.res)
      },
      {
        method: "POST",
        pattern: "/leaves",
        needBody: true,
        handler: async (ctx) => handleLeaveCreate(ctx.db, ctx.body, send, ctx.res)
      },
      {
        method: "GET",
        pattern: "/leaves/:leaveId",
        handler: (ctx) => handleLeaveDetail(ctx.db, ctx.params.leaveId, send, ctx.res)
      },
      {
        method: "POST",
        pattern: "/leaves/:leaveId/cancel",
        needBody: true,
        handler: async (ctx) => handleLeaveCancel(ctx.db, ctx.params.leaveId, ctx.body, send, ctx.res)
      }
    ]
  },
  {
    group: "导入 imports",
    endpoints: [
      {
        method: "POST",
        pattern: "/import/tasks",
        needBody: true,
        handler: async (ctx) => handleImportPreview(ctx.db, ctx.body, send, ctx.res)
      },
      {
        method: "POST",
        pattern: "/import/tasks/confirm",
        needBody: true,
        handler: async (ctx) => handleImportConfirm(ctx.db, ctx.body, send, ctx.res)
      },
      {
        method: "GET",
        pattern: "/import/sessions",
        handler: (ctx) => handleImportSessionList(ctx.db, ctx.url.searchParams, send, ctx.res)
      },
      {
        method: "GET",
        pattern: "/import/sessions/:sessionId",
        handler: (ctx) => handleImportSessionDetail(ctx.db, ctx.params.sessionId, send, ctx.res)
      },
      {
        method: "POST",
        pattern: "/import/sessions/:sessionId/cancel",
        handler: (ctx) => handleImportSessionCancel(ctx.db, ctx.params.sessionId, send, ctx.res)
      }
    ]
  },
  {
    group: "仿真 simulation",
    endpoints: [
      {
        method: "POST",
        pattern: "/simulation/dispatch",
        needBody: true,
        handler: async (ctx) => handleSimulationDispatch(ctx.db, ctx.body, send, ctx.res)
      },
      {
        method: "POST",
        pattern: "/simulation/submit",
        needBody: true,
        handler: async (ctx) => handleSimulationSubmit(ctx.db, ctx.body, send, ctx.res)
      }
    ]
  }
];

const flatRoutes = [];
for (const group of routes) {
  for (const endpoint of group.endpoints) {
    flatRoutes.push(endpoint);
  }
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://${req.headers.host}`);
    const db = await loadDb();

    for (const route of flatRoutes) {
      if (route.method !== req.method) continue;
      const params = matchRoute(route.pattern, url.pathname);
      if (!params) continue;

      const ctx = { req, res, db, url, params };
      if (route.needBody) {
        ctx.body = await body(req);
      }
      await route.handler(ctx);
      return;
    }

    send(res, 404, { error: "not_found" });
  } catch (error) {
    send(res, 500, { error: error.message });
  }
});

server.listen(port, () => {
  console.log(`Pilot station API listening on http://localhost:${port}`);
});
