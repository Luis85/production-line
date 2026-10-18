import { Lexer, Tokenizer,            } from 'marked';
import { parseModelResult } from './model-result.js';
import { PatchProtocolError, parsePatchReply } from './patch-protocol.js';
// Pure transcript formatting shared by the worker runtime and its webview.
// Model protocol replies stay unchanged in interaction evidence; the conversation shows a readable view.

                                  
               
                 
                   
                                                                                               
                 
                                                                                     
                        
 

                                                                           

                           
                                                              
                                                              

const pathCharacters = /[^\s`<>()[\]{}"'|,;]+/g;

/** Wraps text in the shortest Markdown code span that cannot be closed by its content. */
export function codeSpan(value        ) {
  const longest = Math.max(0, ...(value.match(/`+/g) ?? []).map((run) => run.length));
  const fence = "`".repeat(longest + 1);
  const pad = value.startsWith("`") || value.endsWith("`") ? " " : "";
  return fence + pad + value + pad + fence;
}

function pathLike(value        ) {
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

function protectToken(token        ) {
  const [, core, tail] = /^(.*?)([.:!?]*)$/.exec(token) ;
  const wrapped = /^(\*\*|__)(.+)\1$/.exec(core);
  const inner = wrapped ? wrapped[2] : core;
  if (!pathLike(inner)) return token;
  return (wrapped?.[1] ?? "") + codeSpan(inner) + (wrapped?.[1] ?? "") + tail;
}

function protectedInline(token       ) {
  return ['codespan', 'link', 'image', 'html', 'escape', 'br'].includes(token.type);
}

function protectProse(prose        , offset        , source        ) {
  return prose.replace(/\n/g, (newline, index        ) => {
    const position = offset + index;
    const line = source.slice(source.lastIndexOf('\n', position - 1) + 1, position);
    const nextEnd = source.indexOf('\n', position + 1);
    const next = source.slice(position + 1, nextEnd < 0 ? source.length : nextEnd);
    return line.trim() && next.trim() && !/(?: {2}|\\)$/.test(line) ? '  \n' : newline;
  }).replace(pathCharacters, protectToken);
}

function protectInline(tokens         , source        ) {
  let output = '', prose = '', offset = 0;
  const flush = () => { output += protectProse(prose, offset - prose.length, source); prose = ''; };
  for (const token of tokens) {
    if (protectedInline(token)) { flush(); output += token.raw; }
    else prose += token.raw;
    offset += token.raw.length;
  }
  flush();
  return output;
}

function protectBlock(token       ) {
  // Containers may hold nested code or reference definitions. Preserve their authored Markdown.
  if ((token.type !== 'paragraph' && token.type !== 'heading') || !('tokens' in token) || !Array.isArray(token.tokens)) return token.raw;
  const source = token.tokens.map(child => child.raw).join('');
  if (!source || !('text' in token) || source !== token.text) return token.raw;
  const start = token.raw.indexOf(source);
  // Only replace an exact, unambiguous inline source; keep heading markers and trailing whitespace.
  if (start < 0 || start !== token.raw.lastIndexOf(source)) return token.raw;
  return token.raw.slice(0, start) + protectInline(token.tokens, source) + token.raw.slice(start + source.length);
}

/**
 * Format prose paths and soft line breaks using the document's resolved inline tokens.
 * Authored code, links and block containers remain untouched, including nested fences.
 */
export function readableMarkdown(value        ) {
  // Match the shared Markdown renderer’s literal fallback before invoking the lexer.
  if (value.length > 32768) return value;
  const source = value.replace(/\r\n?/g, '\n');
  // This pass preserves emphasis delimiters as prose. Letting globs form emphasis
  // can swallow later authored code spans before we have a chance to protect them.
  const tokenizer = new Tokenizer();
  tokenizer.emStrong = () => undefined;
  tokenizer.del = () => undefined;
  let tokens         ;
  try { tokens = new Lexer({ gfm: true, tokenizer }).lex(source); }
  catch { return source; }
  if (tokens.map(token => token.raw).join('') !== source) return source;
  return tokens.map(protectBlock).join('');
}

function lineList(value        ) {
  if (!value) return [];
  const lines = value.split("\n");
  if (value.endsWith("\n")) lines.pop();
  return lines;
}

/** Added and removed line counts between two file versions (exact LCS for bounded edits). */
export function lineChangeStats(before        , after        ) {
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
  return { added: m - common, removed: n - common, ...(n * m > 4_000_000 ? { approximate: true } : {}) };
}

const plural = (count        , word        ) => `${count} ${word}${count === 1 ? "" : "s"}`;

function fileLine(file                 ) {
  const change =
    file.added !== undefined && file.removed !== undefined
      ? file.added || file.removed
        ? `${plural(file.added, "line")} added, ${file.removed} removed`
        : "no line changes"
      : file.lines !== undefined
        ? `${plural(file.lines, "line")} of proposed content`
        : "proposed change";
  return `- ${codeSpan(file.path)} · ${file.approximate ? "approximately " : ""}${change}`;
}

/** Transcript text for a validated file-task completion. The patch itself stays in task evidence. */
export function patchReplyMessage(summary        , files                   , note         , retainedPatch = true) {
  const body = readableMarkdown(summary.trim()) || "No summary was returned.";
  return (
    body +
    `\n\n**Changed files (${files.length})**\n\n` +
    files.map(fileLine).join("\n") +
    "\n\n" +
    (note ? note + " " : "") +
    (retainedPatch
      ? "The full patch is saved with this file task. Review it before applying it to a checkout."
      : "These proposed changes come from a saved reply. Inspect the task’s current patch separately before applying changes.")
  );
}

function questionMessage(request                         ) {
  const escalation = request.kind === "escalation";
  const parts = [
    escalation ? "**Decision needed outside this task’s authority**" : "**Question for the operator**",
    readableMarkdown(String(request.message).trim()),
  ];
  const choices = Array.isArray(request.choices)
    ? request.choices.filter(
        (choice)                                          =>
          !!choice && typeof choice.label === "string" && typeof choice.id === "string",
      )
    : [];
  if (choices.length)
    parts.push("**Choices**\n\n" + choices.map((choice) => `- ${choice.label} (${codeSpan(choice.id)})`).join("\n"));
  if (typeof request.reason === "string" && request.reason.trim())
    parts.push("**Reason:** " + readableMarkdown(request.reason.trim()));
  return parts.join("\n\n");
}

const record = (value         )                                   =>
  !!value && typeof value === "object" && !Array.isArray(value);

function stringLiteral(source        ) {
  try {
    const value          = JSON.parse(source);
    return typeof value === "string" ? value : undefined;
  } catch {
    return undefined;
  }
}

/** Older transcripts stored at most 16,000 characters of a change set; recover its summary and paths. */
function truncatedChangeSet(text        ) {
  const literal = '"(?:[^"\\\\]|\\\\.)*"';
  const summary = new RegExp('^\\{\\s*"summary"\\s*:\\s*(' + literal + ")\\s*,\\s*\"files\"\\s*:\\s*\\[").exec(text);
  if (!summary) return null;
  const files                    = [];
  for (const match of text.matchAll(new RegExp('\\{\\s*"path"\\s*:\\s*(' + literal + ")", "g"))) {
    const path = stringLiteral(match[1]);
    if (path !== undefined) files.push({ path });
  }
  const value = stringLiteral(summary[1]);
  return value === undefined ? null : { summary: value, files };
}

/**
 * Display form of a stored assistant message. Prose receives safe path/line-break formatting; raw
 * model protocol JSON (file-task change sets and interaction checkpoints) becomes readable
 * Markdown with `raw` keeping the stored text, and other JSON records become a code block.
 */
export function readableReply(text        , context               = {})                {
  const trimmed = text.trim();
  const unfenced = trimmed.replace(/^```(?:json)?\s*/, "").replace(/\s*```$/, "");
  if (!unfenced.startsWith("{") && context.fileTask !== "proposal") return { kind: "text", text: readableMarkdown(text) };
  let value         ;
  try {
    value = context.fileTask === "proposal" ? parsePatchReply(text) : JSON.parse(unfenced);
  } catch (error) {
    // Ambiguous or over-budget replies must not be reinterpreted as a truncated valid proposal.
    const partial = context.fileTask === "proposal" && error instanceof PatchProtocolError && error.code === "patch_reply_not_json" ? truncatedChangeSet(unfenced) : null;
    return partial
      ? {
          kind: "patch",
          raw: text,
          text: patchReplyMessage(
            partial.summary,
            partial.files,
            "This saved reply was shortened, so the file list may be incomplete.",
            false,
          ),
        }
      : { kind: "text", text: readableMarkdown(text) };
  }
  if (!record(value)) return { kind: "text", text: readableMarkdown(text) };
  if (context.fileTask && Object.hasOwn(value, "werkInteraction")) {
    try {
      const result = parseModelResult(unfenced);
      if (result.type === "needs_input") return { kind: "question", raw: text, text: questionMessage({ ...result.request }) };
    } catch { /* Invalid or illustrative envelopes remain ordinary JSON. */ }
  }
  if (
    context.fileTask === "proposal" &&
    typeof value.summary === "string" &&
    Array.isArray(value.files) && value.files.length > 0 &&
    value.files.every((file) => record(file) && typeof file.path === "string" && typeof file.content === "string")
  )
    return {
      kind: "patch",
      raw: text,
      text: patchReplyMessage(
        value.summary,
        (value.files                                              ).map((file) =>
          typeof file.content === "string"
            ? { path: file.path.normalize("NFC"), lines: lineList(file.content).length }
            : { path: file.path.normalize("NFC") },
        ),
        undefined,
        false,
      ),
    };
  const json = JSON.stringify(value, null, 2);
  const fence = "`".repeat(Math.max(3, ...(json.match(/`+/g) ?? []).map((run) => run.length + 1)));
  return { kind: "record", text: `${fence}json\n${json}\n${fence}` };
}
