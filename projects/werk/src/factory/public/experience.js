/* Live Factory model: no individual workers are inferred from summary counts. */
(() => {
  const { SpatialMap, el, button } = WerkSpatial;
  const mount = el('section'); mount.id = 'factory-spatial'; mount.setAttribute('aria-label', 'Live-Systemkarte');
  const content = document.querySelector('.content');
  content.insertBefore(mount, document.querySelector('.freshness').nextSibling);
  const map = new SpatialMap(mount, {label:'Systemkarte: 3D oder 2D'});
  // Keep operational detail available without making it the entry experience.
  for (const id of ['access-summary','managed-registry-note','next-step']) {
    const node = $('#'+id); const details = el('details',undefined,'visual-help'); const summary = el('summary',id==='access-summary'?'Zugriff':id==='managed-registry-note'?'Systemdefinition & Änderungen':'Nächster Schritt'); details.append(summary,node); content.append(details);
  }
  const overview = $('#overview-heading').closest('section');
  const summary = el('details',undefined,'visual-help'); summary.append(el('summary','Summen & Datenabdeckung'),overview); content.append(summary);
  const registry=$('#lines-heading').closest('section'),registryHelp=el('details',undefined,'visual-help');registry.before(registryHelp);registryHelp.append(el('summary','Registrierungen, Verbindungen & Tabelle'),registry);
  const addLine=$('#register-line');mount.before(addLine);
  const hierarchyHelp=el('details',undefined,'visual-help');hierarchyHelp.open=innerWidth>760;const tree=$('#factory-tree').parentElement;tree.before(hierarchyHelp);hierarchyHelp.append(el('summary','Hierarchie & Verwaltung'),tree,$('#create-factory').parentElement);
  $('#lines-heading').nextElementSibling.textContent='2D-Verbindungen und Tabelle zeigen dieselben Beobachtungen wie die Systemkarte. Öffne eine Linie für Aufträge, Worker und Messwerte.';
  const rawRender = renderOverview;
  renderOverview = function(overview, options = {}) { rawRender(overview,options); renderMap(overview,options); };
  const originalConnect=connect;connect=async function(event){await originalConnect(event);if(state.token&&$('#message').dataset.kind!=='error')notice('');};$('#login-form').onsubmit=connect;
  const rawDisconnect = disconnect;
  disconnect = function(options) { rawDisconnect(options); map.update({nodes:[],caption:'Nicht verbunden',legend:''}); };
  $('#disconnect').onclick=()=>disconnect();
  function renderMap(overview,{stale=false,loading=false}={}) {
    const lines=selectedLines(), visible=lines.slice(0,12), byId=new Map((overview?.lines||[]).map(item=>[item.line.id,item]));
    const ids=descendants(state.scope), factories=state.factories.filter(f=>ids.has(f.id)).sort((a,b)=>factoryPath(a.id).localeCompare(factoryPath(b.id))).slice(0,20);
    const nodes=[],edges=[], ownerRows=new Map();
    factories.forEach((factory,i)=>ownerRows.set(factory.id,i*1.5));
    for(const factory of factories) {
      const row=ownerRows.get(factory.id);
      nodes.push({id:'f:'+factory.id,label:factory.name,kind:'Fabrik',reading:factory.parentId?'Unterfabrik':'Portfolio',x:0,z:row,height:35,color:'#81b6ee',description:'Gruppiert Linien und Unterfabriken. Die Fabrik beobachtet deren Zustand; Aufträge werden innerhalb einer Linie ausgeführt.',facts:[['Zuordnung',factoryPath(factory.id)],['Verwaltung',isManaged('factory',factory.id)?'Systemdefinition (YAML)':'Im Browser bearbeitbar']],actions:[{label:'Bereich öffnen',run:()=>navigate(factory.id)},{label:'Fabrik bearbeiten',run:()=>openFactory(factory),disabled:!state.canWrite||isManaged('factory',factory.id),reason:isManaged('factory',factory.id)?managedGuidance:'Nur Lesezugriff'},{label:'Systemdefinition verstehen',href:'/guide#deployment',newTab:true}]});
      if(factories.some(f=>f.id===factory.parentId))edges.push({from:'f:'+factory.parentId,to:'f:'+factory.id,color:'#81b6ee'});
    }
    const ownerOffsets=new Map();
    for(const [index,line] of visible.entries()) {
      const observation=byId.get(line.id), value=observation?.overview;
      const old=stale||Boolean(observation&&Date.now()-Date.parse(observation.checkedAt)>45000);
      const reading=old?'Veralteter Stand':observation?statusNames[observation.status]||'Unbekannt':loading?'Wird geladen':'Unbekannt';
      const offset=ownerOffsets.get(line.factoryId)||0;ownerOffsets.set(line.factoryId,offset+1);
      const z=index*1.4;const color=old||observation?.status!=='available'?'#edc47e':'#8be0b8';
      const url=safeWebview(line.webviewUrl);
      const actions=url?[{label:'Linienkarte öffnen',href:new URL('#system',url).href,newTab:true},{label:'Auftrag übergeben',href:new URL('#intake',url).href,newTab:true}]:[];
      actions.push({label:'Registrierung bearbeiten',run:()=>openLine(line),disabled:!state.canWrite||isManaged('line',line.id),reason:isManaged('line',line.id)?managedGuidance:'Nur Lesezugriff'});
      const facts=[['Fabrik',factoryPath(line.factoryId)],['Projekt',value?.project],['Beobachtet',observation?time(observation.checkedAt):'Noch nicht abgefragt'],['Verwaltung',isManaged('line',line.id)?'Systemdefinition · Migration für Änderungen':'Browser'],['Fehler',observation?.error||'Kein gemeldeter Fehler']];
      nodes.push({id:'l:'+line.id,label:line.name,kind:'Produktionslinie',reading,x:1,z,height:30,color,description:'Eine unabhängige Linie verbindet ihren Orchestrator mit dem eigenen Worker-Pool. Wähle den nächsten Arbeitsbereich.',facts,actions});
      nodes.push({id:'o:'+line.id,label:'Orchestrator · '+line.name,shortLabel:'Orch. '+line.name,kind:'Orchestrator',reading:value?count(value.tasks.running)+' aktiv · '+count(value.tasks.queued)+' wartet':'Aufträge unbekannt',x:2,z,height:65,color,description:'Speichert Aufträge, vergibt begrenzte Reservierungen und sammelt Ereignisse und Snapshots dieser Linie.',facts:[['Aufträge gesamt',value?.tasks.total],['Simuliert',value?.tasks.simulated],['Klärung erforderlich',value?.tasks.blocked],['Beobachtung',reading]],actions:url?[{label:'Taskboard öffnen',href:new URL('#tasks',url).href,newTab:true}]:[]});
      nodes.push({id:'w:'+line.id,label:'Worker-Pool · '+line.name,shortLabel:'Worker '+line.name,kind:'Aggregierter Worker-Pool',reading:value?count(value.workers.online)+' / '+count(value.workers.total)+' online':'Kapazität unbekannt',x:3,z,height:45,color,description:'Die Factory kennt zusammengefasste Kapazität. Einzelne Identitäten, Profile und aktive Aufgaben findest du in der Linie.',facts:[['Belegte / gesamte Slots',value?count(value.workers.slotsBusy)+' / '+count(value.workers.slotsTotal):'Unbekannt'],['Beobachtung',reading]],actions:url?[{label:'Worker untersuchen',href:new URL('#workers',url).href,newTab:true}]:[]});
      edges.push({from:'f:'+line.factoryId,to:'l:'+line.id,color:'#81b6ee'},{from:'l:'+line.id,to:'o:'+line.id},{from:'o:'+line.id,to:'w:'+line.id});
    }
    map.update({nodes,edges,caption:(state.scope?factoryPath(state.scope):'Alle Fabriken')+' · '+(overview?'Stand '+time(overview.observedAt):'Beobachtung wird geladen')+(stale?' · veraltet':''),legend:'Blau: Fabrikzuordnung · Mint: erreichbar · Amber: unbekannt oder veraltet. Pfeile: Registrierung → Orchestrator → Worker-Pool.'+(lines.length>12||ids.size>20?' Begrenzte Karte: erste 12 Linien / 20 Fabriken. Nutze die Bereichsauswahl oder die vollständige Tabelle.':'')});
  }
  for(const type of ['factory','line']) {
    const form=$('#'+type+'-form'), preview=el('p',undefined,'visual-editor-route');form.prepend(preview);
    const update=()=>{const select=$('#'+type+(type==='factory'?'-parent':'-factory'));preview.textContent=(select?.selectedOptions?.[0]?.textContent||'Oberste Ebene')+' → '+($('#'+type+'-name').value||'Neuer Eintrag')+(type==='line'?' → bestehender Orchestrator':'');};
    form.addEventListener('input',update);form.addEventListener('change',update);
    const original=type==='factory'?openFactory:openLine;
    const wrapped=function(record){original(record);update();};if(type==='factory')openFactory=wrapped;else openLine=wrapped;
  }
})();
