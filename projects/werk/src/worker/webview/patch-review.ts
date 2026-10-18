/** Presentation only: parsing never authorizes paths, applies changes or verifies a patch. */
const patchPreviewLimits = Object.freeze({ characters: 512000, files: 80, lines: 2000, lineCharacters: 2000 });
export interface PatchLine { kind: 'context' | 'added' | 'removed' | 'hunk' | 'meta'; text: string; oldLine: number | null; newLine: number | null; shortened: boolean; }
export interface PatchFile {
  id: string; path: string; previousPath: string | null;
  change: 'Modified' | 'Added' | 'Deleted' | 'Renamed' | 'Copied' | 'Binary';
  lines: PatchLine[]; additions: number; deletions: number; malformed: boolean;
}
export interface PatchPreview { files: PatchFile[]; truncated: boolean; unrecognized: boolean; }
type Hunk = { old: number; next: number; oldRemaining: number; newRemaining: number };

/** Git quotes unusual path bytes with C escapes, including octal UTF-8 sequences. */
function pathText(input: string): string | null {
  if (!input.startsWith('"')) return input;
  if (!/^"(?:\\(?:[abtnvfr"\\]|[0-7]{1,3})|[^"\\\r\n])*"$/.test(input)) return null;
  const bytes: number[] = [], encoder = new TextEncoder();
  const escapes: Record<string, number> = { a: 7, b: 8, t: 9, n: 10, v: 11, f: 12, r: 13, '"': 34, '\\': 92 };
  for (let index = 1; index < input.length - 1;) {
    const character = input[index++];
    if (character !== '\\') {
      const point = input.codePointAt(index - 1)!;
      bytes.push(...encoder.encode(String.fromCodePoint(point)));
      if (point > 0xffff) index++;
      continue;
    }
    const escaped = input[index++];
    if (escaped === undefined) return null;
    if (/[0-7]/.test(escaped)) {
      let octal = escaped;
      while (octal.length < 3 && index < input.length - 1 && /[0-7]/.test(input[index])) octal += input[index++];
      const value = parseInt(octal, 8); if (value > 255) return null; bytes.push(value);
    } else if (escapes[escaped] !== undefined) bytes.push(escapes[escaped]);
    else return null;
  }
  try { return new TextDecoder('utf-8', { fatal: true }).decode(new Uint8Array(bytes)); } catch { return null; }
}
function filePath(input: string): string | null {
  const value = pathText(input.startsWith('"') ? input : input.split('\t', 1)[0]);
  if (value === null || value === '/dev/null') return value;
  return value.replace(/^[ab]\//, '');
}
function headerPaths(line: string): { before: string; after: string } | null {
  const matched = /^diff --git ("(?:\\.|[^"\\])*"|\S+) ("(?:\\.|[^"\\])*"|\S+)$/.exec(line);
  if (!matched) return null;
  const before = filePath(matched[1]), after = filePath(matched[2]);
  return before !== null && after !== null ? { before, after } : null;
}
function hunkHeader(line: string): Hunk | null {
  const matched = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@(?:.*)$/.exec(line);
  if (!matched) return null;
  const [old, oldRemaining, next, newRemaining] = [matched[1], matched[2] ?? '1', matched[3], matched[4] ?? '1'].map(Number);
  if (![old, oldRemaining, next, newRemaining].every(Number.isSafeInteger) || !Number.isSafeInteger(old + oldRemaining) || !Number.isSafeInteger(next + newRemaining)) return null;
  if (oldRemaining > 0 && old === 0 || newRemaining > 0 && next === 0) return null;
  return { old, next, oldRemaining, newRemaining };
}

/** Work and rendered text stay bounded even for a very large or malformed provider artifact. */
export function parsePatchPreview(patch: string): PatchPreview {
  const preview: PatchPreview = { files: [], truncated: false, unrecognized: false };
  const source = patch.slice(0, patchPreviewLimits.characters);
  let complete = source.length === patch.length;
  preview.truncated = !complete;
  if (!source.trim()) return preview;
  let position = 0, count = 0, file: PatchFile | undefined, hunk: Hunk | null = null;
  let previousMarker: string | undefined, waitingForAfter = false, recognized = false;
  const unfinished = () => !!hunk && (hunk.oldRemaining > 0 || hunk.newRemaining > 0);
  const finish = () => { if (file && (unfinished() || waitingForAfter)) file.malformed = true; hunk = null; };
  const start = () => {
    finish();
    if (preview.files.length >= patchPreviewLimits.files) { preview.truncated = true; complete = false; return false; }
    file = { id: 'patch-file-' + preview.files.length, path: 'Unidentified file ' + (preview.files.length + 1), previousPath: null, change: 'Modified', lines: [], additions: 0, deletions: 0, malformed: false };
    preview.files.push(file); previousMarker = undefined; waitingForAfter = false;
    return true;
  };
  const append = (line: string, kind: PatchLine['kind'] = 'meta', oldLine: number | null = null, newLine: number | null = null) => {
    const shortened = line.length > patchPreviewLimits.lineCharacters;
    if (shortened) preview.truncated = true;
    file!.lines.push({ kind, text: shortened ? line.slice(0, patchPreviewLimits.lineCharacters) : line, oldLine, newLine, shortened });
  };
  while (position < source.length) {
    if (position >= patchPreviewLimits.characters || count >= patchPreviewLimits.lines) { preview.truncated = true; complete = false; break; }
    const end = source.indexOf('\n', position), boundary = end < 0 ? source.length : end;
    let line = source.slice(position, boundary);
    if (line.endsWith('\r')) line = line.slice(0, -1);
    position = boundary + 1; count++;
    const partial = end < 0 && source.length < patch.length;
    if (partial) preview.truncated = true;
    if (line.startsWith('diff --git ') || line.startsWith('diff --cc ') || line.startsWith('diff --combined ')) {
      if (!recognized && file && preview.files.length === 1) { finish(); previousMarker = undefined; waitingForAfter = false; }
      else if (!start()) break;
      recognized = true;
      const paths = headerPaths(line);
      if (paths) { file!.path = paths.after; if (paths.before !== paths.after) file!.previousPath = paths.before; }
      if (!line.startsWith('diff --git ')) file!.malformed = true;
      append(line);
    } else {
      if (!file && !start()) break;
      // Inside a valid hunk, content like "--- filename" is removed text, never a new file header.
      const marker = line.startsWith('--- ') && !unfinished();
      if (marker && previousMarker !== undefined && !waitingForAfter) { if (!start()) break; }
      if (marker) {
        recognized = true; previousMarker = filePath(line.slice(4)) ?? undefined; waitingForAfter = true; append(line);
        if (previousMarker === undefined) file!.malformed = true;
      } else if (line.startsWith('+++ ') && waitingForAfter) {
        const next = filePath(line.slice(4)); waitingForAfter = false;
        if (next === null) file!.malformed = true;
        else {
          file!.path = next === '/dev/null' ? previousMarker ?? file!.path : next;
          if (previousMarker === '/dev/null') file!.change = 'Added';
          else if (next === '/dev/null') file!.change = 'Deleted';
          else if (previousMarker && previousMarker !== next) file!.previousPath = previousMarker;
        }
        append(line);
      } else if (line.startsWith('@@')) {
        finish(); hunk = hunkHeader(line);
        if (!hunk) file!.malformed = true;
        append(line, 'hunk');
      } else if (line === '\\ No newline at end of file') append(line);
      else if (hunk && !partial && ((line[0] === ' ' && hunk.oldRemaining > 0 && hunk.newRemaining > 0) || (line[0] === '+' && hunk.newRemaining > 0) || (line[0] === '-' && hunk.oldRemaining > 0))) {
        const kind = line[0] === '+' ? 'added' : line[0] === '-' ? 'removed' : 'context';
        const oldLine = kind === 'added' ? null : hunk.old++, newLine = kind === 'removed' ? null : hunk.next++;
        if (oldLine !== null) hunk.oldRemaining--; if (newLine !== null) hunk.newRemaining--;
        if (kind === 'added') file!.additions++; if (kind === 'removed') file!.deletions++;
        append(line.slice(1), kind, oldLine, newLine);
      } else {
        if (hunk && !unfinished() && /^[ +\-]/.test(line) && line !== '-- ') file!.malformed = true;
        if (unfinished()) { file!.malformed = true; hunk = null; }
        if (line.startsWith('new file mode ')) file!.change = 'Added';
        else if (line.startsWith('deleted file mode ')) file!.change = 'Deleted';
        else if (line.startsWith('rename from ') || line.startsWith('copy from ')) {
          file!.previousPath = pathText(line.slice(line.indexOf('from ') + 5)); file!.change = line.startsWith('rename ') ? 'Renamed' : 'Copied';
        } else if (line.startsWith('rename to ') || line.startsWith('copy to ')) {
          file!.path = pathText(line.slice(line.indexOf('to ') + 3)) ?? file!.path; file!.change = line.startsWith('rename ') ? 'Renamed' : 'Copied';
        } else if (line.startsWith('Binary files ') || line === 'GIT binary patch') file!.change = 'Binary';
        append(line);
      }
    }
    if (partial) break;
  }
  if (complete) finish();
  if (waitingForAfter && file) file.malformed = true;
  for (const entry of preview.files) {
    for (const field of ['path', 'previousPath'] as const) if (entry[field] && entry[field]!.length > patchPreviewLimits.lineCharacters) { entry[field] = entry[field]!.slice(0, patchPreviewLimits.lineCharacters) + '…'; preview.truncated = true; }
  }
  preview.unrecognized = !recognized;
  if (!recognized && file) { file.path = 'Saved patch text'; file.malformed = true; }
  return preview;
}
