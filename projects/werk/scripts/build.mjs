import { stripTypeScriptTypes } from 'node:module';
import { readdir, readFile, writeFile, mkdir, cp, chmod, rm, rename } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
const root = fileURLToPath(new URL('../', import.meta.url));
const args = process.argv.slice(2);
if (args.length > 1 || (args[0] && !['factory', 'orchestrator', 'worker'].includes(args[0]))) throw Error('Usage: node scripts/build.mjs [factory|orchestrator|worker]');
const apps = args.length ? args : ['factory', 'orchestrator', 'worker'];
const packageInfo = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
async function compile(source, destination) {
  await mkdir(destination, { recursive: true });
  for (const entry of await readdir(source, { withFileTypes: true })) {
    if (['dist', 'node_modules', 'public'].includes(entry.name) || entry.name.startsWith('.build-')) continue;
    if (entry.isDirectory()) await compile(join(source, entry.name), join(destination, entry.name));
    else if (entry.name.endsWith('.ts') && !entry.name.endsWith('.d.ts')) {
      const code = stripTypeScriptTypes(await readFile(join(source, entry.name), 'utf8'), { mode: 'strip' });
      await writeFile(join(destination, entry.name.replace(/\.ts$/, '.js')), code);
    }
  }
}
async function composeView(path, experience) {
  let html = await readFile(path, 'utf8');
  const css = await readFile(join(root, 'src/shared/ui/spatial.css'), 'utf8');
  const shared = await readFile(join(root, 'src/shared/ui/spatial.js'), 'utf8');
  const code = await readFile(join(root, experience), 'utf8');
  html = html.replace('</head>', '<style>' + css + '</style></head>')
    .replace('</body>', '<script>' + shared + '\n' + code + '</script></body>');
  await writeFile(path, html);
}
for (const app of apps) {
  const dest = join(root, 'src', app, 'dist');
  const staging = join(root, 'src', app, `.build-${process.pid}`);
  try {
    for (const module of [app, 'shared']) await compile(join(root, 'src', module), join(staging, module));
    await writeFile(join(staging, 'package.json'), JSON.stringify({name:`@werk/${app}`,version:packageInfo.version,private:true,type:'module',engines:packageInfo.engines,bin:{[`werk-${app}`]:`${app}/cli.js`}},null,2)+'\n');
    await chmod(join(staging, app, 'cli.js'), 0o755);
    if (['factory', 'orchestrator'].includes(app)) {
      await cp(join(root, 'src', app, 'public'), join(staging, app, 'public'), { recursive: true });
    }
    if (['factory', 'orchestrator'].includes(app)) {
      await cp(join(root, 'src/guide/public/index.html'), join(staging, app, 'public/guide.html'));
    }
    if (['factory', 'orchestrator'].includes(app)) {
      await composeView(join(staging, app, 'public/index.html'), `src/${app}/public/experience.js`);
      await composeView(join(staging, app, 'public/guide.html'), 'src/guide/public/experience.js');
    }
    if (app === 'orchestrator') {
      await mkdir(join(staging,'node_modules'),{recursive:true});
      await cp(join(root,'node_modules/yaml'),join(staging,'node_modules/yaml'),{recursive:true});
    }
    // Replace only this generated distribution, so removed source files cannot survive a rebuild.
    await rm(dest, { recursive: true, force: true });
    await rename(staging, dest);
    console.log(`Built independent application: src/${app}/dist`);
  } finally { await rm(staging, { recursive: true, force: true }); }
}
