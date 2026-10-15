import { relative } from 'node:path';
/** Test-only custom block: retain a source ID even in optimized production SFCs.
 * @param {string} root
 * @returns {import("vite").Plugin}
 */
export function sourceInstrumentation(root) {
  return {
    name: 'werk-storymap-source', enforce: 'pre',
    transform(code, id) {
      if (id.includes('type=werk-source')) {
        const source = relative(root, id.split('?')[0]).replaceAll('\\', '/');
        return `export default component => { component.__werkSource = ${JSON.stringify(source)}; };`;
      }
      if (id.endsWith('.vue') && relative(root, id).replaceAll('\\', '/').startsWith('src/')) {
        return `${code}\n<werk-source>source-coverage</werk-source>\n`;
      }
    },
  };
}
