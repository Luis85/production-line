import { providerIds, type ProviderId } from '../application/provider-contract';
import { parseModelEffort, providerEfforts, type ModelEffort } from '../application/model-effort';
import { isMap, parseDocument } from 'yaml';
export const featureDetailFields = [
  { key: 'goal', label: 'Goal', hint: 'Describe the outcome you want.', rows: 4 },
  { key: 'context', label: 'Context', hint: 'Explain the problem, constraints and relevant project details.', rows: 4 },
  { key: 'acceptance criteria', label: 'Acceptance criteria', hint: 'One observable result per line.', rows: 4 },
  { key: 'verification plan', label: 'Verification plan', hint: 'Explain how the implementation should be checked.', rows: 3 },
] as const;
export type FeatureModelField = 'provider' | 'model' | 'effort' | 'execution_profile' | 'quality_profile' | 'priority' | 'depends_on';
export type FeatureDetailField = typeof featureDetailFields[number]['key'];
interface Section { name: string; start: number; end: number; }
function document(markdown: string) {
  const match = /^(?:\uFEFF)?---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(markdown);
  if (!match) throw Error('Open Advanced template editing to restore the request frontmatter.');
  const metadata = parseDocument(match[1], { strict: true, uniqueKeys: true });
  if (metadata.errors.length || metadata.warnings.length || !isMap(metadata.contents)) throw Error('Correct the frontmatter in Advanced template editing.');
  const body = markdown.slice(match[0].length), lines = body.split(/\r?\n/), sections: Section[] = [];
  let fence: { marker: string; length: number } | undefined, comment = false;
  lines.forEach((line, index) => {
    let visible = '', cursor = 0;
    while (cursor < line.length) {
      if (comment) { const end = line.indexOf('-->', cursor); if (end < 0) break; cursor = end + 3; comment = false; }
      else { const start = line.indexOf('<!--', cursor); if (start < 0) { visible += line.slice(cursor); break; } visible += line.slice(cursor, start); cursor = start + 4; comment = true; }
    }
    const marker = /^ {0,3}(`{3,}|~{3,})/.exec(visible);
    if (fence) { if (marker && marker[1][0] === fence.marker && marker[1].length >= fence.length && /^ {0,3}(?:`+|~+)\s*$/.test(visible)) fence = undefined; return; }
    if (marker) { fence = { marker: marker[1][0], length: marker[1].length }; return; }
    const heading = /^ {0,3}#{1,6}\s+(.+?)\s*#*\s*$/.exec(visible);
    if (!heading) return;
    if (sections.length) sections.at(-1)!.end = index;
    sections.push({ name: heading[1].trim().toLowerCase(), start: index + 1, end: lines.length });
  });
  for (const { key } of featureDetailFields) if (sections.filter(section => section.name === key).length !== 1) throw Error(`Restore exactly one ${key} heading in Advanced template editing.`);
  return { prefix: match[0], metadata, lines, sections };
}
export function readFeatureDetails(markdown: string) {
  const parsed = document(markdown), fields = {} as Record<FeatureDetailField, string>;
  for (const { key } of featureDetailFields) {
    const section = parsed.sections.find(section => section.name === key)!;
    const value = parsed.lines.slice(section.start, section.end).join('\n').replace(/<!--[\s\S]*?-->/g, '').trim();
    fields[key] = key === 'acceptance criteria' ? value.split('\n').map(line => line.replace(/^ {0,3}[-*+]\s+(?:\[[ xX]\]\s*)?/, '')).join('\n') : value;
  }
  const metadata = parsed.metadata.toJS({ maxAliasCount: 0 }) as Record<string, unknown>, values = metadata.paths;
  const provider = metadata.provider as ProviderId | undefined, effort = metadata.effort as ModelEffort | undefined;
  if (provider !== undefined && !providerIds.includes(provider) || effort !== undefined && provider && !providerEfforts[provider]?.includes(effort)) throw Error('Correct the provider or effort in Advanced template editing.');
  if (effort !== undefined) { try { parseModelEffort(effort); } catch { throw Error('Correct the provider or effort in Advanced template editing.'); } }
  const selection = { provider, model: String(metadata.model ?? ''), effort: effort ?? '' as ModelEffort | '' };
  return { fields, selection, executionProfile: String(metadata.execution_profile ?? ''), qualityProfile: String(metadata.quality_profile ?? ''), priority: typeof metadata.priority === 'number' ? metadata.priority : 2, dependsOn: Array.isArray(metadata.depends_on) ? metadata.depends_on.filter((id): id is string => typeof id === 'string').join('\n') : '', title: String(parsed.metadata.get('title') ?? ''), paths: Array.isArray(values) ? values.filter((path): path is string => typeof path === 'string').join('\n') : '' };
}
/** Edits only a named template field; the worker remains the readiness authority. */
export function writeFeatureDetail(markdown: string, field: FeatureDetailField | FeatureModelField | 'paths' | 'title', value: string) {
  const parsed = document(markdown);
  if (field === 'paths' || field === 'title' || field === 'provider' || field === 'model' || field === 'effort' || field === 'execution_profile' || field === 'quality_profile' || field === 'priority' || field === 'depends_on') {
    if (field === 'execution_profile') for (const key of ['provider', 'model', 'effort', 'definition', 'definition_ref', 'agent', 'use_instructions_only']) parsed.metadata.delete(key);
    if (['model', 'effort', 'execution_profile', 'quality_profile', 'depends_on'].includes(field) && !value.trim()) parsed.metadata.delete(field);
    else parsed.metadata.set(field, field === 'priority' ? Number(value) : field === 'paths' || field === 'depends_on' ? value.split('\n').map(path => path.trim()).filter(Boolean) : value);
    return '---\n' + parsed.metadata.toString({ lineWidth: 0 }) + '---\n' + parsed.lines.join('\n');
  }
  const section = parsed.sections.find(section => section.name === field)!;
  const content = field === 'acceptance criteria' ? value.split('\n').filter(line => line.trim()).map(line => /^ {0,3}[-*+]\s+/.test(line) ? line : '- [ ] ' + line).join('\n') : value;
  parsed.lines.splice(section.start, section.end - section.start, '', content, '');
  return parsed.prefix + parsed.lines.join('\n');
}
