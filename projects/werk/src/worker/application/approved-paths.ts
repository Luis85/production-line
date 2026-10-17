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

/** Static approved-file rules shared by live execution and offline feature admission. Filesystem checks remain execution-owned. Returns NFC-normalized paths. */
export function validateApprovedPaths(value: unknown, label = 'Approved paths'): string[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > 32 || value.some(path => typeof path !== 'string')) throw new ValidationError(label + ' must contain 1–32 safe relative non-secret file paths');
  const paths = (value as string[]).map(path => path.normalize('NFC'));
  if (paths.some(path => !safeApprovedPath(path))) throw new ValidationError(label + ' must contain 1–32 safe relative non-secret file paths');
  if (new Set(paths).size !== paths.length) throw new ValidationError(label + ' must be unique');
  return paths;
}
