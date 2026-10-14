import { createApp } from "vue";
import { createRouter, createWebHistory } from "vue-router";
import ui from "@nuxt/ui/vue-plugin";
import App from "./App.vue";
import "./style.css";
const router = createRouter({
  history: createWebHistory(),
  routes: [
    { path: "/", component: { render: () => null } },
    { path: "/factories/:id", component: { render: () => null } },
    { path: "/:pathMatch(.*)*", redirect: "/" },
  ],
});
router.afterEach(() => {
  document.title = "Werk · Fabriken";
});
createApp(App).use(router).use(ui).mount("#app");
