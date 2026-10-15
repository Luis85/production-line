import { createApp } from 'vue';
import { createRouter, createWebHistory } from 'vue-router';
import ui from '@nuxt/ui/vue-plugin';
import App from './App.vue';
import './style.css';
const router = createRouter({ history: createWebHistory(), routes: [
  { path: '/', redirect: '/taskboard' },
  { path: '/taskboard', component: () => import('./pages/TaskboardPage.vue'), meta: { title: 'Taskboard' } },
  { path: '/chat', redirect: to => ({ path: '/taskboard', query: to.query, hash: to.hash }) },
  { path: '/history', component: () => import('./pages/HistoryPage.vue'), meta: { title: 'History' } },
  { path: '/dashboard', component: () => import('./pages/MonitoringPage.vue'), meta: { title: 'Dashboard' } },
  { path: '/monitoring-status', redirect: '/dashboard' },
  { path: '/:pathMatch(.*)*', redirect: '/taskboard' },
] });
router.afterEach(to => { document.title = `${String(to.meta.title ?? 'Worker')} · Werk`; });
createApp(App).use(router).use(ui).mount('#app');
