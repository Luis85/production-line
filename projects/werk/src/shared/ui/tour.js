/* Guided tours are read-only, replayable and do not retain credentials or completion state. */
(() => {
  let activeTour;
  globalThis.WerkTour = function tour(title, steps, trigger) {
    activeTour?.close(false);
    if (!steps.length) return { close() {} };
    const dialog = document.createElement('dialog'); dialog.dataset.werkTour = ''; dialog.className = 'werk-tour';
    dialog.setAttribute('aria-labelledby', 'werk-tour-heading');
    const progress = document.createElement('p'), heading = document.createElement('h2'), body = document.createElement('p'), actions = document.createElement('div');
    heading.id = 'werk-tour-heading'; heading.tabIndex = -1; progress.className = 'werk-tour-progress'; actions.className = 'werk-tour-actions';
    let index = 0, highlighted = null, revision = 0;
    const clear = () => { highlighted?.classList.remove('werk-tour-target'); highlighted = null; };
    const close = (restoreFocus = true) => { revision++; clear(); dialog.remove(); if (activeTour?.dialog === dialog) activeTour = null; if (restoreFocus && trigger?.isConnected) trigger.focus(); };
    const button = (text, action) => { const node = document.createElement('button'); node.type = 'button'; node.textContent = text; node.onclick = action; return node; };
    const back = button('Back', () => { index--; void show(); }), next = button('Next', () => { if (index === steps.length - 1) close(); else { index++; void show(); } }), skip = button('Close tour', () => close());
    actions.append(back, next, skip); dialog.append(progress, heading, body, actions); document.body.append(dialog);
    async function show() {
      const own = ++revision;
      clear(); const step = steps[index];
      progress.textContent = title + ' · ' + (index + 1) + ' / ' + steps.length;
      heading.textContent = step.title; body.textContent = step.text;
      back.disabled = next.disabled = true; dialog.setAttribute('aria-busy', 'true');
      try { await step.activate?.(); }
      catch { if (own === revision) body.textContent = step.text + ' This view could not be opened. Close the tour and retry from the page navigation.'; }
      if (own !== revision || !dialog.isConnected) return;
      back.disabled = index === 0; next.disabled = false; next.textContent = index === steps.length - 1 ? 'Finish' : 'Next'; dialog.setAttribute('aria-busy', 'false');
      requestAnimationFrame(() => {
        if (own !== revision || !dialog.isConnected) return;
        highlighted = step.target ? document.querySelector(step.target) : null;
        if (highlighted) { highlighted.classList.add('werk-tour-target'); highlighted.scrollIntoView({ block: 'center', behavior: 'instant' }); }
        heading.focus({ preventScroll: true });
      });
    }
    dialog.addEventListener('keydown', event => { if (event.key === 'Escape') { event.preventDefault(); close(); } });
    activeTour = { close, dialog }; dialog.show(); void show(); return { close: () => close() };
  };
})();
