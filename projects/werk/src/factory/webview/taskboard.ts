import type {
  FactoryTaskCard,
  FactoryTaskPage,
} from "../application/task-pages";

export interface TaskSource {
  id: string;
  label: string;
  webviewUrl: string;
}
export interface SourceTaskPage {
  source: TaskSource;
  tasks: FactoryTaskCard[];
  cursor: string | null;
  previous: (string | null)[];
  nextCursor: string | null;
  hasMore: boolean;
  loaded: boolean;
  loading: boolean;
  checkedAt: string | null;
  error: string;
}
type ResponsePage = FactoryTaskPage & { lineId: string; checkedAt: string };
const initial = (source: TaskSource): SourceTaskPage => ({
  source,
  tasks: [],
  cursor: null,
  previous: [],
  nextCursor: null,
  hasMore: false,
  loaded: false,
  loading: false,
  checkedAt: null,
  error: "",
});
/** Bounded source pages. Authentication, scope changes and unmount invalidate every outstanding read. */
export function createFactoryTaskboard(
  read: (
    id: string,
    cursor: string | null,
    signal: AbortSignal,
  ) => Promise<ResponsePage>,
  wrap: <T extends object>(value: T) => T = (value) => value,
) {
  const state = wrap({
    sources: [] as TaskSource[],
    sourcePage: 0,
    pages: new Map<string, SourceTaskPage>(),
    loading: false,
  });
  const sourceLimit = 12;
  let generation = 0,
    session = "",
    signature = "",
    closed = false;
  const controllers = new Set<AbortController>(),
    requests = new Map<string, number>();
  const visibleSources = () =>
    state.sources.slice(
      state.sourcePage * sourceLimit,
      (state.sourcePage + 1) * sourceLimit,
    );
  function invalidate() {
    ++generation;
    for (const controller of controllers) controller.abort();
    controllers.clear();
    requests.clear();
    state.loading = false;
  }
  function reset() {
    invalidate();
    state.sources = [];
    state.sourcePage = 0;
    state.pages.clear();
    signature = "";
    session = "";
  }
  async function configure(sources: TaskSource[], sessionIdentity: string) {
    if (closed) return;
    if (!sessionIdentity) {
      reset();
      return;
    }
    const next = JSON.stringify(sources);
    if (next === signature && sessionIdentity === session) return;
    invalidate();
    session = sessionIdentity;
    signature = next;
    state.sources = structuredClone(sources);
    state.sourcePage = 0;
    state.pages.clear();
    await refresh();
  }
  async function load(
    source: TaskSource,
    target?: { cursor: string | null; previous: (string | null)[] },
  ) {
    const own = generation,
      id = (requests.get(source.id) ?? 0) + 1;
    requests.set(source.id, id);
    const previous = state.pages.get(source.id) ?? initial(source);
    state.pages.set(source.id, { ...previous, loading: true });
    const cursor = target ? target.cursor : previous.cursor,
      history = target?.previous ?? previous.previous;
    const controller = new AbortController();
    controllers.add(controller);
    const valid = () =>
      !closed && own === generation && requests.get(source.id) === id;
    try {
      const result = await read(source.id, cursor, controller.signal);
      if (!valid()) return;
      if (
        result.lineId !== source.id ||
        !Array.isArray(result.tasks) ||
        result.tasks.length > 50 ||
        typeof result.hasMore !== "boolean" ||
        typeof result.checkedAt !== "string" ||
        !Number.isFinite(Date.parse(result.checkedAt)) ||
        (result.hasMore
          ? typeof result.nextCursor !== "string" ||
            !result.nextCursor ||
            result.nextCursor === cursor ||
            !result.tasks.length
          : result.nextCursor !== null)
      )
        throw Error("Ungültige Auftragsseite. Erneut laden.");
      state.pages.set(source.id, {
        source,
        tasks: structuredClone(result.tasks),
        cursor,
        previous: [...history],
        nextCursor: result.nextCursor,
        hasMore: result.hasMore,
        loaded: true,
        loading: false,
        checkedAt: result.checkedAt,
        error: "",
      });
    } catch (error) {
      if (valid() && !controller.signal.aborted)
        state.pages.set(source.id, {
          ...previous,
          loading: false,
          error:
            error instanceof Error
              ? error.message
              : "Aufträge dieser Linie sind nicht verfügbar. Erneut laden.",
        });
    } finally {
      controllers.delete(controller);
    }
  }
  async function refresh() {
    if (closed || !session || state.loading) return;
    const own = generation,
      sources = visibleSources();
    state.loading = true;
    let index = 0;
    await Promise.all(
      Array.from({ length: Math.min(4, sources.length) }, async () => {
        while (index < sources.length && own === generation && !closed)
          await load(sources[index++]!);
      }),
    );
    if (own === generation) state.loading = false;
  }
  async function moveSources(direction: "next" | "previous") {
    const target = state.sourcePage + (direction === "next" ? 1 : -1);
    if (
      closed ||
      !session ||
      target < 0 ||
      target * sourceLimit >= state.sources.length
    )
      return;
    invalidate();
    state.sourcePage = target;
    state.pages.clear();
    await refresh();
  }
  async function moveTasks(id: string, direction: "next" | "previous") {
    const page = state.pages.get(id);
    if (
      !page ||
      page.loading ||
      state.loading ||
      !visibleSources().some((source) => source.id === id) ||
      (direction === "next" ? !page.hasMore : !page.previous.length)
    )
      return;
    await load(
      page.source,
      direction === "next"
        ? { cursor: page.nextCursor, previous: [...page.previous, page.cursor] }
        : {
            cursor: page.previous.at(-1) ?? null,
            previous: page.previous.slice(0, -1),
          },
    );
  }
  async function retry(id: string) {
    const source = visibleSources().find((item) => item.id === id);
    if (source && !state.pages.get(id)?.loading && !state.loading)
      await load(source);
  }
  function rows() {
    return visibleSources().flatMap((source) =>
      (state.pages.get(source.id)?.tasks ?? []).map((task) => ({
        ...task,
        sourceId: source.id,
        sourceLabel: source.label + " · " + source.id,
      })),
    );
  }
  function close() {
    closed = true;
    reset();
  }
  return {
    state,
    sourceLimit,
    visibleSources,
    configure,
    refresh,
    moveSources,
    moveTasks,
    retry,
    rows,
    close,
  };
}
