import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, realpath, rename, rm, writeFile } from 'node:fs/promises';
import { basename, dirname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createArchives } from './archives.mjs';
import { isMainScript } from './verify.mjs';
import { readQualifiedStorybook } from './storybook-qualification.mjs';
import { checkReadme, readReadmeManifest, renderReadme } from '../storybook/readme-source.mjs';

const root = fileURLToPath(new URL('../../', import.meta.url));
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const imageRoot = 'docs/evidence/readme/';
const pngHeader = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

async function readmeReleaseEntries(projectRoot = root) {
  await checkReadme(projectRoot);
  const { version, commit, sourceDigest, entries, qualification } = await readQualifiedStorybook(projectRoot);
  if (execFileSync('git', ['status', '--porcelain', '--untracked-files=normal', '--', '.'], { cwd: projectRoot, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim()) throw Error('README artifacts require a clean source checkout. Commit the intended source before qualification; ignored build outputs are allowed.');
  const files = new Map(entries.map(entry => [entry.path, entry.content]));
  const manifest = JSON.parse(files.get('storymap/manifest.json').toString('utf8'));
  if (manifest.schemaVersion !== 1 || manifest.version !== version || manifest.commit !== commit || manifest.sourceDigest !== sourceDigest
    || !Array.isArray(manifest.stories) || manifest.stories.length !== qualification.screenshots
    || typeof manifest.capturedAt !== 'string' || !Number.isFinite(Date.parse(manifest.capturedAt))) throw Error('README screenshot manifest identity is inconsistent');
  const selection = await readReadmeManifest(projectRoot);
  const screenshots = [], output = [];
  for (const image of selection.screenshots) {
    const matches = manifest.stories.filter(story => story.id === image.story && story.viewport === image.viewport);
    if (matches.length !== 1) throw Error(`README screenshot must have one qualified capture: ${image.story} (${image.viewport})`);
    const record = matches[0];
    if (record.screenshot !== `screenshots/${image.story}-${image.viewport}.png` || record.horizontalOverflow !== false) throw Error(`Invalid README capture record: ${image.story}`);
    const bytes = files.get('storymap/' + record.screenshot);
    if (!bytes || bytes.length < 24 || !bytes.subarray(0, 8).equals(pngHeader) || bytes.toString('ascii', 12, 16) !== 'IHDR') throw Error(`README screenshot is not a qualified PNG: ${image.story}`);
    const width = bytes.readUInt32BE(16), height = bytes.readUInt32BE(20);
    if (!Number.isSafeInteger(record.width) || !Number.isSafeInteger(record.height) || record.width <= 0 || record.height <= 0
      || width !== record.width || height < record.height) throw Error(`README screenshot dimensions differ from capture: ${image.story}`);
    screenshots.push({ ...image, path: imageRoot + image.file, width, height, sha256: hash(bytes), capture: 'storymap/' + record.screenshot });
    output.push({ path: imageRoot + image.file, content: bytes, mode: 0o644 });
  }
  const provenance = {
    schemaVersion: 1, version, commit, sourceDigest, capturedAt: manifest.capturedAt, fixtureTime: manifest.fixtureTime,
    sampleData: true, qualification: 'Every Storybook story and desktop/mobile handbook passed before selection.',
    source: selection.source, screenshots,
  };
  const evidence = `# README screenshots\n\nGenerated from the qualified real Vue components for Werk ${version}, commit \`${commit}\`.\nCapture: ${manifest.capturedAt}. Fixture clock: ${manifest.fixtureTime ?? 'not recorded'}.\n\nThese browser captures use deterministic **sample data**. They do not establish\nlive model execution, real account usage, Git publication or human acceptance.\nNo screenshot has been retouched; these are the exact qualified PNG bytes.\n\n| Image | Story | Viewport | Image size |\n| --- | --- | --- | --- |\n${screenshots.map(image => `| [${image.alt}](${image.file}) | \`${image.story}\` | ${image.viewport} | ${image.width} × ${image.height} |`).join('\n')}\n\n[Machine-readable provenance](provenance.json) records source identity and every image hash.\nSource digest: \`${sourceDigest}\`.\n\nRefresh instructions are maintained in [README generation](https://github.com/Luis85/production-line/blob/${commit}/projects/werk/docs/how-to/generate-readme.md).\nRelease generation writes separate artifacts and never commits changes to the source branch.\n`;
  output.push({ path: imageRoot + 'README.md', content: Buffer.from(evidence), mode: 0o644 });
  output.push({ path: imageRoot + 'provenance.json', content: Buffer.from(JSON.stringify(provenance, null, 2) + '\n'), mode: 0o644 });
  output.push({ path: 'README.md', content: Buffer.from(await renderReadme(projectRoot, { commit })), mode: 0o644 });
  return { version, commit, sourceDigest, screenshots: screenshots.length, entries: output };
}

export async function packageReadme(projectRoot = root, output = join(projectRoot, 'release')) {
  const { entries, ...identity } = await readmeReleaseEntries(projectRoot);
  const name = `werk-readme-${identity.version}.zip`;
  const archive = await createArchives(entries.map(entry => ({ ...entry, path: `werk-readme-${identity.version}/${entry.path}` })));
  await mkdir(output, { recursive: true });
  const staging = await mkdtemp(join(dirname(output), `.${basename(output)}-readme-`));
  try {
    await writeFile(join(staging, name), archive.zip);
    await writeFile(join(staging, 'README-SHA256SUMS'), `${hash(archive.zip)}  ${name}\n`);
    for (const file of [name, 'README-SHA256SUMS']) await rename(join(staging, file), join(output, file));
  } finally { await rm(staging, { recursive: true, force: true }); }
  return { ...identity, artifact: name, sha256: hash(archive.zip) };
}

async function resolvedDestination(path) {
  const missing = []; let ancestor = path;
  for (;;) {
    try { return resolve(await realpath(ancestor), ...missing); }
    catch (error) {
      if (error.code !== 'ENOENT' || dirname(ancestor) === ancestor) throw error;
      missing.unshift(basename(ancestor)); ancestor = dirname(ancestor);
    }
  }
}
function assertScratchDestination(output, project) {
  if (output === project || output.startsWith(project + sep) && !['work', 'release'].some(name => output.startsWith(join(project, name) + sep))) throw Error('Export README into a new scratch directory under work/release or outside the project; tracked files are never overwritten.');
}

export async function exportReadme(projectRoot, destination) {
  const output = resolve(destination), project = resolve(projectRoot);
  assertScratchDestination(output, project);
  assertScratchDestination(await resolvedDestination(output), await realpath(project));
  const { entries, ...identity } = await readmeReleaseEntries(projectRoot);
  // Refuse existing exports. Review and adopt selected files explicitly; never remove unrelated work.
  await mkdir(dirname(output), { recursive: true });
  await mkdir(output);
  for (const entry of entries) {
    await mkdir(dirname(join(output, entry.path)), { recursive: true });
    await writeFile(join(output, entry.path), entry.content, { flag: 'wx' });
  }
  return { ...identity, output };
}

if (isMainScript(import.meta.url)) {
  try {
    const args = process.argv.slice(2);
    if (args.length && (args.length !== 2 || args[0] !== '--export')) throw Error('Usage: node scripts/release/readme-package.mjs [--export NEW_SCRATCH_DIRECTORY]');
    console.log(JSON.stringify(args.length ? await exportReadme(root, args[1]) : await packageReadme(), null, 2));
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
