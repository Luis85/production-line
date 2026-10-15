import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { componentContract, routeContract, sourceDigest } from '../../scripts/storybook/source.mjs';

test('source inventory extracts actual imported components and typed props/events', () => {
  const contract = componentContract(`<script setup lang="ts">\nimport Card from './Card.vue';\nconst props=defineProps<{title:string; count?:number}>();\nconst emit=defineEmits<{submit:[id:string]}>();\n</script><template><Card :title="props.title"/></template>`, 'src/worker/webview/components/Panel.vue');
  assert.deepEqual(contract.imports, ['src/worker/webview/components/Card.vue']);
  assert.match(contract.props[0], /title:string/);
  assert.match(contract.events[0], /submit/);
  assert.equal(contract.app, 'Worker');
});
test('digest detects source, fixture and configuration drift while ignoring build output', async () => {
  const root = await mkdtemp(join(tmpdir(), 'werk-storymap-'));
  try {
    for (const dir of ['src', '.storybook', 'storybook', 'scripts/storybook']) await mkdir(join(root, dir), { recursive: true });
    for (const path of ['package.json', 'package-lock.json', 'src/App.vue', 'storybook/app.stories.ts']) await writeFile(join(root, path), '{}');
    const initial = await sourceDigest(root);
    await mkdir(join(root, 'src/worker/dist'), { recursive: true });
    await writeFile(join(root, 'src/worker/dist/app.js'), 'generated');
    await mkdir(join(root, 'src/worker/.build-12345/worker/public'), { recursive: true });
    await writeFile(join(root, 'src/worker/.build-12345/worker/public/index.html'), 'concurrent runtime staging');
    assert.equal(await sourceDigest(root), initial);
    await writeFile(join(root, 'storybook/app.stories.ts'), 'changed fixture');
    assert.notEqual(await sourceDigest(root), initial);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('model macros expose named and default props with their update events', () => {
  const contract = componentContract(`<script setup lang="ts">
const open=defineModel<boolean>('open', {default:false});
const value=defineModel<string>({required:true});
</script><template><div>{{open}} {{value}}</div></template>`, 'src/shared/webview/components/Example.vue');
  assert.ok(contract.props.includes('{ "open"?: boolean }'));
  assert.ok(contract.props.includes('{ "modelValue": string }'));
  assert.ok(contract.events.includes('{ "update:open": [value: boolean] }'));
  assert.ok(contract.events.includes('{ "update:modelValue": [value: string] }'));
});

test('route inventory ignores redirect targets and unrelated path objects', () => {
  const routes = routeContract(`import {createRouter as makeRouter} from 'vue-router';
const unrelated={path:'/not-a-route'};
makeRouter({routes:[
  {path:'/taskboard',component:Board},
  {path:'/chat',redirect:to=>({path:'/taskboard',query:to.query})},
  {path:'/workspace',children:[{path:'tasks',component:Tasks},{path:'/absolute',component:Page}]}
]});`, 'src/worker/webview/main.ts');
  assert.deepEqual(routes.map(route => route.path), ['/taskboard', '/chat', '/workspace', '/workspace/tasks', '/absolute']);
  assert.match(routes[1].redirect, /path:'\/taskboard'/);
  assert.ok(routes.every(route => route.app === 'worker'));
});

test('unsupported computed router declarations fail instead of silently losing routes', () => {
  assert.throws(() => routeContract('createRouter({routes: dynamicRoutes})', 'src/worker/webview/main.ts'), /array literal/);
  assert.throws(() => routeContract('createRouter({routes: [{path: dynamicPath}]})', 'src/worker/webview/main.ts'), /string literal/);
});
