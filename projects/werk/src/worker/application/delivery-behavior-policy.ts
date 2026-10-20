import { DomainError } from '../../shared/errors.js';
import { object } from '../../shared/contracts.js';
import { defaultDeliveryProfile } from './delivery-behavior.js';
import type { DeliveryCondition, DeliveryNode, DeliveryProfile } from './delivery-contracts.js';
export interface DeliveryBehaviorLibrary { defaultProfile: string; profiles: DeliveryProfile[]; }
function invalid(message: string): never { throw new DomainError('invalid_input', message); }
function name(value: unknown, node = false): string {
  if (typeof value !== 'string' || !(node ? /^[a-z][a-z0-9_-]{0,63}$/ : /^[a-z][a-z0-9-]{0,63}$/).test(value)) invalid('Behavior IDs must be lowercase names up to 64 characters.');
  return value;
}
/** Only bounded declarative branches are authored. The journal still enforces lifecycle and authority. */
function validateDeliveryBehaviorProfile(value: unknown): DeliveryProfile {
  const raw = object(value, 'Behavior profile', ['schemaVersion', 'id', 'version', 'root']);
  if (raw.schemaVersion !== 1 || !Number.isSafeInteger(raw.version) || Number(raw.version) < 1) invalid('Behavior profiles require schemaVersion 1 and a positive version.');
  const ids = new Set<string>(); let count = 0;
  const parse = (value: unknown, depth: number): DeliveryNode => {
    if (++count > 128 || depth > 8) invalid('Behavior profiles permit at most 128 nodes and eight levels.');
    const node = object(value, 'Behavior node', ['id', 'type', 'children', 'condition', 'action', 'reason', 'waitingFor']);
    const id = name(node.id, true);
    if (ids.has(id)) invalid('Behavior node IDs must be unique.'); ids.add(id);
    if (node.type === 'selector' || node.type === 'sequence') {
      if (!Array.isArray(node.children) || node.children.length < 1 || node.children.length > 32 || ['condition', 'action', 'reason', 'waitingFor'].some(key => node[key] !== undefined)) invalid('Composite behavior nodes require bounded children only.');
      return { id, type: node.type, children: node.children.map(child => parse(child, depth + 1)) };
    }
    if (node.type === 'condition') {
      if (Object.keys(node).some(key => !['id', 'type', 'condition'].includes(key)) || typeof node.condition !== 'string') invalid('Condition nodes require one known condition.');
      return { id, type: 'condition', condition: node.condition as DeliveryCondition };
    }
    if (node.type !== 'action' || Object.keys(node).some(key => !['id', 'type', 'action', 'reason', 'waitingFor'].includes(key)) || typeof node.action !== 'string' || typeof node.reason !== 'string' || !node.reason.trim() || node.reason.length > 1000 || node.waitingFor !== undefined && (typeof node.waitingFor !== 'string' || !node.waitingFor.trim() || node.waitingFor.length > 300)) invalid('Action nodes require a known action, reason and optional waiting description.');
    return { id, type: 'action', action: node.action as Extract<DeliveryNode, {type:'action'}>['action'], reason: node.reason.trim(), ...(node.waitingFor === undefined ? {} : { waitingFor: (node.waitingFor as string).trim() }) };
  };
  const root = parse(raw.root, 0), canonical = defaultDeliveryProfile.root;
  if (root.type !== 'selector' || canonical.type !== 'selector' || root.children.length !== canonical.children.length) invalid('Behavior profiles require the complete supported delivery selector.');
  root.children.forEach((branch, index) => {
    const expected = canonical.children[index];
    if (branch.type !== 'sequence' || expected.type !== 'sequence' || branch.children.length !== 2) invalid('Each behavior branch must contain its condition followed by its action.');
    const [condition, action] = branch.children, [expectedCondition, expectedAction] = expected.children;
    if (condition.type !== 'condition' || expectedCondition.type !== 'condition' || action.type !== 'action' || expectedAction.type !== 'action' || condition.condition !== expectedCondition.condition || action.action !== expectedAction.action) invalid('Behavior branches must preserve safety precedence and supported lifecycle condition/action mappings.');
  });
  return { schemaVersion: 1, id: name(raw.id), version: Number(raw.version), root };
}
export function validateDeliveryBehaviorLibrary(value: unknown): DeliveryBehaviorLibrary {
  const raw = object(value, 'Behavior library', ['defaultProfile', 'profiles']);
  if (!Array.isArray(raw.profiles) || raw.profiles.length < 1 || raw.profiles.length > 16) invalid('Configure 1–16 reusable behavior profiles.');
  const profiles = raw.profiles.map(validateDeliveryBehaviorProfile), defaultProfile = name(raw.defaultProfile);
  if (new Set(profiles.map(profile => profile.id)).size !== profiles.length || !profiles.some(profile => profile.id === defaultProfile)) invalid('Behavior profiles must be unique and include the selected default.');
  return { defaultProfile, profiles };
}
export function selectedDeliveryBehavior(library?: DeliveryBehaviorLibrary): DeliveryProfile {
  if (!library) return structuredClone(defaultDeliveryProfile);
  const validated = validateDeliveryBehaviorLibrary(library);
  return structuredClone(validated.profiles.find(profile => profile.id === validated.defaultProfile)!);
}
