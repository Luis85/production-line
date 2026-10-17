import type { StorybookConfig } from '@storybook/vue3-vite';
import ui from '@nuxt/ui/vite';
import vue from '@vitejs/plugin-vue';
import { fileURLToPath } from 'node:url';
import { sourceInstrumentation } from './instrument.mjs';
const root = fileURLToPath(new URL('../', import.meta.url));
const config: StorybookConfig = {
  stories: ['../storybook/**/*.stories.ts'],
  addons: ['@storybook/addon-docs'],
  framework: '@storybook/vue3-vite',
  staticDirs: [{ from: '../work/storybook-public', to: '/' }],
  core: { disableTelemetry: true },
  previewHead: head => head + '<link rel="icon" href="data:,">',
  managerHead: head => head + '<link rel="icon" href="data:,">',
  async viteFinal(config) {
    config.plugins ??= [];
    config.plugins.push(sourceInstrumentation(root), vue(), ui({ dts: false, autoImport: false, components: false, colorMode: false,
      ui: { colors: { primary: 'emerald', neutral: 'slate' } },
      icon: { clientBundle: { scan: { globInclude: ['**/*.{vue,jsx,tsx,md,mdc,mdx,yml,yaml,ts}'] }, icons: ['lucide:shield-check'], sizeLimitKb: 1024 } },
    }));
    config.build = { ...config.build, target: 'es2022', chunkSizeWarningLimit: 1500 };
    return config;
  },
};
export default config;
