import { fileURLToPath } from 'node:url';
import { collectTestDiagnostics, diagnosticRecords, formatTestDiagnostics } from './test-types.mjs';

const args = process.argv.slice(2);
if (args.length > 1 || args.length === 1 && args[0] !== '--json') throw Error('Usage: node scripts/quality/typecheck-tests.mjs [--json]');
const root = fileURLToPath(new URL('../../', import.meta.url));
const { diagnostics, files, mappedImports } = collectTestDiagnostics(root);
if (args[0] === '--json') console.log(JSON.stringify({ files: files.length, mappedImports, diagnostics: diagnosticRecords(diagnostics, root) }, null, 2));
else {
  if (diagnostics.length) console.error(formatTestDiagnostics(diagnostics, root));
  console.log(`Test types: ${files.length} maintained files, ${mappedImports} imports checked against source, ${diagnostics.length} errors.`);
}
process.exitCode = diagnostics.length ? 1 : 0;
