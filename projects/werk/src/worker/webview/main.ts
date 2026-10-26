import { createApp } from 'vue';
import { createRouter, createWebHistory } from 'vue-router';
import ui from '@nuxt/ui/vue-plugin';
import App from './App.vue';
import './style.css';
import { isSettingsAnchor } from './settings-navigation';
const router = createRouter({ history: createWebHistory(), scrollBehavior(to, from, savedPosition) {
  if (savedPosition) return savedPosition;
  if (to.hash && to.path !== '/settings') return { el: to.hash, top: 16 };
  if (to.path !== from.path) return { top: 0 };
}, routes: [
  { path: '/', redirect: '/workboard' },
  { path: '/taskboard', redirect: to => ({ path: '/workboard', query: to.query, hash: to.hash }) },
  { path: '/projects', component: () => import('./pages/ProjectsPage.vue'), meta: { title: 'Projects' } },
  { path: '/workboard', component: () => import('./pages/TaskboardPage.vue'), meta: { title: 'Workboard' } },
  { path: '/workflow', component: () => import('./pages/WorkflowPage.vue'), meta: { title: 'Workflow' } },
  { path: '/review', component: () => import('./pages/ReviewPage.vue'), meta: { title: 'Feature request review' } },
  { path: '/chat', redirect: to => ({ path: '/workboard', query: to.query, hash: to.hash }) },
  { path: '/history', component: () => import('./pages/HistoryPage.vue'), meta: { title: 'History' } },
  { path: '/dashboard', component: () => import('./pages/MonitoringPage.vue'), meta: { title: 'Metrics' } },
  { path: '/settings', component: () => import('./pages/SettingsPage.vue'), meta: { title: 'Settings' } },
  { path: '/monitoring-status', redirect: '/dashboard' },
  { path: '/:pathMatch(.*)*', redirect: '/workboard' },
] });
// Keep bookmarks and setup links from earlier releases working.
router.beforeEach(to => to.path === '/dashboard' && isSettingsAnchor(to.hash) ? { path: '/settings', query: to.query, hash: to.hash, replace: true } : undefined);
router.afterEach(to => { document.title = `${String(to.meta.title ?? 'Worker')} · Werk`; });
createApp(App).use(router).use(ui).mount('#app');
