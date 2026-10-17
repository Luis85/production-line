import { defineComponent, h, onBeforeUnmount, onMounted, nextTick, ref } from 'vue';
import { mountDocumentation } from '../scripts/storybook/documentation-client.mjs';
import './documentation.css';

/** Use exactly the generated handbook, including links and search, in Storybook. */
export const DocumentationPage = defineComponent({
  props: { page: { type: String, required: true } },
  setup(props) {
    const content = ref(''), error = ref(''), container = ref<HTMLElement>();
    const controller = new AbortController(); let cleanup: (() => void) | undefined;
    onMounted(async () => {
      try {
        const response = await fetch(`handbook/${encodeURIComponent(props.page)}.html`, { signal: controller.signal });
        if (!response.ok) throw Error(`Documentation could not be loaded (${response.status}).`);
        const document = new DOMParser().parseFromString(await response.text(), 'text/html');
        const surface = document.querySelector('.werk-docs');
        if (!surface) throw Error('The generated documentation page is missing.');
        for (const link of surface.querySelectorAll('a[href]')) {
          const href = link.getAttribute('href')!;
          if (!href.startsWith('#')) link.setAttribute('href', new URL(href, response.url).href);
        }
        if (controller.signal.aborted) return;
        content.value = surface.outerHTML; await nextTick();
        if (!controller.signal.aborted && container.value) cleanup = mountDocumentation(container.value);
      } catch (reason) { if (!controller.signal.aborted) error.value = reason instanceof Error ? reason.message : String(reason); }
    });
    onBeforeUnmount(() => { controller.abort(); cleanup?.(); });
    return () => error.value ? h('p', { class: 'docs-error', role: 'alert' }, error.value)
      : content.value ? h('div', { ref: container, innerHTML: content.value })
      : h('p', { class: 'docs-loading', role: 'status' }, 'Loading documentation…');
  },
});
export function documentationStory(page: string, summary: string) {
  return { args: { page }, parameters: { controls: { disable: true }, actions: { disable: true },
    storymap: { app: 'Documentation', kind: 'documentation', document: page, summary, covers: [], styles: [], ready: `[data-document="${page}"] .docs-prose h1` } } };
}
