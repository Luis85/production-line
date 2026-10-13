/* Shared, dependency-free spatial diagram. Models come from each owning surface. */
(() => {
  const el = (tag, text, className) => {
    const node = document.createElement(tag);
    if (text !== undefined) node.textContent = text;
    if (className) node.className = className;
    return node;
  };
  const button = (text, run) => { const node = el('button', text); node.type = 'button'; node.onclick = run; return node; };
  class SpatialMap {
    constructor(root, { label, english = false } = {}) {
      this.root = root; this.english = english; this.nodes = []; this.edges = []; this.selected = ''; this.angle = -.32; this.zoom = 1; this.mode = '3d';
      root.classList.add('spatial');
      this.toolbar = el('div', undefined, 'spatial-toolbar'); this.toolbar.setAttribute('role', 'group'); this.toolbar.setAttribute('aria-label', label);
      this.mode3 = button('3D', () => this.setMode('3d')); this.mode2 = button('2D', () => this.setMode('2d'));
      this.left = button(english ? 'Rotate left' : 'Links drehen', () => { this.angle -= .18; this.draw(); });
      this.right = button(english ? 'Rotate right' : 'Rechts drehen', () => { this.angle += .18; this.draw(); });
      this.plus = button(english ? 'Zoom in' : 'Vergrößern', () => { this.zoom = Math.min(1.6, this.zoom + .15); this.draw(); });
      this.minus = button(english ? 'Zoom out' : 'Verkleinern', () => { this.zoom = Math.max(.55, this.zoom - .15); this.draw(); });
      this.reset = button(english ? 'Reset view' : 'Ansicht zurücksetzen', () => { this.angle = -.32; this.zoom = 1; this.draw(); });
      this.toolbar.append(this.mode3, this.mode2);
      this.camera = el('details', undefined, 'spatial-camera'); this.camera.open = innerWidth > 760;
      const cameraControls = el('div', undefined, 'spatial-toolbar'); cameraControls.append(this.left, this.right, this.plus, this.minus, this.reset);
      this.camera.append(el('summary', english ? 'Camera & zoom' : 'Kamera & Zoom'), cameraControls);
      const layout = el('div', undefined, 'spatial-layout'); const stage = el('div', undefined, 'spatial-stage');
      this.caption = el('p', english ? 'Select a component to explore its responsibility.' : 'Komponente wählen, Zusammenhang verstehen, gezielt weiterarbeiten.', 'spatial-caption');
      this.scroll = el('div', undefined, 'spatial-scroll'); this.scroll.tabIndex = 0; this.scroll.setAttribute('role', 'region'); this.scroll.setAttribute('aria-label', label);
      this.canvas = el('canvas'); this.canvas.setAttribute('aria-hidden', 'true'); this.scroll.append(this.canvas);
      this.legend = el('p', undefined, 'spatial-legend');
      this.list = el('div', undefined, 'spatial-nodes'); this.list.setAttribute('role', 'group'); this.list.setAttribute('aria-label', english ? 'Select component' : 'Komponente auswählen');
      stage.append(this.caption, this.scroll, this.camera, this.legend, this.list);
      this.inspector = el('aside', undefined, 'spatial-inspector'); this.inspector.setAttribute('aria-label', english ? 'Selected component' : 'Gewählte Komponente');
      this.title = el('h2'); this.title.tabIndex = -1;
      this.kind = el('p', undefined, 'spatial-kind'); this.description = el('p'); this.facts = el('dl'); this.actions = el('div', undefined, 'spatial-actions');
      this.inspector.append(this.title, this.kind, this.description, this.facts, this.actions); layout.append(stage, this.inspector); root.append(this.toolbar, layout);
      this.canvas.onpointerdown = event => { this.drag = { x: event.clientX, angle: this.angle, moved: false }; if(event.pointerType !== 'touch') this.canvas.setPointerCapture(event.pointerId); };
      this.canvas.onpointermove = event => {
        if (!this.drag || this.mode !== '3d' || event.pointerType === 'touch') return;
        if (Math.abs(event.clientX - this.drag.x) > 5) this.drag.moved = true;
        if (this.drag.moved) { this.angle = this.drag.angle + (event.clientX - this.drag.x) / 280; this.draw(); }
      };
      this.canvas.onpointerup = event => {
        if (!this.drag?.moved) {
          const rect = this.canvas.getBoundingClientRect(), x = event.clientX - rect.left, y = event.clientY - rect.top;
          const hit = [...(this.hits || [])].reverse().find(h => x >= h.x && x <= h.x + h.w && y >= h.y && y <= h.y + h.h);
          if (hit) this.select(hit.id);
        }
        this.drag = null;
      };
      this.canvas.onpointercancel = () => { this.drag = null; };
      this.scroll.onkeydown = event => {
        if (event.target !== this.scroll) return;
        // Native arrow-key scrolling pans the diagram in both modes. Rotation has named buttons.
        if (event.key === 'Home') { event.preventDefault(); this.reset.click(); }
      };
      this.observer = new ResizeObserver(() => this.draw()); this.observer.observe(this.scroll); this.setMode('3d');
    }
    setMode(mode) {
      this.mode = mode; this.mode3.setAttribute('aria-pressed', String(mode === '3d')); this.mode2.setAttribute('aria-pressed', String(mode === '2d'));
      this.left.disabled = this.right.disabled = mode === '2d'; this.draw();
    }
    update({ nodes, edges = [], caption, legend }) {
      const focused = this.list.contains(document.activeElement) ? document.activeElement?.dataset?.spatialNode : null;
      const focusedAction = this.actions.contains(document.activeElement) ? document.activeElement.textContent : null;
      this.nodes = nodes; this.edges = edges; this.caption.textContent = caption; this.legend.textContent = legend + (innerWidth < 760 ? (this.english ? ' Swipe the diagram horizontally or use the component buttons below.' : ' Diagramm horizontal verschieben oder die Komponenten darunter wählen.') : '');
      if (!nodes.some(node => node.id === this.selected)) this.selected = nodes[0]?.id || '';
      this.list.replaceChildren();
      for (const node of nodes) {
        const control = button(node.label, () => this.select(node.id)); control.dataset.spatialNode = node.id;
        control.title = node.kind + ' · ' + (node.reading || ''); this.list.append(control);
        if (focused === node.id) control.focus({ preventScroll: true });
      }
      this.select(this.selected, false);
      if (focusedAction) [...this.actions.children].find(control => control.textContent === focusedAction)?.focus({preventScroll:true});
    }
    select(id, announce = true) {
      this.selected = id; const node = this.nodes.find(item => item.id === id);
      for (const control of this.list.children) control.setAttribute('aria-pressed', String(control.dataset.spatialNode === id));
      this.facts.replaceChildren(); this.actions.replaceChildren();
      this.title.textContent = node?.label || (this.english ? 'No components' : 'Keine Komponenten');
      this.kind.textContent = node ? node.kind + (node.reading ? ' · ' + node.reading : '') : '';
      this.description.textContent = node?.description || (this.english ? 'Choose another scope.' : 'Wähle einen anderen Bereich oder lege eine Fabrik an.');
      for (const [label, value] of node?.facts || []) { const pair = el('div'); pair.append(el('dt', label), el('dd', String(value ?? 'Unbekannt'))); this.facts.append(pair); }
      for (const action of node?.actions || []) {
        let control;
        if (action.href) { control = el('a', action.label); control.href = action.href; if (action.newTab) { control.target = '_blank'; control.rel = 'noopener noreferrer'; control.setAttribute('aria-label', action.label + (this.english ? ' (new tab)' : ' (neuer Tab)')); } }
        else control = button(action.label, action.run);
        if (action.disabled) { control.disabled = true; control.title = action.reason || ''; }
        this.actions.append(control);
      }
      if (announce && node) this.title.focus({ preventScroll: innerWidth > 1100 }); this.draw();
    }
    draw() {
      if (!this.canvas || !this.root.isConnected) return;
      const width = Math.max(620, this.scroll.clientWidth), rows = Math.max(1, ...this.nodes.map(n => n.z || 0));
      const height = Math.max(370, Math.min(700, 320 + rows * 45));
      const ratio = Math.min(window.devicePixelRatio || 1, 2); this.canvas.width = width * ratio; this.canvas.height = height * ratio;
      this.canvas.style.width = width + 'px'; this.canvas.style.height = height + 'px';
      const c = this.canvas.getContext('2d'); if (!c) return; c.scale(ratio, ratio); c.clearRect(0, 0, width, height); this.hits = [];
      if (!this.nodes.length) { c.fillStyle = '#b5c4cd'; c.font = '16px system-ui'; c.fillText(this.english ? 'No components in this scope' : 'Keine Komponenten in diesem Bereich', 24, 100); return; }
      const xs = this.nodes.map(n => n.x), zs = this.nodes.map(n => n.z || 0), cx = (Math.min(...xs) + Math.max(...xs)) / 2, cz = (Math.min(...zs) + Math.max(...zs)) / 2;
      const raw = (x, z, y = 0) => {
        x = (x - cx) * 175; z = (z - cz) * 140;
        if (this.mode === '2d') return { x, y: z - y * .2, depth: z };
        const xx = x * Math.cos(this.angle) - z * Math.sin(this.angle), zz = x * Math.sin(this.angle) + z * Math.cos(this.angle);
        return { x: xx, y: zz * .58 - y, depth: zz };
      };
      const bounds = this.nodes.map(n => raw(n.x, n.z || 0));
      const spanX = Math.max(...bounds.map(p => p.x)) - Math.min(...bounds.map(p => p.x)) + 220, spanY = Math.max(...bounds.map(p => p.y)) - Math.min(...bounds.map(p => p.y)) + 200;
      const scale = Math.min((width - 60) / spanX, (height - 40) / spanY, 1.3) * this.zoom;
      const project = (x,z,y=0) => { const p = raw(x,z,y); return { x: width/2 + p.x*scale, y: height/2 + 24 + p.y*scale, depth:p.depth }; };
      const stroke = (points, color, dash = []) => { c.beginPath(); points.forEach((p,i) => i ? c.lineTo(p.x,p.y) : c.moveTo(p.x,p.y)); c.strokeStyle = color; c.setLineDash(dash); c.stroke(); c.setLineDash([]); };
      if (this.mode === '3d') {
        c.lineWidth = 1;
        for (let x = Math.min(...xs)-.6; x <= Math.max(...xs)+.7; x += .5) stroke([project(x,Math.min(...zs)-.5),project(x,Math.max(...zs)+.5)], '#263c47');
        for (let z = Math.min(...zs)-.5; z <= Math.max(...zs)+.6; z += .5) stroke([project(Math.min(...xs)-.6,z),project(Math.max(...xs)+.6,z)], '#263c47');
      }
      const centers = new Map(this.nodes.map(n => [n.id,project(n.x,n.z||0)]));
      for (const edge of this.edges) {
        const a=centers.get(edge.from), b=centers.get(edge.to); if(!a||!b)continue;
        c.lineWidth = 2; stroke([a,b], edge.color || '#7399aa', edge.dashed ? [6,5] : []);
        const t=.67, x=a.x+(b.x-a.x)*t, y=a.y+(b.y-a.y)*t, angle=Math.atan2(b.y-a.y,b.x-a.x);
        stroke([{x:x-8*Math.cos(angle-.5),y:y-8*Math.sin(angle-.5)},{x,y},{x:x-8*Math.cos(angle+.5),y:y-8*Math.sin(angle+.5)}],edge.color||'#7399aa');
      }
      const ordered = [...this.nodes].sort((a,b)=>centers.get(a.id).depth-centers.get(b.id).depth);
      for (const node of ordered) {
        const p=centers.get(node.id), boxWidth=Math.min(130,140*scale), selected=node.id===this.selected, color=node.color||'#8be0b8';
        const w=68*scale, d=22*scale, h=(node.height||48)*scale, top=this.mode==='3d'?p.y-h:p.y-26;
        if(this.mode==='3d') {
          const polygon=(points,fill)=>{c.beginPath();points.forEach(([x,y],i)=>i?c.lineTo(x,y):c.moveTo(x,y));c.closePath();c.fillStyle=fill;c.fill();c.strokeStyle=selected?color:'#4a6572';c.lineWidth=selected?2:1;c.stroke();};
          polygon([[p.x-w/2,top],[p.x+w/2,top+d/2],[p.x+w/2,p.y+d/2],[p.x-w/2,p.y]],'#29404c');
          polygon([[p.x+w/2,top+d/2],[p.x+w/2+d,top-d/2],[p.x+w/2+d,p.y-d/2],[p.x+w/2,p.y+d/2]],'#1a2e38');
          polygon([[p.x-w/2,top],[p.x-w/2+d,top-d],[p.x+w/2+d,top-d/2],[p.x+w/2,top+d/2]],color);
          for(let i=0;i<2;i++)stroke([{x:p.x-w/2+10,y:top+18+i*8},{x:p.x+w/2-10,y:top+d/2+18+i*8}],color);
        } else {
          c.fillStyle=selected?'#253f43':'#1b2d37';c.fillRect(p.x-boxWidth/2,p.y-30,boxWidth,54);c.strokeStyle=color;c.lineWidth=selected?3:1;c.strokeRect(p.x-boxWidth/2,p.y-30,boxWidth,54);
        }
        const labelY=this.mode==='3d'?top-d-29:p.y-10;
        c.font='600 14px system-ui';c.textAlign='center';
        const shorten=(text,max)=>{let s=String(text);while(s.length>2&&c.measureText(s).width>max)s=s.slice(0,-2)+'…';return s;};
        const labelWidth=this.mode==='2d'?boxWidth-12:Math.min(150,Math.max(84,140*scale));
        const label=shorten(node.shortLabel||node.label,labelWidth), reading=shorten(node.reading||node.kind,labelWidth);
        if(this.mode==='3d'){c.fillStyle='#132129';c.fillRect(p.x-82,labelY-16,164,42);}
        c.fillStyle=selected?color:'#edf4f7';c.fillText(label,p.x,labelY);c.font='12px system-ui';c.fillStyle='#b5c4cd';c.fillText(reading,p.x,labelY+19);
        this.hits.push({id:node.id,x:p.x-84,y:Math.min(labelY-18,top-d),w:168,h:p.y+30-Math.min(labelY-18,top-d)});
      }
    }
  }
  globalThis.WerkSpatial = { SpatialMap, el, button };
})();
