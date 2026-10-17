import assert from 'node:assert/strict';

/** @param {import('../../src/worker/application/model-contract.js').ModelResult | string} result */
export function completedText(result) {
  if (typeof result === 'string') return result;
  assert.ok(result.type === 'completed', 'Expected a completed model result.');
  return result.text;
}

/** Read an emitted JSON-schema property only after validating its shape.
 * @param {import('../../src/worker/application/tool-policy.js').ToolDefinition} tool
 * @param {string} name
 */
export function toolPropertyDescription(tool, name) {
  const properties = tool.inputSchema.properties;
  assert.ok(properties && typeof properties === 'object' && !Array.isArray(properties));
  /** @type {unknown} */
  const property = Reflect.get(properties, name);
  assert.ok(property && typeof property === 'object' && 'description' in property);
  assert.ok(typeof property.description === 'string');
  return property.description;
}
