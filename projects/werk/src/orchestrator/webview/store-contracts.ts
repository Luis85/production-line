
export type Tab = "system" | "intake" | "tasks" | "workers" | "metrics";
export type RecordData = Record<string, any>;
export interface Page {
  cursor: string | null;
  previous: (string | null)[];
  nextCursor: string | null;
  hasMore: boolean;
  loaded: boolean;
  count: number;
}
export const firstPage = (): Page => ({
  cursor: null,
  previous: [],
  nextCursor: null,
  hasMore: false,
  loaded: false,
  count: 0,
});
export const names: Record<Tab, string> = {
  system: "Dashboard",
  intake: "Auftrag übergeben",
  tasks: "Aufträge",
  workers: "Worker",
  metrics: "Messwerte",
};
export const statuses: Record<string, string> = {
  queued: "Wartet",
  running: "In Ausführung",
  review: "Review erforderlich",
  simulated: "Simuliert",
  blocked: "Klärung erforderlich",
};
export const date = (value: string | number) =>
  Number.isFinite(new Date(value).getTime())
    ? new Date(value).toLocaleString("de-DE")
    : "Nicht erfasst";
export const contextState = (task: RecordData) =>
  task.context?.commit
    ? `Kontext am Commit ${task.context.commit} fixiert · ${task.executionMode === "cli" ? "CLI-Ausführung zum Review" : "Ausführung weiterhin simuliert"}`
    : "Kontext noch nicht aufgelöst";
export const errorText = (error: unknown) =>
  error instanceof Error ? error.message : "Anfrage fehlgeschlagen.";
export function checkedPage(
  result: RecordData,
  key: string,
  page: Page,
  limit = 50,
): Page {
  if (
    !result ||
    !Array.isArray(result[key]) ||
    result[key].length > limit ||
    typeof result.hasMore !== "boolean" ||
    (result.hasMore
      ? typeof result.nextCursor !== "string" ||
      !result.nextCursor ||
      result.nextCursor.length > 1024 ||
      result.nextCursor === page.cursor ||
      !result[key].length
      : result.nextCursor !== null)
  )
    throw Error("Ungültige Seitenantwort. Bitte erneut laden.");
  if (
    result[key].some(
      (item: RecordData) =>
        !item ||
        (key === "events"
          ? !Number.isSafeInteger(item.seq)
          : typeof item.id !== "string") ||
        (key === "tasks" && typeof item.title !== "string") ||
        (key === "workers" && !Array.isArray(item.profiles)),
    )
  )
    throw Error("Ungültige Datensätze auf dieser Seite.");
  return {
    ...page,
    previous: [...page.previous],
    nextCursor: result.nextCursor,
    hasMore: result.hasMore,
    loaded: true,
    count: result[key].length,
  };
}
export function targetPage(page: Page, direction: "next" | "previous"): Page {
  return direction === "next"
    ? {
      ...firstPage(),
      cursor: page.nextCursor,
      previous: [...page.previous, page.cursor],
    }
    : {
      ...firstPage(),
      cursor: page.previous.at(-1) ?? null,
      previous: page.previous.slice(0, -1),
    };
}
export function checkedWorkerDetail(value: RecordData, id: string) {
  const integer = (v: unknown) => Number.isSafeInteger(v) && Number(v) >= 0;
  const time = (v: unknown) =>
    typeof v === "number" &&
    Number.isFinite(v) &&
    Number.isFinite(new Date(v).getTime());
  if (
    !value ||
    value.id !== id ||
    typeof value.project !== "string" ||
    !time(value.seen) ||
    typeof value.online !== "boolean" ||
    !value.config ||
    !integer(value.config.maxParallel) ||
    !integer(value.config.maxAttempts) ||
    !["priority", "fifo"].includes(value.config.order) ||
    !Array.isArray(value.profiles) ||
    value.profiles.length > 8 ||
    value.profiles.some(
      (p: RecordData) =>
        !p ||
        typeof p.id !== "string" ||
        !["claude", "codex"].includes(p.provider) ||
        !["mock", "cli"].includes(p.mode) ||
        !integer(p.maxParallel),
    ) ||
    !Array.isArray(value.activeTasks) ||
    value.activeTasks.length > 8 ||
    typeof value.activeTasksTruncated !== "boolean" ||
    value.activeTasks.some(
      (t: RecordData) =>
        !t ||
        typeof t.id !== "string" ||
        t.status !== "running" ||
        !integer(t.attempt) ||
        (t.profile !== null && typeof t.profile !== "string") ||
        (t.expiresAt !== null && !time(t.expiresAt)),
    )
  )
    throw Error("Ungültige Worker-Antwort. Bitte erneut laden.");
  return value;
}
export interface StoreOptions {
  request?: (path: string, init: RequestInit) => Promise<any>;
  now?: () => number;
  uuid?: () => string;
  reactive?: <T extends object>(value: T) => T;
}
