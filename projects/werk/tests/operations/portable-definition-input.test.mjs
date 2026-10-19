import test from 'node:test';
import assert from 'node:assert/strict';
import { definitionImportReference, definitionName } from '../../scripts/runtime/portable/definition-input.mjs';

test('definition import --ref sets the reference for YAML and JSON input and refuses a second reference', () => {
  const yamlBody = definitionName('definition import', { yaml: 'agents: {}' }, { name: 'Reviewer', ref: 'project-reviewer' }, true);
  assert.deepEqual(definitionImportReference('definition import', yamlBody, { ref: 'project-reviewer' }), { yaml: 'agents: {}', name: 'Reviewer', ref: 'project-reviewer' });
  assert.deepEqual(definitionImportReference('definition import', { name: 'Reviewer', yaml: 'agents: {}' }, {}), { name: 'Reviewer', yaml: 'agents: {}' });
  assert.throws(() => definitionImportReference('definition import', { ref: 'other', yaml: 'agents: {}' }, { ref: 'project-reviewer' }), error => error instanceof Error && /Reference given twice: --ref and "ref"/.test(error.message) && /** @type {{ exitCode?: number }} */ (error).exitCode === 2);
  const update = { yaml: 'agents: {}' };
  assert.equal(definitionImportReference('definition update', update, { ref: 'project-reviewer' }), update, 'update takes its target reference from the command');
});
