/* Shared, read-only game guidance. Examples never execute game actions or write a profile. */
(()=>{
'use strict';
const games={durak:'Дурак',bunker:'Бункер',poker:'Покер',mafia:'Мафия',monopoly:'Монополия'};
const esc=value=>String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const plural=n=>n%100>=11&&n%100<=14?'событий':n%10===1?'событие':n%10>=2&&n%10<=4?'события':'событий';
const canUse=()=>window.VEZDEHOT_TAB_SESSION?.canWrite()!==false;
let active=null,serial=0;
function journal(options={}){
  const id=String(options.id||'journal').replace(/[^a-zA-Z0-9_-]/g,'-');
  const entries=(Array.isArray(options.entries)?options.entries:[]).filter(entry=>entry&&typeof entry.text==='string');
  return `<details class="vh-journal" data-key="journal-${esc(id)}" data-detail="${esc(id)}" ${options.open?'open':''}><summary><span class="vh-journal-symbol" aria-hidden="true">↳</span><span class="vh-journal-heading"><strong>${esc(options.title||'Журнал ходов')}</strong><small>${entries.length} ${plural(entries.length)} · новые сверху</small></span><span class="vh-disclosure-plus" aria-hidden="true">+</span></summary>${entries.length?`<ol class="vh-journal-list">${entries.map(entry=>`<li>${entry.label?`<span class="vh-journal-label">${esc(entry.label)}</span>`:''}<p>${esc(entry.text)}</p></li>`).join('')}</ol>`:`<p class="vh-journal-empty">${esc(options.empty||'Здесь появятся события этой партии.')}</p>`}</details>`;
}
function tip(options={}){
  if(!options.text)return '';
  return `<details class="vh-coach" data-key="context-tip" data-guide-tip><summary><span class="vh-coach-mark" aria-hidden="true">?</span><strong>${esc(options.title||'Подсказка к этому ходу')}</strong><span class="vh-disclosure-plus" aria-hidden="true">+</span></summary><p>${esc(options.text)}</p></details>`;
}
function element(tag,className,text){const node=document.createElement(tag);if(className)node.className=className;if(text!==undefined)node.textContent=String(text);return node}
function button(label,className,attribute,value){const node=element('button',className,label);node.type='button';if(attribute)node.setAttribute(attribute,value??'');return node}
function usableLessons(lessons){
  if(!Array.isArray(lessons))return [];
  return lessons.filter(lesson=>lesson&&typeof lesson.prompt==='string'&&Array.isArray(lesson.choices)&&lesson.choices.length>=2&&lesson.choices.length<=5&&lesson.choices.every(choice=>choice&&typeof choice.label==='string'&&typeof choice.feedback==='string')&&lesson.choices.filter(choice=>choice.correct===true).length===1).slice(0,8);
}
function open(options={}){
  if(!canUse()||!document.body)return null;
  active?.close('replaced');
  const game=Object.hasOwn(games,options.game)?options.game:'durak',lessons=usableLessons(options.lessons),context=options.context&&typeof options.context.text==='string'?options.context:null;
  const sections=(Array.isArray(options.sections)?options.sections:[]).filter(section=>section&&typeof section.text==='string');
  const trigger=options.trigger||document.activeElement,states=new Map(),oldOverflow=document.body.style.overflow;
  const overlay=element('div','vh-guide-overlay'),sheet=element('section','vh-guide-sheet'),uid='vh-guide-'+ ++serial;
  overlay.dataset.game=game;sheet.setAttribute('role','dialog');sheet.setAttribute('aria-modal','true');sheet.setAttribute('aria-labelledby',uid+'-title');sheet.setAttribute('aria-describedby',uid+'-intro');sheet.tabIndex=-1;
  const header=element('header','vh-guide-header'),closeButton=button('×','vh-guide-close','data-guide-close');closeButton.setAttribute('aria-label','Закрыть справку');
  const heading=element('h2','vh-guide-title',options.title||'Разберёмся в игре');heading.id=uid+'-title';
  const intro=element('p','vh-guide-intro','Партия подождёт. Изучи ситуацию и возвращайся к своему решению.');intro.id=uid+'-intro';
  header.append(element('p','vh-guide-eyebrow','VEZDEHOT / '+games[game]),closeButton,heading,intro);
  const tabs=element('div','vh-guide-tabs');tabs.setAttribute('role','tablist');tabs.setAttribute('aria-label','Разделы справки');
  const body=element('div','vh-guide-body'),panels=new Map(),tabButtons=new Map();
  const choices=[...(context?[['now','Сейчас']]:[]),['rules','Правила'],...(lessons.length?[['practice','Практика']]:[])];
  let tabKey=choices[0][0],lessonIndex=0,finished=false;const answers=new Map(),complete=new Set();
  const addPanel=(key,label)=>{
    const tab=button(label,'vh-guide-tab','data-guide-tab',key);tab.id=uid+'-tab-'+key;tab.setAttribute('role','tab');tab.setAttribute('aria-controls',uid+'-panel-'+key);
    const panel=element('div','vh-guide-panel');panel.id=uid+'-panel-'+key;panel.setAttribute('role','tabpanel');panel.setAttribute('aria-labelledby',tab.id);panel.tabIndex=0;
    tabs.append(tab);body.append(panel);panels.set(key,panel);tabButtons.set(key,tab);tab.onclick=()=>selectTab(key);
  };
  choices.forEach(([key,label])=>addPanel(key,label));
  function selectTab(key,focus=false){
    if(!panels.has(key))return;tabKey=key;
    for(const [id,panel] of panels){const selected=id===key;panel.hidden=!selected;const tab=tabButtons.get(id);tab.setAttribute('aria-selected',String(selected));tab.tabIndex=selected?0:-1}
    if(focus)tabButtons.get(key).focus();
  }
  tabs.addEventListener('keydown',event=>{
    if(!['ArrowLeft','ArrowRight','Home','End'].includes(event.key))return;
    event.preventDefault();const keys=choices.map(item=>item[0]),index=keys.indexOf(tabKey),next=event.key==='Home'?0:event.key==='End'?keys.length-1:(index+(event.key==='ArrowRight'?1:-1)+keys.length)%keys.length;selectTab(keys[next],true);
  });
  if(context){
    const panel=panels.get('now'),card=element('section','vh-guide-current');
    card.append(element('span','vh-guide-section-label','ТВОЯ СИТУАЦИЯ'),element('h3','',context.title||'На что обратить внимание'),element('p','',context.text));
    panel.append(card,element('p','vh-guide-footnote','Подсказка объясняет правила и доступную информацию. Решение остаётся за тобой.'));
    if(lessons.length){const learn=button('Попробовать на примере →','vh-guide-primary','data-guide-learn');learn.onclick=()=>{selectTab('practice');tabButtons.get('practice').focus()};panel.append(learn)}
  }
  const ruleList=element('ol','vh-guide-rules');sections.forEach((section,index)=>{const row=element('li',''),copy=element('div','');copy.append(element('h3','',section.title||'Правило '+(index+1)),element('p','',section.text));row.append(element('span','vh-guide-rule-number',String(index+1).padStart(2,'0')),copy);ruleList.append(row)});
  panels.get('rules').append(ruleList);if(!sections.length)panels.get('rules').append(element('p','','Правила появятся здесь.'));
  function renderPractice(focusHeading=false){
    const panel=panels.get('practice');if(!panel)return;panel.replaceChildren();
    const progressRow=element('div','vh-guide-progress-row'),progress=element('progress','vh-guide-progress');progress.max=lessons.length;progress.value=complete.size;progress.setAttribute('aria-label','Учебные ситуации разобраны');progressRow.append(element('span','',complete.size+' из '+lessons.length+' разобрано'),element('span','vh-guide-sandbox','Без ставок и начислений'));panel.append(progressRow,progress);
    if(finished){
      const card=element('div','vh-guide-complete'),h=element('h3','','Можно вернуться к игре');h.tabIndex=-1;
      card.append(element('span','vh-guide-complete-mark','✓'),h,element('p','','Все примеры разобраны. Продолжи настоящую партию, когда будешь готов.'));
      const again=button('Повторить примеры','vh-guide-secondary','data-guide-restart');again.onclick=()=>{answers.clear();complete.clear();finished=false;lessonIndex=0;renderPractice(true)};
      const back=button('Вернуться к игре','vh-guide-primary','data-guide-finish');back.onclick=()=>close('user');card.append(back,again);panel.append(card);if(focusHeading)h.focus();return;
    }
    const lesson=lessons[lessonIndex],answer=answers.get(lessonIndex),correct=answer!==undefined&&lesson.choices[answer].correct===true;
    const h=element('h3','vh-guide-lesson-title',lesson.title||'Учебная ситуация');h.tabIndex=-1;
    panel.append(element('p','vh-guide-section-label','ПРИМЕР '+(lessonIndex+1)+' / '+lessons.length),h,element('p','vh-guide-question',lesson.prompt));
    const answerList=element('div','vh-guide-choices');answerList.setAttribute('role','group');answerList.setAttribute('aria-label','Выбери ответ');
    lesson.choices.forEach((choice,index)=>{
      const item=button('','vh-guide-choice','data-guide-choice',String(index));item.setAttribute('aria-pressed',String(answer===index));item.disabled=correct;item.dataset.result=answer===index?(correct?'correct':'wrong'):'';
      item.append(element('span','vh-guide-choice-letter',String.fromCharCode(65+index)),element('span','',choice.label));
      item.onclick=()=>{if(!canUse()||active?.overlay!==overlay||complete.has(lessonIndex))return;answers.set(lessonIndex,index);if(choice.correct===true)complete.add(lessonIndex);renderPractice();const feedback=panel.querySelector('[data-guide-feedback]');feedback?.focus()};answerList.append(item);
    });panel.append(answerList);
    if(answer!==undefined){const feedback=element('div','vh-guide-feedback');feedback.dataset.result=correct?'correct':'wrong';feedback.setAttribute('data-guide-feedback','');feedback.setAttribute('role','status');feedback.setAttribute('aria-live','polite');feedback.tabIndex=-1;feedback.append(element('strong','',correct?'Верно':'Попробуй ещё раз'),element('p','',lesson.choices[answer].feedback));panel.append(feedback)}
    const nav=element('div','vh-guide-lesson-nav');
    if(lessonIndex>0){const previous=button('← Назад','vh-guide-secondary','data-guide-previous');previous.onclick=()=>{lessonIndex--;renderPractice(true)};nav.append(previous)}
    const next=button(lessonIndex===lessons.length-1?'Завершить разбор →':'Следующий пример →','vh-guide-primary','data-guide-next');next.disabled=!correct;next.onclick=()=>{if(!canUse()||!complete.has(lessonIndex))return;if(lessonIndex===lessons.length-1)finished=true;else lessonIndex++;renderPractice(true)};nav.append(next);panel.append(nav);if(focusHeading)h.focus();
  }
  renderPractice();selectTab(tabKey);
  const footer=element('footer','vh-guide-footer');footer.append(element('span','','Изучение примеров не меняет партию.'),button('Вернуться к игре','vh-guide-back','data-guide-close'));
  sheet.append(header,tabs,body,footer);overlay.append(sheet);
  for(const node of document.body.children){if(['SCRIPT','STYLE','LINK'].includes(node.tagName)||node.id==='vh-session-overlay')continue;states.set(node,node.inert);node.inert=true}
  document.body.append(overlay);document.body.style.overflow='hidden';
  function close(reason='user'){
    if(active?.overlay!==overlay)return;
    active=null;document.removeEventListener('keydown',onKey,true);document.removeEventListener('focusin',onFocus,true);overlay.remove();document.body.style.overflow=oldOverflow;
    if(canUse())for(const [node,inert] of states)if(node.isConnected)node.inert=inert;
    if(reason==='user'&&canUse()){
      options.onClose?.({reason});const target=trigger?.isConnected&&!trigger.inert?trigger:document.querySelector('[data-rules], [data-durak-help], [data-help]');target?.focus?.({preventScroll:true});
    }
  }
  function focusables(){return [...sheet.querySelectorAll('button:not([disabled]), [tabindex="0"]')].filter(node=>!node.hidden&&!node.closest('[hidden]')&&node.tabIndex!==-1)}
  function onKey(event){
    if(event.key==='Escape'){event.preventDefault();event.stopPropagation();close('user');return}
    if(event.key!=='Tab')return;const nodes=focusables(),first=nodes[0]||sheet,last=nodes.at(-1)||sheet;
    if(event.shiftKey&&(document.activeElement===first||!nodes.includes(document.activeElement))){event.preventDefault();last.focus()}
    else if(!event.shiftKey&&(document.activeElement===last||!nodes.includes(document.activeElement))){event.preventDefault();first.focus()}
  }
  function onFocus(event){if(active?.overlay===overlay&&!sheet.contains(event.target))closeButton.focus()}
  active={overlay,close};document.addEventListener('keydown',onKey,true);document.addEventListener('focusin',onFocus,true);overlay.querySelectorAll('[data-guide-close]').forEach(node=>node.onclick=()=>close('user'));closeButton.focus();
  return {close:()=>close('user')};
}
document.addEventListener('vezdehot:accountchange',()=>active?.close('account'));
document.addEventListener('vezdehot:sessionlost',()=>active?.close('ownership'));
window.addEventListener('pagehide',()=>active?.close('pagehide'));
window.VEZDEHOT_GUIDE=Object.freeze({open,journal,tip});
})();
