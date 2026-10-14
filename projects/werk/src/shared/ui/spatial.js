/* Shared, dependency-free spatial diagram. Models come from each owning surface. */
(() => {
  const el = (tag, text, className) => {
    const node = document.createElement(tag);
    if (text !== undefined) node.textContent = text;
    if (className) node.className = className;
    return node;
  };
  const button = (text, run) => { const node = el('button', text); node.type = 'button'; node.onclick = run; return node; };
  // Every model is assembled in world coordinates. Camera projection applies to
  // all vertices, so faces, ports and the ground share the same perspective.
  function componentParts(model) {
    const parts = [];
    const box = (x,z,y,w,d,h,accent=false) => parts.push({x,z,y,w,d,h,accent});
    switch (model) {
      case 'factory':
        box(0,0,0,112,80,8); box(-23,0,8,44,58,34); box(27,8,8,38,42,24);
        box(-23,0,42,48,62,5,true); box(27,8,32,42,46,5,true); break;
      case 'line':
        box(0,0,0,116,66,10); box(0,-24,10,102,6,9,true); box(0,24,10,102,6,9,true);
        for (const x of [-36,-12,12,36]) box(x,0,10,7,42,4); break;
      case 'orchestrator':
        box(0,0,0,80,70,7); box(0,0,7,54,48,72); box(0,0,79,58,52,5,true);
        break;
      case 'workers':
        box(0,0,0,116,76,7);
        for (const x of [-28,28]) { box(x,0,7,40,48,48); box(x,0,55,44,52,5,true); }
        break;
      case 'worker':
        box(0,0,0,90,76,7); box(0,0,7,62,52,58); box(0,0,65,66,56,5,true);
        break;
      case 'queue': case 'evidence':
        for (let i=0;i<3;i++) { box(i*5-5,i*4-4,i*13,84,58,8,i===2); }
        break;
      case 'profile':
        box(0,0,0,96,68,7); box(0,0,7,72,48,25); box(0,0,32,76,52,4,true);
        for (const x of [-20,0,20]) box(x,25,16,6,3,7,true); break;
      default:
        box(0,0,0,94,68,8); box(0,0,8,72,50,9,true); box(0,0,17,58,36,3);
    }
    return parts;
  }
  const rectangle = points => ({
    x:Math.min(...points.map(p=>p.x)), y:Math.min(...points.map(p=>p.y)),
    w:Math.max(...points.map(p=>p.x))-Math.min(...points.map(p=>p.x)),
    h:Math.max(...points.map(p=>p.y))-Math.min(...points.map(p=>p.y))
  });
  const overlaps = (a,b,gap=0) => a.x < b.x+b.w+gap && a.x+a.w+gap > b.x && a.y < b.y+b.h+gap && a.y+a.h+gap > b.y;
  function buildScene(nodes, {width=800,angle=-.42,zoom=1,mode='3d'}={}) {
    const minX=Math.min(...nodes.map(n=>n.x)), maxX=Math.max(...nodes.map(n=>n.x));
    const minZ=Math.min(...nodes.map(n=>n.z||0)), maxZ=Math.max(...nodes.map(n=>n.z||0));
    const cx=(minX+maxX)*120, cz=(minZ+maxZ)*120, cos=Math.cos(angle), sin=Math.sin(angle);
    const raw = (x,z,y=0) => {
      const dx=x-cx,dz=z-cz;
      if(mode==='2d') return {x:dx,y:dz,depth:dz};
      const depth=dx*sin+dz*cos;
      return {x:dx*cos-dz*sin,y:depth*.64-y*.77,depth:depth+y*.64/.77};
    };
    const ground=[[minX*240-92,minZ*240-80],[maxX*240+92,minZ*240-80],[maxX*240+92,maxZ*240+80],[minX*240-92,maxZ*240+80]];
    const extent=rectangle(ground.map(([x,z])=>raw(x,z)));
    const fit=Math.min(1,(width-80)/(extent.w+60));
    const scale=mode==='2d'?Math.max(.82,fit)*Math.max(1,zoom):Math.max(.55,fit)*zoom;
    const sceneWidth=Math.max(620,width,extent.w*scale+100);
    const offset={x:sceneWidth/2-(extent.x+extent.w/2)*scale,y:110-extent.y*scale};
    const project=(x,z,y=0)=>{const p=raw(x,z,y);return {x:offset.x+p.x*scale,y:offset.y+p.y*scale,depth:p.depth};};
    const models=nodes.map(node=>{
      const x=node.x*240,z=(node.z||0)*240,faces=[];
      if(mode==='3d') for(const part of componentParts(node.model)) {
        const x0=x+part.x-part.w/2,x1=x0+part.w,z0=z+part.z-part.d/2,z1=z0+part.d,y0=part.y,y1=y0+part.h;
        const vertices=[[x0,z0,y0],[x1,z0,y0],[x1,z1,y0],[x0,z1,y0],[x0,z0,y1],[x1,z0,y1],[x1,z1,y1],[x0,z1,y1]].map(p=>project(...p));
        const sides=[{indices:[4,5,6,7],normal:[0,0,1],light:.86},
          {indices:[0,1,5,4],normal:[0,-1,0],light:.40},{indices:[1,2,6,5],normal:[1,0,0],light:.53},
          {indices:[2,3,7,6],normal:[0,1,0],light:.61},{indices:[3,0,4,7],normal:[-1,0,0],light:.46}];
        for(const side of sides) {
          if(side.normal[0]*sin+side.normal[1]*cos+side.normal[2]*.64/.77<=0)continue;
          const points=side.indices.map(i=>vertices[i]);
          const details=[];
          if(side.normal[1]===1&&part.h>=48)for(const level of [.3,.58]) {
            details.push([project(x0+9,z1,part.y+part.h*level),project(x1-9,z1,part.y+part.h*level)]);
          }
          faces.push({points,details,depth:points.reduce((s,p)=>s+p.depth,0)/4,light:side.light,accent:part.accent});
        }
      }
      const center=project(x,z),bounds=mode==='3d'?rectangle(faces.flatMap(f=>f.points)):{x:center.x-87,y:center.y-35,w:174,h:70};
      return {node,center,faces,bounds};
    });
    const labels=[];
    if(mode==='3d') for(const item of [...models].sort((a,b)=>a.center.y-b.center.y||a.center.x-b.center.x)) {
      const {bounds,center}=item, w=154,h=47;
      let label;
      // Prefer a short, vertical association above or below the component.
      // Opposite-side candidates avoid pushing labels into a distant column.
      for(let ring=0;ring<30&&!label;ring++)for(const dx of [0,-1,1])for(const above of [true,false]) {
        if(label)break;
        const candidate={x:Math.max(10,Math.min(sceneWidth-w-10,center.x-w/2+dx*(w+12))),
          y:above?bounds.y-13-h-ring*55:bounds.y+bounds.h+13+ring*55,w,h};
        if(candidate.y>=10&&!models.some(m=>overlaps(candidate,m.bounds,6))&&!labels.some(l=>overlaps(candidate,l,6))) {label=candidate;break;}
      }
      label ||= {x:center.x-w/2,y:extent.h*scale+170+labels.length*55,w,h};
      label.id=item.node.id;item.label=label;labels.push(label);
    }
    const height=Math.max(390,extent.h*scale+150,...models.map(m=>m.bounds.y+m.bounds.h+35),...labels.map(l=>l.y+l.h+26));
    return {width:sceneWidth,height,scale,project,ground,models,labels};
  }
  const tint = (hex, light) => {
    const rgb=hex.replace('#','').match(/.{2}/g).map(v=>parseInt(v,16));
    return `rgb(${rgb.map(v=>Math.round(v*light)).join(',')})`;
  };
  function drawScene(c, scene, edges, selected, mode) {
    const path=(points,fill,stroke,width=1,dash=[])=>{
      c.beginPath();points.forEach((p,i)=>i?c.lineTo(p.x,p.y):c.moveTo(p.x,p.y));
      if(fill){c.closePath();c.fillStyle=fill;c.fill();}if(stroke){c.strokeStyle=stroke;c.lineWidth=width;c.setLineDash(dash);c.stroke();c.setLineDash([]);}
    };
    const rect=(r,fill,stroke,width=1)=>{
      c.beginPath();c.roundRect(r.x,r.y,r.w,r.h,5);c.fillStyle=fill;c.fill();if(stroke){c.strokeStyle=stroke;c.lineWidth=width;c.stroke();}
    };
    if(mode==='3d')path(scene.ground.map(p=>scene.project(...p)),'#152630','#304550');
    const byId=new Map(scene.models.map(m=>[m.node.id,m]));
    for(const edge of edges) {
      const from=byId.get(edge.from),to=byId.get(edge.to);if(!from||!to)continue;
      const a=from.center,b=to.center,dx=b.x-a.x,dy=b.y-a.y,length=Math.hypot(dx,dy);if(length<1)continue;
      const ux=dx/length,uy=dy/length;
      const radius=m=>mode==='2d'?Math.min(87/Math.max(Math.abs(ux),.001),35/Math.max(Math.abs(uy),.001))+5:55*scene.scale;
      const start=radius(from),end=radius(to);if(start+end>=length)continue;
      const p={x:a.x+ux*start,y:a.y+uy*start},q={x:b.x-ux*end,y:b.y-uy*end};
      const active=from.node.id===selected||to.node.id===selected,color=active?(edge.color||'#a3bdc8'):'#536e7b';
      path([p,q],null,color,active?1.8:1.3,edge.dashed?[5,5]:[]);
      const t=.64,x=p.x+(q.x-p.x)*t,y=p.y+(q.y-p.y)*t;
      path([{x:x-ux*7-uy*4,y:y-uy*7+ux*4},{x,y},{x:x-ux*7+uy*4,y:y-uy*7-ux*4}],null,color,1.6);
    }
    if(mode==='3d') {
      for(const {node,center} of scene.models) {
        c.beginPath();c.ellipse(center.x+3,center.y+7,54*scene.scale,17*scene.scale,0,0,Math.PI*2);c.fillStyle='#0b161c80';c.fill();
        if(node.id===selected) {
          const x=node.x*240,z=(node.z||0)*240;
          path([[-69,-49],[69,-49],[69,49],[-69,49],[-69,-49]].map(([dx,dz])=>scene.project(x+dx,z+dz)),null,node.color||'#8be0b8',1.5);
        }
      }
      // Painter's ordering covers faces across every part and every model.
      const faces=scene.models.flatMap(m=>m.faces.map(face=>({...face,node:m.node})));
      faces.sort((a,b)=>a.depth-b.depth);
      for(const face of faces) {
        path(face.points,tint(face.accent?face.node.color||'#8be0b8':'#74919f',face.light),'#152630',.75);
        for(const detail of face.details)path(detail,null,face.node.color||'#8be0b8',1.5);
      }
    }
    const hits=[];
    for(const item of scene.models) {
      const {node,center,bounds}=item,color=node.color||'#8be0b8',active=node.id===selected;
      const label=mode==='3d'?item.label:bounds;
      if(mode==='3d') {
        const above=label.y+label.h<=bounds.y;
        const anchor={x:bounds.x+bounds.w/2,y:above?bounds.y:bounds.y+bounds.h};
        const end={x:label.x+label.w/2,y:above?label.y+label.h:label.y};
        if(Math.abs(end.x-anchor.x)>10||Math.abs(end.y-anchor.y)>24)path([anchor,end],null,'#647f8c',1,[2,3]);
      }
      rect(label,active?'#1d353d':'#132129',active?color:mode==='2d'?'#4a6572':null);
      if(mode==='2d') {c.fillStyle=color;c.fillRect(label.x+12,label.y+15,5,5);}
      const shorten=(text,max)=>{let value=String(text);while(value.length>1&&c.measureText(value+'…').width>max)value=value.slice(0,-1);return value===String(text)?value:value.trimEnd()+'…';};
      c.textAlign='center';c.font='600 14px system-ui';c.fillStyle=active?color:'#edf4f7';
      c.fillText(shorten(node.shortLabel||node.label,label.w-24),label.x+label.w/2,label.y+(mode==='3d'?18:28));
      c.font='12px system-ui';c.fillStyle='#b5c4cd';c.fillText(shorten(node.reading||node.kind,label.w-20),label.x+label.w/2,label.y+(mode==='3d'?36:49));
      hits.push({id:node.id,...bounds},{id:node.id,...label});
    }
    return hits;
  }

  class SpatialMap {
    constructor(root, { label, english = false } = {}) {
      this.root = root; this.english = english; this.nodes = []; this.edges = []; this.selected = ''; this.angle = -.42; this.zoom = 1; this.mode = '3d';
      root.classList.add('spatial');
      this.toolbar = el('div', undefined, 'spatial-toolbar'); this.toolbar.setAttribute('role', 'group'); this.toolbar.setAttribute('aria-label', label);
      this.mode3 = button('3D', () => this.setMode('3d')); this.mode2 = button('2D', () => this.setMode('2d'));
      this.left = button(english ? 'Rotate left' : 'Links drehen', () => { this.angle -= .18; this.draw(); });
      this.right = button(english ? 'Rotate right' : 'Rechts drehen', () => { this.angle += .18; this.draw(); });
      this.plus = button(english ? 'Zoom in' : 'Vergrößern', () => { this.zoom = Math.min(1.6, this.zoom + .15); this.draw(); });
      this.minus = button(english ? 'Zoom out' : 'Verkleinern', () => { this.zoom = Math.max(this.mode === '2d' ? 1 : .55, this.zoom - .15); this.draw(); });
      this.reset = button(english ? 'Reset view' : 'Ansicht zurücksetzen', () => { this.angle = -.42; this.zoom = 1; this.draw(); });
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
      this.mode = mode; if(mode === '2d') this.zoom = Math.max(1,this.zoom); this.mode3.setAttribute('aria-pressed', String(mode === '3d')); this.mode2.setAttribute('aria-pressed', String(mode === '2d'));
      this.left.disabled = this.right.disabled = mode === '2d'; this.draw();
    }
    update({ nodes, edges = [], caption, legend }) {
      const focused = this.list.contains(document.activeElement) ? document.activeElement?.dataset?.spatialNode : null;
      const focusedAction = this.actions.contains(document.activeElement) ? document.activeElement.textContent : null;
      this.nodes = nodes; this.edges = edges; this.caption.textContent = caption; this.legend.textContent = legend + (this.english ? ' Shapes identify component types, not instance counts.' : ' Formen kennzeichnen Komponententypen, keine Anzahl von Instanzen.') + (innerWidth < 760 ? (this.english ? ' Pan the diagram or use the component buttons below.' : ' Diagramm verschieben oder die Komponenten darunter wählen.') : '');
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
      const scene = this.nodes.length ? buildScene(this.nodes, {
        width:Math.max(620,this.scroll.clientWidth), angle:this.angle, zoom:this.zoom, mode:this.mode
      }) : {width:Math.max(620,this.scroll.clientWidth),height:390};
      this.minus.disabled=this.zoom <= (this.mode === '2d' ? 1 : .55);
      this.plus.disabled=this.zoom >= 1.6;
      const ratio=Math.min(window.devicePixelRatio||1,2);
      this.canvas.width=scene.width*ratio;this.canvas.height=scene.height*ratio;
      this.canvas.style.width=scene.width+'px';this.canvas.style.height=scene.height+'px';
      const c=this.canvas.getContext('2d');if(!c)return;c.scale(ratio,ratio);
      if(!this.nodes.length){this.hits=[];c.fillStyle='#b5c4cd';c.font='16px system-ui';c.fillText(this.english?'No components in this scope':'Keine Komponenten in diesem Bereich',24,100);return;}
      this.hits=drawScene(c,scene,this.edges,this.selected,this.mode);
    }
  }
  globalThis.WerkSpatial = { SpatialMap, el, button, buildScene };
})();
