/* Explanatory topology and a local-only deployment definition composer. */
(() => {
  const {SpatialMap,el,button}=WerkSpatial;
  const model=document.querySelector('#model');const oldTree=model.querySelector('.tree');const root=el('div');oldTree.before(root);
  oldTree.hidden=true;document.querySelector('#entity-detail').hidden=true;
  model.querySelector('h1').textContent='Explore how Werk fits together.';
  model.querySelector('.lead').textContent='Select a component to see what it owns, how work moves through it, and where to go next.';
  const map=new SpatialMap(root,{label:'Illustrative architecture in 3D or 2D',english:true});
  const definition=[
    ['factory','Factory','Portfolio',0,0,'#81b6ee',35],['subfactory','Sub-factory','Logical grouping',0,1.6,'#81b6ee',25],['line','Production line','Independent boundary',1,1,'#81b6ee',30],['orchestrator','Orchestrator','Tasks & leases',2,1,'#8be0b8',85],['worker','Workers','Execution & capacity',3,1,'#8be0b8',55],['task','Task & evidence','Result for review',3,2.5,'#edc47e',30]
  ];
  const nodes=definition.map(([id,label,reading,x,z,color,height])=>({id,label,reading,x,z,color,height,kind:entities[id][0],description:entities[id][1],facts:[['Boundary',entities[id][2]]] ,actions:[{label:id==='factory'||id==='subfactory'||id==='line'?'Compose a system definition':'Follow a task',href:id==='factory'||id==='subfactory'||id==='line'?'#deployment':'#task-life'}]}));
  map.update({nodes,edges:[{from:'factory',to:'subfactory',color:'#81b6ee'},{from:'subfactory',to:'line',color:'#81b6ee'},{from:'line',to:'orchestrator'},{from:'orchestrator',to:'worker'},{from:'worker',to:'task'},{from:'task',to:'orchestrator',dashed:true}],caption:'Illustrative architecture · no connection to live services',legend:'Blue: ownership · Mint: coordination and execution · Amber: results and evidence. Dashed connection: reports return to the owning Orchestrator.'});
  // A 2D lifecycle is a readable route into the component explanations.
  const life=el('div',undefined,'visual-route');life.setAttribute('aria-label','Task lifecycle');
  for(const [id,label]of [['orchestrator','Submit & persist'],['worker','Lease & execute'],['task','Record evidence'],['task','Human review']])life.append(button(label,()=>{map.select(id);model.scrollIntoView({block:'start'});}));document.querySelector('#task-title').after(life);
  const deployment=document.querySelector('#deployment'), heading=document.querySelector('#deploy-title');heading.textContent='Compose your system definition';
  deployment.querySelector('p').textContent='Prepare a native or Docker definition with one independent line. Download it, validate it with the launcher, then start it in a new state directory. This editor does not change a running deployment.';
  const initialPre=deployment.querySelector('pre');const oldHint=initialPre.nextElementSibling;initialPre.hidden=true;oldHint.hidden=true;
  const composer=el('div',undefined,'visual-definition');const form=el('form');form.id='definition-form';const output=el('div');const pre=el('pre');pre.tabIndex=0;const code=el('code');code.id='definition-preview';pre.append(code);output.append(pre);
  const fields={};
  function field(id,label,value,{type='text',min,max,pattern}={}){const labelNode=el('label',label);labelNode.htmlFor='definition-'+id;const input=el('input');input.id='definition-'+id;input.type=type;input.value=value;input.required=true;if(min!==undefined)input.min=min;if(max!==undefined)input.max=max;if(pattern)input.pattern=pattern;if(type==='text')input.maxLength=100;form.append(labelNode,input);fields[id]=input;return input;}
  const idPattern='[a-z][a-z0-9]*(?:-[a-z0-9]+)*';
  field('id','System ID','my-system',{pattern:idPattern});field('factory','Factory name','My Factory');field('factoryPort','Factory port','3100',{type:'number',min:1024,max:65535});field('line','Line ID','alpha',{pattern:idPattern});field('project','Project ID','demo-alpha',{pattern:'[a-zA-Z0-9_-]+'});field('port','Orchestrator port','3001',{type:'number',min:1024,max:65535});field('workers','Worker processes','2',{type:'number',min:1,max:8});field('workerPort','First worker status port','4201',{type:'number',min:1024,max:65535});
  fields.id.maxLength=55;fields.line.maxLength=63;
  const status=el('p');status.id='definition-state';status.setAttribute('role','status');const download=button('Download system.yaml',()=>{if(!update())return;const blob=new Blob([code.textContent],{type:'application/yaml'}),url=URL.createObjectURL(blob),link=el('a');link.href=url;link.download='system.yaml';link.click();setTimeout(()=>URL.revokeObjectURL(url),1000);});form.append(status,download);composer.append(form,output);initialPre.before(composer);
  let environment='native';
  function update(){
    const values=Object.fromEntries(Object.entries(fields).map(([id,node])=>[id,node.value.trim()]));
    const valid=Object.values(fields).every(input=>input.checkValidity());const count=Number(values.workers),start=Number(values.workerPort);const ports=[Number(values.factoryPort),Number(values.port),...Array.from({length:Math.min(8,Math.max(0,count))},(_,i)=>start+i)];
    const reserved=/^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i;
    const error=reserved.test(values.id)||reserved.test(values.line)?'System and line IDs cannot use reserved device names.':values.id.length>55||values.line.length>63?'System ID: at most 55 characters; line ID: at most 63.':!values.factory?'Enter a Factory name.':!valid?'Use lowercase hyphen-separated system and line IDs, a project ID, and valid whole-number ports.':new Set(ports).size!==ports.length?'Each service needs a distinct port. Worker ports occupy a consecutive range.':ports.some(p=>p>65535)?'The worker port range must end at or below 65535.':'';
    status.textContent=error||'Ready to download · '+count+' workers · ports '+ports.join(', ');download.disabled=Boolean(error);
    if(error){code.textContent='Complete the definition to preview valid YAML.';return false;}
    const quote=value=>JSON.stringify(value);
    code.textContent=['schemaVersion: 1','id: '+quote(values.id),'environment: '+environment,'factory:','  id: '+quote(values.id+'-factory'),'  name: '+quote(values.factory),'  port: '+values.factoryPort,'productionLines:','  - id: '+quote(values.line),'    name: '+quote(values.line),'    project: '+quote(values.project),'    orchestrator:','      port: '+values.port,'    workers:','      count: '+count,'      statusPort: '+start,''].join('\n');
    document.querySelector('#deployment-commands').textContent=environment==='docker'?'./werk-docker.sh system plan --file system.yaml --environment docker\n./werk-docker.sh system up --file system.yaml --environment docker':'node werk.mjs system plan --file system.yaml\nnode werk.mjs system up --file system.yaml';return true;
  }
  form.addEventListener('input',update);form.onsubmit=event=>event.preventDefault();
  document.querySelector('#native-mode').addEventListener('click',()=>{environment='native';update();});document.querySelector('#docker-mode').addEventListener('click',()=>{environment='docker';update();});
  const warning=el('p','Existing deployment? Back up and explicitly migrate its topology before changing ownership, ports or worker counts. Restarting does not apply a changed definition. Credentials are generated by the launcher and never included here.','note');composer.after(warning);update();
})();
