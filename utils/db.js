import { mkdir, readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));

function getDataDir() {
  return process.env.ZFL_DATA_DIR || join(__dirname, "..", "data");
}

function getDbPath() {
  return join(getDataDir(), "pilot-station.json");
}

function getAuditLogPath() {
  return join(getDataDir(), "audit-log.json");
}

const auditSeed = {
  events: []
};

const seed = {
  pilots: [
    { id: "P-01", name: "沈望", districts: ["东港", "北槽"], shipTypes: ["散货船", "集装箱船"], grades: ["A", "B"], shifts: [{ start: "2026-06-14T00:00:00.000Z", end: "2026-06-14T12:00:00.000Z" }] },
    { id: "P-02", name: "何澜", districts: ["西港"], shipTypes: ["油轮", "化学品船"], grades: ["A"], shifts: [{ start: "2026-06-14T08:00:00.000Z", end: "2026-06-14T20:00:00.000Z" }] },
    { id: "P-03", name: "周屿", districts: ["东港", "西港", "北槽"], shipTypes: ["散货船", "集装箱船", "油轮"], grades: ["A"], shifts: [{ start: "2026-06-14T06:00:00.000Z", end: "2026-06-14T18:00:00.000Z" }] },
    { id: "P-04", name: "林潮", districts: ["北槽"], shipTypes: ["集装箱船"], grades: ["B"], shifts: [{ start: "2026-06-14T00:00:00.000Z", end: "2026-06-14T12:00:00.000Z" }] },
    { id: "P-05", name: "郑涵", districts: ["东港", "西港"], shipTypes: ["油轮", "化学品船", "散货船"], grades: ["A", "B"], shifts: [{ start: "2026-06-14T12:00:00.000Z", end: "2026-06-15T00:00:00.000Z" }] }
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
    },
    {
      id: "T-260614-02",
      vessel: { name: "海盛号", imo: "IMO9412002", type: "集装箱船", length: 260 },
      district: "北槽",
      berthPlan: "靠泊N2",
      tideWindow: { start: "2026-06-14T10:00:00.000Z", end: "2026-06-14T13:00:00.000Z" },
      requiredGrade: "A",
      status: "pending",
      pilotId: null,
      history: [{ at: "2026-06-13T20:00:00.000Z", action: "created", note: "北槽集装箱船任务" }]
    },
    {
      id: "T-260614-03",
      vessel: { name: "远泰9", imo: "IMO9311002", type: "油轮", length: 220 },
      district: "西港",
      berthPlan: "靠泊W1",
      tideWindow: { start: "2026-06-15T06:00:00.000Z", end: "2026-06-15T09:00:00.000Z" },
      requiredGrade: "A",
      status: "pending",
      pilotId: null,
      history: [{ at: "2026-06-13T22:29:06.400Z", action: "created", note: "西港油轮任务" }]
    },
    {
      id: "T-260614-04",
      vessel: { name: "长江明珠", imo: "IMO9700303", type: "散货船", length: 210 },
      district: "东港",
      berthPlan: "靠泊D5",
      tideWindow: { start: "2026-06-17T02:00:00.000Z", end: "2026-06-17T05:00:00.000Z" },
      requiredGrade: "B",
      status: "pending",
      pilotId: null,
      history: [{ at: "2026-06-14T08:00:00.000Z", action: "created", note: "东港散货船任务 - 用于验证P-01休假冲突" }]
    },
    {
      id: "T-260614-05",
      vessel: { name: "海洋之星", imo: "IMO9800404", type: "集装箱船", length: 280 },
      district: "北槽",
      berthPlan: "靠泊N4",
      tideWindow: { start: "2026-06-15T08:00:00.000Z", end: "2026-06-15T11:00:00.000Z" },
      requiredGrade: "B",
      status: "pending",
      pilotId: null,
      history: [{ at: "2026-06-14T09:30:00.000Z", action: "created", note: "北槽集装箱船任务 - 用于验证P-04临时停用冲突" }]
    }
  ],
  drafts: [
    {
      id: "D-260614-01",
      vessel: { name: "东方之星", imo: "IMO9500101", type: "化学品船", length: 200 },
      district: "西港",
      berthPlan: "靠泊W3",
      tideWindow: { start: "2026-06-16T03:00:00.000Z", end: "2026-06-16T06:00:00.000Z" },
      requiredGrade: "A",
      note: "化学品船待船公司最终确认吃水",
      createdAt: "2026-06-13T18:00:00.000Z",
      updatedAt: "2026-06-13T18:00:00.000Z"
    },
    {
      id: "D-260614-02",
      vessel: { name: "远洋先锋", imo: "IMO9600202", type: "集装箱船", length: 300 },
      district: "北槽",
      berthPlan: null,
      tideWindow: null,
      requiredGrade: "A",
      note: "大型集装箱船，泊位和窗口待港调统一排期",
      createdAt: "2026-06-13T21:15:00.000Z",
      updatedAt: "2026-06-13T21:15:00.000Z"
    }
  ],
  changeRequests: [],
  leaveRecords: [
    {
      id: "L-260614-01",
      pilotId: "P-01",
      type: "vacation",
      period: { start: "2026-06-16T00:00:00.000Z", end: "2026-06-18T12:00:00.000Z" },
      reason: "年度年休假",
      status: "active",
      createdAt: "2026-06-13T10:00:00.000Z"
    },
    {
      id: "L-260614-02",
      pilotId: "P-04",
      type: "disabled",
      period: { start: "2026-06-15T06:00:00.000Z", end: "2026-06-15T18:00:00.000Z" },
      reason: "体检/临时调休",
      status: "active",
      createdAt: "2026-06-13T15:30:00.000Z"
    }
  ]
};

export async function loadDb() {
  const dbPath = getDbPath();
  if (!existsSync(dbPath)) {
    await mkdir(dirname(dbPath), { recursive: true });
    await writeFile(dbPath, JSON.stringify(seed, null, 2));
  }
  const db = JSON.parse(await readFile(dbPath, "utf8"));
  if (!db.drafts) db.drafts = [];
  if (!db.changeRequests) db.changeRequests = [];
  if (!db.leaveRecords) db.leaveRecords = [];
  return db;
}

export async function saveDb(db) {
  const dbPath = getDbPath();
  await writeFile(dbPath, JSON.stringify(db, null, 2));
}

export function listLeaveRecords(db, { pilotId, status, includeCancelled = false } = {}) {
  let records = db.leaveRecords;
  if (!includeCancelled) records = records.filter((r) => r.status === "active");
  if (pilotId) records = records.filter((r) => r.pilotId === pilotId);
  if (status) records = records.filter((r) => r.status === status);
  return [...records].sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
}

export function activeLeavesForPilot(db, pilotId) {
  return db.leaveRecords.filter((r) => r.pilotId === pilotId && r.status === "active");
}

export function createLeaveRecord(db, input) {
  const record = {
    id: input.id || `L-${Date.now()}`,
    pilotId: input.pilotId,
    type: input.type || "vacation",
    period: { start: input.period.start, end: input.period.end },
    reason: input.reason || "",
    status: "active",
    createdAt: new Date().toISOString()
  };
  db.leaveRecords.push(record);
  return record;
}

export function cancelLeaveRecord(db, recordId, note) {
  const record = db.leaveRecords.find((r) => r.id === recordId);
  if (!record) return null;
  record.status = "cancelled";
  record.cancelledAt = new Date().toISOString();
  if (note) record.cancelledNote = note;
  return record;
}

export function getLeaveRecord(db, recordId) {
  return db.leaveRecords.find((r) => r.id === recordId) || null;
}

let _auditWriteLock = Promise.resolve();

export async function loadAuditLog() {
  const auditLogPath = getAuditLogPath();
  if (!existsSync(auditLogPath)) {
    await mkdir(dirname(auditLogPath), { recursive: true });
    await writeFile(auditLogPath, JSON.stringify(auditSeed, null, 2));
  }
  try {
    const content = await readFile(auditLogPath, "utf8");
    if (!content || content.trim().length === 0) {
      return { events: [] };
    }
    const auditLog = JSON.parse(content);
    if (!auditLog.events) auditLog.events = [];
    return auditLog;
  } catch (err) {
    console.warn(`[loadAuditLog] JSON解析失败，重置为空日志: ${err.message}`);
    const fresh = { events: [] };
    await writeFile(auditLogPath, JSON.stringify(fresh, null, 2));
    return fresh;
  }
}

export async function saveAuditLog(auditLog) {
  const auditLogPath = getAuditLogPath();
  const prevLock = _auditWriteLock;
  let releaseLock;
  _auditWriteLock = new Promise((resolve) => {
    releaseLock = resolve;
  });
  try {
    await prevLock;
    await writeFile(auditLogPath, JSON.stringify(auditLog, null, 2));
  } finally {
    releaseLock();
  }
}

export async function resetDbToSeed() {
  const dbPath = getDbPath();
  await mkdir(dirname(dbPath), { recursive: true });
  await writeFile(dbPath, JSON.stringify(seed, null, 2));
  return JSON.parse(JSON.stringify(seed));
}

export async function resetAuditLogToSeed() {
  const auditLogPath = getAuditLogPath();
  await mkdir(dirname(auditLogPath), { recursive: true });
  await writeFile(auditLogPath, JSON.stringify(auditSeed, null, 2));
  return JSON.parse(JSON.stringify(auditSeed));
}

export async function resetAllToSeed() {
  await resetDbToSeed();
  await resetAuditLogToSeed();
  return loadDb();
}

export { seed as dbSeed, auditSeed, getDataDir, getDbPath, getAuditLogPath };
