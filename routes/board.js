import { buildBoard, buildDistrictBoard } from "../services/board.js";
import { isValidDistrict } from "../config/scheduling-rules.js";
import { nextTwelveHours } from "../utils/time.js";

export function handleBoardOverview(db, searchParams, send, res) {
  const date = searchParams.get("date");
  const board = buildBoard(db, date);
  return send(res, 200, board);
}

export function handleBoardDistrict(db, district, searchParams, send, res) {
  if (!isValidDistrict(district)) {
    return send(res, 400, { error: "invalid_district", message: `无效的港区: ${district}` });
  }
  const date = searchParams.get("date");
  const range = nextTwelveHours(date);
  const board = buildDistrictBoard(db, district, range.start, range.end);
  return send(res, 200, {
    generatedAt: new Date().toISOString(),
    window: range,
    ...board
  });
}
