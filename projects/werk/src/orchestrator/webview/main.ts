import { createApp } from "vue";
import { createRouter, createWebHashHistory } from "vue-router";
import ui from "@nuxt/ui/vue-plugin";
import App from "./App.vue";
import "./style.css";
// Preserve bookmarked legacy #tasks?task=id links while using Vue Router hash history.
if (/^#(?:system|intake|tasks|workers|metrics)(?:\?|$)/.test(location.hash))
  history.replaceState(null, "", "#" + "/" + location.hash.slice(1));
const router = createRouter({
  history: createWebHashHistory(),
  routes: [
    { path: "/", redirect: "/system" },
    { path: "/system", component: () => import("./pages/DashboardPage.vue") },
    { path: "/intake", component: () => import("./pages/IntakePage.vue") },
    { path: "/tasks", component: () => import("./pages/TasksPage.vue") },
    { path: "/workers", component: () => import("./pages/WorkersPage.vue") },
    { path: "/metrics", component: () => import("./pages/MetricsPage.vue") },
    { path: "/:pathMatch(.*)*", redirect: "/system" },
  ],
});
createApp(App).use(router).use(ui).mount("#app");
