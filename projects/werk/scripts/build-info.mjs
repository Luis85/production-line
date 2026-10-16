/** Deterministic metadata embedded in every independently runnable distribution. */
export function buildInfoModule(packageInfo) {
  if (typeof packageInfo?.version !== 'string' || !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/.test(packageInfo.version)) {
    throw Error('Root package must declare a release version');
  }
  return `// Generated from the root package manifest. Do not edit.\nexport const buildInfo = Object.freeze(${JSON.stringify({version: packageInfo.version})});\n`;
}
