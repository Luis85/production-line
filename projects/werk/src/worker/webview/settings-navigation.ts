/** Each settings destination owns one independently saved operator goal. */
const settingsSections = [
  { id: 'provider-connections', label: 'Provider connections', goal: 'Connect a model provider', hint: 'Configure and check one provider account.', icon: 'i-lucide-plug', group: 'models' },
  { id: 'default-provider', label: 'Default provider', goal: 'Choose the default provider', hint: 'Set the starting provider for new requests.', icon: 'i-lucide-route', group: 'models' },
  { id: 'queue', label: 'Queue capacity', goal: 'Set request capacity', hint: 'Control how much work this worker admits.', icon: 'i-lucide-list-ordered', group: 'limits' },
  { id: 'duration-policy', label: 'Execution time limits', goal: 'Set execution time limits', hint: 'Bound individual attempts and waits.', icon: 'i-lucide-timer', group: 'limits' },
  { id: 'consumption-limits', label: 'Token allowance', goal: 'Set the worker token allowance', hint: 'Bound reported usage and reserved work.', icon: 'i-lucide-gauge', group: 'limits' },
  { id: 'tool-access', label: 'Tools & MCP', goal: 'Grant tool access', hint: 'Choose the capabilities requests may use.', icon: 'i-lucide-wrench', group: 'capabilities' },
  { id: 'retained-approvals', label: 'Saved project authority', goal: 'Revoke saved project authority', hint: 'Remove retained local approval grants.', icon: 'i-lucide-shield-check', group: 'capabilities' },
  { id: 'agent-definitions', label: 'Agent instructions', goal: 'Prepare reusable agent instructions', hint: 'Preview and import an instruction profile.', icon: 'i-lucide-bot', group: 'capabilities' },
  { id: 'execution-profiles', label: 'Execution profiles', goal: 'Advertise execution profiles', hint: 'Set the identities available to an orchestrator.', icon: 'i-lucide-sliders-horizontal', group: 'coordination' },
  { id: 'orchestrator', label: 'Orchestrator connection', goal: 'Connect an orchestrator', hint: 'Optionally receive assigned work.', icon: 'i-lucide-network', group: 'coordination' },
  { id: 'request-policy', label: 'Assigned request rules', goal: 'Set assigned request rules', hint: 'Configure readiness and completion policy.', icon: 'i-lucide-list-checks', group: 'coordination' },
  { id: 'repositories', label: 'Repositories', goal: 'Configure repository assignments', hint: 'Retained checkouts and worktrees.', icon: 'i-lucide-git-branch', group: 'projects' },
  { id: 'shared-intake', label: 'Shared request intake', goal: 'Configure shared request intake', hint: 'Retained team request bindings.', icon: 'i-lucide-inbox', group: 'projects' },
  { id: 'delivery-policy', label: 'Project delivery', goal: 'Review project delivery authority', hint: 'Quality profiles and review rules.', icon: 'i-lucide-list-checks', group: 'projects' },
  { id: 'integrations', label: 'Project integration', goal: 'Inspect retained project integration', hint: 'Legacy authoring files and recovery.', icon: 'i-lucide-folder-cog', group: 'projects' },
] as const;
export const settingsGroups = [
  { id: 'models', label: 'Models & accounts' },
  { id: 'limits', label: 'Worker limits' },
  { id: 'capabilities', label: 'Tools & instructions' },
  { id: 'coordination', label: 'Optional coordination' },
  { id: 'projects', label: 'Legacy project configuration' },
] as const;
export type SettingsSectionId = typeof settingsSections[number]['id'];
export function settingsSectionId(hash: string): SettingsSectionId | undefined {
  const id = hash.replace(/^#/, '');
  return settingsSections.find(section => section.id === (id === 'queue-settings' ? 'queue' : id))?.id;
}
export function isSettingsAnchor(hash: string): boolean { return settingsSectionId(hash) !== undefined; }
export function visibleSettingsSections(centralHome: boolean) { return settingsSections.filter(section => !centralHome || section.group !== 'projects'); }
