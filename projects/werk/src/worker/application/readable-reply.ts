// Pure transcript formatting shared by the worker runtime and its webview.
// Model protocol replies stay unchanged in interaction evidence; the conversation shows a readable view.

export interface ChangedFileStat {
  path: string;
  added?: number;
  removed?: number;
  /** Line count of proposed content when the original file is unknown (legacy transcripts). */
  lines?: number;
}

export type ReadableReply =
  | { kind: "text" | "record"; text: string; raw?: undefined }
  | { kind: "patch" | "question"; text: string; raw: string };

const pathCharacters = /[^\s`<>()[\]{}"'|,;]+/g;

/** Wraps text in the shortest Markdown code span that cannot be closed by its content. */
export function codeSpan(value: string) {
  const longest = Math.max(0, ...(value.match(/`+/g) ?? []).map((run) => run.length));
  const fence = "`".repeat(longest + 1);
  const pad = value.startsWith("`") || value.endsWith("`") ? " " : "";
  return fence + pad + value + pad + fence;
}

function pathLike(value: string) {
  if (!/[A-Za-z]/.test(value) || /:\/\/|^www\.|^mailto:/i.test(value)) return false;
  const slash = value.includes("/"),
    glob = value.includes("*"),
    extension = /\.[A-Za-z0-9]{1,10}$/.test(value);
  if (glob) return slash || extension;
  if (slash)
    return extension || /^\.{1,2}\//.test(value) || (value.match(/\//g) ?? []).length >= 2;
  // Underscores and tildes in file names otherwise become emphasis or strikethrough.
  return extension && /[_~]/.test(value);
}

function protectToken(token: string) {
  const [, core, tail] = /^(.*?)([.:!?]*)$/.exec(token)!;
  const wrapped = /^(\*\*|__)(.+)\1$/.exec(core);
  const inner = wrapped ? wrapped[2] : core;
  if (!pathLike(inner)) return token;
  return (wrapped?.[1] ?? "") + codeSpan(inner) + (wrapped?.[1] ?? "") + tail;
}

function protectLine(line: string) {
  // Existing inline code is already literal; only format the prose between spans.
  return line
    .split(/(`+[^`]*`+)/)
    .map((part, index) => (index % 2 ? part : part.replace(pathCharacters, protectToken)))
    .join("");
}

const blockLine = /^\s{0,3}(?:[-*+]\s|\d{1,9}[.)]\s|#{1,6}\s|>|\||(?:-{3,}|={3,}|\*{3,}|_{3,})\s*$)/;

/**
 * Model-written Markdown for a transcript: file paths and globs such as `src/**\/*.spec.ts`
 * become code spans instead of emphasis, and single line breaks inside prose are kept.
 * Fenced code blocks are left untouched.
 */
export function readableMarkdown(value: string) {
  const lines = value.replace(/\r\n?/g, "\n").split("\n");
  let fence: string | null = null;
  return lines
    .map((line, index) => {
      const marker = /^\s{0,3}(`{3,}|~{3,})/.exec(line)?.[1];
      if (fence) {
        if (marker && marker[0] === fence[0] && marker.length >= fence.length) fence = null;
        return line;
      }
      if (marker) {
        fence = marker;
        return line;
      }
      const next = lines[index + 1];
      const hardBreak =
        line.trim() &&
        next?.trim() &&
        !blockLine.test(line) &&
        !blockLine.test(next) &&
        !/^\s{0,3}(`{3,}|~{3,})/.test(next) &&
        !/(?: {2}|\\)$/.test(line);
      return protectLine(line) + (hardBreak ? "  " : "");
    })
    .join("\n");
}

function lineList(value: string) {
  if (!value) return [];
  const lines = value.split("\n");
  if (value.endsWith("\n")) lines.pop();
  return lines;
}

/** Added and removed line counts between two file versions (exact LCS for bounded edits). */
export function lineChangeStats(before: string, after: string) {
  const a = lineList(before),
    b = lineList(after);
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start++;
  let endA = a.length,
    endB = b.length;
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) {
    endA--;
    endB--;
  }
  const n = endA - start,
    m = endB - start;
  let common = 0;
  if (n && m && n * m <= 4_000_000) {
    let row = new Uint32Array(m + 1);
    for (let i = 0; i < n; i++) {
      const next = new Uint32Array(m + 1);
      for (let j = 0; j < m; j++)
        next[j + 1] =
          a[start + i] === b[start + j] ? row[j] + 1 : Math.max(row[j + 1], next[j]);
      row = next;
    }
    common = row[m];
  }
  return { added: m - common, removed: n - common };
}

const plural = (count: number, word: string) => `${count} ${word}${count === 1 ? "" : "s"}`;

function fileLine(file: ChangedFileStat) {
  const change =
    file.added !== undefined && file.removed !== undefined
      ? file.added || file.removed
        ? `${plural(file.added, "line")} added, ${file.removed} removed`
        : "no line changes"
      : file.lines !== undefined
        ? `${plural(file.lines, "line")} of proposed content`
        : "proposed change";
  return `- ${codeSpan(file.path)} · ${change}`;
}

/** Transcript text for a validated file-task completion. The patch itself stays in task evidence. */
export function patchReplyMessage(summary: string, files: ChangedFileStat[], note?: string) {
  const body = readableMarkdown(summary.trim()) || "No summary was returned.";
  return (
    body +
    `\n\n**Changed files (${files.length})**\n\n` +
    files.map(fileLine).join("\n") +
    "\n\n" +
    (note ? note + " " : "") +
    "The full patch is saved with this file task. Review it before applying it to a checkout."
  );
}

function questionMessage(request: Record<string, unknown>) {
  const escalation = request.kind === "escalation";
  const parts = [
    escalation ? "**Decision needed outside this task’s authority**" : "**Question for the operator**",
    readableMarkdown(String(request.message).trim()),
  ];
  const choices = Array.isArray(request.choices)
    ? request.choices.filter(
        (choice): choice is { id: string; label: string } =>
          !!choice && typeof choice.label === "string" && typeof choice.id === "string",
      )
    : [];
  if (choices.length)
    parts.push("**Choices**\n\n" + choices.map((choice) => `- ${choice.label} (${codeSpan(choice.id)})`).join("\n"));
  if (typeof request.reason === "string" && request.reason.trim())
    parts.push("**Reason:** " + readableMarkdown(request.reason.trim()));
  return parts.join("\n\n");
}

const record = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === "object" && !Array.isArray(value);

function stringLiteral(source: string) {
  try {
    const value: unknown = JSON.parse(source);
    return typeof value === "string" ? value : undefined;
  } catch {
    return undefined;
  }
}

/** Older transcripts stored at most 16,000 characters of a change set; recover its summary and paths. */
function truncatedChangeSet(text: string) {
  const literal = '"(?:[^"\\\\]|\\\\.)*"';
  const summary = new RegExp('^\\{\\s*"summary"\\s*:\\s*(' + literal + ")\\s*,\\s*\"files\"\\s*:\\s*\\[").exec(text);
  if (!summary) return null;
  const files: ChangedFileStat[] = [];
  for (const match of text.matchAll(new RegExp('\\{\\s*"path"\\s*:\\s*(' + literal + ")", "g"))) {
    const path = stringLiteral(match[1]);
    if (path !== undefined) files.push({ path });
  }
  const value = stringLiteral(summary[1]);
  return value === undefined ? null : { summary: value, files };
}

/**
 * Display form of a stored assistant message. Plain replies are returned unchanged; raw
 * model protocol JSON (file-task change sets and interaction checkpoints) becomes readable
 * Markdown with `raw` keeping the stored text, and other JSON records become a code block.
 */
export function readableReply(text: string): ReadableReply {
  const trimmed = text.trim();
  const unfenced = trimmed.replace(/^```(?:json)?\s*/, "").replace(/\s*```$/, "");
  if (!unfenced.startsWith("{")) return { kind: "text", text };
  let value: unknown;
  try {
    value = JSON.parse(unfenced);
  } catch {
    const partial = truncatedChangeSet(unfenced);
    return partial
      ? {
          kind: "patch",
          raw: text,
          text: patchReplyMessage(
            partial.summary,
            partial.files,
            "This saved reply was shortened, so the file list may be incomplete.",
          ),
        }
      : { kind: "text", text };
  }
  if (!record(value)) return { kind: "text", text };
  const interaction = value.werkInteraction;
  if (record(interaction) && typeof interaction.message === "string")
    return { kind: "question", raw: text, text: questionMessage(interaction) };
  if (
    typeof value.summary === "string" &&
    Array.isArray(value.files) &&
    value.files.every((file) => record(file) && typeof file.path === "string")
  )
    return {
      kind: "patch",
      raw: text,
      text: patchReplyMessage(
        value.summary,
        (value.files as Array<{ path: string; content?: unknown }>).map((file) =>
          typeof file.content === "string"
            ? { path: file.path, lines: lineList(file.content).length }
            : { path: file.path },
        ),
      ),
    };
  const json = JSON.stringify(value, null, 2);
  const fence = "`".repeat(Math.max(3, ...(json.match(/`+/g) ?? []).map((run) => run.length + 1)));
  return { kind: "record", text: `${fence}json\n${json}\n${fence}` };
}
