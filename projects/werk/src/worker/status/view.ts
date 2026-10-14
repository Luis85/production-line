import { readFileSync } from 'node:fs';
import type { Status } from './server.js';

/** The live diagnostic view and offline export use one compiled Vue interface. */
export function statusHtml(snapshot?: Status): string {
  const initial = snapshot ? JSON.stringify(snapshot).replace(/</g, '\\u003c').replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029') : 'null';
  const template = readFileSync(new URL('../public/status.html', import.meta.url), 'utf8');
  const marker = '<script id="werk-status-data" type="application/json">null</script>';
  if (!template.includes(marker)) throw Error('Worker diagnostic view is not built correctly.');
  return template.replace(marker, () => '<script id="werk-status-data" type="application/json">' + initial + '</script>');
}
