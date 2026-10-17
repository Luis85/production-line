/** Shared by standalone documentation and the Storybook canvas. Returns lifecycle cleanup. */
export function mountDocumentation(root) {
  const surface = root.querySelector('.werk-docs');
  if (!surface) return () => {};
  const menu = surface.querySelector('.docs-menu');
  const media = window.matchMedia('(min-width: 960px)');
  const resize = () => { menu.open = media.matches; };
  resize(); media.addEventListener('change', resize);
  const search = surface.querySelector('#docs-search');
  const entries = [...surface.querySelectorAll('[data-doc-entry]')];
  const filter = () => {
    const query = search.value.trim().toLocaleLowerCase();
    let matches = 0;
    for (const entry of entries) { entry.hidden = !entry.dataset.docSearch.includes(query); if (!entry.hidden) matches++; }
    for (const group of surface.querySelectorAll('.docs-nav-group')) group.hidden = !group.querySelector('[data-doc-entry]:not([hidden])');
    surface.querySelector('#docs-search-status').textContent = query ? `${matches} matching pages${matches ? '' : '. Try another search.'}` : '';
  };
  search.addEventListener('input', filter);
  const cleanups = [];
  for (const pre of surface.querySelectorAll('pre')) {
    const code = pre.querySelector('code'); if (!code) continue;
    const button = document.createElement('button'); button.type = 'button'; button.className = 'docs-copy'; button.textContent = 'Copy'; button.setAttribute('aria-label', 'Copy code example');
    const status = document.createElement('output'); status.className = 'docs-copy-status'; status.setAttribute('aria-live', 'polite');
    const copy = async () => {
      try { await navigator.clipboard.writeText(code.textContent); status.textContent = 'Copied'; }
      catch { const range = document.createRange(); range.selectNodeContents(code); const selection = window.getSelection(); selection.removeAllRanges(); selection.addRange(range); status.textContent = 'Code selected. Use your device’s copy command.'; }
    };
    button.addEventListener('click', copy); pre.before(button, status); cleanups.push(() => { button.removeEventListener('click', copy); button.remove(); status.remove(); });
  }
  return () => { media.removeEventListener('change', resize); search.removeEventListener('input', filter); cleanups.forEach(cleanup => cleanup()); };
}
