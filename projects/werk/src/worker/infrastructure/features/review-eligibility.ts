import { DomainError } from '../../../shared/errors.js';
import { validateApprovedPaths } from '../../application/approved-paths.js';
import { featureInputHash, featureWorkflowPath, type FeatureWorkflowSnapshot, type SharedFeatureInput } from '../../application/feature-workflow.js';
import { parseFeature, featureInput, featureRequestContext } from './document.js';
import { featureMarkdownSections, validateFeatureTemplate, validateFeatureWorkflowApprovedPaths } from './workflow.js';

type ReviewWorkflow = Pick<FeatureWorkflowSnapshot, 'configuration' | 'template'> & { files?: Pick<FeatureWorkflowSnapshot['files'], 'configuration'> };
export interface FeatureReviewEligibility {
  valid: boolean; input?: SharedFeatureInput; inputHash?: string; errors: { code: string; message: string }[];
}
function invalid(message: string): never { throw new DomainError('invalid_input', message); }
/** Review accepts incomplete requirements, but never unsafe identity, scope or input bytes. */
export function validateFeatureReviewEligibility(markdown: string, snapshot: ReviewWorkflow, provider = 'codex-cli'): FeatureReviewEligibility {
  try {
    if (Buffer.byteLength(markdown) > 32768) invalid('Ready Check request content must fit within 32 KiB of UTF-8 text, including frontmatter and answers, to leave room for reviewer findings.');
    if (markdown.includes('\0') || Buffer.from(markdown).toString('utf8') !== markdown) invalid('Ready Check request content must be valid UTF-8 text without NUL characters.');
    const parsed = parseFeature(markdown), data = parsed.data;
    if (typeof data.id !== 'string' || !['draft', 'ready'].includes(String(data.status)) || data.mode !== 'patch') invalid('Ready Check requires a stable feature ID, draft or ready status and patch mode.');
    if (['source', 'werk', 'werkOwner', 'werkTask', 'werkPullRequest', 'werkTracking'].some(key => Object.hasOwn(data, key))) invalid('New review requests cannot contain worker-owned lifecycle metadata.');
    const template = validateFeatureTemplate(snapshot.template);
    if (data.templateId !== template.templateId) invalid('Feature request templateId does not match the configured template.');
    const base = featureInput(parsed, provider, { reviewOnly: true }), paths = base.paths ?? [];
    if (paths.length) validateApprovedPaths(paths);
    for (const path of paths) featureWorkflowPath(path, 'Approved path');
    if (new Set(paths.map(path => path.toLowerCase())).size !== paths.length) invalid('Approved paths must be distinct, including on case-insensitive filesystems.');
    validateFeatureWorkflowApprovedPaths(paths, snapshot.configuration, snapshot.files?.configuration.path);
    const sections = featureMarkdownSections(parsed.body), section = (name: string) => sections.get(name)?.join('\n').trim() ?? '';
    const criteria = section('acceptance criteria').split(/\r?\n/).flatMap(line => {
      const match = /^ {0,3}[-*+]\s+(?:\[[ xX]\]\s*)?(.*)$/.exec(line);
      return match?.[1].trim() ? [match[1].trim()] : [];
    });
    if (criteria.length > 32 || criteria.some(item => item.length > 1000)) invalid('Keep acceptance criteria within 32 items of at most 1,000 characters each.');
    const { message, metadata } = featureRequestContext(data, base);
    const input: SharedFeatureInput = { ...base, paths, message, metadata, id: data.id, templateId: template.templateId, criteria,
      sections: { goal: section('goal'), context: section('context'), verificationPlan: section('verification plan') } };
    return { valid: true, input, inputHash: featureInputHash(input), errors: [] };
  } catch (error) {
    return { valid: false, errors: [{ code: 'feature_review_structure', message: error instanceof Error ? error.message : 'Feature request structure is invalid.' }] };
  }
}
