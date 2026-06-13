import { schedulingOptions, isValidDistrict, isValidShipType, isValidGrade, isValidTaskStatus } from "../config/scheduling-rules.js";

export function handleConfigOptions(send, res) {
  return send(res, 200, schedulingOptions);
}

export function handleConfigValidate(db, searchParams, send, res) {
  const district = searchParams.get("district");
  const shipType = searchParams.get("shipType");
  const grade = searchParams.get("grade");
  const status = searchParams.get("status");

  const result = {};

  if (district !== null) {
    result.district = { value: district, valid: isValidDistrict(district) };
  }
  if (shipType !== null) {
    result.shipType = { value: shipType, valid: isValidShipType(shipType) };
  }
  if (grade !== null) {
    result.grade = { value: grade, valid: isValidGrade(grade) };
  }
  if (status !== null) {
    result.status = { value: status, valid: isValidTaskStatus(status) };
  }

  return send(res, 200, result);
}
