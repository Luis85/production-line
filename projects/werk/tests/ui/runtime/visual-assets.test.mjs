import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import vm from 'node:vm';

// Release consumers receive composed pages, not the source HTML alone.
for(const app of ['factory','orchestrator'])for(const file of ['index.html','guide.html']){
  test(`${app}/${file} ships executable, self-contained spatial UI`,async()=>{
    const html=await readFile(new URL(`../../../src/${app}/dist/${app}/public/${file}`,import.meta.url),'utf8');
    const scripts=[...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map(match=>match[1]);
    assert.equal(scripts.length,2,'base UI plus composed visual adapter');
    new vm.Script(scripts.join('\n'));
    assert.match(html,/class SpatialMap/);
    assert.match(html,/\.spatial-layout/);
    assert.doesNotMatch(html,/<script[^>]+src=/,'no external runtime or CDN dependency');
  });
}
