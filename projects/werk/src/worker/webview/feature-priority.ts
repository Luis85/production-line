/** Request priorities use the documented three-level authoring scale, separately from scheduler ranks. */
export const featurePriorityOptions = [{ value: 1, label: '1 · High' }, { value: 2, label: '2 · Medium' }, { value: 3, label: '3 · Low' }];
export function readFeaturePriority(metadata: Record<string, unknown>): number {
  const value = metadata.priority;
  if (value === undefined) return metadata.priority_scale === 'three-level/v1' ? 3 : 2;
  if (typeof value === 'string') return ({ urgent: 0, high: 1, normal: 2, low: 3 } as Record<string, number>)[value] ?? 3;
  if (metadata.priority_scale === 'three-level/v1' && [1, 2, 3].includes(Number(value))) return Number(value);
  // Legacy numeric priorities are scheduler ranks: larger values are more urgent.
  return value === 2 ? 1 : value === 1 ? 2 : 3;
}
