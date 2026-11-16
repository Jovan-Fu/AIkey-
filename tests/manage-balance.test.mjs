import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import vm from 'node:vm';
import {installBillingMonitor} from '../billing-monitor.js';

// Exact text structure observed on the user's Cloud management page; dummy account/project identifiers.
const banner='歡迎立即升級帳戶，以免服務中斷 (您的抵免額還剩下 €8.46 美元，免費試用期將在 12 天後結束)。';
const id='012345-ABCDEF-123456',name='billingAccounts/'+id,other='AAAAAA-BBBBBB-CCCCCC';
async function collector(url,visibleId=id){
  const node=text=>({innerText:text,textContent:text,getClientRects:()=>[1]});
  const context={URL,Date,location:{href:url},performance:{timeOrigin:Date.now()-1000},getComputedStyle:()=>({visibility:'visible'}),document:{querySelector:()=>node(visibleId),querySelectorAll:selector=>selector.includes('[role="alertdialog"]')?[node(banner)]:[]}};
  context.window ||= {addEventListener(){}};vm.createContext(context);
  for(const file of ['trial-parser.js','trial-collector.js'])vm.runInContext(await readFile(new URL('../'+file,import.meta.url),'utf8'),context);
  return context.AIkeyTrialCollector.collect();
}
test('real traditional management alert text is collected with account identity and currency conflict retained for API verification',async()=>{
  for(const url of [`https://console.cloud.google.com/billing/${id}/manage?project=example-project`,`https://console.cloud.google.com/billing/${id}/manage`,`https://console.cloud.google.com/billing/manage?authuser=0`]){
    const s=await collector(url);assert.equal(s.kind,'manage');assert.equal(s.account,name);assert.equal(s.observation.balance,8.46);assert.equal(s.observation.remainingDays,12);assert(s.observation.currencyConflict);
  }
});
test('management collector refuses conflicting primary ID and generic page without an identified account even when project query is present',async()=>{
  assert.match((await collector(`https://console.cloud.google.com/billing/${id}/manage`,other)).error,/不一致/);
  assert.match((await collector('https://console.cloud.google.com/billing/manage?project=example-project','')).error,/未唯一/);
});
async function fixture(run,{job=null,visibleId=id,routeAccount=id,auth='0'}={}){
  const url=`https://console.cloud.google.com/billing/${routeAccount}/manage?project=example-project&authuser=${auth}`;
  let tabUrl=url;const db={trialMonitor:{profiles:{[name]:{name,currency:'EUR',balance:null,balanceSource:'尚未采集',authUser:'0',armed:true,deadline:Date.now()-60000,job}},active:name}},requests=[],scripts=[];
  const conn={authUser:'0',tabId:8,accounts:[{name,currencyCode:'EUR'}]};let reloads=0,opens=0;
  const request=async(service,path,method='GET')=>{requests.push({service,path,method});assert.equal(method,'GET');if(path==='v1/'+name)return {name,currencyCode:'EUR',open:true};throw Error('Unexpected API path '+path);};
  globalThis.chrome={runtime:{id:'test'},storage:{local:{get:async key=>({[key]:structuredClone(db[key])}),set:async value=>Object.assign(db,structuredClone(value))}},alarms:{create:async()=>{},onAlarm:{addListener(){}}},
    tabs:{query:async()=>[{id:8,url:tabUrl}],get:async()=>({id:8,url:tabUrl,status:'complete'}),reload:async()=>reloads++,create:async()=>opens++},
    action:{setBadgeText:async()=>{},setBadgeBackgroundColor:async()=>{},setTitle:async()=>{}},
    scripting:{executeScript:async options=>{scripts.push(options);if(options.files)return [];return [{frameId:0,result:await collector(tabUrl,visibleId)}];}}
  };
  const monitor=installBillingMonitor({request,isBusy:()=>false,getConnection:()=>conn});
  try{await run({monitor,db,conn,requests,scripts,get reloads(){return reloads;},get opens(){return opens;},switchUrl(value){tabUrl=value;}});}finally{delete globalThis.chrome;}
}
test('management capture and forced background reread return 8.46 EUR without reloading, clicking or starting an overdue close',async()=>fixture(async h=>{
  const before=h.db.trialMonitor.profiles[name].deadline;
  const result=await h.monitor.capture(name,h.conn);assert.equal(result.captured,true);
  let p=h.db.trialMonitor.profiles[name];assert.equal(p.balance,8.46);assert.equal(p.currency,'EUR');assert.equal(p.observedDays,12);assert.equal(p.manageTabId,8);assert.equal(p.refreshState,'manage-read');
  assert.equal(p.armed,true);assert.equal(p.deadline,before);assert.equal(p.job,null);assert.equal(h.opens,0);
  await h.monitor.dashboard({type:'MONITOR_REFRESH_NOW',account:name},h.conn);
  p=h.db.trialMonitor.profiles[name];assert.equal(p.refreshState,'manage-read');assert.equal(p.balance,8.46);assert.equal(h.reloads,0);assert.equal(h.opens,0);
  assert(h.requests.every(r=>r.method==='GET'));assert(h.scripts.every(s=>s.world==='ISOLATED'));
}));
test('another account or Google login index is excluded before page injection',async()=>{
  await fixture(async h=>{assert.equal((await h.monitor.capture(name,h.conn)).captured,false);assert.equal(h.scripts.length,0);assert.equal(h.db.trialMonitor.profiles[name].balance,null);},{routeAccount:other});
  await fixture(async h=>{assert.equal((await h.monitor.capture(name,h.conn)).captured,false);assert.equal(h.scripts.length,0);},{auth:'1'});
});
test('active closing tab is never used as a balance source',async()=>fixture(async h=>{
  assert.equal((await h.monitor.capture(name,h.conn)).captured,false);assert.equal(h.scripts.length,0);assert.equal(h.opens,0);
},{job:{status:'executing',tabId:8,createdAt:Date.now()}}));
test('changing a registered management tab to another billing page blocks further balance refresh',async()=>fixture(async h=>{
  await h.monitor.capture(name,h.conn);h.switchUrl(`https://console.cloud.google.com/billing/${id}/history?authuser=0`);
  const count=h.scripts.length;await h.monitor.dashboard({type:'MONITOR_REFRESH_NOW',account:name},h.conn);
  assert.equal(h.scripts.length,count);assert.equal(h.db.trialMonitor.profiles[name].refreshState,'failed');assert.equal(h.reloads,0);
}));
