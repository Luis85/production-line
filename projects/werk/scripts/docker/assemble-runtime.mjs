/** Offline build adapter: retain Git and its runtime libraries without the donor toolchain. */
import { execFileSync } from 'node:child_process';
import { readdirSync, statSync, readFileSync, mkdirSync, copyFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
const donor = '/git-donor';
const run = (program, args, options = {}) => execFileSync(program, args, { encoding: 'utf8', timeout: 10000, maxBuffer: 1024 * 1024, ...options });
if (process.versions.node !== '24.19.0') throw Error('Release runtime requires pinned Node.js 24.19.0');
for (const path of ['/usr/lib/git-core', '/usr/share/git-core', '/usr/share/ca-certificates', '/etc/ssl/certs']) {
  mkdirSync(dirname(path), { recursive: true });
  run('cp', ['-a', donor + path, dirname(path)]);
}
copyFileSync(donor + '/usr/bin/git', '/usr/bin/git');
const libraryDirectories = ['/lib', '/usr/lib'].flatMap(path => readdirSync(donor + path, { withFileTypes: true }).filter(entry => entry.name.endsWith('-linux-gnu')).map(entry => donor + path + '/' + entry.name));
const env = { ...process.env, LD_LIBRARY_PATH: libraryDirectories.join(':') };
const seen = new Set(), libraries = new Set();
const candidates = ['/usr/bin/git', ...readdirSync(donor + '/usr/lib/git-core').map(name => '/usr/lib/git-core/' + name)];
if (candidates.length > 512) throw Error('Unexpected Git runtime inventory');
for (const path of candidates) {
  const info = statSync(donor + path); if (!info.isFile() || seen.has(info.ino)) continue; seen.add(info.ino);
  if (readFileSync(donor + path).subarray(0, 4).toString('hex') !== '7f454c46') continue;
  const output = run('/usr/bin/ldd', [donor + path], { env });
  if (output.includes('not found')) throw Error('Git runtime dependency could not be resolved');
  for (const match of output.matchAll(/(?:=>\s*)?(\/[^\s()]+)\s+\(/g)) {
    if (match[1].startsWith(donor + '/')) libraries.add(match[1].slice(donor.length));
  }
}
let bytes = 0;
for (const path of libraries) {
  if (!/^\/(?:usr\/)?lib\//.test(path) || libraries.size > 128) throw Error('Unexpected Git library path');
  bytes += statSync(donor + path).size; if (bytes > 128 * 1024 * 1024) throw Error('Git runtime libraries exceed their budget');
  mkdirSync(dirname(path), { recursive: true });
  if (!existsSync(path)) copyFileSync(donor + path, path);
}
// Preserve distribution copyright/license notices for Git and copied system libraries.
for (const entry of readdirSync(donor + '/usr/share/doc', { withFileTypes: true })) {
  const copyright = join(donor, '/usr/share/doc', entry.name, 'copyright');
  if (!existsSync(copyright) || !statSync(copyright).isFile()) continue;
  const target = join('/usr/share/doc', entry.name); mkdirSync(target, { recursive: true }); copyFileSync(copyright, join(target, 'copyright'));
}
run('/usr/bin/git', ['--version']);
for (const command of ['git-remote-https', 'git-upload-pack', 'git-receive-pack']) {
  if (!existsSync('/usr/lib/git-core/' + command)) throw Error('Missing Git helper');
  const output = run('/usr/bin/ldd', ['/usr/lib/git-core/' + command]);
  if (output.includes('not found')) throw Error('Incomplete Git helper libraries');
}
console.log(JSON.stringify({ assembled: 'git', sharedLibraries: libraries.size, libraryBytes: bytes, node: process.versions.node }));
