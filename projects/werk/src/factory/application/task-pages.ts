import { validateRequestGateEvidence } from "../../shared/request-gate.js";
import { DomainError } from "../../shared/errors.js";

export interface FactoryTaskCard {
  id: string;
  title: string;
  status: string;
  project: string;
  priority: number;
  workerId: string | null;
  profile: string | null;
  createdAt: number;
  executionMode: "mock" | "cli";
  gate?: { phase: "needs_rework" | "done" | "ready"; label: string };
}
export interface FactoryTaskPage {
  tasks: FactoryTaskCard[];
  hasMore: boolean;
  nextCursor: string | null;
}
export function taskPageQuery(parameters: URLSearchParams): {
  limit: number;
  cursor?: string;
} {
  for (const key of parameters.keys())
    if (
      !["limit", "cursor"].includes(key) ||
      parameters.getAll(key).length !== 1
    )
      throw new DomainError(
        "invalid_input",
        "Only one limit and cursor may be supplied.",
      );
  const raw = parameters.get("limit") ?? "50";
  if (!/^(?:[1-9]|[1-4][0-9]|50)$/.test(raw))
    throw new DomainError("invalid_input", "Task page limit must be 1–50.");
  const cursor = parameters.get("cursor");
  if (
    cursor !== null &&
    (!cursor || cursor.length > 1024 || !/^[A-Za-z0-9_-]+$/.test(cursor))
  )
    throw new DomainError("invalid_input", "Task page cursor is invalid.");
  return { limit: Number(raw), ...(cursor === null ? {} : { cursor }) };
}
/** Return only public card fields, never upstream leases, request bodies or credentials. */
export function checkedTaskPage(
  value: unknown,
  limit: number,
  cursor?: string,
): FactoryTaskPage {
  const invalid = () =>
    new DomainError(
      "unavailable",
      "The line returned an invalid task page. Retry or open the line directly.",
    );
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw invalid();
  const page = value as Record<string, unknown>;
  if (
    !Array.isArray(page.tasks) ||
    page.tasks.length > limit ||
    typeof page.hasMore !== "boolean" ||
    (page.hasMore
      ? typeof page.nextCursor !== "string" ||
        !/^[A-Za-z0-9_-]{1,1024}$/.test(page.nextCursor) ||
        page.nextCursor === cursor ||
        !page.tasks.length
      : page.nextCursor !== null)
  )
    throw invalid();
  const seen = new Set<string>();
  const tasks = page.tasks.map((raw: unknown) => {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw invalid();
    const row = raw as Record<string, unknown>;
    if (
      typeof row.id !== "string" ||
      !/^[A-Za-z0-9_-]{1,100}$/.test(row.id) ||
      seen.has(row.id) ||
      typeof row.title !== "string" ||
      !row.title ||
      row.title.length > 200 ||
      typeof row.project !== "string" ||
      !/^[A-Za-z0-9_-]{1,100}$/.test(row.project) ||
      typeof row.status !== "string" ||
      !/^[a-z][a-z_]{0,39}$/.test(row.status) ||
      !Number.isSafeInteger(row.priority) ||
      Number(row.priority) < 0 ||
      typeof row.createdAt !== "number" ||
      !Number.isFinite(row.createdAt) ||
      !Number.isFinite(new Date(row.createdAt).getTime())
    )
      throw invalid();
    if (
      row.executionMode !== undefined &&
      !["mock", "cli"].includes(String(row.executionMode))
    )
      throw invalid();
    for (const key of ["workerId", "profile"])
      if (
        row[key] !== null &&
        row[key] !== undefined &&
        (typeof row[key] !== "string" || String(row[key]).length > 200)
      )
        throw invalid();
    seen.add(row.id);
    let gate: FactoryTaskCard["gate"];
    if (row.requestGate !== undefined) {
      let receipt;
      try {
        receipt = validateRequestGateEvidence(row.requestGate);
      } catch {
        throw invalid();
      }
      gate = {
        phase:
          receipt.status === "blocked"
            ? "needs_rework"
            : receipt.stage === "done"
              ? "done"
              : "ready",
        label:
          receipt.status === "blocked"
            ? "Gate blockiert"
            : receipt.stage === "done"
              ? "Abschluss geprüft"
              : "Bereit geprüft",
      };
    }
    return {
      ...(gate ? { gate } : {}),
      id: row.id,
      title: row.title,
      status: row.status,
      project: row.project,
      priority: Number(row.priority),
      workerId: (row.workerId as string | null) ?? null,
      profile: (row.profile as string | null) ?? null,
      createdAt: row.createdAt,
      executionMode:
        row.executionMode === "cli" ? ("cli" as const) : ("mock" as const),
    };
  });
  return {
    tasks,
    hasMore: page.hasMore,
    nextCursor: page.nextCursor as string | null,
  };
}
