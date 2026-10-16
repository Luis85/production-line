import { readFile, writeFile, rm, realpath } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { build } from 'vite';
import vue from '@vitejs/plugin-vue';
import ui from '@nuxt/ui/vite';

/** One shared Vue/Nuxt UI compiler for every separately shipped webview. */
export function webviewConfig(root, outDir, standalone = false) {
  return {
    configFile: false, root, base: standalone ? './' : '/',
    plugins: [vue(), ui({ dts: false, autoImport: false, components: false, colorMode: false,
      ui: { colors: { primary: 'emerald', neutral: 'slate' } },
      icon: { clientBundle: { scan: { globInclude: ['**/*.{vue,jsx,tsx,md,mdc,mdx,yml,yaml,ts}'] }, icons: ['lucide:shield-check'], sizeLimitKb: 256 } } })],
    build: { target: 'es2022', emptyOutDir: true, outDir,
      ...(standalone ? { cssCodeSplit: false, assetsInlineLimit: Infinity, rollupOptions: { output: { inlineDynamicImports: true } } } : {}) }
  };
}
export async function buildWebview(projectRoot, source, destination) {
  await build(webviewConfig(await realpath(join(projectRoot, source)), destination));
}
/** Standalone explanations/exports use the same Vue components without a server or CDN. */
export async function buildStandaloneWebview(projectRoot, source, destination, scratch) {
  try {
    await build(webviewConfig(await realpath(join(projectRoot, source)), scratch, true));
    let html = await readFile(join(scratch, 'index.html'), 'utf8');
    const asset = async path => {
      if (!/^\.\/assets\/[a-zA-Z0-9_.-]+\.(?:js|css)$/.test(path)) throw Error('Unexpected standalone webview asset: ' + path);
      return readFile(resolve(scratch, path), 'utf8');
    };
    for (const match of [...html.matchAll(/<script\b[^>]*src="([^"]+)"[^>]*><\/script>/g)]) {
      const code = await asset(match[1]);
      html = html.replace(match[0], () => '<script type="module">' + code.replace(/<\/script/gi, '<\\/script') + '</script>');
    }
    for (const match of [...html.matchAll(/<link\b[^>]*rel="stylesheet"[^>]*href="([^"]+)"[^>]*>/g)]) {
      const css = await asset(match[1]);
      html = html.replace(match[0], () => '<style>' + css.replace(/<\/style/gi, '<\\/style') + '</style>');
    }
    html = html.replace(/<link\b[^>]*rel="modulepreload"[^>]*>/g, '');
    await writeFile(destination, html);
  } finally { await rm(scratch, { recursive: true, force: true }); }
}
