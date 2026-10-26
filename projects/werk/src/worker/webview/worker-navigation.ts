import type { NavigationLink } from '../../shared/webview/types';
/** Production navigation and isolated workspace examples share one set of destinations. */
export const workerLinks = [
  { path: '/taskboard', label: 'Taskboard', icon: 'i-lucide-columns-2' },
  { path: '/workflow', label: 'Workflow', icon: 'i-lucide-workflow' },
  { path: '/dashboard', label: 'Metrics', icon: 'i-lucide-activity' },
  { path: '/history', label: 'History', icon: 'i-lucide-history' },
  { path: '/settings', label: 'Settings', icon: 'i-lucide-settings-2' },
] satisfies NavigationLink[];
