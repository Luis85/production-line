import { inputError } from '../config.mjs';
// Teams commit the YAML profile itself, so these commands also accept it directly as --file PATH.yaml.
const yamlCommands = ['definition preview', 'definition import', 'definition update'];
export const isYamlProfile = (cmd, file) => yamlCommands.includes(cmd) && typeof file === 'string' && /\.ya?ml$/i.test(file);
/** Apply --name to import/update input (JSON or YAML) and require a name when a YAML profile is imported. */
export function definitionName(cmd, body, options, yamlProfile) {
  if (!['definition import', 'definition update'].includes(cmd)) return body;
  if (options.name !== undefined) {
    if (body && Object.hasOwn(body, 'name')) throw inputError('Name given twice: --name and "name" in the --file JSON. Remove one of them.');
    return { ...body, name: options.name };
  }
  if (cmd === 'definition import' && yamlProfile) throw inputError('--name required when importing a YAML profile.');
  return body;
}
/** Apply --ref to import input so the stable reference is set in the same operation as the import. */
export function definitionImportReference(cmd, body, options) {
  if (cmd !== 'definition import' || options.ref === undefined) return body;
  if (body && Object.hasOwn(body, 'ref')) throw inputError('Reference given twice: --ref and "ref" in the --file JSON. Remove one of them.');
  return { ...body, ref: options.ref };
}
