import { mkdir, readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const dbPath = join(__dirname, "..", "data", "pilot-station.json");

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
  changeRequests: []
};

export async function loadDb() {
  if (!existsSync(dbPath)) {
    await mkdir(dirname(dbPath), { recursive: true });
    await writeFile(dbPath, JSON.stringify(seed, null, 2));
  }
  const db = JSON.parse(await readFile(dbPath, "utf8"));
  if (!db.drafts) db.drafts = [];
  if (!db.changeRequests) db.changeRequests = [];
  return db;
}

export async function saveDb(db) {
  await writeFile(dbPath, JSON.stringify(db, null, 2));
}
