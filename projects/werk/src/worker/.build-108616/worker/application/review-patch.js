/** Unified review diffs for approved file snapshots: minimal hunks with context that `git apply` accepts. */
                             
               
                  
                   
 

const CONTEXT_LINES = 3;

/** A line keeps its terminator, so a missing final newline is a real difference. */
function splitLines(value        ) {
  const lines           = [];
  let start = 0;
  while (start < value.length) {
    const end = value.indexOf("\n", start);
    if (end === -1) {
      lines.push(value.slice(start));
      break;
    }
    lines.push(value.slice(start, end + 1));
    start = end + 1;
  }
  return lines;
}

                                                    

/** Beyond this many changed lines a file is effectively rewritten; replacing it keeps memory bounded. */
const MAX_EDIT_DISTANCE = 2000;

/** Myers O(ND) shortest edit script over the lines between the common prefix and suffix. */
function middleEdits(before          , after          )         {
  const n = before.length, m = after.length, max = n + m;
  const replaced = ()         => [...before.map(line => ({ kind: "-"         , line })), ...after.map(line => ({ kind: "+"         , line }))];
  if (!n || !m) return replaced();
  const offset = max + 1;
  const frontier = new Int32Array(2 * max + 3);
  // trace[d] holds diagonals -d..d of the frontier before step d.
  const trace               = [];
  let found = -1;
  for (let distance = 0; distance <= Math.min(max, MAX_EDIT_DISTANCE) && found < 0; distance++) {
    trace.push(frontier.slice(offset - distance, offset + distance + 1));
    for (let diagonal = -distance; diagonal <= distance; diagonal += 2) {
      let x = diagonal === -distance || (diagonal !== distance && frontier[offset + diagonal - 1] < frontier[offset + diagonal + 1])
        ? frontier[offset + diagonal + 1]
        : frontier[offset + diagonal - 1] + 1;
      let y = x - diagonal;
      while (x < n && y < m && before[x] === after[y]) { x++; y++; }
      frontier[offset + diagonal] = x;
      if (x >= n && y >= m) { found = distance; break; }
    }
  }
  if (found < 0) return replaced();
  const edits         = [];
  let x = n, y = m;
  for (let distance = found; distance > 0; distance--) {
    const previous = trace[distance], at = (diagonal        ) => previous[diagonal + distance], diagonal = x - y;
    const down = diagonal === -distance || (diagonal !== distance && at(diagonal - 1) < at(diagonal + 1));
    const priorDiagonal = down ? diagonal + 1 : diagonal - 1;
    const priorX = at(priorDiagonal), priorY = priorX - priorDiagonal;
    while (x > priorX && y > priorY) { edits.push({ kind: " ", line: before[--x] }); y--; }
    if (down) edits.push({ kind: "+", line: after[--y] });
    else edits.push({ kind: "-", line: before[--x] });
  }
  while (x > 0 && y > 0) { edits.push({ kind: " ", line: before[--x] }); y--; }
  return edits.reverse();
}

function lineEdits(before          , after          )         {
  let prefix = 0;
  while (prefix < before.length && prefix < after.length && before[prefix] === after[prefix]) prefix++;
  let suffix = 0;
  while (suffix < before.length - prefix && suffix < after.length - prefix &&
    before[before.length - 1 - suffix] === after[after.length - 1 - suffix]) suffix++;
  return [
    ...before.slice(0, prefix).map(line => ({ kind: " "         , line })),
    ...middleEdits(before.slice(prefix, before.length - suffix), after.slice(prefix, after.length - suffix)),
    ...before.slice(before.length - suffix).map(line => ({ kind: " "         , line })),
  ];
}

const printed = (edit      ) => edit.kind + (edit.line.endsWith("\n") ? edit.line : edit.line + "\n\\ No newline at end of file\n");
/** Git omits a count of one and starts an empty range at the line before it. */
const range = (start        , count        ) => `${count ? start + 1 : start}${count === 1 ? "" : "," + count}`;

function hunks(edits        ) {
  const changed = edits.flatMap((edit, index) => edit.kind === " " ? [] : [index]);
  let output = "";
  for (let group = 0; group < changed.length;) {
    let last = group;
    // Hunks whose context would touch or overlap are merged, as Git does.
    while (last + 1 < changed.length && changed[last + 1] - changed[last] <= 2 * CONTEXT_LINES + 1) last++;
    const from = Math.max(0, changed[group] - CONTEXT_LINES), to = Math.min(edits.length, changed[last] + CONTEXT_LINES + 1);
    let oldStart = 0, newStart = 0;
    for (const edit of edits.slice(0, from)) {
      if (edit.kind !== "+") oldStart++;
      if (edit.kind !== "-") newStart++;
    }
    const body = edits.slice(from, to);
    const oldCount = body.filter(edit => edit.kind !== "+").length, newCount = body.filter(edit => edit.kind !== "-").length;
    output += `@@ -${range(oldStart, oldCount)} +${range(newStart, newCount)} @@\n${body.map(printed).join("")}`;
    group = last + 1;
  }
  return output;
}

/** Returns "" for an unchanged existing file. Paths are always quoted so non-ASCII names survive `git apply`. */
export function reviewFilePatch(file            , content        ) {
  if (file.existed && file.content === content) return "";
  const before = file.existed ? file.content : "";
  const header = `diff --git ${JSON.stringify("a/" + file.path)} ${JSON.stringify("b/" + file.path)}\n${file.existed ? "" : "new file mode 100644\n"}`;
  // An empty new file has no hunk; Git records it with the mode header alone.
  if (!file.existed && !content) return header;
  return `${header}--- ${file.existed ? JSON.stringify("a/" + file.path) : "/dev/null"}\n+++ ${JSON.stringify("b/" + file.path)}\n${hunks(lineEdits(splitLines(before), splitLines(content)))}`;
}
