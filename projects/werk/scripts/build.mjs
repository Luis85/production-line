import { stripTypeScriptTypes } from 'node:module';
import { readdir, readFile, writeFile, mkdir, cp, chmod, rm, rename } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { buildWebview, buildStandaloneWebview } from './webviews.mjs';
import { buildInfoModule } from './build-info.mjs';
const root = fileURLToPath(new URL('../', import.meta.url));
const rawArgs = process.argv.slice(2);
const distOnly = rawArgs.includes('--dist-only');
const args = rawArgs.filter(value => value !== '--dist-only');
if (rawArgs.filter(value => value === '--dist-only').length > 1) throw Error('Duplicate --dist-only');
if (args.length > 1 || (args[0] && !['factory', 'orchestrator', 'worker'].includes(args[0]))) throw Error('Usage: node scripts/build.mjs [factory|orchestrator|worker] [--dist-only]');
const apps = args.length ? args : ['factory', 'orchestrator', 'worker'];
const packageInfo = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
async function compile(source, destination) {
  await mkdir(destination, { recursive: true });
  for (const entry of await readdir(source, { withFileTypes: true })) {
    if (['dist', 'node_modules', 'public', 'webview'].includes(entry.name) || entry.name.startsWith('.build-')) continue;
    if (entry.isDirectory()) await compile(join(source, entry.name), join(destination, entry.name));
    else if (entry.name.endsWith('.ts') && !entry.name.endsWith('.d.ts')) {
      const code = stripTypeScriptTypes(await readFile(join(source, entry.name), 'utf8'), { mode: 'strip' });
      await writeFile(join(destination, entry.name.replace(/\.ts$/, '.js')), code);
    }
  }
}
for (const app of apps) {
  const dest = join(root, 'src', app, 'dist');
  const staging = join(root, 'src', app, `.build-${process.pid}`);
  try {
    for (const module of [app, 'shared']) await compile(join(root, 'src', module), join(staging, module));
    await writeFile(join(staging, 'shared', 'build-info.js'), buildInfoModule(packageInfo));
    await writeFile(join(staging, 'package.json'), JSON.stringify({name:`@werk/${app}`,version:packageInfo.version,private:true,type:'module',engines:packageInfo.engines,bin:{[`werk-${app}`]:`${app}/cli.js`}},null,2)+'\n');
    await chmod(join(staging, app, 'cli.js'), 0o755);
    const publicDirectory = join(staging, app, 'public');
    await buildWebview(root, 'src/' + app + '/webview', publicDirectory);
    if (['factory', 'orchestrator'].includes(app)) {
      await buildStandaloneWebview(root, 'src/guide/webview', join(publicDirectory, 'guide.html'), join(staging, '.guide-view'));
    }
    if (app === 'orchestrator') await buildStandaloneWebview(root, 'src/orchestrator/webview/concept', join(publicDirectory, 'concept.html'), join(staging, '.concept-view'));
    if (app === 'worker') await buildStandaloneWebview(root, 'src/worker/webview/status', join(publicDirectory, 'status.html'), join(staging, '.status-view'));
    if (['orchestrator', 'worker'].includes(app)) {
      await mkdir(join(staging,'node_modules'),{recursive:true});
      await cp(join(root,'node_modules/yaml'),join(staging,'node_modules/yaml'),{recursive:true});
    }
    // The shared HTTP client owns a bounded dispatcher in every portable app.
    await mkdir(join(staging, 'node_modules'), { recursive: true });
    await cp(join(root, 'node_modules/undici'), join(staging, 'node_modules/undici'), { recursive: true });
    if (app === 'worker') {
      // Transcript projection shares the browser's Markdown lexer at runtime.
      await cp(join(root, 'node_modules/marked'), join(staging, 'node_modules/marked'), { recursive: true });
      const { buildFeatureAuthoring } = await import('./release/feature-authoring.mjs');
      await buildFeatureAuthoring(root, staging);
    }
    // Replace only this generated distribution, so removed source files cannot survive a rebuild.
    await rm(dest, { recursive: true, force: true });
    await rename(staging, dest);
    console.log(`Built independent application: src/${app}/dist`);
    if (!distOnly) { const { packageApp } = await import('./release/apps.mjs'); await packageApp(root, app); }
  } finally { await rm(staging, { recursive: true, force: true }); }
}
