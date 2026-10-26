import { createApp } from 'vue';
import { createRouter, createWebHistory } from 'vue-router';
import ui from '@nuxt/ui/vue-plugin';
import App from './App.vue';
import './style.css';
import { legacyWorkerDestination } from './worker-route-compatibility';
const router = createRouter({ history: createWebHistory(), scrollBehavior(to, from, savedPosition) {
  if (savedPosition) return savedPosition;
  if (to.hash && to.path !== '/settings') return { el: to.hash, top: 16 };
  if (to.path !== from.path) return { top: 0 };
}, routes: [
  { path: '/', redirect: '/workboard' },
  { path: '/taskboard', redirect: to => ({ path: '/workboard', query: to.query, hash: to.hash }) },
  { path: '/projects/new', component: () => import('./pages/AddProjectPage.vue'), meta: { title: 'Add a project', goal: 'Clone and register one project' } },
  { path: '/project', component: () => import('./pages/ProjectSetupPage.vue'), meta: { title: 'Project setup', goal: 'Prepare one project for requests' } },
  { path: '/requests/new', component: () => import('./pages/NewRequestPage.vue'), meta: { title: 'New Feature Request', goal: 'Publish a ready Feature Request' } },
  { path: '/request/maintenance', component: () => import('./pages/TaskMaintenancePage.vue'), meta: { title: 'Manage saved task', goal: 'Manage one saved file task' } },
  { path: '/request', component: () => import('./pages/RequestPage.vue'), meta: { title: 'Feature Request', goal: 'Advance one existing request' } },
  { path: '/workflow/evidence', component: () => import('./pages/WorkflowEvidencePage.vue'), meta: { title: 'Delivery quality evidence', goal: 'Inspect delivery quality evidence' } },
  { path: '/projects', component: () => import('./pages/ProjectsPage.vue'), meta: { title: 'Projects', goal: 'Choose a project' } },
  { path: '/workboard', component: () => import('./pages/TaskboardPage.vue'), meta: { title: 'Workboard', goal: 'Choose the next request to advance' } },
  { path: '/workflow', component: () => import('./pages/WorkflowPage.vue'), meta: { title: 'Workflow health', goal: 'Understand delivery health' } },
  { path: '/review', component: () => import('./pages/ReviewPage.vue'), meta: { title: 'Feature request review', goal: 'Decide the next valid action for this increment' } },
  { path: '/chat', redirect: to => ({ path: '/workboard', query: to.query, hash: to.hash }) },
  { path: '/history', component: () => import('./pages/HistoryPage.vue'), meta: { title: 'Request history', goal: 'Find retained evidence' } },
  { path: '/dashboard', component: () => import('./pages/MonitoringPage.vue'), meta: { title: 'Worker health', goal: 'Understand worker resource health' } },
  { path: '/settings', component: () => import('./pages/SettingsPage.vue'), meta: { title: 'Settings', goal: 'Choose one worker setting' } },
  { path: '/monitoring-status', redirect: '/dashboard' },
  { path: '/:pathMatch(.*)*', redirect: '/workboard' },
] });
// Keep bookmarks and setup links from earlier releases working.
router.beforeEach(legacyWorkerDestination);
router.afterEach(to => { document.title = `${String(to.meta.title ?? 'Worker')} · Werk`; });
createApp(App).use(router).use(ui).mount('#app');
