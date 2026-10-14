import { createApp } from "vue";
import ui from "@nuxt/ui/vue-plugin";
import StatusApp from "./StatusApp.vue";
import "../style.css";

let initial: unknown = null;
try {
  initial = JSON.parse(
    document.getElementById("werk-status-data")?.textContent ?? "null",
  );
} catch {
  initial = { invalid: true };
}
createApp(StatusApp, { initial }).use(ui).mount("#app");
