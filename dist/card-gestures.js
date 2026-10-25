/* Tap stays with the game UI. A completed pointer drag submits at most one card. */
(()=>{
'use strict';
const documents=new WeakMap(),bindings=new WeakMap();
function clickGuard(doc){
  let guard=documents.get(doc);if(guard)return guard;
  guard={until:0};documents.set(doc,guard);
  // The original table may be replaced by onDrop. Keep this one document-level
  // guard alive across bindings so the trailing pointer click cannot hit new UI.
  doc.addEventListener('pointerdown',()=>{guard.until=0},true);
  doc.addEventListener('click',event=>{
    if(event.detail===0||Date.now()>guard.until)return;
    guard.until=0;event.preventDefault();event.stopImmediatePropagation();
  },true);
  return guard;
}
function bind(options){
  const {root,cardSelector,dropSelector}=options||{};
  if(!root||!root.ownerDocument||typeof cardSelector!=='string'||typeof dropSelector!=='string'||['getCardId','canStart','canDrop','getStateKey','onDrop'].some(k=>typeof options[k]!=='function'))throw new TypeError('Incomplete card gesture binding');
  bindings.get(root)?.destroy();
  const doc=root.ownerDocument,win=doc.defaultView,guard=clickGuard(doc),listeners=[],rejectedDown=new WeakSet();
  let state=null,destroyed=false;
  const previous=root.getAttribute('data-card-drag');root.setAttribute('data-card-drag','');
  const listen=(node,type,fn,capture=true)=>{node?.addEventListener(type,fn,{capture,passive:false});listeners.push([node,type,fn,capture])};
  const zones=()=>Array.from(root.querySelectorAll(dropSelector));
  const point=e=>Number.isFinite(e.clientX)&&Number.isFinite(e.clientY);
  const allowed=(s,drop=false)=>{
    try{return !destroyed&&root.isConnected&&s.card.isConnected&&!doc.hidden&&!s.card.disabled&&s.card.getAttribute('aria-disabled')!=='true'&&options.getCardId(s.card)===s.id&&Object.is(options.getStateKey(),s.key)&&(drop?options.canDrop(s.id):options.canStart(s.id))===true}catch{return false}
  };
  function cleanup(s){
    s.ghost?.remove();s.card.classList.remove('vh-card-dragging');
    for(const zone of s.zones||[])zone.classList.remove('vh-drop-ready','vh-drop-over');
    doc.body?.classList.remove('vh-card-drag-active');
    try{if(s.card.hasPointerCapture?.(s.pointerId))s.card.releasePointerCapture(s.pointerId)}catch{}
  }
  function cancel(reason='cancelled',suppress=true){
    if(!state)return;const s=state;state=null;
    if(suppress)guard.until=Date.now()+800;
    cleanup(s);options.onCancel?.(reason);
  }
  function hover(s,x,y){
    let inside=false;const visible=typeof doc.elementFromPoint==='function'?doc.elementFromPoint(x,y):undefined;
    for(const zone of s.zones){
      const r=zone.getBoundingClientRect(),hit=zone.isConnected&&r.width>0&&r.height>0&&x>=r.left&&x<=r.right&&y>=r.top&&y<=r.bottom&&(visible===undefined||visible!==null&&zone.contains(visible));
      zone.classList.toggle('vh-drop-over',hit);inside=inside||hit;
    }
    return inside;
  }
  function moveGhost(s,x,y){s.ghost.style.left=(x-s.offsetX)+'px';s.ghost.style.top=(y-s.offsetY)+'px';hover(s,x,y)}
  function begin(s,event){
    if(!allowed(s)||!allowed(s,true)){cancel('state_changed');return false}
    s.zones=zones().filter(zone=>zone.isConnected);if(!s.zones.length){cancel('no_drop_zone');return false}
    const bounds=s.card.getBoundingClientRect(),ghost=s.card.cloneNode(true);
    ghost.removeAttribute('id');ghost.removeAttribute('autofocus');ghost.removeAttribute('aria-describedby');ghost.removeAttribute('aria-labelledby');
    for(const child of ghost.querySelectorAll('[id],[autofocus],[tabindex],button,a,input,select,textarea')){child.removeAttribute('id');child.removeAttribute('autofocus');child.setAttribute('tabindex','-1')}
    ghost.setAttribute('aria-hidden','true');ghost.setAttribute('tabindex','-1');ghost.setAttribute('inert','');ghost.classList.add('vh-card-ghost');ghost.classList.remove('vh-card-dragging');
    Object.assign(ghost.style,{position:'fixed',zIndex:'2147483000',pointerEvents:'none',margin:'0',width:bounds.width+'px',height:bounds.height+'px',transform:'none',transition:'none',animation:'none'});
    s.offsetX=Math.max(0,Math.min(bounds.width,s.startX-bounds.left));s.offsetY=Math.max(0,Math.min(bounds.height,s.startY-bounds.top));s.ghost=ghost;s.dragging=true;
    doc.body.appendChild(ghost);s.card.classList.add('vh-card-dragging');doc.body.classList.add('vh-card-drag-active');
    s.zones.forEach(zone=>zone.classList.add('vh-drop-ready'));
    try{s.card.setPointerCapture?.(s.pointerId)}catch{}
    moveGhost(s,event.clientX,event.clientY);return true;
  }
  function down(event){
    if(destroyed||state||rejectedDown.has(event)||event.isPrimary===false||event.button!==0||!point(event))return;
    const card=event.target?.closest?.(cardSelector);if(!card||!root.contains(card)||card.disabled||card.getAttribute('aria-disabled')==='true')return;
    let id,key;try{id=options.getCardId(card);key=options.getStateKey();if(options.canStart(id)!==true)return}catch{return}
    const s={card,id,key,pointerId:event.pointerId,touch:event.pointerType==='touch',startX:event.clientX,startY:event.clientY,dragging:false,ghost:null,zones:[]};
    if(!allowed(s))return;state=s;
    // Do not cancel a tap or capture a touch until its direction is known.
  }
  function move(event){
    const s=state;if(!s||event.pointerId!==s.pointerId)return;
    if(!point(event)||!allowed(s)){cancel('state_changed');return}
    if(!s.dragging){
      const dx=Math.abs(event.clientX-s.startX),dy=Math.abs(event.clientY-s.startY);
      if(s.touch&&dx>=10&&dx>=dy*1.1){cancel('horizontal_scroll');return}
      if(s.touch?dy<10||dy<=dx*1.05:Math.hypot(dx,dy)<8)return;
      if(!begin(s,event))return;
    }
    event.preventDefault();moveGhost(s,event.clientX,event.clientY);
  }
  function up(event){
    const s=state;if(!s||event.pointerId!==s.pointerId)return;
    if(!allowed(s)){cancel('state_changed');return}
    if(!s.dragging){state=null;return}
    event.preventDefault();guard.until=Date.now()+800;
    const accepted=point(event)&&allowed(s,true)&&hover(s,event.clientX,event.clientY);
    state=null;cleanup(s);
    // Cleanup releases pointer capture and may synchronously trigger observers.
    // Recheck ownership and revision after it, immediately before the callback.
    if(accepted&&allowed(s,true))options.onDrop(s.id);else options.onCancel?.('invalid_drop');
  }
  listen(root,'pointerdown',down);
  listen(doc,'pointerdown',event=>{if(state&&event.pointerId!==state.pointerId){rejectedDown.add(event);cancel('multiple_pointers')}});
  listen(doc,'pointermove',move);listen(doc,'pointerup',up);
  listen(doc,'pointercancel',event=>{if(state&&event.pointerId===state.pointerId)cancel('pointer_cancel')});
  listen(doc,'lostpointercapture',event=>{if(state&&event.pointerId===state.pointerId)cancel('capture_lost')});
  listen(root,'dragstart',event=>event.preventDefault());
  listen(doc,'keydown',event=>{if(state&&event.key==='Escape'){event.preventDefault();cancel('escape')}});
  listen(doc,'visibilitychange',()=>{if(doc.hidden)cancel('hidden')});
  for(const event of ['vezdehot:accountchange','vezdehot:sessionpause','vezdehot:sessionlost'])listen(doc,event,()=>cancel('ownership_changed'));
  for(const event of ['blur','resize','scroll'])listen(win,event,()=>cancel(event));
  function destroy(){if(destroyed)return;destroyed=true;listeners.forEach(([node,type,fn,capture])=>node?.removeEventListener(type,fn,capture));if(previous===null)root.removeAttribute('data-card-drag');else root.setAttribute('data-card-drag',previous);if(bindings.get(root)===api)bindings.delete(root);cancel('destroyed')}
  const api=Object.freeze({destroy,cancel});bindings.set(root,api);return api;
}
window.VEZDEHOT_CARDS=Object.freeze({bind});
})();
