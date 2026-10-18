import { createHash } from 'node:crypto';
import { mkdir, rename, rm, writeFile } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createArchives } from './archives.mjs';
import { isMainScript } from './verify.mjs';
import { readQualifiedStorybook } from './storybook-qualification.mjs';

const root = fileURLToPath(new URL('../../', import.meta.url));
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');

export async function packageStorybook(projectRoot = root, output = join(projectRoot, 'release')) {
  const { version, commit, entries, qualification } = await readQualifiedStorybook(projectRoot);
  const prefix = `werk-storybook-${version}`;
  const archive = await createArchives(entries.map(entry => ({ ...entry, path: `${prefix}/${entry.path}` })));
  const name = `${prefix}.zip`;
  const checksum = sha256(archive.zip);
  const staging = join(dirname(output), `.${basename(output)}-storybook-${process.pid}-${Date.now()}`);
  await mkdir(staging, { recursive: true });
  try {
    await writeFile(join(staging, name), archive.zip);
    await writeFile(join(staging, 'STORYBOOK-SHA256SUMS'), `${checksum}  ${name}\n`);
    await mkdir(output, { recursive: true });
    for (const asset of [name, 'STORYBOOK-SHA256SUMS']) await rename(join(staging, asset), join(output, asset));
  } finally { await rm(staging, { recursive: true, force: true }); }
  return { version, commit, output, files: entries.length, stories: qualification.stories, screenshots: qualification.screenshots, artifact: { name, bytes: archive.zip.length, sha256: checksum } };
}

if (isMainScript(import.meta.url)) {
  try {
    if (process.argv.length > 2) throw Error('Usage: node scripts/release/storybook-package.mjs');
    console.log(JSON.stringify(await packageStorybook(), null, 2));
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
