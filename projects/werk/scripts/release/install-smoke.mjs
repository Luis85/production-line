// Exercise the exact standalone installer asset with candidate bytes over HTTP.
// Only the test transport is substituted; release selection and hashes stay pinned.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
const args = process.argv.slice(2);
if (args.length !== 2) throw Error('Usage: node scripts/release/install-smoke.mjs ARCHIVES DESTINATION');
const archives = resolve(args[0]), directory = resolve(args[1]);
const installerPath = join(archives, 'install.mjs');
const sums = await readFile(join(archives, 'SHA256SUMS'), 'utf8');
assert.ok(sums.includes(`${createHash('sha256').update(await readFile(installerPath)).digest('hex')}  install.mjs\n`));
assert.match(execFileSync(process.execPath, [installerPath, '--help'], { encoding: 'utf8' }), /Node 24/);
const { install, release } = await import(pathToFileURL(installerPath).href);
const archive = await readFile(join(archives, `werk-${release.version}.tar.gz`));
const server = createServer((_request, response) => response.end(archive));
await new Promise(ok => server.listen(0, '127.0.0.1', ok));
let requests = 0;
try {
  const root = await install(release, { directory }, {
    fetcher: (url, options) => {
      assert.equal(url, `https://github.com/${release.repository}/releases/download/v${release.version}/werk-${release.version}.tar.gz`);
      requests++;
      return fetch(`http://127.0.0.1:${server.address().port}`, options);
    },
  });
  assert.equal(requests, 1);
  assert.equal(root, release.layout === 'werk-home-v1' ? directory : join(directory, `werk-${release.version}`));
  await assert.rejects(install(release, { directory }), /Destination already exists/);
  console.log(JSON.stringify({ ok: true, root, checksumVerified: true, existingInstallationPreserved: true }));
} finally { server.closeAllConnections(); await new Promise(ok => server.close(ok)); }
