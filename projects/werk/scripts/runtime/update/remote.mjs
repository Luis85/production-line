import { createHash } from 'node:crypto';

export const repository = 'Luis85/production-line';
const stable = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
export function versionParts(version) {
  if (typeof version !== 'string' || !stable.test(version)) throw Error('Updates require a stable semantic version.');
  return version.split('.').map(BigInt);
}
export function newer(candidate, current) {
  const left = versionParts(candidate), right = versionParts(current);
  for (let i = 0; i < 3; i++) if (left[i] !== right[i]) return left[i] > right[i];
  return false;
}
export async function download(url, { fetcher = fetch, limit = 16384, timeout = 15000 } = {}) {
  const response = await fetcher(url, { signal: AbortSignal.timeout(timeout) });
  if (!response.ok) throw Error(`GitHub release download failed (HTTP ${response.status}).`);
  let length = 0; const chunks = [];
  for await (const chunk of response.body) {
    length += chunk.length;
    if (length > limit) throw Error('GitHub release response exceeds its size limit.');
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}
function describe(bytes) {
  const entries = new Map();
  for (const line of bytes.toString('utf8').trimEnd().split('\n')) {
    const match = /^([a-f0-9]{64})  ([A-Za-z0-9.-]+)\r?$/.exec(line);
    if (!match || entries.has(match[2])) throw Error('Invalid or duplicate release checksum entry.');
    entries.set(match[2], match[1]);
  }
  const archive = [...entries.keys()].find(name => /^werk-\d+\.\d+\.\d+\.tar\.gz$/.test(name));
  if (!archive) throw Error('Latest release has no stable Werk runtime archive.');
  const version = archive.slice(5, -7); versionParts(version);
  if (entries.size !== 3 || !entries.has(`werk-${version}.zip`) || !entries.has('install.mjs')) throw Error('Release assets do not describe one complete stable version.');
  return { version, repository, sha256: entries.get(archive), url: `https://github.com/${repository}/releases/tag/v${version}` };
}
export async function latest(options = {}) {
  // Read a single stable-latest checksum document, then pin every asset by version.
  // No token, API quota or downloaded executable is needed for discovery.
  return describe(await download(`https://github.com/${repository}/releases/latest/download/SHA256SUMS`, options));
}
export async function published(version, options = {}) {
  // An explicitly requested stable version reads that tag's own checksum document.
  versionParts(version);
  const release = describe(await download(`https://github.com/${repository}/releases/download/v${version}/SHA256SUMS`, options));
  if (release.version !== version) throw Error('Release checksums describe a different version.');
  return release;
}
export const digest = value => createHash('sha256').update(value).digest('hex');
