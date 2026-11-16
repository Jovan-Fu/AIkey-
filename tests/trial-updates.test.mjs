import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import vm from 'node:vm';
import {installBillingMonitor} from '../billing-monitor.js';
import {monitorDisplay} from '../monitor-core.js';

test('traditional trial banners parse current remaining balance, days and currency conflicts',async()=>{
  const context={};context.window ||= {addEventListener(){}};vm.createContext(context);vm.runInContext(await readFile(new URL('../trial-parser.js',import.meta.url),'utf8'),context);
  const parse=context.AIkeyTrialParser.parse;
  const banner=parse('您的抵免額還剩下 $11.60 美元，免費試用期將在 14 天後結束');
  assert.equal(banner.balance,11.6);assert.equal(banner.currency,'USD');assert.equal(banner.remainingDays,14);
  assert.equal(parse('Free trial Remaining credits: USD 10.25 Expires in 3 days').balance,10.25);
  assert.equal(parse('您的抵免額還剩下 US$11.60，免費試用期將在 14 天後結束').currency,'USD');
  assert.equal(parse('Free trial Remaining credits: EUR 11,60 Expires in 3 days').balance,11.6);
  assert.equal(parse('Free trial Remaining credits: EUR 1.234,56 Expires in 3 days').balance,1234.56);
  assert.equal(parse('您的抵免額還剩下 €11.60 美元，免費試用期將在 14 天後結束').currency,'CONFLICT');
  assert.equal(parse('Free trial Total charges USD 200'),null);
  assert.equal(parse('Invoice total USD 11.60'),null);
});

function setup(db){
  globalThis.chrome={runtime:{id:'extension'},storage:{local:{get:async key=>({[key]:structuredClone(db[key])}),set:async values=>Object.assign(db,structuredClone(values))}},
    action:{setBadgeText:async()=>{},setBadgeBackgroundColor:async()=>{},setTitle:async()=>{}}};
}
test('project banner maps to verified billing account rather than active profile, keeps exact deadline and preserves automatic balance on unrelated saves',async()=>{
  const name='billingAccounts/EEEEEE-DDDDDD-CCCCCC',other='billingAccounts/000000-000000-000000',deadline=Date.now()+12*86400000;
  const db={trialMonitor:{profiles:{[name]:{name,balance:70.97,currency:'USD',balanceSource:'手动记录',deadline,armed:true},[other]:{name:other,balance:99,currency:'USD'}},active:other}};
  setup(db);
  let connection={authUser:'0',accounts:[{name}]};const requests=[];
  const m=installBillingMonitor({request:async(...args)=>{requests.push(args);return {billingAccountName:name};},isBusy:()=>false,getConnection:()=>connection});
  const sender={id:'extension',frameId:0,tab:{id:9},url:'https://console.cloud.google.com/vertex-ai/studio?project=some-project'};
  try{
    assert.equal((await m.content({type:'MONITOR_BANNER',account:other,balance:11.6,currency:'USD',remainingDays:14},sender)).accepted,true);
    assert.equal(requests[0][0],'cloudbilling');assert.equal(requests[0][1],'v1/projects/some-project/billingInfo');
    assert.equal(db.trialMonitor.profiles[name].balance,11.6);assert.equal(db.trialMonitor.profiles[other].balance,99);
    assert.equal(db.trialMonitor.profiles[name].deadline,deadline);assert.equal(db.trialMonitor.profiles[name].observedDays,14);
    assert.equal(db.trialMonitor.profiles[name].balanceSource,'Google Cloud试用横幅');
    globalThis.chrome.alarms={create:async()=>{}};
    await m.dashboard({type:'MONITOR_SAVE',account:name,balance:70.97,balanceEdited:false,currency:'USD',deadline,arm:true,confirmScope:true,confirmAccount:name.split('/')[1]},connection);
    assert.equal(db.trialMonitor.profiles[name].balance,11.6);assert.equal(db.trialMonitor.profiles[name].balanceSource,'Google Cloud试用横幅');
    await m.content({type:'MONITOR_BANNER',balance:2,currency:'CONFLICT',currencyConflict:true},sender);
    assert.equal(db.trialMonitor.profiles[name].balance,11.6);assert.match(db.trialMonitor.profiles[name].syncError,/币种/);
    connection=null;
    assert.equal((await m.content({type:'MONITOR_BANNER',balance:1,currency:'USD'},sender)).accepted,false);
    assert.equal(db.trialMonitor.profiles[name].balance,11.6);
  }finally{delete globalThis.chrome;}
});

test('overview refresh works without Sheets and never reloads a switched project tab',async()=>{
  const name='billingAccounts/EEEEEE-DDDDDD-CCCCCC',db={trialMonitor:{profiles:{[name]:{name,overviewTabId:9,authUser:'0',balance:null,armed:false}},active:name}},reloads=[];
  setup(db);let url='https://console.cloud.google.com/billing/overview?authuser=0';
  globalThis.chrome.tabs={get:async id=>({id,url}),reload:async id=>reloads.push(id)};
  const m=installBillingMonitor({request:async()=>{},isBusy:()=>false});
  try{
    await m.tick();await m.tick();assert.deepEqual(reloads,[9]);
    db.trialMonitor.profiles[name].lastRefreshAt=0;url='https://console.cloud.google.com/vertex-ai/studio?project=some-project';
    await m.tick();assert.deepEqual(reloads,[9]);assert.match(db.trialMonitor.profiles[name].syncError,/概览标签页已切换/);
  }finally{delete globalThis.chrome;}
});

test('saved-unarmed UI cannot report closure enabled and refresh resets silently restored checkbox state',async()=>{
  const name='billingAccounts/EEEEEE-DDDDDD-CCCCCC',nodes=new Map(),timers=[];
  let config={profiles:{[name]:{name,balance:70.97,currency:'USD',deadline:Date.now()+3600000,armed:false,savedAt:Date.now()}},active:name};
  function el(id){if(!nodes.has(id))nodes.set(id,{value:id==='billing'?name:'',checked:false,textContent:'',hidden:false,events:{},addEventListener(t,f){this.events[t]=f;}});return nodes.get(id);}
  const context={document:{getElementById:el},Date,Number,Math,Intl,console,setInterval:f=>timers.push(f),chrome:{runtime:{sendMessage:async msg=>{
    if(msg.type==='MONITOR_READ')return {ok:true,data:structuredClone(config)};
    if(msg.type==='MONITOR_SAVE' && msg.arm && (!msg.confirmAccount||!msg.confirmScope))return {ok:false,error:'启用前请确认账号和范围'};
    return {ok:true,data:structuredClone(config)};
  }}}};
  context.window ||= {addEventListener(){}};vm.createContext(context);vm.runInContext(await readFile(new URL('../monitor-ui.js',import.meta.url),'utf8'),context);await new Promise(r=>setImmediate(r));
  assert.equal(el('auto-close').checked,false);assert.match(el('monitor-saved').textContent,/未启用按日期关闭/);
  el('auto-close').checked=true;await timers[0]();assert.equal(el('auto-close').checked,false);
  el('auto-close').checked=true;el('auto-close').events.change();await el('save-monitor').events.click();
  assert.match(el('monitor-status').textContent,/保存失败/);assert.equal(config.profiles[name].armed,false);
});

test('upgrade protection hides precise controls, catches immediate-upgrade and restores original attributes when disabled',async()=>{
  const attrs=new Map(),elements=[],styleIds=new Set(),events={},intervals=[];let enabled=true;
  const button={innerText:'立即升级',getAttribute:k=>attrs.get(k)??null,setAttribute:(k,v)=>attrs.set(k,v),removeAttribute:k=>attrs.delete(k),matches:()=>true};
  elements.push(button);
  const doc={querySelectorAll:()=>elements,getElementById:id=>styleIds.has(id)?{}:null,createElement:()=>({id:'',textContent:''}),head:{append:s=>styleIds.add(s.id)}};
  const context={document:doc,window:{addEventListener:(t,f)=>events[t]=f},location:{pathname:'/'},console,setTimeout(){},setInterval:f=>intervals.push(f),chrome:{runtime:{sendMessage:async()=>({ok:true,data:{enabled}})}}};
  context.window ||= {addEventListener(){}};vm.createContext(context);vm.runInContext(await readFile(new URL('../billing-page.js',import.meta.url),'utf8'),context);await new Promise(r=>setImmediate(r));
  assert.equal(attrs.get('data-aikey-upgrade-guard'),'blocked');assert.equal(attrs.get('aria-disabled'),'true');
  enabled=false;intervals[0]();await new Promise(r=>setImmediate(r));assert.equal(attrs.has('data-aikey-upgrade-guard'),false);assert.equal(attrs.has('aria-disabled'),false);
});

test('known manual amounts stay visible with explicit caution while current automatic values show without caution',()=>{
  assert.equal(monitorDisplay({name:'account',balance:70.97,currency:'USD',balanceSource:'手动记录',balanceUpdatedAt:Date.now()},Date.now(),true).text,'71');
  assert.equal(monitorDisplay({name:'account',balance:11.6,currency:'USD',balanceSource:'Google Cloud试用横幅',balanceUpdatedAt:Date.now()},Date.now(),true).text,'12');
});


test('known closure failure stays failed, does not claim submission, and explicit retry checks server state first',async()=>{
  const name='billingAccounts/012345-ABCDEF-123456',db={trialMonitor:{profiles:{[name]:{name,armed:true,deadline:Date.now()-1000,job:{status:'executing',token:'one',tabId:9}}},active:name}};
  setup(db);const opened=[];let open=true,reads=0;
  globalThis.chrome.tabs={create:async args=>{opened.push(args);return {id:10};}};
  const m=installBillingMonitor({request:async()=>{reads++;return {name,open};},isBusy:()=>false});
  try{
    await m.content({type:'CLOSE_RESULT',account:name,token:'one',submitted:false,note:'未识别到关闭按钮'},{id:'extension',frameId:0,tab:{id:9},url:'https://console.cloud.google.com/billing/manage'});
    assert.equal(db.trialMonitor.profiles[name].job.status,'failed');assert.equal(db.trialMonitor.profiles[name].armed,true);
    await m.tick();assert.equal(opened.length,0);
    await m.dashboard({type:'MONITOR_RETRY_CLOSE',account:name},{authUser:'0',accounts:[{name}]});
    assert.equal(reads,1);assert.equal(opened.length,1);assert.equal(new URL(opened[0].url).pathname,'/billing/manage');
    db.trialMonitor.profiles[name].job.status='failed';open=false;
    await m.dashboard({type:'MONITOR_RETRY_CLOSE',account:name},{authUser:'0',accounts:[{name}]});
    assert.equal(opened.length,1);assert.equal(db.trialMonitor.profiles[name].job.status,'verified-closed');
  }finally{delete globalThis.chrome;}
});

test('page heartbeat reports missing or active content script and refuses unrelated origins',async()=>{
  setup({});const m=installBillingMonitor({request:async()=>{},isBusy:()=>false});
  try{
    assert.equal((await m.dashboard({type:'MONITOR_READ'})).pageAgent,null);
    await assert.rejects(()=>m.content({type:'MONITOR_HEARTBEAT',version:'2.4.0'},{id:'extension',tab:{id:9},frameId:0,url:'https://evil.test'}));
    await m.content({type:'MONITOR_HEARTBEAT',version:'2.4.0'},{id:'extension',tab:{id:9},frameId:0,url:'https://console.cloud.google.com/'});
    assert.equal((await m.dashboard({type:'MONITOR_READ'})).pageAgent.version,'2.4.0');
  }finally{delete globalThis.chrome;}
});


test('read-only banner monitoring can restore an already authorized console context after worker suspension',async()=>{
  const name='billingAccounts/012345-ABCDEF-123456',db={trialMonitor:{profiles:{[name]:{name,currency:'USD',balance:null}},active:name}};setup(db);
  let connection=null,restores=0;
  const m=installBillingMonitor({request:async()=>({billingAccountName:name}),isBusy:()=>false,getConnection:()=>connection,ensureConnection:async()=>{restores++;connection={authUser:'0',accounts:[{name}]};return connection;}});
  try{
    const result=await m.content({type:'MONITOR_BANNER',balance:11.6,currency:'USD',remainingDays:14},{id:'extension',tab:{id:9},frameId:0,url:'https://console.cloud.google.com/vertex-ai/studio?project=some-project'});
    assert.equal(result.accepted,true);assert.equal(restores,1);assert.equal(db.trialMonitor.profiles[name].balance,11.6);
  }finally{delete globalThis.chrome;}
});


test('last known balance remains visible while tooltip distinguishes stale, missing time, manual and uncertain currency',()=>{
  const now=1800000000000,base={name:'account',balance:11.09,currency:'EUR',balanceSource:'Google Cloud试用横幅',deadline:now+13*86400000};
  const stale=monitorDisplay({...base,balanceUpdatedAt:now-6*60000},now,true);
  assert.equal(stale.text,'11');assert.equal(stale.color,'#e45757');assert.match(stale.title,/超过5分钟/);assert.match(stale.title,/6分钟前/);assert.match(stale.title,/11.09 EUR/);
  const manual=monitorDisplay({...base,balanceSource:'手动记录',balanceUpdatedAt:now},now,true);assert.equal(manual.text,'11');assert.match(manual.title,/手动记录，尚未验证自动同步/);
  const noTime=monitorDisplay(base,now,true);assert.equal(noTime.text,'11');assert.match(noTime.title,/缺少采集时间/);
  const recent=monitorDisplay({...base,balanceUpdatedAt:now},now,true);assert.equal(recent.color,'#e45757');assert.match(recent.title,/最近5分钟内采集/);
  const uncertain=monitorDisplay({...base,balanceObservation:{status:'currency-unknown',amount:11.08}},now,true);assert.equal(uncertain.text,'?');assert.match(uncertain.title,/11.08（币种待核实）/);
  assert.equal(monitorDisplay({...base,balance:null},now,true).text,'?');
  assert.equal(monitorDisplay({...base,deadline:null,balanceUpdatedAt:now},now,false).text,'11');
});
