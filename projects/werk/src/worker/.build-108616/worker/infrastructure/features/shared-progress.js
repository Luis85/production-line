import { createHash } from 'node:crypto';
                                                     

/** Reserved presentation fields never change the accepted author-owned request. */
export const sharedSourceProjectionKeys = ['werkOwner', 'werkTask', 'werkPullRequest']         ;
                                                                                                                             
function progress(value         )                       {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return;
  const p = value                     ;
  if (typeof p.sourceBodyHash !== 'string' || !/^[a-f0-9]{64}$/.test(p.sourceBodyHash) || p.schemaVersion !== 1 || typeof p.summary !== 'string' || p.summary.length > 2000 || ![p.task, p.review].every(path => path === null || typeof path === 'string' && /^[^\\\r\n\x00-\x1f\[\]]{1,500}\.md$/.test(path) && !path.split('/').some(part => !part || part === '.' || part === '..'))) return;
  return p            ;
}
export function sharedProgressSection(value         )         {
  const p = progress(value);
  if (!p) return '';
  const links = [p.task ? `- Action needed: [[${p.task.replace(/\.md$/, '')}]]` : '', p.review ? `- Pull request: [[${p.review.replace(/\.md$/, '')}]]` : ''].filter(Boolean);
  return '\n\n<!-- werk:progress:v1 -->\n## Worker progress\n\n' + p.summary.replace(/[\r\n]+/g, ' ') + '\n' + (links.length ? '\n' + links.join('\n') + '\n' : '') + '\n<!-- /werk:progress:v1 -->\n';
}
export function acceptedSharedBody(parsed                 )         {
  const metadata = parsed.data.werk                                                   ;
  const value = progress(metadata?.shared?.progress), section = sharedProgressSection(value);
  if (!value || !section || !parsed.body.endsWith(section)) return parsed.body;
  const original = parsed.body.slice(0, -section.length);
  return createHash('sha256').update(original).digest('hex') === value.sourceBodyHash ? original : parsed.body;
}
