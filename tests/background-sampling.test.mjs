import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import vm from 'node:vm';
import {installBillingMonitor} from '../billing-monitor.js';

async function fixture(callback){
  const name='billingAccounts/012345-ABCDEF-123456',url='https://console.cloud.google.com/billing/012345-ABCDEF-123456/overview?authuser=0';
  let now=1800000000000,loadedAt=now,amount=11.09,account=name,scriptCalls=0,reloads=0,creates=0,currentUrl=url;
  const db={trialMonitor:{profiles:{[name]:{name,authUser:'0',balance:11.09,currency:'EUR',balanceUpdatedAt:now-600000,balanceSource:'Google Cloud试用横幅',deadline:now-1,armed:true,job:{status:'failed',error:'prior close failure'}}},active:name}};
  const realNow=Date.now;Date.now=()=>now;
  const connection={authUser:'0',accounts:[{name,currencyCode:'EUR'}]};
  globalThis.chrome={runtime:{id:'extension'},storage:{local:{get:async k=>({[k]:structuredClone(db[k])}),set:async v=>Object.assign(db,structuredClone(v))}},
    action:{setBadgeText:async()=>{},setBadgeBackgroundColor:async()=>{},setTitle:async()=>{}},
    tabs:{get:async id=>({id,url:currentUrl,status:'complete'}),reload:async()=>{reloads++;loadedAt=now;},create:async()=>{creates++;return {id:10};}},
    scripting:{executeScript:async options=>{scriptCalls++;assert.equal(options.world,'ISOLATED');if(options.files){assert.deepEqual(options.files,['trial-parser.js','trial-collector.js']);return [];}
      return [{frameId:0,result:{url:currentUrl,kind:'overview',account,pageStartedAt:loadedAt,observation:{balance:amount,currency:'EUR',remainingDays:13}}}];}}
  };
  const m=installBillingMonitor({request:async()=>{throw new Error('unexpected cloud write/request');},isBusy:()=>false,getConnection:()=>connection});
  const sender={id:'extension',tab:{id:9},frameId:0,url};
  try{await callback({m,name,db,sender,connection,get profile(){return db.trialMonitor.profiles[name];},get reloads(){return reloads;},get creates(){return creates;},get scriptCalls(){return scriptCalls;},get now(){return now;},advance:ms=>now+=ms,setAmount:v=>amount=v,setAccount:v=>account=v,setUrl:v=>currentUrl=v});}
  finally{Date.now=realNow;delete globalThis.chrome;}
}

test('traditional banner registers overview refresh source, failed past-due closure does not suppress refresh, and worker samples without any page timer',async()=>{
  await fixture(async h=>{
    await h.m.content({type:'MONITOR_BANNER',balance:11.09,currency:'EUR',remainingDays:13,pageStartedAt:h.now-600000},h.sender);
    assert.equal(h.profile.overviewTabId,9);
    await h.m.tick();assert.equal(h.reloads,1);assert.equal(h.profile.refreshState,'loading');
    h.advance(30000);h.setAmount(11.08);await h.m.tick();
    assert.equal(h.scriptCalls,2);assert.equal(h.profile.balance,11.08);assert.equal(h.profile.refreshState,'updated');assert.equal(h.profile.lastDomReadAt,h.now);assert.equal(h.creates,0);
  });
});

test('unchanged cached DOM does not move data timestamp, while consecutive reload-and-sample cycles do',async()=>{
  await fixture(async h=>{
    await h.m.content({type:'MONITOR_BANNER',balance:11.09,currency:'EUR',pageStartedAt:h.now-600000},h.sender);
    const old=h.profile.balanceUpdatedAt;h.advance(15000);
    await h.m.content({type:'MONITOR_BANNER',balance:11.09,currency:'EUR',pageStartedAt:h.now-615000},h.sender);
    assert.equal(h.profile.balanceUpdatedAt,old);assert.equal(h.profile.lastDomReadAt,h.now);
    await h.m.tick();const firstReload=h.now;h.advance(30000);await h.m.tick();assert.equal(h.profile.balanceUpdatedAt,firstReload);
    h.advance(30000);await h.m.tick();const secondReload=h.now;h.advance(30000);await h.m.tick();assert.equal(h.profile.balanceUpdatedAt,secondReload);assert.equal(h.reloads,2);
  });
});

test('wrong overview account and changed URL never overwrite a known balance',async()=>{
  await fixture(async h=>{
    h.profile.overviewTabId=9;await h.m.tick();h.advance(30000);h.setAccount('billingAccounts/000000-000000-000000');h.setAmount(99);await h.m.tick();
    assert.equal(h.profile.balance,11.09);assert.equal(h.profile.refreshState,'failed');assert.match(h.profile.syncError,/核实概览账号/);
    const calls=h.scriptCalls;h.setUrl('https://example.com/private');await h.m.tick();assert.equal(h.scriptCalls,calls);assert.equal(h.profile.balance,11.09);
  });
});

test('manual balance refresh is read-only and cannot trigger even an already due closure',async()=>{
  await fixture(async h=>{
    h.profile.overviewTabId=9;h.profile.job=null;h.profile.autoRefresh=false;
    await h.m.dashboard({type:'MONITOR_REFRESH_NOW',account:h.name},h.connection);
    assert.equal(h.reloads,1);assert.equal(h.creates,0);assert.equal(h.profile.job,null);
  });
});

test('closed tabs expose an error without changing the last successfully captured timestamp',async()=>{
  await fixture(async h=>{
    h.profile.overviewTabId=9;const old=h.profile.balanceUpdatedAt;
    globalThis.chrome.tabs.get=async()=>{throw new Error('No tab with id 9');};
    await h.m.tick();assert.equal(h.profile.balanceUpdatedAt,old);assert.match(h.profile.syncError,/No tab/);assert.equal(h.profile.refreshState,'failed');
  });
});

test('background collector extracts only structured trial data on the fixed Cloud origin',async()=>{
  const banner='您的抵免額還剩下 €11.09 美元，免費試用期將在 13 天後結束',id='012345-ABCDEF-123456';
  const node=t=>({innerText:t,getClientRects:()=>[1]});
  const context={location:{href:'https://console.cloud.google.com/billing/'+id+'/overview?authuser=0'},document:{querySelector:()=>node(id+' fake-private-key-must-not-return'),querySelectorAll:()=>[node(banner)]},getComputedStyle:()=>({visibility:'visible'}),URL,performance:{timeOrigin:1800000000000}};
  context.window ||= {addEventListener(){}};vm.createContext(context);for(const file of ['trial-parser.js','trial-collector.js'])vm.runInContext(await readFile(new URL('../'+file,import.meta.url),'utf8'),context);
  const result=context.AIkeyTrialCollector.collect();assert.equal(result.account,'billingAccounts/'+id);assert.equal(result.observation.balance,11.09);assert(!JSON.stringify(result).includes('fake-private-key'));
  context.location.href='https://example.com/billing/'+id+'/overview';assert.match(context.AIkeyTrialCollector.collect().error,/拒绝/);
});
