import {createFixture,MODES} from './qa-fixture.mjs';
import {namespace} from './qa-config.mjs';
const fixture=createFixture({storage:localStorage,namespace}),$=selector=>document.querySelector(selector);
const game=$('#qa-game'),viewport=$('#qa-viewport'),account=$('#qa-account'),scenario=$('#qa-scenario'),output=$('#qa-status');
let frame;
account.value=fixture.current().account;
function resize(){
  const [width,height]=viewport.value.split('x').map(Number);frame.height=height;
  const doc=frame.contentDocument,inner=frame.contentWindow?.innerWidth;
  const measured=doc?.documentElement&&inner?Math.max(0,inner-doc.documentElement.clientWidth):0;
  // Native scrollbar width differs across hosts. Keep the actual document at
  // the selected width, including when game content begins/stops scrolling.
  const target=width+Math.min(50,measured);if(Number(frame.width)!==target)frame.width=target;
}
function open(){
  frame?.remove();frame=document.createElement('iframe');frame.title='Настоящий интерфейс игры · изолированные данные';frame.id='qa-frame';
  // The sandbox allows only local scripts/storage and dialogs used by this fixture.
  frame.setAttribute('sandbox','allow-scripts allow-same-origin allow-modals');frame.src='./server-'+game.value+'.html';frame.addEventListener('load',resize);$('#qa-stage').append(frame);resize();
}
function summary(){
  if(frame)resize();
  const state=fixture.current(),w=fixture.wallet(),d=frame?.contentDocument;
  output.textContent='QA '+state.account.toUpperCase()+' · '+w.balance+' тестовых V · '+w.xp+' XP'+(state.loseNext?' · следующий подтверждённый ответ будет потерян':'')+(d?.body?' · ширина '+d.documentElement.clientWidth+'/'+d.documentElement.scrollWidth:'');
}
game.onchange=open;viewport.onchange=resize;$('#qa-reload').onclick=open;
account.onchange=()=>{fixture.setAccount(account.value);open();summary()};
$('#qa-reset').onclick=async()=>{
  frame?.remove();fixture.reset();const stake=scenario.value==='paid'?100:0;
  const result=await fixture.request(game.value,{op:'start',expectedRevision:0,actionId:crypto.randomUUID(),stake,bots:1,difficulty:'normal',scenarioChoice:'random'});
  open();summary();if(!result.ok)output.textContent='Не удалось подготовить fixture: '+result.data.error;
};
$('#qa-lose').onclick=()=>{fixture.armLostResponse();summary()};
window.addEventListener('message',event=>{if(event.origin===location.origin&&event.source===frame?.contentWindow&&event.data?.type==='qa:lobby'){game.focus();output.textContent='Ты вернулся к выбору игры. Выбери другой стол на панели QA.'}});
window.VEZDEHOT_QA=Object.freeze({fixture,MODES,reload:open});
open();summary();setInterval(summary,500);
