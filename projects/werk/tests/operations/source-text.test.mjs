import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeSource } from '../helpers/source-text.mjs';
test('Vue fixture import extraction and execution are invariant under CRLF checkout', () => {
  const source = '<script setup lang="ts">\nimport { ref } from "vue";\nconst answer = 42;\n</script>';
  for (const input of [source, source.replace(/\n/g, '\r\n'), source.replace(/\n/g, '\r')]) {
    const script = normalizeSource(input).match(/<script[^>]*>([\s\S]*?)<\/script>/)[1].replace(/^import .*;\n/gm, '');
    assert.equal(new Function(script + '\nreturn answer;')(), 42);
  }
});
