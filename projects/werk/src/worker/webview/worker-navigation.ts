import type { NavigationLink } from '../../shared/webview/types';
/** Production navigation and isolated workspace examples share one set of destinations. */
export const workerLinks = [
  { path: '/workboard', label: 'Workboard', icon: 'i-lucide-columns-2' },
  { path: '/projects', label: 'Projects', icon: 'i-lucide-folder-git-2' },
  { path: '/workflow', label: 'Workflow', icon: 'i-lucide-workflow' },
  { path: '/settings', label: 'Settings', icon: 'i-lucide-settings-2' },
] satisfies NavigationLink[];
