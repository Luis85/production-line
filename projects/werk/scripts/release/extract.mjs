import { createHash } from 'node:crypto';
import { chmod, lstat, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { list, extract } from 'tar';
import { unzipSync } from 'fflate';
import { verifyRelease } from './verify.mjs';

// Maintainer acceptance harness: only extracts a checksum-verified release to a new directory.
export async function extractRelease(artifacts, destination, format = process.platform === 'win32' ? 'zip' : 'tar.gz') {
  if (!['zip', 'tar.gz'].includes(format)) throw Error('Unsupported release archive format');
  const sums = (await readFile(join(artifacts, 'SHA256SUMS'), 'utf8')).trim().split('\n');
  if (sums.length !== 2) throw Error('Expected checksums for exactly two release archives');
  const names = [];
  for (const line of sums) {
    const match = /^([a-f0-9]{64})  (werk-(\d+\.\d+\.\d+(?:-[a-zA-Z0-9.-]+)?)\.(tar\.gz|zip))$/.exec(line);
    if (!match || names.some(entry => entry.name === match[2])) throw Error('Invalid release checksum entry');
    const artifactPath = join(artifacts, match[2]);
    const info = await lstat(artifactPath);
    if (!info.isFile() || info.size > 300 * 1024 * 1024) throw Error('Release archive is nonregular or exceeds 300 MiB');
    const content = await readFile(artifactPath);
    if (createHash('sha256').update(content).digest('hex') !== match[1]) throw Error(`Archive checksum mismatch: ${match[2]}`);
    names.push({ name: match[2], version: match[3], format: match[4], content });
  }
  if (names[0].version !== names[1].version || new Set(names.map(entry => entry.format)).size !== 2) throw Error('Release archives must share a version');
  const selected = names.find(entry => entry.format === format);
  const prefix = `werk-${selected.version}`;
  const seen = new Set();
  let payloadBytes = 0;
  function checkPath(path, bytes) {
    payloadBytes += bytes;
    if (bytes > 32 * 1024 * 1024 || payloadBytes > 256 * 1024 * 1024 || seen.size >= 10001) throw Error('Release archive exceeds extraction bounds');
    if (!path.startsWith(prefix + '/') || /[:\\\x00-\x1f]/.test(path) || path.split('/').some(part => !part || part === '.' || part === '..') || seen.has(path)) throw Error(`Unsafe or duplicate archive entry: ${path}`);
    seen.add(path);
  }
  let zipFiles;
  if (format === 'zip') {
    zipFiles = unzipSync(selected.content, { filter(file) { checkPath(file.name, file.originalSize); return true; } });
  } else {
    await list({ file: join(artifacts, selected.name), onReadEntry(entry) {
      // PAX headers are handled by tar itself; payload entries must be regular files.
      checkPath(entry.path, entry.size);
      if (entry.type !== 'File') throw Error(`Unexpected archive entry type: ${entry.type}`);
    } });
  }
  await mkdir(dirname(destination), { recursive: true });
  await mkdir(destination); // Never merge an archive into existing state or a previous installation.
  try {
    if (zipFiles) {
      for (const [path, content] of Object.entries(zipFiles)) {
        const full = join(destination, path);
        await mkdir(dirname(full), { recursive: true });
        await writeFile(full, content, { flag: 'wx' });
      }
    } else await extract({ file: join(artifacts, selected.name), cwd: destination, chmod: true });
    const root = join(destination, prefix);
    const verified = await verifyRelease(root);
    if (verified.version !== selected.version) throw Error('Manifest version differs from archive name');
    if (zipFiles && process.platform !== 'win32') {
      const manifest = JSON.parse(await readFile(join(root, 'release-manifest.json'), 'utf8'));
      for (const file of manifest.files) await chmod(join(root, file.path), file.mode === '755' ? 0o755 : 0o644);
    }
    return { root, ...verified };
  } catch (error) { await rm(destination, { recursive: true, force: true }); throw error; }
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    if (process.argv.length !== 4) throw Error('Usage: node scripts/release/extract.mjs <artifact-directory> <new-destination>');
    console.log(JSON.stringify(await extractRelease(resolve(process.argv[2]), resolve(process.argv[3]))));
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
