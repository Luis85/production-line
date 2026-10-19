import { ValidationError } from '../../shared/errors.js';

/** Letters, digits and marks in any script plus punctuation that is portable across Git, Linux and Windows file names. */
const allowedCharacters = /^[\p{L}\p{M}\p{N} _.,/()&'’+\-–—→]+$/u;
/** Windows maps these names to devices with any extension, including superscript-digit COM and LPT ports. */
const windowsDevice = /^(?:con|prn|aux|nul|com[1-9¹²³]|lpt[1-9¹²³])$/iu;
const secretName = /(?:^|\/)(?:credentials?|secrets?|id_rsa|id_ed25519)(?:[./]|$)/iu;
const keyExtension = /\.(?:pem|key|p12|pfx)$/iu;
export const maxApprovedPathLength = 240;
const maxSegmentBytes = 255;
const utf8 = new TextEncoder();

function unsafeSegment(part: string): boolean {
  if (!part || part === '.' || part === '..' || part.startsWith('.') || /[ .]$/.test(part) || utf8.encode(part).length > maxSegmentBytes) return true;
  return [part, part.normalize('NFKC')].some(name => windowsDevice.test(name.split('.')[0].trimEnd()));
}
/** Compatibility folding catches look-alike secret names such as full-width letters or a long s. */
const secret = (path: string) => [path, path.normalize('NFKC')].some(name => secretName.test(name) || keyExtension.test(name));
/** True when one NFC-normalized path satisfies the static approved-file rule. */
export function safeApprovedPath(path: string): boolean {
  return path.length <= maxApprovedPathLength && allowedCharacters.test(path) && !path.startsWith('-') && !path.split('/').some(unsafeSegment) && !secret(path);
}
/** Folder approvals end in one slash and name a safe folder below the repository root, never the root itself. */
export const approvedFolder = (path: string) => path.endsWith('/');
function safeApprovedFolder(path: string): boolean {
  return approvedFolder(path) && path.length <= maxApprovedPathLength && safeApprovedPath(path.slice(0, -1));
}
/** True when a worktree path is an exact approved file, or a safe path below an approved folder. */
export function approvedPathMatch(approved: readonly string[], path: string): boolean {
  return approved.includes(path) && !approvedFolder(path) || safeApprovedPath(path) && approved.some(entry => approvedFolder(entry) && path.startsWith(entry));
}

/** Files and their parent folders must retain one spelling across case-insensitive checkouts. Folder entries count as folders, never files. */
export function approvedPathsCollide(paths: readonly string[]): boolean {
  const key = (path: string) => path.normalize('NFC').toLowerCase();
  const names = paths.map(path => approvedFolder(path) ? path.slice(0, -1) : path);
  const files = new Set(paths.filter(path => !approvedFolder(path)).map(key)), prefixes = new Map<string, string>();
  if (new Set(names.map(key)).size !== paths.length) return true;
  for (const [position, path] of names.entries()) {
    const parts = path.split('/'), last = approvedFolder(paths[position]) ? parts.length + 1 : parts.length;
    for (let index = 1; index <= parts.length; index++) {
      const prefix = parts.slice(0, index).join('/'), folded = key(prefix);
      const previous = prefixes.get(folded);
      if (previous !== undefined && previous !== prefix || index < last && files.has(folded)) return true;
      prefixes.set(folded, prefix);
    }
  }
  return false;
}

export interface ApprovedPathOptions {
  /** Implementation requests may approve folder prefixes ending in `/`; proposal-only consumers keep exact files. */
  folders?: boolean;
}
/** Static approved-file rules shared by live execution and offline feature admission. Filesystem checks remain execution-owned. Returns NFC-normalized paths. */
export function validateApprovedPaths(value: unknown, label = 'Approved paths', options: ApprovedPathOptions = {}): string[] {
  const rule = options.folders ? 'safe relative non-secret file paths or folder paths ending in /' : 'safe relative non-secret file paths';
  if (!Array.isArray(value) || value.length < 1 || value.length > 32 || value.some(path => typeof path !== 'string')) throw new ValidationError(`${label} must contain 1–32 ${rule}`);
  const paths = (value as string[]).map(path => path.normalize('NFC'));
  if (paths.some(path => options.folders && approvedFolder(path) ? !safeApprovedFolder(path) : !safeApprovedPath(path))) throw new ValidationError(`${label} must contain 1–32 ${rule}`);
  if (new Set(paths).size !== paths.length) throw new ValidationError(label + ' must be unique');
  if (approvedPathsCollide(paths)) throw new ValidationError(label + ' must be unique without file or folder aliases, including on case-insensitive filesystems');
  return paths;
}
