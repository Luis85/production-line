import { computed, reactive } from "vue";
export interface InteractionMessage {
  id?: string;
  role: string;
  text: string;
  state?: string;
}
export interface LineInteractionResult {
  chat?: {
    available: boolean;
    busy: boolean;
    phase?: string;
    messages: InteractionMessage[];
  };
  sessions?: {
    selected: string;
    records: {
      id: string;
      title: string;
      busy?: boolean;
      status?: string;
    }[];
  };
}
export interface InteractionTask {
  project: string;
  provider: string;
  executionMode: string;
  priority: number;
  requirementRef?: string;
  title?: string;
  criteria?: string[];
  wikilinks?: string[];
}
export type InteractionRequest = (
  body: Record<string, unknown>,
) => Promise<LineInteractionResult>;
export function createLineInteraction(
  request: InteractionRequest,
  submit: (task: InteractionTask, key: string) => Promise<any>,
  writable: () => boolean,
  project = "",
) {
  const state = reactive({
    connection: null as {
      workerUrl: string;
      workerToken: string;
    } | null,
    sessionId: null as string | null,
    workerUrl: "",
    credential: "",
    draft: "",
    busy: false,
    reading: false,
    chat: null as LineInteractionResult["chat"] | null,
    task: null as
      | NonNullable<LineInteractionResult["sessions"]>["records"][number]
      | null,
    message: "",
    taskMessage: "",
    tab: "chat",
    submitting: false,
    input: {
      project,
      reference: "",
      title: "",
      criteria: "",
      provider: "auto",
      mode: "mock",
    },
  });
  const drafts = new Map<string, string>();
  let epoch = 0,
    revision = 0,
    taskKey = crypto.randomUUID(),
    lastPayload = "";
  const draftKey = () =>
    state.connection && state.sessionId
      ? state.connection.workerUrl + "|" + state.sessionId
      : null;
  function remember() {
    const key = draftKey();
    if (key) drafts.set(key, state.draft);
  }
  function reset(clear = false) {
    remember();
    ++epoch;
    ++revision;
    state.connection = null;
    state.sessionId = null;
    state.chat = null;
    state.task = null;
    state.busy = state.reading = state.submitting = false;
    state.credential = "";
    state.draft = "";
    if (clear) {
      drafts.clear();
      state.input = {
        project,
        reference: "",
        title: "",
        criteria: "",
        provider: "auto",
        mode: "mock",
      };
      state.message = state.taskMessage = "";
      taskKey = crypto.randomUUID();
      lastPayload = "";
    }
  }
  function paint(result: LineInteractionResult, allowSwitch = false) {
    if (result.sessions) {
      if (
        state.sessionId &&
        state.sessionId !== result.sessions.selected &&
        !allowSwitch
      ) {
        reset();
        state.message =
          "The selected worker session changed. Reconnect to inspect it before sending.";
        return false;
      }
      remember();
      state.sessionId = result.sessions.selected;
      state.task =
        result.sessions.records.find((item) => item.id === state.sessionId) ??
        null;
    }
    if (result.chat) state.chat = result.chat;
    return true;
  }
  const canSend = computed(
    () =>
      !!state.connection &&
      !state.busy &&
      writable() &&
      state.chat?.available &&
      !state.chat.busy &&
      !state.task?.busy &&
      !!state.draft.trim(),
  );
  const phase = computed(() =>
    state.task?.busy && !state.chat?.busy
      ? state.task.status
      : (state.chat?.phase ??
        (state.chat?.busy
          ? "running"
          : state.chat?.messages.at(-1)?.state === "error"
            ? "failed"
            : state.chat?.messages.at(-1)?.state === "cancelled"
              ? "cancelled"
              : state.chat?.messages.length
                ? "completed"
                : "draft")),
  );
  const title = computed(
    () =>
      state.task?.title ||
      state.chat?.messages.find((m) => m.role === "user")?.text.slice(0, 120) ||
      "New task",
  );
  async function connect() {
    if (state.busy) return;
    const own = epoch;
    state.busy = true;
    state.message = "Connecting to the worker…";
    const candidate = {
      workerUrl: state.workerUrl.trim(),
      workerToken: state.credential,
    };
    try {
      const result = await request({ ...candidate, action: "read" });
      if (own !== epoch) return;
      state.connection = candidate;
      state.sessionId = null;
      if (!paint(result)) return;
      state.credential = "";
      state.draft = drafts.get(draftKey() ?? "") ?? "";
      state.message =
        "Connected. Messages stay with this worker’s selected task.";
    } catch (error) {
      if (own === epoch) state.message = (error as Error).message;
    } finally {
      if (own === epoch) state.busy = false;
    }
  }
  async function perform(
    action: "read" | "new" | "send" | "cancel",
    automatic = false,
  ) {
    const read = action === "read";
    if (
      !state.connection ||
      state.busy ||
      (read && state.reading) ||
      (!read && !writable()) ||
      (action === "send" && !canSend.value)
    )
      return;
    if (read) state.reading = true;
    else state.busy = true;
    const own = epoch,
      id = ++revision,
      message = state.draft;
    if (!read)
      state.message =
        action === "send"
          ? "Sending your message…"
          : action === "new"
            ? "Preparing a new task…"
            : "Stopping the reply…";
    try {
      const result = await request({
        ...state.connection,
        action,
        sessionId: state.sessionId,
        ...(action === "send" ? { message } : {}),
      });
      if (own !== epoch || id !== revision) return;
      if (action === "new") {
        remember();
        state.sessionId = null;
        state.draft = "";
      }
      if (!paint(result, action === "new")) return;
      if (action === "send" && state.draft === message) state.draft = "";
      if (!automatic)
        state.message =
          action === "send"
            ? "Message queued on this worker."
            : action === "cancel"
              ? "Reply stopped."
              : action === "new"
                ? "New task ready. Your previous draft stays available while this panel is open."
                : "Conversation refreshed.";
    } catch (error) {
      if (own === epoch && id === revision)
        state.message = (error as Error).message;
    } finally {
      if (own === epoch) {
        if (read) state.reading = false;
        else state.busy = false;
      }
    }
  }
  async function submitTask() {
    if (!writable() || state.submitting) return;
    const own = epoch,
      input = state.input,
      task = {
        project: input.project,
        provider: input.provider,
        executionMode: input.mode,
        priority: 1,
        ...(input.reference.trim()
          ? { requirementRef: input.reference.trim() }
          : {
              title: input.title,
              criteria: input.criteria
                .split("\n")
                .map((v) => v.trim())
                .filter(Boolean),
              wikilinks: [],
            }),
      };
    const serialized = JSON.stringify(task);
    if (serialized !== lastPayload) {
      taskKey = crypto.randomUUID();
      lastPayload = serialized;
    }
    state.submitting = true;
    try {
      const result = await submit(task, taskKey);
      if (own !== epoch) return;
      state.taskMessage =
        typeof result.factoryId === "string" && "remoteTaskId" in result
          ? "Saved in Factory intake: " +
            result.id +
            ". " +
            (result.status === "delivered"
              ? "Delivered to the line."
              : "Delivery is pending.") +
            " Follow delivery in Factory intake."
          : "Task saved to this line: " +
            result.id +
            ". Follow its progress in the line taskboard.";
      input.title = input.criteria = input.reference = "";
      taskKey = crypto.randomUUID();
      lastPayload = "";
    } catch (error) {
      if (own === epoch) state.taskMessage = (error as Error).message;
    } finally {
      if (own === epoch) state.submitting = false;
    }
  }
  return { state, canSend, phase, title, connect, perform, reset, submitTask };
}
