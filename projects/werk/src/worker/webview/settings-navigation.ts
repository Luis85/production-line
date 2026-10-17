/** Stable settings destinations also support bookmarks from earlier releases. */
export const settingsSections = [
  { id: 'provider-connections', label: 'Providers & accounts', hint: 'Models and sign-in', icon: 'i-lucide-plug' },
  { id: 'queue', label: 'Queue & duration', hint: 'Capacity and execution limits', icon: 'i-lucide-list-ordered' },
  { id: 'consumption-limits', label: 'Consumption', hint: 'Allowance and worker share', icon: 'i-lucide-gauge' },
  { id: 'tool-access', label: 'Tools & MCP', hint: 'Permissions and connections', icon: 'i-lucide-wrench' },
  { id: 'repositories', label: 'Repositories', hint: 'Checkouts and worktrees', icon: 'i-lucide-git-branch' },
  { id: 'shared-intake', label: 'Shared request intake', hint: 'Team feature requests', icon: 'i-lucide-inbox' },
  { id: 'execution-profiles', label: 'Execution profiles', hint: 'Available execution identities', icon: 'i-lucide-sliders-horizontal' },
  { id: 'agent-definitions', label: 'Agent definitions', hint: 'Reusable task instructions', icon: 'i-lucide-bot' },
  { id: 'integrations', label: 'Project integration', hint: 'Local authoring files', icon: 'i-lucide-folder-cog' },
  { id: 'orchestrator', label: 'Orchestrator', hint: 'Optional assignments and review', icon: 'i-lucide-network' },
] as const;
export type SettingsSectionId = typeof settingsSections[number]['id'];
export function settingsSectionId(hash: string): SettingsSectionId {
  const id = hash.replace(/^#/, '');
  if (id === 'duration-policy' || id === 'queue-settings') return 'queue';
  return settingsSections.find(section => section.id === id)?.id ?? 'provider-connections';
}

export function isSettingsAnchor(hash: string): boolean {
  return ['#duration-policy', '#queue-settings'].includes(hash) || settingsSections.some(section => '#' + section.id === hash);
}
