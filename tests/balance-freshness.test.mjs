import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import vm from 'node:vm';
import {installBillingMonitor} from '../billing-monitor.js';
import {makeSnapshot} from '../sheet-sync.js';

async function fixture(run,{auto=true,failedCreate=false,existingOverview=false,connected=true}={}){
  const name='billingAccounts/012345-ABCDEF-123456',manage='https://console.cloud.google.com/billing/012345-ABCDEF-123456/manage?authuser=0';
  let now=Date.parse('2026-11-16T10:00:00Z'),nextId=2,amount=4.28,fail=failedCreate;
  const oldPage=now-21*60000,tabs=new Map([[1,{id:1,url:manage,status:'complete',started:oldPage}]]),created=[],reloaded=[];
  const profile={name,authUser:'0',balance:4.28,currency:'EUR',balanceSource:'Google Cloud试用横幅',balanceUpdatedAt:now-20*60000,balancePageStartedAt:oldPage,balanceSourceTabId:1,manageTabId:1,autoRefresh:auto,armed:false,deadline:null,job:null};
  const db={trialMonitor:{profiles:{[name]:profile},active:name}},conn={authUser:'0',accounts:[{name,currencyCode:'EUR'}]};
  if(existingOverview)tabs.set(2,{id:2,url:manage.replace('/manage',''),status:'complete',started:now}),nextId=3;
  const realNow=Date.now;Date.now=()=>now;
  globalThis.chrome={runtime:{id:'extension'},storage:{local:{get:async k=>({[k]:structuredClone(db[k])}),set:async v=>Object.assign(db,structuredClone(v))}},alarms:{create(){},onAlarm:{addListener(){}}},action:{setBadgeText(){},setBadgeBackgroundColor(){},setTitle(){}},
    tabs:{get:async id=>{if(!tabs.has(id))throw Error('No tab');return {...tabs.get(id)};},query:async()=>[...tabs.values()].map(t=>({...t})),create:async options=>{created.push(options);if(fail)throw Error('tab create failed');const tab={id:nextId++,url:options.url,status:'complete',started:now};tabs.set(tab.id,tab);return {...tab};},reload:async id=>{reloaded.push(id);tabs.get(id).started=now;}},
    scripting:{executeScript:async options=>{assert.equal(options.world,'ISOLATED');if(options.files)return [];const t=tabs.get(options.target.tabId);return [{frameId:0,result:{url:t.url,account:name,pageStartedAt:t.started,observation:{balance:t.id===1?4.28:amount,currency:'EUR',remainingDays:11}}}];}}};
  const monitor=installBillingMonitor({request:async(_service,path,method='GET')=>{assert.equal(method,'GET');assert.equal(path,'v1/'+name);return {name,currencyCode:'EUR'};},isBusy:()=>false,getConnection:()=>connected?conn:null});
  const send=(tabId,balance,started)=>monitor.content({type:'MONITOR_BANNER',balance,currency:'EUR',remainingDays:11,pageStartedAt:started},{id:'extension',tab:{id:tabId},frameId:0,url:tabs.get(tabId).url});
  try{await run({monitor,name,db,conn,created,reloaded,tabs,oldPage,send,get p(){return db.trialMonitor.profiles[name];},get now(){return now;},advance:ms=>now+=ms,setAmount:v=>amount=v,setFailure:v=>fail=v});assert.equal(db.trialMonitor.profiles[name].armed,false);assert.equal(db.trialMonitor.profiles[name].job,null);}finally{Date.now=realNow;delete globalThis.chrome;}
}
test('management-only monitoring creates one inactive overview and advances real snapshot times on successive refresh cycles even for unchanged balance',async()=>fixture(async h=>{
  const old=h.p.balanceUpdatedAt;
  await h.send(1,4.28,h.oldPage);assert.equal(h.p.lastBalanceReadAt,h.now);assert.equal(h.p.balanceUpdatedAt,old);assert.equal(h.p.balanceValueChangedAt,undefined);
  await h.monitor.tick();assert.equal(h.created.length,1);assert.equal(h.created[0].active,false);assert.equal(new URL(h.created[0].url).pathname,'/billing/012345-ABCDEF-123456');assert.equal(h.p.autoOverviewTabId,2);assert.equal(h.reloaded.length,0);
  const firstPage=h.now;h.advance(30000);await h.monitor.tick();assert.equal(h.p.balanceUpdatedAt,firstPage);assert.equal(h.p.lastBalanceReadAt,h.now);assert.equal(h.p.balance,4.28);
  h.advance(30000);await h.monitor.tick();const secondPage=h.now;assert.deepEqual(h.reloaded,[2]);
  h.advance(30000);await h.monitor.tick();assert.equal(h.p.balanceUpdatedAt,secondPage);assert.equal(h.p.balance,4.28);assert.equal(h.created.length,1);assert(!h.reloaded.includes(1));
  const data=makeSnapshot(h.db.trialMonitor).accounts[0];assert.equal(data.sampledAt,secondPage);assert.equal(data.lastReadAt,h.now);assert.equal(data.valueChangedAt,null);
}));
test('older management and previous-document messages cannot roll a refreshed balance or its timestamp back',async()=>fixture(async h=>{
  await h.monitor.tick();h.advance(30000);h.setAmount(4.10);await h.monitor.tick();
  const fresh=h.p.balanceUpdatedAt;assert.equal(h.p.balance,4.10);
  const late=await h.send(1,4.28,h.oldPage);assert.equal(late.balanceAccepted,false);assert.equal(h.p.balance,4.10);assert.equal(h.p.balanceUpdatedAt,fresh);assert.equal(h.p.overviewTabId,2);
  const sameTabLate=await h.send(2,99,h.oldPage);assert.equal(sameTabLate.balanceAccepted,false);assert.equal(h.p.balance,4.10);
}));
test('pausing auto refresh prevents tab creation, while an explicit fresh-page read still cannot arm closure',async()=>fixture(async h=>{
  await h.monitor.tick();assert.equal(h.created.length,0);
  await h.monitor.dashboard({type:'MONITOR_REFRESH_NOW',account:h.name,freshPage:true},h.conn);
  assert.equal(h.created.length,1);assert.equal(h.p.autoRefresh,false);assert.equal(h.p.balance,4.28);
},{auto:false}));
test('reuses an already open matching overview and never creates duplicate overview tabs',async()=>fixture(async h=>{
  await h.monitor.tick();assert.equal(h.created.length,0);assert.equal(h.p.overviewTabId,2);h.advance(30000);await h.monitor.tick();assert.deepEqual(h.reloaded,[2]);assert(!h.reloaded.includes(1));
},{existingOverview:true}));
test('a closed owned refresh tab is detached and replaced at most once per minute without reloading management',async()=>fixture(async h=>{
  await h.monitor.tick();h.tabs.delete(2);h.advance(30000);await h.monitor.tick();assert.equal(h.p.overviewTabId,undefined);
  h.advance(30000);await h.monitor.tick();assert.equal(h.created.length,2);assert.equal(h.p.autoOverviewTabId,3);assert(!h.reloaded.includes(1));
}));
test('failed tab creation is rate limited and leaves a visible refresh error without stamping the old balance fresh',async()=>fixture(async h=>{
  const at=h.p.balanceUpdatedAt;await h.monitor.tick();assert.equal(h.created.length,1);assert.match(h.p.overviewRefreshError,/failed/);assert.equal(h.p.balanceUpdatedAt,at);
  h.advance(30000);await h.monitor.tick();assert.equal(h.created.length,1);assert.equal(h.p.balanceUpdatedAt,at);
  h.advance(30000);h.setFailure(false);await h.monitor.tick();assert.equal(h.created.length,2);assert.equal(h.p.overviewRefreshError,'');
},{failedCreate:true}));
test('no current authorized Google connection means no automatically opened billing page',async()=>fixture(async h=>{
  const at=h.p.balanceUpdatedAt;await h.monitor.tick();assert.equal(h.created.length,0);assert.equal(h.p.balanceUpdatedAt,at);assert.equal(h.p.balance,4.28);
},{connected:false}));
test('03 card distinguishes a recent successful DOM read from the older page snapshot instead of reporting no collection',async()=>{
  const name='billingAccounts/012345-ABCDEF-123456',nodes=new Map(),now=Date.now();
  const node=id=>{if(!nodes.has(id))nodes.set(id,{value:id==='billing'?name:'',textContent:'',checked:false,hidden:false,events:{},addEventListener(type,fn){this.events[type]=fn;}});return nodes.get(id);};
  const p={name,balance:4.28,currency:'EUR',balanceSource:'Google Cloud试用横幅',balanceUpdatedAt:now-21*60000,lastBalanceReadAt:now,observedDays:11,observedAt:now,autoOverviewTabId:2,overviewTabId:2};
  const context={document:{getElementById:node},Date,Number,Math,Intl,setInterval(){},chrome:{runtime:{sendMessage:async()=>({ok:true,data:{active:name,profiles:{[name]:p}}})}}};
  context.window ||= {addEventListener(){}};vm.createContext(context);vm.runInContext(await readFile(new URL('../monitor-ui.js',import.meta.url),'utf8'),context);await new Promise(r=>setImmediate(r));
  assert.match(node('balance-source').textContent,/页面快照超过5分钟/);assert(!node('balance-source').textContent.includes('未采集'));
  assert.match(node('balance-read').textContent,/最近成功读取/);assert.match(node('sync-health').textContent,/独立的后台概览刷新页/);assert.equal(node('trial-close').textContent,'未启用');
});
