'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const vm=require('node:vm');

const source=fs.readFileSync(path.join(__dirname,'../dist/platform.js'),'utf8');
const plain=value=>JSON.parse(JSON.stringify(value));
const entry=(id,game,win,delta,xp,at)=>({id,game,win,delta,xp,at,synced:false});
const rows=[
  entry('durak-win','durak',true,250,25,'2026-10-22T12:00:00Z'),
  entry('poker-payout','poker',false,1200,10,'2026-10-22T10:00:00Z'),
  entry('mafia-loss','mafia',false,0,5,'2026-10-21T18:00:00Z'),
  entry('monopoly-adjustment','monopoly',false,-50,8,'2026-10-20T09:00:00Z')
];

function harness(history=[],lifetime={}){
  const profile={nick:'History Tester',balance:7800,games:49,wins:18,xp:3100,history,...lifetime};
  const store=new Map([['vezdehot:profile:guest',JSON.stringify(profile)]]),timers=new Set(),events=[];
  const document={documentElement:{dataset:{}},addEventListener(){},dispatchEvent:event=>events.push(event),querySelector:()=>null};
  const context={
    window:{VEZDEHOT_AUTH_CONFIG:{},addEventListener(){}},document,
    localStorage:{getItem:key=>store.get(key)||null,setItem:(key,value)=>store.set(key,value)},
    CustomEvent:class{constructor(type,options){this.type=type;this.detail=options?.detail}},
    setTimeout(fn,ms){const timer=setTimeout(fn,ms);timer.unref?.();timers.add(timer);return timer},clearTimeout(timer){clearTimeout(timer);timers.delete(timer)},
    location:{search:'',origin:'https://app.test',assign(){}},URLSearchParams,AbortController,crypto:require('node:crypto').webcrypto,console
  };
  vm.createContext(context);vm.runInContext(source,context);
  return {api:context.window.VEZDEHOT,store,events,context,close(){for(const timer of timers)clearTimeout(timer)}};
}

test('history filters game and stored outcome independently; payout does not imply a win',async t=>{
  const h=harness(rows);t.after(()=>h.close());await h.api.ready;
  assert.deepEqual(plain(h.api.getHistory()).map(row=>row.id),rows.map(row=>row.id));
  assert.deepEqual(plain(h.api.getHistory({game:'poker',outcome:'all'})).map(row=>row.id),['poker-payout']);
  assert.deepEqual(plain(h.api.getHistory({game:'all',outcome:'win'})).map(row=>row.id),['durak-win']);
  assert.deepEqual(plain(h.api.getHistory({game:'all',outcome:'other'})).map(row=>row.id),['poker-payout','mafia-loss','monopoly-adjustment']);
  assert.equal(h.api.getHistory({game:'poker',outcome:'win'}).length,0);
});

test('history summaries count gross credits separately from negative adjustments and lifetime stats',async t=>{
  const h=harness(rows);t.after(()=>h.close());await h.api.ready;
  const summary=plain(h.api.getHistorySummary());
  assert.equal(summary.total,4);assert.equal(summary.wins,1);assert.equal(summary.other,3);
  assert.equal(summary.credited,1450);assert.equal(summary.xp,48);assert.equal(summary.winRate,25);
  assert.equal(summary.retainedLimit,30);
  assert.deepEqual(summary.lifetime,{games:49,wins:18,xp:3100,balance:7800});
  const poker=summary.byGame.find(row=>row.game==='poker');
  assert.ok(poker);assert.equal(poker.count,1);assert.equal(poker.wins,0);assert.equal(poker.label,'Покер');
  const filtered=plain(h.api.getHistorySummary({game:'poker',outcome:'other'}));
  assert.equal(filtered.total,1);assert.equal(filtered.credited,1200);assert.equal(filtered.wins,0);
  assert.deepEqual(filtered.lifetime,summary.lifetime);
});

test('empty history has honest zero summary even when lifetime games exist',async t=>{
  const h=harness([]);t.after(()=>h.close());await h.api.ready;
  assert.equal(h.api.getHistory().length,0);
  const summary=h.api.getHistorySummary();
  for(const field of ['total','wins','other','credited','xp','winRate'])assert.equal(summary[field],0,field);
  assert.equal(summary.lifetime.games,49);
  assert.equal(summary.lifetime.wins,18);
  assert.equal(summary.byGame.reduce((sum,row)=>sum+row.count,0),0);
});

test('invalid dates remain safe and undated; unknown games are discarded; ties preserve order',async t=>{
  const fixture=[
    entry('bad-date','mafia',false,0,3,'not a date'),
    entry('older','poker',true,30,2,'2026-10-20T12:00:00Z'),
    entry('tie-a','durak',true,40,5,'2026-10-22T12:00:00Z'),
    entry('unknown','<img src=x onerror=alert(1)>',true,9999,9999,'2026-10-23T12:00:00Z'),
    entry('tie-b','bunker',false,0,1,'2026-10-22T12:00:00Z'),
    entry('no-date','monopoly',false,0,0,'')
  ];
  const h=harness(fixture);t.after(()=>h.close());await h.api.ready;
  const result=plain(h.api.getHistory());
  assert.deepEqual(result.map(row=>row.id),['tie-a','tie-b','older','bad-date','no-date']);
  assert.equal(result.find(row=>row.id==='bad-date').at,'');
  assert.equal(result.find(row=>row.id==='no-date').at,'');
  assert.equal(h.api.getHistorySummary().credited,70);
});

test('history helpers return independent copies and cannot mutate profile or future summaries',async t=>{
  const h=harness(rows);t.after(()=>h.close());await h.api.ready;
  const first=h.api.getHistory();first[0].delta=99999;first[0].game='poker';first.reverse();first.push({id:'injected'});
  const summary=h.api.getHistorySummary();summary.lifetime.games=999;summary.byGame[0].count=999;
  assert.equal(h.api.getHistory()[0].id,'durak-win');assert.equal(h.api.getHistory()[0].delta,250);
  assert.equal(h.api.getHistorySummary().credited,1450);assert.equal(h.api.getHistorySummary().lifetime.games,49);
  assert.equal(h.api.getProfile().history.length,4);
});

test('only retained real entries are exposed; lifetime totals are not reconstructed from thirty rows',async t=>{
  const fixture=Array.from({length:36},(_,i)=>entry('round-'+i,'durak',i%2===0,10,1,new Date(Date.UTC(2026,9,22,12,0,i)).toISOString()));
  const h=harness(fixture,{games:103,wins:61,xp:8500});t.after(()=>h.close());await h.api.ready;
  const summary=h.api.getHistorySummary();assert.equal(h.api.getHistory().length,30);assert.equal(summary.total,30);
  assert.equal(summary.credited,300);assert.equal(summary.xp,30);assert.equal(summary.lifetime.games,103);assert.equal(summary.lifetime.wins,61);
});

test('malformed legacy numeric values cannot poison rendered totals with NaN or Infinity',async t=>{
  const fixture=[
    entry('infinite','durak',true,'Infinity','Infinity','2026-10-22T12:00:00Z'),
    {...entry('not-numeric','poker','false','NaN',-12,'2026-10-22T11:00:00Z'),synced:'false'},
    entry('numeric-string','mafia',false,'42.9','3.9','2026-10-22T10:00:00Z'),
    entry('out-of-range','bunker',true,9e12,9e12,'2026-10-22T09:00:00Z')
  ];
  const h=harness(fixture);t.after(()=>h.close());await h.api.ready;
  const normalized=h.api.getHistory();
  assert.ok(normalized.every(row=>Number.isFinite(row.delta)&&Number.isFinite(row.xp)&&row.xp>=0));
  assert.equal(normalized[0].delta,0);assert.equal(normalized[0].xp,0);assert.equal(normalized[1].xp,0);
  assert.equal(normalized[1].win,false);assert.equal(normalized[1].synced,false);
  assert.equal(normalized[2].delta,42);assert.equal(normalized[2].xp,3);
  assert.equal(h.api.getHistorySummary().credited,2000042);assert.equal(h.api.getHistorySummary().xp,2000000003);
});
