import { object, identifier, sha256 } from "./validation.js";
import { ValidationError } from "./errors.js";
/** Numeric gate receipt; private rules, inputs and reviewer findings stay on the worker. */
export interface RequestGateEvidence {
  schemaVersion: 1;
  requestId: string;
  revision: number;
  inputDigest: string;
  policyDigest: string;
  evaluationId: string;
  stage: "ready" | "done";
  status: "passed" | "blocked";
  failedRules: number;
  unknownRules: number;
}
export function validateRequestGateEvidence(
  value: unknown,
): RequestGateEvidence {
  const body = object(value, "Request gate evidence", [
    "schemaVersion",
    "requestId",
    "revision",
    "inputDigest",
    "policyDigest",
    "evaluationId",
    "stage",
    "status",
    "failedRules",
    "unknownRules",
  ]);
  if (
    body.schemaVersion !== 1 ||
    typeof body.stage !== "string" ||
    !["ready", "done"].includes(body.stage) ||
    typeof body.status !== "string" ||
    !["passed", "blocked"].includes(body.status)
  )
    throw new ValidationError("Invalid request gate receipt.");
  for (const key of ["requestId", "evaluationId"])
    if (identifier(body[key], key) !== body[key])
      throw new ValidationError("Invalid gate receipt identity.");
  for (const key of ["inputDigest", "policyDigest"]) sha256(body[key], key);
  for (const key of ["revision", "failedRules", "unknownRules"])
    if (
      !Number.isSafeInteger(body[key]) ||
      Number(body[key]) < 0 ||
      (key !== "revision" && Number(body[key]) > 33)
    )
      throw new ValidationError("Invalid gate receipt count.");
  if (
    Number(body.failedRules) + Number(body.unknownRules) > 33 ||
    (body.status === "passed") !==
      (body.failedRules === 0 && body.unknownRules === 0)
  )
    throw new ValidationError(
      "Gate receipt status must match its rule counts.",
    );
  return structuredClone(body) as unknown as RequestGateEvidence;
}
