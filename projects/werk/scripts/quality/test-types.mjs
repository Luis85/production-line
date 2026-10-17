import { resolve, relative, sep } from 'node:path';
import ts from 'typescript';
import { generatedImportSource } from './generated-imports.mjs';

const generated = /(?:^|\/)src\/(factory|orchestrator|worker)\/dist\/|(?:^|\/)\.mutation-build\//;

/** Check every maintained test against source contracts, without requiring a runtime build. */
export function collectTestDiagnostics(root) {
  const configPath = resolve(root, 'tsconfig.tests.json');
  const config = ts.readConfigFile(configPath, ts.sys.readFile);
  if (config.error) return { diagnostics: [config.error], files: [], mappedImports: 0 };
  const parsed = ts.parseJsonConfigFileContent(config.config, ts.sys, root, undefined, configPath);
  if (parsed.errors.length) return { diagnostics: parsed.errors, files: [], mappedImports: 0 };
  if (!parsed.fileNames.length) throw Error('Test typechecking selected no maintained test files.');
  if (!parsed.options.allowJs || !parsed.options.checkJs || !parsed.options.noEmit)
    throw Error('Test typechecking requires allowJs, checkJs and noEmit.');
  const host = ts.createCompilerHost(parsed.options);
  let mappedImports = 0;
  host.resolveModuleNames = (names, importer) => names.map(name => {
    if (generated.test(name)) {
      // The runtime imports remain pointed at built archives; only type resolution changes.
      const source = resolve(root, generatedImportSource(root, importer, name));
      if (source.endsWith('.ts') && ts.sys.fileExists(source)) {
        mappedImports++;
        return { resolvedFileName: source, extension: ts.Extension.Ts };
      }
    }
    return ts.resolveModuleName(name, importer, parsed.options, host).resolvedModule;
  });
  const program = ts.createProgram(parsed.fileNames, parsed.options, host);
  // Application TypeScript has its own strict gate. Imported scripts supply inferred contracts;
  // diagnostics here cover all selected tests and support, rather than unrelated script bodies.
  const diagnostics = [...program.getOptionsDiagnostics(), ...program.getGlobalDiagnostics(), ...program.getSyntacticDiagnostics()];
  for (const path of parsed.fileNames) {
    const source = program.getSourceFile(path);
    if (!source) throw Error(`TypeScript did not load selected test ${relative(root, path)}.`);
    diagnostics.push(...uncheckedDirectives(source), ...program.getSemanticDiagnostics(source));
  }
  return { diagnostics: ts.sortAndDeduplicateDiagnostics(diagnostics), files: parsed.fileNames, mappedImports };
}

export function diagnosticRecords(diagnostics, root) {
  return diagnostics.map(diagnostic => {
    const location = diagnostic.file && diagnostic.start !== undefined ? diagnostic.file.getLineAndCharacterOfPosition(diagnostic.start) : null;
    return {
      code: diagnostic.code,
      message: ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n'),
      ...(diagnostic.file ? { file: relative(root, diagnostic.file.fileName).split(sep).join('/') } : {}),
      ...(location ? { line: location.line + 1, column: location.character + 1, sourceLine: diagnostic.file.text.split(/\r?\n/)[location.line] } : {}),
    };
  });
}

export function formatTestDiagnostics(diagnostics, root) {
  return ts.formatDiagnosticsWithColorAndContext(diagnostics, {
    getCanonicalFileName: path => path,
    getCurrentDirectory: () => root,
    getNewLine: () => '\n',
  });
}

/** Inspect parsed comment trivia, so directive-shaped strings, regexes and template fixtures remain ordinary data. */
function uncheckedDirectives(source) {
  const ranges = new Map();
  const visit = node => {
    for (const range of ts.getLeadingCommentRanges(source.text, node.getFullStart()) ?? []) ranges.set(range.pos, range);
    for (const range of ts.getTrailingCommentRanges(source.text, node.end) ?? []) ranges.set(range.pos, range);
    for (const child of node.getChildren(source)) visit(child);
  };
  visit(source);
  return [...ranges.values()].flatMap(range => {
    const comment = source.text.slice(range.pos, range.end);
    const match = /^(?:\/\/\/?|[/*]*)\s*@ts-(nocheck|ignore)/m.exec(comment);
    return match ? [{
      file: source, start: range.pos + match.index, length: match[0].length,
      category: ts.DiagnosticCategory.Error, code: 90001,
      messageText: `@ts-${match[1]} disables required test typechecking. Use typed fixtures or a documented, checked @ts-expect-error for deliberately invalid contract inputs.`,
    }] : [];
  });
}
