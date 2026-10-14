import { defineConfig } from 'vite';
import vue from '@vitejs/plugin-vue';
import ui from '@nuxt/ui/vite';
import { fileURLToPath } from 'node:url';
export default defineConfig({
  root: fileURLToPath(new URL('.', import.meta.url)),
  plugins: [vue(), ui({ dts: false, autoImport: false, components: false, colorMode: false, ui: { colors: { primary: 'emerald', neutral: 'slate' } }, icon: { clientBundle: { scan: true, sizeLimitKb: 256 } } })],
  build: { target: 'es2022', emptyOutDir: true },
});
