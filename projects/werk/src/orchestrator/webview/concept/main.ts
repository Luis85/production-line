import { createApp } from 'vue';
import ui from '@nuxt/ui/vue-plugin';
import ConceptApp from './ConceptApp.vue';
import './style.css';
createApp(ConceptApp).use(ui).mount('#app');
