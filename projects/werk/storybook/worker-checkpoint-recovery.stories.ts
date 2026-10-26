import type { Meta, StoryObj } from '@storybook/vue3-vite';
import { h, nextTick } from 'vue';
import { userEvent, waitFor, within } from 'storybook/test';
import UApp from '@nuxt/ui/components/App.vue';
import WorkerShell from '../src/worker/webview/components/WorkerShell.vue';
import RequestPage from '../src/worker/webview/pages/RequestPage.vue';
import type { InteractionView } from '../src/worker/application/interactions';
import { state } from '../src/worker/webview/store';
import { workerLinks } from '../src/worker/webview/worker-navigation';
import { installWorkerFixture } from './worker-fixtures';
const meta = { title:'Worker/Checkpoint recovery', parameters:{layout:'fullscreen'} } satisfies Meta;
export default meta;
type Story = StoryObj;
let commands: Record<string,unknown>[] = [], accepted = 0, unrelated = 0;
function install() {
  installWorkerFixture('checkpoint'); commands=[]; accepted=0; unrelated=0;
  const original=(window as unknown as {__WERK_STORY_FETCH__:typeof fetch}).__WERK_STORY_FETCH__;
  let result: InteractionView | null = null;
  (window as unknown as {__WERK_STORY_FETCH__:typeof fetch}).__WERK_STORY_FETCH__=async(input,init={})=>{
    const path=new URL(typeof input==='string'?input:input instanceof URL?input.href:input.url,location.href).pathname;
    const body=typeof init.body==='string'?JSON.parse(init.body):{};
    if(path==='/api/chat'&&init.method==='POST')unrelated++;
    if(path==='/api/interactions'&&body.action==='answer'){
      commands.push(structuredClone(body));
      if(!result){
        const previous=state.sessions!.records.find(session=>session.id==='decision')!.interaction!;
        const turn={id:'accepted-answer-turn',runId:'accepted-answer-run',kind:'answer' as const,status:'queued' as const,createdAt:new Date().toISOString(),finishedAt:null,priorTurnId:previous.latestTurn!.id};
        result={...JSON.parse(JSON.stringify(previous)),revision:previous.revision+1,phase:'queued',pending:null,latestTurn:turn,turns:[turn],totalTurns:previous.totalTurns+1};accepted++;
        return Response.json({error:'Fixture lost acknowledgement after accepting the exact answer.'},{status:503});
      }
      if(JSON.stringify(body)!==JSON.stringify(commands[0]))throw Error('Recovery changed the original checkpoint command.');
      return Response.json(result);
    }
    if(result&&path==='/api/interactions'&&body.action==='get')return Response.json(result);
    if(result&&path==='/api/interactions'&&body.action==='turn')return Response.json({...result.latestTurn,schemaVersion:1,sessionId:'decision',input:'Fixture accepted answer',dispatch:null});
    return original(input,init);
  };
}
export const LostAnswerAcknowledgement: Story = {
  name:'Keep exact-answer recovery visible after the server advances',
  parameters:{storymap:{app:'Worker',summary:'The server accepts an answer and clears its checkpoint, but the response is lost. Recovery stays visible, blocks unrelated follow-up and retries the identical operation once.',covers:['src/worker/webview/pages/RequestPage.vue','src/worker/webview/components/TaskInteraction.vue','src/worker/webview/components/InteractionPanel.vue'],route:'/request?session=decision',ready:'[data-checkpoint-recovery-ready]'}},
  render:()=>({setup(){install();return()=>h(UApp,null,{default:()=>h(WorkerShell,{links:workerLinks,homePath:'/workboard',homeLabel:'Werk Home',navLabel:'Worker pages'},{identity:()=>h('span','Checkpoint recovery · illustrative data'),default:()=>h(RequestPage)})});}}),
  play:async({canvasElement})=>{
    const q=within(canvasElement), answer=await q.findByLabelText('Your answer or decision');
    await userEvent.type(answer,'Use the browser delivery format.');await userEvent.click(q.getByRole('button',{name:'Answer & continue'}));
    await q.findByText('Your last response is still unconfirmed. Retry the same request before sending another response.');
    const retry=await q.findByRole('button',{name:'Retry the same request'});
    await waitFor(()=>{const details=canvasElement.querySelector<HTMLDetailsElement>('.task-checkpoint');if(!details?.open||!retry.checkVisibility())throw Error('An advanced checkpoint hid its uncertain-operation recovery.');});
    await userEvent.click(canvasElement.querySelector('.task-checkpoint > summary')!);
    await waitFor(()=>{if(!canvasElement.querySelector<HTMLDetailsElement>('.task-checkpoint')?.open||!retry.checkVisibility())throw Error('Unknown-outcome recovery must remain visible until resolved.');});
    const followup=q.getByLabelText('Follow-up for this task');await userEvent.type(followup,'This must not be sent before recovery.');
    if(!(q.getByRole('button',{name:'Send follow-up'}) as HTMLButtonElement).disabled)throw Error('An unknown answer outcome enabled unrelated follow-up.');
    followup.closest('form')!.dispatchEvent(new Event('submit',{bubbles:true,cancelable:true}));await nextTick();if(unrelated)throw Error('An unrelated follow-up escaped the recovery fence.');
    await userEvent.click(retry);await waitFor(()=>{if(commands.length!==2||accepted!==1||q.queryByRole('button',{name:'Retry the same request'}))throw Error('Exact recovery did not confirm one accepted answer.');});
    if(JSON.stringify(commands[0])!==JSON.stringify(commands[1]))throw Error('Recovery replaced the saved operation or answer.');
    canvasElement.setAttribute('data-checkpoint-recovery-ready','true');
  },
};
