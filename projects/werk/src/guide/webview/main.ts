import { createApp } from 'vue';
import ui from '@nuxt/ui/vue-plugin';
import GuideApp from './GuideApp.vue';
import './style.css';
createApp(GuideApp).use(ui).mount('#app');
