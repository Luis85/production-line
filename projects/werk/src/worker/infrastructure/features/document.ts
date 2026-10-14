import { parseDocument, isAlias, isMap, isSeq, visit, type Document } from 'yaml';
import { createHash } from 'node:crypto';
import type { FeatureInput } from '../../application/feature-requests.js';

export const featureTemplate = `---
schemaVersion: 1
title: Describe the feature
status: draft
mode: chat
# Optional provider override; otherwise use the configured feature provider.
# provider: codex-cli
# For a review patch, set mode: patch and list approved project-relative files.
# paths:
#   - src/example.ts
# Optional: definitionId, agent, useInstructionsOnly
---
# Goal

Describe the problem and the desired result.

## Acceptance criteria

- [ ] Describe an observable result.

## Context

Add constraints and relevant project details. Chat does not read project files.
For patch mode, only the files listed in paths are supplied to the model.

## Ready to queue

Copy this template into the feature folder as a new .md file, finish the request,
and change status to ready. The worker fills in the ID and lifecycle metadata.
`;
export const featureId = /^[a-z0-9][a-z0-9-]{0,79}$/;
export const requestName = (name: string) => !name.startsWith('_') && /^[^/\\\x00-\x1f]{1,196}\.md$/i.test(name);
export const digest = (value: string) => createHash('sha256').update(value).digest('hex');
export interface FeatureDocument { document: Document; body: string; raw: string; data: Record<string, unknown>; }
export function parseFeature(raw: string): FeatureDocument {
  if (Buffer.byteLength(raw) > 65536) throw Error('Feature request exceeds 64 KiB.');
  const match = /^(?:\uFEFF)?---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(raw);
  if (!match) throw Error('Use YAML frontmatter between --- lines, followed by Markdown.');
  const document = parseDocument(match[1], { strict: true, uniqueKeys: true, customTags: [] });
  if (document.errors.length || document.warnings.length || !isMap(document.contents)) throw Error('Frontmatter must be a valid YAML mapping with unique keys.');
  let nodes = 0;
  visit(document, (_key, node, path) => {
    if (++nodes > 500 || path.length > 12 || isAlias(node) || (node as { tag?: string })?.tag) throw Error('Frontmatter aliases, tags or excessive nesting are not supported.');
    if (isMap(node)) for (const pair of node.items) if (typeof (pair.key as { value?: unknown })?.value !== 'string' || ['__proto__', 'prototype', 'constructor'].includes(String(pair.key))) throw Error('Frontmatter keys must be safe strings.');
    if (isSeq(node) && node.items.length > 100) throw Error('Frontmatter list is too large.');
  });
  const data = document.toJS({ maxAliasCount: 0 }) as Record<string, unknown>;
  if (data.schemaVersion !== 1) throw Error('Set schemaVersion: 1.');
  if (data.id !== undefined && (typeof data.id !== 'string' || !featureId.test(data.id))) throw Error('Feature id must use 1–80 lowercase letters, digits or hyphens.');
  if (data.source !== 'orchestrator' && typeof data.id === 'string' && data.id.startsWith('remote-')) throw Error('The remote- ID prefix is reserved for orchestrator assignments.');
  return { document, raw, data, body: raw.slice(match[0].length) };
}
export function featureInput(parsed: FeatureDocument, defaultProvider: string): FeatureInput {
  const d = parsed.data, title = d.title, mode = d.mode ?? 'chat', provider = d.provider ?? defaultProvider;
  if (typeof title !== 'string' || !title.trim() || title.length > 120) throw Error('title must contain 1–120 characters.');
  if (!parsed.body.trim() || parsed.body.length > 8000) throw Error('Request Markdown must contain 1–8,000 characters.');
  if (!['chat', 'patch'].includes(String(mode))) throw Error('mode must be chat or patch.');
  if (!['codex-cli', 'claude-cli', 'openai-api', 'anthropic-api'].includes(String(provider))) throw Error('Choose a supported provider connection.');
  if (d.paths !== undefined && (!Array.isArray(d.paths) || d.paths.some(path => typeof path !== 'string' || !path || path.length > 1024) || d.paths.length > 32)) throw Error('paths must list at most 32 project-relative files.');
  if (mode === 'patch' && (!Array.isArray(d.paths) || !d.paths.length)) throw Error('Patch requests require an explicit paths list.');
  if (mode === 'chat' && d.paths !== undefined) throw Error('Use mode: patch to supply approved files. Chat does not read paths.');
  if (d.definitionId !== undefined && (typeof d.definitionId !== 'string' || d.definitionId.length > 100)) throw Error('Invalid definitionId.');
  if (d.agent !== undefined && (typeof d.agent !== 'string' || d.agent.length > 100)) throw Error('Invalid agent name.');
  if (d.useInstructionsOnly !== undefined && typeof d.useInstructionsOnly !== 'boolean') throw Error('useInstructionsOnly must be true or false.');
  if (d.priority !== undefined && d.priority !== 1 && d.priority !== 2) throw Error('priority must be 1 or 2.');
  return { title: title.trim(), mode: mode as 'chat' | 'patch', provider: String(provider), message: parsed.body.trim(), ...(d.paths ? { paths: d.paths as string[] } : {}), priority: Number(d.priority ?? 1), ...(d.definitionId ? { definitionId: String(d.definitionId) } : {}), ...(d.agent ? { agent: String(d.agent) } : {}), ...(d.useInstructionsOnly !== undefined ? { useInstructionsOnly: d.useInstructionsOnly } : {}) };
}
export function renderFeature(parsed: FeatureDocument, id: string, status: string, metadata: Record<string, unknown>) {
  parsed.document.set('id', id); parsed.document.set('status', status); parsed.document.set('werk', metadata);
  const newline = parsed.raw.includes('\r\n') ? '\r\n' : '\n';
  return '---' + newline + parsed.document.toString({ lineWidth: 0 }).replace(/\r?\n/g, newline) + '---' + newline + parsed.body;
}
