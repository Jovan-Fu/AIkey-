import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFile,access} from 'node:fs/promises';
import vm from 'node:vm';
import {installConfiguration} from '../config-manager.js';
import {BalanceGuardCore} from '../balance-guard-core.js';
const account='billingAccounts/012345-ABCDEF-123456',now=Date.now();
function nodes(){const map=new Map();return id=>{if(!map.has(id)){let value=id==='billing'?account:'';map.set(id,{get value(){return value;},set value(v){value=String(v);},textContent:'',dataset:{},checked:false,disabled:false,hidden:false,events:{},addEventListener(k,f){this.events[k]=f;}});}return map.get(id);};}
test('configuration export button produces a private local JSON; preview/import restores values and keeps all automatic actions off',async()=>{
  const endpoint='https://script.google.com/macros/s/'+'a'.repeat(32)+'/exec',sheet='https://docs.google.com/spreadsheets/d/'+'b'.repeat(40)+'/edit';
  const db={sheetSync:{endpoint,spreadsheetUrl:sheet,secret:'a'.repeat(64),enabled:true},billingAccount:account,trialMonitor:{active:account,profiles:{[account]:{name:account,currency:'EUR',balance:4.28,authUser:'0'}}},balanceGuard:{accounts:{[account]:{threshold:30}}}},node=nodes(),calls=[];let exportedBlob,clicked=false,filename,importEvent;
  const manager=installConfiguration({isBusy:()=>false});
  globalThis.chrome={storage:{local:{get:async ks=>Object.fromEntries(ks.map(k=>[k,structuredClone(db[k])])),set:async v=>Object.assign(db,structuredClone(v))}}};
  const context={document:{getElementById:node,createElement:tag=>{assert.equal(tag,'a');const a={click(){filename=a.download;clicked=true;}};return a;}},Blob,Date,JSON,URL:{createObjectURL:b=>{exportedBlob=b;return 'blob:local';},revokeObjectURL(){}},Event:class{constructor(type){this.type=type;}},window:{dispatchEvent:e=>importEvent=e.type},setTimeout(){},chrome:{runtime:{sendMessage:async m=>{calls.push(m.type);return {ok:true,data:await manager.handle(m)};}}}};
  try{context.window ||= {addEventListener(){}};vm.createContext(context);vm.runInContext(await readFile(new URL('../config-ui.js',import.meta.url),'utf8'),context);
    await node('config-export').events.click();assert(clicked);assert.match(filename,/^AIkey-config-.*\.json$/);const text=await exportedBlob.text();assert.equal(JSON.parse(text).settings.minimums[account].threshold,30);
    db.sheetSync.endpoint='';db.balanceGuard.accounts[account].threshold=88;
    node('config-file').files=[{size:text.length,text:async()=>text}];await node('config-file').events.change();assert.equal(node('config-apply').hidden,false);assert(node('config-status').textContent.includes(sheet));assert(!node('config-status').textContent.includes('a'.repeat(64)));
    await node('config-apply').events.click();assert.equal(db.sheetSync.endpoint,endpoint);assert.equal(db.balanceGuard.accounts[account].threshold,30);assert.equal(db.sheetSync.enabled,false);assert.equal(db.trialMonitor.profiles[account].armed,false);assert.equal(importEvent,'aikey-config-imported');assert(calls.every(t=>t.startsWith('CONFIG_')));
  }finally{delete globalThis.chrome;}
});
test('03 minimum UI retains zero and unsaved edits; refresh, save and check never send an enable request',async()=>{
  const node=nodes(),calls=[],timers=[];let state={account,threshold:0,enabled:false,armed:false,projects:[],status:'未启用',balance:null};
  const context={document:{getElementById:node},Date,Number,Object,Promise,window:{addEventListener(){}},setInterval:f=>timers.push(f),chrome:{runtime:{sendMessage:async m=>{calls.push(m);if(m.type==='MONITOR_READ')return {ok:true,data:{active:account}};if(m.type==='BALANCE_GUARD_READ')return {ok:true,data:{[account]:state}};if(m.type==='BALANCE_GUARD_SAVE')state={...state,threshold:m.threshold};if(m.type==='BALANCE_GUARD_CHECK')state={...state,fresh:true,checkId:'test',checkedAt:now,balance:20,threshold:m.threshold,closeBillingAccount:m.closeBillingAccount,closeBillingAccountConfigured:true};return {ok:true,data:state};}}}};
  context.window ||= {addEventListener(){}};vm.createContext(context);vm.runInContext(await readFile(new URL('../balance-guard-ui.js',import.meta.url),'utf8'),context);await new Promise(r=>setImmediate(r));
  assert.equal(node('minimum-balance').value,'0');assert.equal(node('balance-guard-enable').disabled,true);
  node('minimum-balance').value='31';node('minimum-balance').events.input();await timers[0]();assert.equal(node('minimum-balance').value,'31');
  await node('balance-guard-save').events.click();assert.equal(state.threshold,31);assert.equal(state.enabled,false);assert.equal(node('balance-guard-enable').disabled,true);
  await node('balance-guard-check').events.click();assert.match(node('balance-guard-message').textContent,/启用后会立即停用/);assert.equal(state.enabled,false);assert(!calls.some(m=>m.type==='BALANCE_GUARD_ENABLE'));
});
test('dashboard resources and import graph exist; retired panels, pricing requests and Monitoring permission are absent',async()=>{
  const html=await readFile(new URL('../dashboard.html',import.meta.url),'utf8'),manifest=JSON.parse(await readFile(new URL('../manifest.json',import.meta.url),'utf8'));
  assert(!/token|guard-allowance|单价|报价/i.test(html));assert.equal(manifest.version,'2.5.8');assert(!JSON.stringify(manifest).includes('monitoring.clients6'));
  const ids=[...html.matchAll(/\bid="([^"]+)"/g)].map(m=>m[1]);assert.equal(new Set(ids).size,ids.length);
  for(const m of html.matchAll(/(?:src|href)="([^":#]+\.(?:js|css|png))"/g))await access(new URL('../'+m[1],import.meta.url));
  const seen=new Set();async function scan(file){if(seen.has(file))return;seen.add(file);const code=await readFile(new URL('../'+file,import.meta.url),'utf8');assert(!/monitoring\.clients6|from ['"]\.\/cost-guard|from ['"]\.\/token-monitor/.test(code));for(const m of code.matchAll(/from ['"]\.\/([^'"]+)['"]/g))await scan(m[1]);}
  await scan('background.js');assert(seen.has('config-manager.js'));assert(seen.has('balance-guard-core.js'));assert(!seen.has('auto-pricing.js'));
  assert.equal(BalanceGuardCore.summary({threshold:0}).threshold,0);
});
async function guardUi(state,profile,{ignoreCombined=false}={}){
  const node=nodes(),calls=[],timers=[];let stored=state,release;
  const context={document:{getElementById:node},Date,Number,Object,Promise,window:{addEventListener(){}},setInterval:f=>timers.push(f),chrome:{runtime:{sendMessage:async m=>{
    calls.push(m);if(m.type==='MONITOR_READ')return {ok:true,data:{active:account,profiles:{[account]:profile},accountCurrencies:{[account]:'EUR'}}};
    if(m.type==='BALANCE_GUARD_READ')return {ok:true,data:stored?{[account]:stored}:{}};
    if(m.type==='BALANCE_GUARD_CHECK'){if(release)await release;stored={account,threshold:m.threshold,enabled:false,armed:false,fresh:true,checkId:'test',checkedAt:Date.now(),sampledAt:Date.now(),currency:'EUR',balance:2.45,closeBillingAccount:ignoreCombined?false:m.closeBillingAccount,closeBillingAccountConfigured:!ignoreCombined,projects:[{id:'example-project'}]};}
    if(m.type==='BALANCE_GUARD_TEST')return {ok:true,data:{...stored,enabled:false,armed:false}};
    if(m.type==='BALANCE_GUARD_ENABLE')stored={...stored,enabled:true,armed:true,status:'已启用'};
    return {ok:true,data:stored};
  }}}};
  vm.createContext(context);vm.runInContext(await readFile(new URL('../balance-guard-ui.js',import.meta.url),'utf8'),context);await new Promise(r=>setImmediate(r));
  return {node,calls,timers,setWait:p=>release=p,get state(){return stored;}};
}
test('real reported condition: 2.45 EUR and authorized date closure never appear as active balance protection',async()=>{
  const h=await guardUi(null,{balance:2.45,currency:'EUR',balanceUpdatedAt:Date.now(),balanceSource:'Google Cloud试用横幅',armed:true,deadline:Date.now()+11*86400000});
  assert.equal(h.node('balance-guard-state').textContent,'未启用按余额停用');assert.equal(h.node('balance-guard-notice').dataset.level,'danger');assert.match(h.node('balance-guard-notice').textContent,/2\.45 EUR.*30 EUR/);assert.match(h.node('balance-guard-notice').textContent,/不能代替余额停用/);assert.equal(h.node('balance-guard-enable').disabled,true);
  await h.timers[0]();assert(!h.calls.some(m=>m.type==='BALANCE_GUARD_ENABLE'));
});
test('checking scope requires subsequent exact account and explicit consent before step 2 becomes available',async()=>{
  const h=await guardUi({account,threshold:30},{});await h.node('balance-guard-check').events.click();assert.equal(h.node('balance-guard-authorization').open,true);assert.equal(h.node('balance-guard-enable').disabled,true);assert.match(h.node('balance-guard-enable').textContent,/立即停用/);
  h.node('balance-guard-consent').checked=true;h.node('balance-guard-consent').events.change();assert.equal(h.node('balance-guard-enable').disabled,true);
  h.node('balance-guard-account').value=account.split('/')[1];h.node('balance-guard-account').events.input();assert.equal(h.node('balance-guard-enable').disabled,false);
  h.node('minimum-balance').value='29';h.node('minimum-balance').events.input();assert.equal(h.node('balance-guard-enable').disabled,true);assert(!h.calls.some(m=>m.type==='BALANCE_GUARD_ENABLE'));
});
test('changing a draft while the scope check is in flight cannot authorize or restore the outdated result',async()=>{
  const h=await guardUi({account,threshold:30},{});let release;h.setWait(new Promise(r=>release=r));const running=h.node('balance-guard-check').events.click();
  h.node('minimum-balance').value='22';h.node('minimum-balance').events.input();release();await running;
  assert.equal(h.node('minimum-balance').value,'22');assert.equal(h.node('balance-guard-enable').disabled,true);assert.match(h.node('balance-guard-message').textContent,/检查期间.*已修改/);assert(!h.calls.some(m=>m.type==='BALANCE_GUARD_ENABLE'));
});
test('read-only balance retest keeps the actual production authorization visible and never sends enable',async()=>{
  const h=await guardUi({account,threshold:30,enabled:true,armed:true,status:'余额保护已启用'},{});await h.node('balance-guard-test').events.click();assert.equal(h.node('balance-guard-state').textContent,'已启用（仅项目）');assert.equal(h.state.armed,true);assert(!h.calls.some(m=>m.type==='BALANCE_GUARD_ENABLE'));
  const paused=await guardUi({account,threshold:30,enabled:true,armed:false},{});assert.equal(paused.node('balance-guard-state').textContent,'未启用按余额停用');
});
test('new combined UI cannot enable an old background which silently ignores the account-close option',async()=>{
  const h=await guardUi({account,threshold:30},{},{ignoreCombined:true});assert.equal(h.node('balance-close-account').checked,true);await h.node('balance-guard-check').events.click();
  h.node('balance-guard-account').value=account.split('/')[1];h.node('balance-guard-consent').checked=true;h.node('balance-guard-consent').events.change();assert.equal(h.node('balance-guard-enable').disabled,true);assert.match(h.node('balance-guard-message').textContent,/重新加载整个/);assert(!h.calls.some(m=>m.type==='BALANCE_GUARD_ENABLE'));
});
test('project success with a pending account closure stays incomplete and only verified dual success is shown as complete',async()=>{
  const initial={account,threshold:30,closeBillingAccount:true,closeBillingAccountConfigured:true,enabled:true,armed:true,triggeredAt:now,projectComplete:true,completed:false,accountClose:{status:'opening',accountOpen:true,message:'等待官方页关闭'}};
  const pending=await guardUi(initial,{});assert.match(pending.node('balance-guard-state').textContent,/尚未全部完成/);assert.match(pending.node('balance-close-status').textContent,/等待官方页关闭/);assert.notEqual(pending.node('balance-guard-notice').dataset.level,'ok');
  const done=await guardUi({...initial,completed:true,accountClose:{status:'verified-closed',accountOpen:false}},{});assert.match(done.node('balance-guard-state').textContent,/项目与结算账号均已停用/);assert.equal(done.node('balance-guard-notice').dataset.level,'ok');
});
