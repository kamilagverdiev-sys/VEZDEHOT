/* Fixture adapter: real server UIs, local fake account/transport/wallet only. */
import {createFixture,MODES} from './qa-fixture.mjs';
import {namespace} from './qa-config.mjs';
const fixture=createFixture({storage:window.localStorage,namespace});
const scope=fixture.current().scope;
Object.defineProperty(window,'localStorage',{value:fixture.storage,configurable:false});
const active=()=>fixture.current().scope===scope;
const subscribers=new Set(),hosts=new Set();
const status=()=>({ready:active(),busy:false,pending:false,phase:active()?'saved':'readonly',wallet:fixture.wallet()});
function refresh(){
  const s=status();for(const host of hosts){host.innerHTML='<details class="sw-card"><summary><span class="sw-heading"><b>QA · тестовый кошелёк</b><small>Изолированные монеты, без сервера</small></span><strong class="sw-amount">'+s.wallet.balance+' <span>V</span></strong></summary><div class="sw-content">Тестовый опыт: '+s.wallet.xp+' XP. Сброс и смена аккаунта — на панели QA.</div></details>'}
  for(const fn of subscribers)fn(s);return Promise.resolve(true);
}
window.VEZDEHOT_TAB_SESSION=Object.freeze({canWrite:active});
window.VEZDEHOT_SERVER_WALLET=Object.freeze({status,refresh,mount(host){hosts.add(host);refresh();return()=>hosts.delete(host)},subscribe(fn){subscribers.add(fn);fn(status());return()=>subscribers.delete(fn)}});
Object.assign(window.VEZDEHOT,{scopeKey:()=>scope,account:()=>({user:active()?{id:scope}:null,loading:false,switching:!active(),authPending:false}),getProfile:()=>({nick:'QA игрок '+fixture.current().account.toUpperCase()}),openAccount(){alert('Это изолированный QA. Выбери тестовый аккаунт A или B на верхней панели.')}});
for(const mode of MODES)window.VEZDEHOT['server'+mode[0].toUpperCase()+mode.slice(1)+'Request']=body=>fixture.request(mode,body,scope);
window.VEZDEHOT_QA=Object.freeze({fixture,mode:document.documentElement.dataset.qaGame});
window.qaReadyResolve();
document.addEventListener('click',event=>{
  const link=event.target.closest?.('a[href]');if(!link)return;
  const url=new URL(link.href,location.href);
  if(url.origin!==location.origin){event.preventDefault();return}
  if(url.pathname.endsWith('/index.html')){event.preventDefault();if(parent!==window)parent.postMessage({type:'qa:lobby'},location.origin);else location.assign('./index.html')}
});
