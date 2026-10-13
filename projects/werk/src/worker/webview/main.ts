import { createApp } from 'vue';
import { createRouter, createWebHistory } from 'vue-router';
import ui from '@nuxt/ui/vue-plugin';
import App from './App.vue';
import ChatPage from './pages/ChatPage.vue';
import HistoryPage from './pages/HistoryPage.vue';
import MonitoringPage from './pages/MonitoringPage.vue';
import './style.css';
const router = createRouter({ history: createWebHistory(), routes: [
  { path: '/', redirect: '/chat' },
  { path: '/chat', component: ChatPage, meta: { title: 'Chat' } },
  { path: '/history', component: HistoryPage, meta: { title: 'History' } },
  { path: '/dashboard', component: MonitoringPage, meta: { title: 'Dashboard' } },
  { path: '/monitoring-status', redirect: '/dashboard' },
] });
router.afterEach(to => { document.title = `${String(to.meta.title ?? 'Worker')} · Werk`; });
createApp(App).use(router).use(ui).mount('#app');
