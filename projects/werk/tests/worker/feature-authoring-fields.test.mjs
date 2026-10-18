import test from 'node:test';
import assert from 'node:assert/strict';
import { frontend } from '../ui/helpers/frontend-loader.mjs';
const { readFeatureDetails, writeFeatureDetail } = await frontend('src/worker/webview/feature-authoring-fields.ts');
const markdown = `---
schemaVersion: 1
id: stable-fr
templateId: project-v1
title: Export orders
paths: [src/export.ts]
risk: reviewed
---
# Goal

Export orders.

## Context

Existing order management.

## Acceptance criteria

- [ ] A CSV download is available.

## Verification plan

Run the export tests.

## Team review

Keep the finance review requirement.
`;
test('plain request details read the configured Markdown without exposing metadata as form content', () => {
  assert.deepEqual(readFeatureDetails(markdown), { fields: { goal: 'Export orders.', context: 'Existing order management.', 'acceptance criteria': 'A CSV download is available.', 'verification plan': 'Run the export tests.' }, title: 'Export orders', paths: 'src/export.ts' });
});
test('editing a standard field preserves canonical identity, custom fields and unrelated template sections', () => {
  const changed = writeFeatureDetail(markdown, 'context', 'Finance needs a monthly export.');
  assert.match(changed, /id: stable-fr/); assert.match(changed, /templateId: project-v1/); assert.match(changed, /risk: reviewed/);
  assert.match(changed, /## Team review\n\nKeep the finance review requirement/); assert.equal(readFeatureDetails(changed).fields.context, 'Finance needs a monthly export.');
});
test('acceptance lines become checklist entries and approved paths remain structured frontmatter', () => {
  const criteria = writeFeatureDetail(markdown, 'acceptance criteria', 'Dates use UTC.\nAmounts retain precision.');
  assert.match(criteria, /- \[ \] Dates use UTC\.\n- \[ \] Amounts retain precision\./);
  const paths = writeFeatureDetail(criteria, 'paths', 'src/export.ts\n tests/export.test.ts \n');
  assert.equal(readFeatureDetails(paths).paths, 'src/export.ts\ntests/export.test.ts'); assert.match(paths, /risk: reviewed/);
});
test('headings inside fenced examples and comments never replace a real request section', () => {
  const special = markdown.replace('Existing order management.', 'Existing order management.\n\n```md\n## Goal\nExample only\n```\n<!--\n## Goal\nComment only\n-->');
  const changed = writeFeatureDetail(special, 'goal', 'Export approved orders.');
  assert.equal(readFeatureDetails(changed).fields.goal, 'Export approved orders.'); assert.match(changed, /Example only/); assert.match(changed, /Comment only/);
});
test('missing or duplicate headings leave recovery to advanced editing rather than guessing a target', () => {
  assert.throws(() => writeFeatureDetail(markdown.replace('## Context', '## Background'), 'goal', 'Changed'), /exactly one context/);
  assert.throws(() => readFeatureDetails(markdown + '\n## Goal\nDuplicate'), /exactly one goal/);
});

test('template guidance comments stay in Markdown and do not appear in ordinary request fields', () => {
  const guided = markdown.replace('Existing order management.', '<!-- Add relevant context. -->').replace('- [ ] A CSV download is available.', '<!-- List observable outcomes. -->');
  const details = readFeatureDetails(guided);
  assert.equal(details.fields.context, ''); assert.equal(details.fields['acceptance criteria'], '');
  const changed = writeFeatureDetail(guided, 'goal', 'Export approved orders.');
  assert.match(changed, /<!-- Add relevant context. -->/); assert.match(changed, /<!-- List observable outcomes. -->/);
});
