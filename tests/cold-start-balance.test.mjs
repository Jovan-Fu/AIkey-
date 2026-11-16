import {test} from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFile} from 'node:fs/promises';
import {installBillingMonitor} from '../billing-monitor.js';

// Current Google Cloud Chinese banner, with no real account/project identifiers.
const banner='免费试用状态：剩余 $300.00 赠金和 78 天时间。升级为完整账号即可不受限制地访问所有 Google Cloud 服务，您可以使用任何剩余的赠金，然后只需按用量付费。';
const account='billingAccounts/012345-ABCDEF-123456';
const accountId=account.split('/')[1];
async function parser(){const context={};vm.createContext(context);vm.runInContext(await readFile(new URL('../trial-parser.js',import.meta.url),'utf8'),context);return context.AIkeyTrialParser.parse;}

test('current simplified Chinese status banner reads 300 credit and 78 days, including zero and localized amounts',async()=>{
  const parse=await parser(),value=parse(banner);
  assert(value,'The current official banner must be recognized');assert.equal(value.balance,300);assert.equal(value.currency,'DOLLAR');assert.equal(value.remainingDays,78);
  const zero=parse('免费试用状态：剩余 US$0.00 赠金和 0 天时间。');assert.equal(zero.balance,0);assert.equal(zero.currency,'USD');assert.equal(zero.remainingDays,0);
  const euro=parse('免费试用状态：剩余 €1.234,56 赠金和 12 天时间。');assert.equal(euro.balance,1234.56);assert.equal(euro.currency,'EUR');assert.equal(euro.remainingDays,12);
  assert.equal(parse('免费试用状态：剩余 25.00 美元赠金和 9 天时间。').currency,'USD');
});

test('new Chinese parser still refuses used-credit totals and preserves currency conflicts',async()=>{
  const parse=await parser();
  assert.equal(parse('免费试用期间，已使用 $300.00 赠金。'),null);
  const days=parse('免费试用状态：剩余 78 天；累计消费 $300.00。');assert.equal(days.balance,null);assert.equal(days.remainingDays,78);
  const conflict=parse('免费试用状态：剩余 €30.00 美元赠金和 8 天时间。');assert.equal(conflict.balance,30);assert.equal(conflict.currency,'CONFLICT');assert(conflict.currencyConflict);
});

async function fixture(run,{saved=false,auto=true,connected=true,failedCreate=false}={}){
  let now=Date.parse('2026-11-16T17:00:00Z');const realNow=Date.now;Date.now=()=>now;
  const db={trialMonitor:{profiles:saved?{[account]:{name:account,currency:'USD',balance:null,balanceUpdatedAt:null,authUser:'0',autoRefresh:auto,armed:false,job:null}}:{},active:saved?account:''}};
  const connection={authUser:'0',tabId:1,accounts:[{name:account,currencyCode:'USD'}]};
  const tabs=new Map([[1,{id:1,url:'https://console.cloud.google.com/billing?authuser=0',status:'complete'}]]),opened=[],reloaded=[],apiCalls=[];let nextId=2;
  const collect=async tab=>{
    const node=text=>({innerText:text,textContent:text,getClientRects:()=>[1]});
    const context={URL,Date,location:{href:tab.url},performance:{timeOrigin:tab.started},getComputedStyle:()=>({visibility:'visible'}),document:{querySelector:()=>node(accountId),querySelectorAll:()=>[node(banner)]}};
    vm.createContext(context);for(const file of ['trial-parser.js','trial-collector.js'])vm.runInContext(await readFile(new URL('../'+file,import.meta.url),'utf8'),context);
    return context.AIkeyTrialCollector.collect();
  };
  globalThis.chrome={runtime:{id:'extension'},storage:{local:{get:async key=>({[key]:structuredClone(db[key])}),set:async value=>Object.assign(db,structuredClone(value))}},alarms:{create(){},onAlarm:{addListener(){}}},action:{setBadgeText(){},setBadgeBackgroundColor(){},setTitle(){}},
    tabs:{get:async id=>{if(!tabs.has(id))throw Error('No tab');return {...tabs.get(id)};},query:async()=>[...tabs.values()],create:async options=>{opened.push(options);if(failedCreate)throw Error('Cannot open balance page');const tab={id:nextId++,url:options.url,status:'loading',started:now};tabs.set(tab.id,tab);return {...tab};},reload:async id=>{reloaded.push(id);tabs.get(id).started=now;}},
    scripting:{executeScript:async options=>{assert.equal(options.world,'ISOLATED');if(options.files)return [];return [{frameId:0,result:await collect(tabs.get(options.target.tabId))}];}}};
  const request=async(service,path,method='GET')=>{apiCalls.push({service,path,method});assert.equal(method,'GET');assert.equal(path,'v1/'+account);return {name:account,currencyCode:'USD',open:true,displayName:'Example billing'};};
  const monitor=installBillingMonitor({request,isBusy:()=>false,getConnection:()=>connected?connection:null});
  try{await run({monitor,connection,db,tabs,opened,reloaded,apiCalls,advance:ms=>now+=ms,get profile(){return db.trialMonitor.profiles[account];}});assert(apiCalls.every(c=>c.method==='GET'));assert(!db.balanceGuard?.accounts?.[account]?.enabled);if(db.trialMonitor.profiles[account]){assert.equal(db.trialMonitor.profiles[account].armed,false);assert.equal(db.trialMonitor.profiles[account].job,null);}}finally{Date.now=realNow;delete globalThis.chrome;}
}

test('new browser first readonly capture creates one matching background source and later reads the real banner without enabling shutdown',async()=>fixture(async h=>{
  const first=await h.monitor.capture(account,h.connection);assert.equal(first.captured,false);assert.equal(first.pending,true);assert.match(first.reason,/等待|正在/);
  assert.equal(h.opened.length,1);assert.equal(h.opened[0].active,false);assert.equal(new URL(h.opened[0].url).pathname,'/billing/'+accountId);assert.equal(h.profile.balance,null);
  h.advance(1000);await h.monitor.capture(account,h.connection);assert.equal(h.opened.length,1);
  h.tabs.get(2).status='complete';h.advance(29000);await h.monitor.tick();
  assert.equal(h.profile.balance,300);assert.equal(h.profile.currency,'USD');assert.equal(h.profile.observedDays,78);assert(h.profile.balanceUpdatedAt);assert.equal(h.opened.length,1);
}));

test('saved or imported profile with no old tab IDs bootstraps on the next alarm and does not wait forever',async()=>fixture(async h=>{
  await h.monitor.tick();assert.equal(h.opened.length,1);assert.equal(h.profile.refreshState,'loading');assert.equal(h.profile.balanceUpdatedAt,null);
  h.tabs.get(2).status='complete';h.advance(30000);await h.monitor.tick();assert.equal(h.profile.balance,300);assert.equal(h.profile.observedDays,78);assert.equal(h.reloaded.length,0);
},{saved:true}));

test('cold start honors paused refresh and absent verified connection instead of opening account pages',async()=>{
  await fixture(async h=>{await h.monitor.tick();assert.equal(h.opened.length,0);assert.equal(h.profile.balance,null);},{saved:true,auto:false});
  await fixture(async h=>{await h.monitor.tick();assert.equal(h.opened.length,0);assert.equal(h.profile.balance,null);},{saved:true,connected:false});
});

test('failed cold-start tab creation stays unknown, exposes the error and is rate limited',async()=>fixture(async h=>{
  await h.monitor.tick();assert.equal(h.opened.length,1);assert.match(h.profile.syncError,/Cannot open/);assert.equal(h.profile.balanceUpdatedAt,null);
  h.advance(30000);await h.monitor.tick();assert.equal(h.opened.length,1);assert.equal(h.profile.balance,null);
  h.advance(30000);await h.monitor.tick();assert.equal(h.opened.length,2);assert.match(h.profile.syncError,/Cannot open/);
},{saved:true,failedCreate:true}));
