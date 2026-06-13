import { mkdir, readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const dbPath = join(__dirname, "..", "data", "pilot-station.json");

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

export async function loadDb() {
  if (!existsSync(dbPath)) {
    await mkdir(dirname(dbPath), { recursive: true });
    await writeFile(dbPath, JSON.stringify(seed, null, 2));
  }
  return JSON.parse(await readFile(dbPath, "utf8"));
}

export async function saveDb(db) {
  await writeFile(dbPath, JSON.stringify(db, null, 2));
}
