/* Guided tours are read-only, replayable and do not retain credentials or completion state. */
(() => {
  globalThis.WerkTour = function tour(title, steps, trigger) {
    document.querySelector('[data-werk-tour]')?.remove();
    const dialog = document.createElement('dialog'); dialog.dataset.werkTour = ''; dialog.className = 'werk-tour';
    dialog.setAttribute('aria-labelledby', 'werk-tour-heading');
    const progress = document.createElement('p'), heading = document.createElement('h2'), body = document.createElement('p'), actions = document.createElement('div');
    heading.id = 'werk-tour-heading'; heading.tabIndex = -1; progress.className = 'werk-tour-progress'; actions.className = 'werk-tour-actions';
    let index = 0, highlighted = null;
    const clear = () => { highlighted?.classList.remove('werk-tour-target'); highlighted = null; };
    const close = () => { clear(); dialog.remove(); if (trigger?.isConnected) trigger.focus(); };
    const button = (text, action) => { const node = document.createElement('button'); node.type = 'button'; node.textContent = text; node.onclick = action; return node; };
    const back = button('Back', () => { index--; show(); }), next = button('Next', () => { if (index === steps.length - 1) close(); else { index++; show(); } }), skip = button('Close tour', close);
    actions.append(back, next, skip); dialog.append(progress, heading, body, actions); document.body.append(dialog);
    function show() {
      clear(); const step = steps[index]; step.activate?.();
      progress.textContent = title + ' · ' + (index + 1) + ' / ' + steps.length;
      heading.textContent = step.title; body.textContent = step.text;
      back.disabled = index === 0; next.textContent = index === steps.length - 1 ? 'Finish' : 'Next';
      requestAnimationFrame(() => { if (!dialog.isConnected) return; highlighted = step.target ? document.querySelector(step.target) : null; if (highlighted) { highlighted.classList.add('werk-tour-target'); highlighted.scrollIntoView({ block: 'center', behavior: 'instant' }); } heading.focus({ preventScroll: true }); });
    }
    dialog.addEventListener('keydown', event => { if (event.key === 'Escape') { event.preventDefault(); close(); } });
    dialog.show(); show(); return { close };
  };
})();
