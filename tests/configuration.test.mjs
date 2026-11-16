import {test} from 'node:test';
import assert from 'node:assert/strict';
import {exportConfiguration,parseConfiguration,applyConfiguration,migrateSimpleConfiguration} from '../config-core.js';
import {installBillingMonitor} from '../billing-monitor.js';
const a='billingAccounts/012345-ABCDEF-123456',b='billingAccounts/AAAAAA-BBBBBB-CCCCCC',now=Date.now();
const endpoint='https://script.google.com/macros/s/'+'a'.repeat(32)+'/exec',url='https://docs.google.com/spreadsheets/d/'+'b'.repeat(40)+'/edit';
function original(){return {billingAccount:a,sheetSync:{endpoint,spreadsheetUrl:url,secret:'a'.repeat(64),enabled:true,refreshOverview:true},trialMonitor:{active:a,upgradeGuard:true,profiles:{[a]:{name:a,displayName:'测试',currency:'EUR',balance:4.28,balanceSource:'Google Cloud试用横幅',balanceUpdatedAt:now,lastBalanceReadAt:now,deadline:now+86400000,armed:false,authUser:'0',autoRefresh:true,job:{status:'verified-closed'},cookie:'PRIVATE_COOKIE',apiKey:'PRIVATE_API_KEY',json:'PRIVATE_KEY_FILE'}}},balanceGuard:{accounts:{[a]:{account:a,threshold:0,policy:null,armed:false,enabled:false,jobs:{secret:'PRIVATE_JOB'},events:[]}}},state:{apiKey:'PRIVATE_API_KEY'}};}
test('configuration round-trip includes saved sheet URL, endpoint, sync key and zero minimum; excludes credentials and action history',()=>{
  const backup=exportConfiguration(original(),now),text=JSON.stringify(backup),s=parseConfiguration(text);
  assert.equal(s.sheetSync.endpoint,endpoint);assert.equal(s.sheetSync.spreadsheetUrl,url);assert.equal(s.sheetSync.secret,'a'.repeat(64));assert.equal(s.minimums[a].threshold,0);
  assert(!text.includes('PRIVATE_'));assert(!text.includes('jobs'));assert(!text.includes('armed'));
  const restored=applyConfiguration({},s,now);assert.equal(restored.balanceGuard.accounts[a].threshold,0);assert.equal(restored.balanceGuard.accounts[a].savedAt,now);
  assert.equal(restored.sheetSync.enabled,false);assert.equal(restored.trialMonitor.profiles[a].armed,false);assert.equal(restored.trialMonitor.profiles[a].balanceUpdatedAt,null);
  assert.equal(restored.balanceGuard.accounts[a].enabled,false);assert.equal(restored.balanceGuard.accounts[a].policy,null);
});
test('import keeps a newer live balance and other accounts; refuses to replace an authorized or executing task',()=>{
  const current=original(),s=parseConfiguration(exportConfiguration(current));s.profiles[a].balance=999;current.trialMonitor.profiles[b]={name:b,currency:'USD',balance:80};
  const next=applyConfiguration(current,s,now);assert.equal(next.trialMonitor.profiles[a].balance,4.28);assert.equal(next.trialMonitor.profiles[a].balanceUpdatedAt,now);assert.equal(next.trialMonitor.profiles[b].balance,80);
  for(const mutation of [c=>c.trialMonitor.profiles[a].armed=true,c=>c.trialMonitor.profiles[a].job={status:'executing'},c=>c.balanceGuard.accounts[a].triggeredAt=now,c=>c.balanceGuard.accounts[a].enabled=true]){const c=original();mutation(c);assert.throws(()=>applyConfiguration(c,s),/不能导入/);}
});
test('configuration rejects fake destinations, malformed account/amount, unsupported format and oversized files',()=>{
  const mutations=[v=>v.app='other',v=>v.settings.sheetSync.endpoint='https://evil.test/exec',v=>v.settings.sheetSync.spreadsheetUrl='https://docs.google.com.evil.test/spreadsheets/d/12345678901234567890/edit',v=>v.settings.minimums[a].threshold=-1,v=>v.settings.minimums[a].threshold='30',v=>v.settings.profiles[a].authUser='0&evil=1',v=>v.settings.profiles.evil={}];
  for(const change of mutations){const v=exportConfiguration(original());change(v);assert.throws(()=>parseConfiguration(v));}
  assert.throws(()=>parseConfiguration('{'.repeat(250001)));assert.throws(()=>parseConfiguration('{}'));
});
test('in-place migration keeps sheet configuration and observations, retires old monitors, disarms closure once and never performs a network request',async()=>{
  const db=original();db.trialMonitor.profiles[a].armed=true;delete db.balanceGuard;db.costGuard={accounts:{[a]:{enabled:true,armed:true,jobs:{p:'unchanged'}}}};db.tokenMonitor={accounts:{[a]:{enabled:true}}};const oldSheet=structuredClone(db.sheetSync),cleared=[];
  const storage={get:async keys=>Object.fromEntries(keys.map(k=>[k,structuredClone(db[k])])),set:async v=>Object.assign(db,structuredClone(v))};
  await migrateSimpleConfiguration(storage,{clear:async name=>cleared.push(name)});
  assert.deepEqual(db.sheetSync,oldSheet);assert.equal(db.trialMonitor.profiles[a].balanceUpdatedAt,now);assert.equal(db.trialMonitor.profiles[a].balance,4.28);assert.equal(db.trialMonitor.profiles[a].armed,false);assert.equal(db.balanceGuard.accounts[a].threshold,30);assert.equal(db.balanceGuard.accounts[a].enabled,false);
  assert.equal(db.costGuard.accounts[a].armed,false);assert.equal(db.tokenMonitor.accounts[a].enabled,false);assert.deepEqual(cleared,['aikey-cost-guard','aikey-token-readonly']);
  db.balanceGuard.accounts[a].threshold=28;await migrateSimpleConfiguration(storage,{clear:async()=>assert.fail('one-time migration repeated')});assert.equal(db.balanceGuard.accounts[a].threshold,28);
});
test('startup alarm waits for migration before reading an old authorized deadline',async()=>{
  const db={trialMonitor:{active:a,profiles:{[a]:{name:a,armed:true,deadline:1,job:null}}}};let reads=0,release;
  const gate=new Promise(resolve=>release=resolve);
  globalThis.chrome={runtime:{id:'test'},storage:{local:{get:async k=>{reads++;return {[k]:structuredClone(db[k])};},set:async v=>Object.assign(db,structuredClone(v))}},alarms:{create(){},onAlarm:{addListener(){}}},tabs:{create:async()=>assert.fail('must not open account close page during upgrade')},action:{setBadgeText(){},setBadgeBackgroundColor(){},setTitle(){}}};
  try{const m=installBillingMonitor({request:async()=>assert.fail('no API call'),isBusy:()=>false,waitUntilReady:()=>gate});const pending=m.tick();await new Promise(r=>setImmediate(r));assert.equal(reads,0);db.trialMonitor.profiles[a].armed=false;release();await pending;assert.equal(db.trialMonitor.profiles[a].job,null);}
  finally{release();delete globalThis.chrome;}
});
