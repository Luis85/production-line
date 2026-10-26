import { createMemoryHistory, createRouter } from 'vue-router';
const Empty = { render: () => null };
export const router = createRouter({ history: createMemoryHistory(), routes: [
  '/', '/system', '/intake', '/tasks', '/workers', '/metrics', '/taskboard', '/workboard', '/projects', '/projects/new', '/project', '/requests/new', '/request/maintenance', '/request', '/workflow/evidence', '/workflow', '/review', '/history', '/dashboard', '/settings', '/factories/:id',
].map(path => ({ path, component: Empty })) });
