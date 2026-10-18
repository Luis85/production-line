import { containsSensitivePatchMaterial } from './review-patch-policy.js';
import { reviewFilePatch,                 } from "./review-patch.js";

/** Approved-file patch reply limits, stated to the model and enforced before a reply becomes reviewable. */
export const PATCH_REPLY_LIMITS = Object.freeze({
  replyChars: 64000,
  summaryChars: 2000,
  fileChars: 64000,
  patchChars: 131072,
});

                               
                           
                          
                           
                           
                         
                           
                          
                                
                     
                     
                               

/** A reply that does not follow the patch protocol. Messages name the rule, never reply or file content. */
export class PatchProtocolError extends Error {
           code                   ;
  constructor(code                   , message        ) {
    super(message);
    this.name = "PatchProtocolError";
    this.code = code;
  }
}

const MAX_CANDIDATES = 256;

/** Model-chosen paths are shown to the operator only as bounded, printable text. */
function shownPath(value         ) {
  if (typeof value !== "string") return "a non-text path";
  const printable = value.replace(/[\u0000-\u001f\u007f-\u009f]/g, "?");
  return JSON.stringify(printable.length > 120 ? printable.slice(0, 117) + "..." : printable);
}

const plainObject = (value         )                                   =>
  !!value && typeof value === "object" && !Array.isArray(value);

/** End index of the JSON object starting at `start`, honoring strings; -1 when it never closes. */
function objectEnd(text        , start        ) {
  let depth = 0, inString = false;
  for (let index = start; index < text.length; index++) {
    const character = text[index];
    if (inString) {
      if (character === "\\") index++;
      else if (character === '"') inString = false;
    } else if (character === '"') inString = true;
    else if (character === "{") depth++;
    else if (character === "}" && --depth === 0) return index;
  }
  return -1;
}

/**
 * Reads one patch object from a reply. A bare or fenced object is preferred; otherwise exactly one
 * top-level object with `summary` or `files` may be surrounded by prose. Two different objects are refused.
 */
export function parsePatchReply(reply        )                          {
  if (reply.length > PATCH_REPLY_LIMITS.replyChars)
    throw new PatchProtocolError("patch_reply_too_large", `The reply has ${reply.length} characters; the limit is ${PATCH_REPLY_LIMITS.replyChars}.`);
  const trimmed = reply.trim();
  const fenced = /^```[A-Za-z]*[ \t]*\r?\n?([\s\S]*?)\s*```$/.exec(trimmed);
  try {
    const direct = JSON.parse(fenced ? fenced[1] : trimmed);
    if (plainObject(direct)) return direct;
  } catch {
    // Fall through to bounded extraction from surrounding prose.
  }
  const candidates                            = [];
  let attempts = 0, start = reply.indexOf("{");
  for (; start !== -1 && attempts < MAX_CANDIDATES; start = reply.indexOf("{", start + 1)) {
    attempts++;
    const end = objectEnd(reply, start);
    if (end < 0) continue;
    try {
      const value = JSON.parse(reply.slice(start, end + 1));
      if (plainObject(value) && ("files" in value || "summary" in value)) {
        if (!candidates.some(item => JSON.stringify(item) === JSON.stringify(value))) candidates.push(value);
        start = end;
      }
    } catch {
      // Not JSON; a later brace may start the object.
    }
  }
  if (start !== -1)
    throw new PatchProtocolError("patch_reply_ambiguous", "The reply exceeds the bounded patch-object search; return exactly one JSON object without surrounding text.");
  if (candidates.length === 1) return candidates[0];
  if (candidates.length > 1)
    throw new PatchProtocolError("patch_reply_ambiguous", `The reply contains ${candidates.length} different patch objects; return exactly one.`);
  throw new PatchProtocolError("patch_reply_not_json", 'The reply is not a JSON object of the form {"summary":"...","files":[{"path":"...","content":"..."}]}.');
}

                                 
                  
                
                           
 

/** Validates a reply against the approved snapshots and builds the minimal review patch. */
export function validatePatchReply(approved                       , reply        )                 {
  const result = parsePatchReply(reply);
  if (typeof result.summary !== "string")
    throw new PatchProtocolError("patch_summary_invalid", "The reply needs a text summary.");
  if (result.summary.length > PATCH_REPLY_LIMITS.summaryChars)
    throw new PatchProtocolError("patch_summary_invalid", `The summary has ${result.summary.length} characters; the limit is ${PATCH_REPLY_LIMITS.summaryChars}.`);
  if (!Array.isArray(result.files) || !result.files.length)
    throw new PatchProtocolError("patch_files_invalid", "The reply needs a non-empty files list of changed approved files.");
  if (result.files.length > approved.length)
    throw new PatchProtocolError("patch_files_invalid", `The reply lists ${result.files.length} files; this task approves ${approved.length}.`);
  const seen = new Set        ();
  let patch = "", changedFileCount = 0;
  for (const [index, change] of result.files.entries()) {
    if (!plainObject(change))
      throw new PatchProtocolError("patch_files_invalid", `File entry ${index + 1} is not an object with path and content.`);
    // Approved names are canonical; models may echo the same Unicode spelling decomposed.
    const path = typeof change.path === "string" ? change.path.normalize("NFC") : undefined;
    const before = approved.find(file => file.path === path);
    if (!before)
      throw new PatchProtocolError("patch_file_unapproved", `File entry ${index + 1} uses ${shownPath(change.path)}, which is not an approved path.`);
    if (seen.has(before.path))
      throw new PatchProtocolError("patch_file_duplicate", `${shownPath(before.path)} is listed more than once.`);
    seen.add(before.path);
    if (typeof change.content !== "string")
      throw new PatchProtocolError("patch_file_content_invalid", `The content of ${shownPath(before.path)} must be the complete file text.`);
    if (change.content.length > PATCH_REPLY_LIMITS.fileChars)
      throw new PatchProtocolError("patch_file_content_invalid", `The content of ${shownPath(before.path)} has ${change.content.length} characters; the limit is ${PATCH_REPLY_LIMITS.fileChars}.`);
    if (change.content.includes("\0"))
      throw new PatchProtocolError("patch_file_content_invalid", `The content of ${shownPath(before.path)} contains a NUL character.`);
    const filePatch = reviewFilePatch(before, change.content);
    if (filePatch) { patch += filePatch; changedFileCount++; }
  }
  if (!patch)
    throw new PatchProtocolError("patch_unchanged", "Every listed file is identical to its approved snapshot.");
  if (patch.length > PATCH_REPLY_LIMITS.patchChars)
    throw new PatchProtocolError("patch_too_large", `The review patch has ${patch.length} characters; the limit is ${PATCH_REPLY_LIMITS.patchChars}.`);
  if (containsSensitivePatchMaterial(patch))
    throw new PatchProtocolError("patch_sensitive_material", "The patch contains material that looks like a private key or access token.");
  return { summary: result.summary, patch, changedFileCount };
}

/** The output contract appended to file-task prompts, with the limits enforced above. */
export function patchProtocolInstruction(approvedCount        ) {
  const limits = PATCH_REPLY_LIMITS;
  return `Return ONLY one JSON object, without Markdown fences or text before or after it: {"summary":"...","files":[{"path":"approved path","content":"complete new file content"}]}. Limits: the summary is at most ${limits.summaryChars} characters; files lists 1-${approvedCount} changed approved paths, each at most once; each content is the complete new file text of at most ${limits.fileChars} characters without NUL characters; the whole reply is at most ${limits.replyChars} characters. Omit unchanged files.`;
}
