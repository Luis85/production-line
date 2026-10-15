import { setup, type Preview } from '@storybook/vue3-vite';
import { h, nextTick } from 'vue';
import ui from '@nuxt/ui/vue-plugin';
import UApp from '@nuxt/ui/components/App.vue';
import { router } from '../storybook/router';

const styles = import.meta.glob('../src/**/webview/**/style.css', { query: '?inline', import: 'default', eager: true }) as Record<string, string>;
const stylePaths: Record<string, string> = {
  Worker: 'src/worker/webview/style.css', Shared: 'src/worker/webview/style.css',
  Factory: 'src/factory/webview/style.css', Orchestrator: 'src/orchestrator/webview/style.css',
  Concept: 'src/orchestrator/webview/concept/style.css', Guide: 'src/guide/webview/style.css',
};
const globals = window as typeof window & {
  __WERK_STORYMAP__?: Record<string, any>;
  __WERK_MOUNTED_SOURCES__: Set<string>;
  __WERK_STORY_ERRORS__: string[];
  __WERK_STORY_READY__: boolean;
  __WERK_STORY_FETCH__?: typeof fetch;
};
const originalFetch = window.fetch.bind(window);
globals.__WERK_MOUNTED_SOURCES__ = new Set();
globals.__WERK_STORY_ERRORS__ = [];
globals.__WERK_STORY_READY__ = false;
window.fetch = async (input, init) => {
  const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url, location.href);
  if ((url.pathname.startsWith('/api/') || url.pathname.startsWith('/v1/')) || ['/status', '/monitoring', '/health'].includes(url.pathname)) {
    if (globals.__WERK_STORY_FETCH__) {
      try { return await globals.__WERK_STORY_FETCH__(input, init); }
      catch (error) { globals.__WERK_STORY_ERRORS__.push(String(error)); throw error; }
    }
    const error = `No offline fixture for ${init?.method ?? 'GET'} ${url.pathname}`;
    globals.__WERK_STORY_ERRORS__.push(error); throw Error(error);
  }
  if (url.origin !== location.origin && !['data:', 'blob:'].includes(url.protocol)) {
    const error = `Story attempted a remote request: ${url.origin}`;
    globals.__WERK_STORY_ERRORS__.push(error); throw Error(error);
  }
  return originalFetch(input, init);
};
setup(app => {
  app.use(router).use(ui);
  app.mixin({ mounted() {
    const source = (this.$options as { __werkSource?: string }).__werkSource;
    if (source) globals.__WERK_MOUNTED_SOURCES__.add(source);
  } });
});
const preview: Preview = {
  parameters: { layout: 'fullscreen', controls: { expanded: true }, options: { storySort: { order: ['System', 'Worker', 'Factory', 'Orchestrator', 'Shared', 'Concept', 'Guide'] } } },
  loaders: [async context => {
    globals.__WERK_STORYMAP__ = context.parameters.storymap;
    globals.__WERK_MOUNTED_SOURCES__ = new Set();
    globals.__WERK_STORY_ERRORS__ = [];
    globals.__WERK_STORY_READY__ = false;
    delete globals.__WERK_STORY_FETCH__;
    const meta = context.parameters.storymap ?? {};
    document.documentElement.classList.remove('dark');
    document.querySelector('#werk-story-styles')?.remove();
    const style = document.createElement('style'); style.id = 'werk-story-styles';
    const paths = meta.styles ?? [stylePaths[meta.app] ?? stylePaths.Worker];
    style.textContent = paths.map((path: string) => styles[`../${path}`] ?? '').join('\n') + '\nhtml,body{margin:0} .sb-show-main.sb-main-fullscreen{padding:0!important}';
    document.head.append(style);
    await router.replace(meta.route ?? (meta.app === 'Worker' ? '/taskboard' : '/'));
    await router.isReady();
    return {};
  }],
  afterEach: async () => { await nextTick(); globals.__WERK_STORY_READY__ = true; },
  decorators: [(story) => ({
    setup() { return () => h(UApp, null, { default: () => h(story()) }); },
  })],
};
export default preview;
