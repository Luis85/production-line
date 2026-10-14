/* Worker task sessions share the serial LLM queue; line submission remains explicit. */
(() => {
  const { el, button } = WerkSpatial;
  globalThis.WerkInteraction = function({title, request, submit, project, trigger, canWrite}) {
    const dialog=el('dialog',undefined,'interaction-widget');dialog.setAttribute('aria-labelledby','interaction-heading');
    const heading=el('h2',title),notice=el('p');heading.id='interaction-heading';notice.setAttribute('role','status');
    const close=button('Close',()=>dialog.close()),header=el('div',undefined,'operation-actions');header.append(heading,close);
    const tabs=el('div',undefined,'operation-actions'),chat=el('section'),task=el('section');task.hidden=true;
    const chatTab=button('Chat',()=>{chat.hidden=false;task.hidden=true;chatTab.setAttribute('aria-pressed','true');taskTab.setAttribute('aria-pressed','false');}),taskTab=button('Submit task',()=>{chat.hidden=true;task.hidden=false;chatTab.setAttribute('aria-pressed','false');taskTab.setAttribute('aria-pressed','true');});chatTab.setAttribute('aria-pressed','true');taskTab.setAttribute('aria-pressed','false');tabs.append(chatTab,taskTab);
    const field=(form,label,id,type='text')=>{const wrapper=el('div'),name=el('label',label),input=el(type==='textarea'?'textarea':'input');name.htmlFor=id;input.id=id;if(type!=='textarea')input.type=type;input.required=true;wrapper.append(name,input);form.append(wrapper);return input;};
    const setup=el('form',undefined,'operation-form'),address=field(setup,'Worker webview address','interaction-worker-url','url'),credential=field(setup,'Worker access token','interaction-worker-token','password');credential.autocomplete='off';address.placeholder='http://127.0.0.1:4100';
    const connect=el('button','Connect model session');connect.type='submit';setup.append(connect,el('p','Use a worker registered with this line. Access stays in this dialog’s memory. Its selected session is shared with the worker webview.'));
    const taskHeading=el('h3','New task'),taskStatus=el('p','Connect a worker to inspect its selected task.');taskStatus.setAttribute('role','status');const transcript=el('div',undefined,'interaction-transcript'),composer=el('form',undefined,'operation-form'),draft=field(composer,'Message to the model','interaction-message','textarea');draft.maxLength=8000;draft.disabled=true;
    const send=el('button','Queue task');send.type='submit';send.disabled=true;const stop=button('Stop reply',()=>perform('cancel')),reload=button('Refresh conversation',()=>perform('read')),newTask=button('New task',()=>perform('new'));stop.disabled=reload.disabled=newTask.disabled=true;const chatActions=el('div',undefined,'operation-actions');chatActions.append(send,stop,reload,newTask);composer.append(chatActions);chat.append(el('p','The first message queues this worker task. Follow-up messages continue the same task session. The worker runs one LLM request at a time; New task opens a separate session.'),setup,taskHeading,taskStatus,transcript,composer);
    let connection=null,session=null,epoch=0,busy=false,reading=false,readRevision=0,timer=null,closed=false,chatValue=null,selectedTask=null,lastTranscript='';
    const drafts=new Map();
    const draftKey=()=>connection&&session?connection.workerUrl+'|'+session:null;
    function rememberDraft(){const key=draftKey();if(key)drafts.set(key,draft.value);}
    function controls(){draft.disabled=!connection;send.disabled=busy||!connection||!canWrite||!chatValue?.available||chatValue.busy||selectedTask?.busy||!draft.value.trim();stop.disabled=busy||!canWrite||!chatValue?.busy;reload.disabled=busy||reading||!connection;newTask.disabled=busy||!canWrite||!connection;composer.setAttribute('aria-busy',String(busy));}
    draft.oninput=controls;
    const reconnect=button('Change worker / reconnect',()=>resetConnection());reconnect.hidden=true;chatActions.append(reconnect);
    function resetConnection(){rememberDraft();draft.disabled=true;epoch++;readRevision++;busy=false;reading=false;chatValue=null;selectedTask=null;lastTranscript='';clearInterval(timer);timer=null;connection=null;session=null;setup.hidden=false;connect.disabled=false;reconnect.hidden=true;send.disabled=stop.disabled=reload.disabled=newTask.disabled=true;send.textContent='Queue task';taskHeading.textContent='New task';taskStatus.textContent='Reconnect to inspect the selected task.';transcript.replaceChildren();credential.focus();}
    function paint(result){
      if(result.sessions){const selected=result.sessions.records.find(item=>item.id===result.sessions.selected);selectedTask=selected;if(session&&session!==result.sessions.selected){notice.textContent='The selected worker session changed. Reconnect to inspect it before sending.';resetConnection();return;}session=result.sessions.selected;taskHeading.textContent=selected?.title||'New task';}
      if(!result.chat)return;const value=result.chat;chatValue=value;const first=value.messages.find(message=>message.role==='user');
      if(taskHeading.textContent==='New task'&&first)taskHeading.textContent=first.text.slice(0,120);
      const last=value.messages.at(-1),phase=value.phase||(value.busy?'running':!last?'draft':last.state==='error'?'failed':last.state==='cancelled'?'cancelled':'completed');
      taskStatus.textContent=phase==='queued'?'Queued · waiting for this worker’s current LLM request.':phase==='running'?'Running · the worker is prompting the LLM.':phase==='failed'||last?.state==='error'?'The last reply failed. Inspect it before sending a follow-up.':phase==='cancelled'||last?.state==='cancelled'?'Reply stopped. You can continue this task.':first?'Ready for a follow-up in this task session.':'Draft · the first message queues this task.';
      if(selectedTask?.busy&&!value.busy)taskStatus.textContent=selectedTask.status==='queued'?'This assigned task is queued. Send a follow-up when it finishes.':'This assigned task is running. Send a follow-up when it finishes.';
      const serialized=JSON.stringify({messages:value.messages,phase});if(serialized!==lastTranscript){lastTranscript=serialized;transcript.replaceChildren();for(const message of value.messages){const entry=el('article');entry.append(el('strong',message.role==='user'?'You':'Model'),el('p',message.text||(phase==='queued'?'Queued…':'Reply in progress…')));transcript.append(entry);}if(!value.messages.length)transcript.append(el('p','Describe the task in your first message.'));}
      send.textContent=first?'Send follow-up':'Queue task';controls();
    }
    async function perform(action,automatic=false){
      const read=action==='read';
      if(!connection||busy||(read&&reading)||(!read&&!canWrite)||(action==='send'&&!draft.value.trim()))return;
      if(read)reading=true;else busy=true;
      const own=epoch,revision=++readRevision,message=draft.value;
      if(!read)notice.textContent=action==='send'?'Sending your message…':action==='new'?'Preparing a new task…':'Stopping the reply…';
      controls();
      try{
        const result=await request({...connection,action,sessionId:session,...(action==='send'?{message}:{})});
        if(own!==epoch||revision!==readRevision)return;
        if(action==='new'){rememberDraft();session=null;draft.value='';taskHeading.textContent='New task';taskStatus.textContent='Draft · the first message queues this task.';}
        else if(action==='send'&&draft.value===message)draft.value='';
        paint(result);
        if(own===epoch)notice.textContent=action==='new'?'New task ready. Your previous task’s unsent draft is kept while this dialog stays open.':action==='send'?'Message queued on this worker.':action==='cancel'?'Reply stopped.':automatic?notice.textContent:'Conversation refreshed.';
        if(action==='new'&&own===epoch)draft.focus();
      }catch(error){if(own===epoch&&revision===readRevision)notice.textContent=error.message;}
      finally{if(own===epoch){if(read)reading=false;else busy=false;controls();}}
    }
    setup.onsubmit=async event=>{
      event.preventDefault();if(busy)return;busy=true;connect.disabled=true;notice.textContent='Connecting to the worker…';const own=epoch;
      try{
        const candidate={workerUrl:address.value.trim(),workerToken:credential.value};const result=await request({...candidate,action:'read'});if(own!==epoch)return;
        connection=candidate;session=null;credential.value='';paint(result);draft.value=drafts.get(draftKey())??'';setup.hidden=true;reconnect.hidden=false;notice.textContent='Connected. Messages stay with this worker’s selected task.';
        clearInterval(timer);timer=setInterval(()=>{if(!document.hidden)void perform('read',true);},3000);draft.focus();
      }catch(error){if(own===epoch)notice.textContent=error.message;}
      finally{if(own===epoch){busy=false;connect.disabled=false;controls();}}
    };
    composer.onsubmit=event=>{event.preventDefault();void perform('send');};
    const form=el('form',undefined,'operation-form'),projectField=field(form,'Project','interaction-project');projectField.value=project||'';
    const reference=field(form,'Requirement link (optional)','interaction-reference');reference.required=false;reference.placeholder='[[requirements/my-feature]]';
    const taskTitle=field(form,'Task title','interaction-title'),criteria=field(form,'Acceptance criteria · one per line','interaction-criteria','textarea');taskTitle.maxLength=200;criteria.maxLength=12000;
    const requireTaskFields=()=>{taskTitle.required=criteria.required=!reference.value.trim();};reference.oninput=requireTaskFields;
    const providerLabel=el('label','Provider'),provider=el('select');provider.id='interaction-provider';providerLabel.htmlFor=provider.id;for(const [value,label]of [['auto','Automatic'],['codex','Codex'],['claude','Claude']]){const option=el('option',label);option.value=value;provider.append(option);}form.append(providerLabel,provider);
    const modeLabel=el('label','Execution'),mode=el('select');mode.id='interaction-mode';modeLabel.htmlFor=mode.id;for(const [value,label]of [['mock','Simulation'],['cli','Live Codex · review required']]){const option=el('option',label);option.value=value;mode.append(option);}form.append(modeLabel,mode);
    const taskNotice=el('p');taskNotice.setAttribute('role','status');
    const submitButton=el('button','Submit task to this line');submitButton.type='submit';submitButton.disabled=!canWrite;form.append(el('p','A saved task enters the configured router. Live work requires a compatible Codex worker and pinned context; results require review.'),submitButton,taskNotice);task.append(form);
    let taskKey=crypto.randomUUID(),lastPayload='',submitting=false;
    form.onsubmit=async event=>{
      event.preventDefault();if(!canWrite||submitting)return;submitting=true;submitButton.disabled=true;submitButton.textContent='Submitting task…';taskNotice.textContent='Saving this task to the line…';
      const fields=[projectField,reference,taskTitle,criteria,provider,mode];for(const input of fields)input.disabled=true;
      const input={project:projectField.value,provider:provider.value,executionMode:mode.value,priority:1,...(reference.value.trim()?{requirementRef:reference.value.trim()}:{title:taskTitle.value,criteria:criteria.value.split('\n').map(value=>value.trim()).filter(Boolean),wikilinks:[]})};
      const serialized=JSON.stringify(input);if(serialized!==lastPayload){taskKey=crypto.randomUUID();lastPayload=serialized;}
      try{const result=await submit(input,taskKey);if(closed)return;const intake=typeof result.factoryId==='string'&&'remoteTaskId' in result;taskNotice.textContent=intake?'Saved in Factory intake: '+result.id+'. '+(result.status==='delivered'?'Delivered to the line.':'Delivery is pending.')+' Follow delivery in Factory intake.':'Task saved to this line: '+result.id+'. Follow its progress in the line taskboard.';taskTitle.value='';criteria.value='';reference.value='';requireTaskFields();taskKey=crypto.randomUUID();lastPayload='';}
      catch(error){if(!closed)taskNotice.textContent=error.message;}
      finally{if(!closed){submitting=false;for(const input of fields)input.disabled=false;submitButton.disabled=!canWrite;submitButton.textContent='Submit task to this line';}}
    };
    chat.append(notice);dialog.append(header,tabs,chat,task);document.body.append(dialog);dialog.addEventListener('close',()=>{closed=true;epoch++;clearInterval(timer);drafts.clear();connection=null;session=null;credential.value='';draft.value='';dialog.remove();if(trigger?.isConnected)trigger.focus();});dialog.addEventListener('click',event=>{if(event.target===dialog&&event.clientX<dialog.getBoundingClientRect().left)dialog.close();});dialog.showModal();address.focus();return{close:()=>dialog.close()};
  };
})();
