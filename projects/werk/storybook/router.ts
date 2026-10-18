import { createMemoryHistory, createRouter } from 'vue-router';
const Empty = { render: () => null };
export const router = createRouter({ history: createMemoryHistory(), routes: [
  '/', '/system', '/intake', '/tasks', '/workers', '/metrics', '/taskboard', '/review', '/history', '/dashboard', '/settings', '/factories/:id',
].map(path => ({ path, component: Empty })) });
