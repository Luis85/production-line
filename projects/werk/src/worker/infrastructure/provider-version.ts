/** Claude native sessions need prompt refresh; resumed cost scope changed in a later CLI release. */
export const minimumClaudeVersion = '2.1.257';
export function claudeVersion(output: string, exitCode: number | null): {
  version?: string; compatibility: 'minimum_met' | 'unsupported' | 'unknown'; costScope?: 'invocation' | 'session';
} {
  const matched = /^\s*(?:Claude Code\s+)?v?(\d{1,4})\.(\d{1,4})\.(\d{1,6})(?:\s|\(|$)/m.exec(output);
  if (exitCode !== 0 || !matched) return { compatibility: 'unknown' };
  const [major, minor, patch] = matched.slice(1).map(Number);
  const atLeast = (minimum: number) => major > 2 || major === 2 && (minor > 1 || minor === 1 && patch >= minimum);
  return { version: matched.slice(1).join('.'), compatibility: atLeast(257) ? 'minimum_met' : 'unsupported',
    ...(atLeast(257) ? { costScope: atLeast(277) ? 'session' : 'invocation' } : {}) };
}
