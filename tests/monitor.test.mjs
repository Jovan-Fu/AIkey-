import {test} from 'node:test';
import assert from 'node:assert/strict';
import {ACCOUNT_RE,billingRoute,billingPageUrl,due,monitorDisplay} from '../monitor-core.js';
import {installBillingMonitor} from '../billing-monitor.js';
import {readFile} from 'node:fs/promises';
import vm from 'node:vm';

test('account route, deadline and icon calculations do not mistake unknown balance for zero',()=>{
  assert(ACCOUNT_RE.test('billingAccounts/012345-ABCDEF-123456'));
  assert.equal(billingRoute('https://evil.test/billing/012345-ABCDEF-123456/manage'),null);
  assert.equal(billingRoute('https://console.cloud.google.com/billing/012345-ABCDEF-123456/manage').page,'manage');
  assert.equal(billingRoute('https://console.cloud.google.com/billing/012345-ABCDEF-123456').page,'overview');
  assert(!due({armed:false,deadline:1},2));assert(due({armed:true,deadline:1},2));
  assert.equal(monitorDisplay(null).text,'?');
  assert.equal(monitorDisplay({name:'test',deadline:86400001,balance:null},1,true).text,'?');
  assert.equal(monitorDisplay({name:'test',deadline:90*86400000,balance:null,balanceUpdatedAt:1},1).color,'#f5ba4b');
  assert.equal(monitorDisplay({name:'test',accountOpen:false}).text,'OFF');
});

test('closure requires explicit scope, exact account, due time, designated tab and single-use ticket; DOM never proves closure',async()=>{
  const db={},tabs=[],notices=[],requests=[];const id='a'.repeat(32),name='billingAccounts/012345-ABCDEF-123456';
  globalThis.chrome={runtime:{id},alarms:{create:async()=>{},get:async()=>({scheduledTime:Date.now()+30000}),onAlarm:{addListener(){}}},storage:{local:{get:async k=>({[k]:structuredClone(db[k])}),set:async v=>Object.assign(db,structuredClone(v))}},
    tabs:{create:async args=>{tabs.push(args);return {id:42};}},notifications:{create:async(...args)=>notices.push(args)},
    action:{setBadgeText:async()=>{},setBadgeBackgroundColor:async()=>{},setTitle:async()=>{}}};
  const m=installBillingMonitor({request:async(...args)=>{requests.push(args);return {name,open:false};},isBusy:()=>false});
  const connection={authUser:'1',accounts:[{name,displayName:'Trial'}]};
  const save={type:'MONITOR_SAVE',account:name,balance:200,currency:'USD',deadline:Date.now()+60000,arm:true,confirmAccount:'012345-ABCDEF-123456',confirmScope:true,upgradeGuard:true};
  try{
    await assert.rejects(()=>m.dashboard({...save,confirmScope:false},connection),/启用整个账号/);
    await assert.rejects(()=>m.dashboard({...save,confirmAccount:'WRONG'},connection),/启用整个账号/);
    await m.dashboard(save,connection);
    await m.tick();assert.equal(tabs.length,0);
    db.trialMonitor.profiles[name].deadline=Date.now()-1;
    await m.tick();await m.tick();assert.equal(tabs.length,1);assert.equal(tabs[0].active,false);
    const sender={id,frameId:0,tab:{id:42},url:'https://console.cloud.google.com/billing/012345-ABCDEF-123456/manage'};
    assert.equal((await m.content({type:'CLOSE_TICKET'},{...sender,tab:{id:43}})).allowed,false);
    await assert.rejects(()=>m.content({type:'CLOSE_TICKET'},{...sender,url:'https://evil.test/'}));
    const ticket=await m.content({type:'CLOSE_TICKET'},sender);assert(ticket.allowed);
    assert.equal((await m.content({type:'CLOSE_TICKET'},sender)).allowed,false);
    await assert.rejects(()=>m.content({type:'CLOSE_RESULT',token:'forged'},sender));
    await m.content({type:'CLOSE_RESULT',token:ticket.token,note:'fake success text'},sender);
    assert.equal(db.trialMonitor.profiles[name].job.status,'needs-verification');
    assert.equal(requests.length,0);
    await m.dashboard({type:'MONITOR_CHECK_ACCOUNT',account:name},{authUser:'1',accounts:[]});
    assert.equal(db.trialMonitor.profiles[name].job.status,'verified-closed');
    assert.equal(requests[0][1],'v1/'+name);
    const deadline=db.trialMonitor.profiles[name].deadline;
    await m.content({type:'MONITOR_SNAPSHOT',balance:180,currency:'USD',remainingDays:20},{...sender,url:sender.url.replace('/manage','/overview')});
    assert.equal(db.trialMonitor.profiles[name].deadline,deadline);
    assert.equal(db.trialMonitor.profiles[name].balance,180);
    assert(notices.length>0);
  }finally{delete globalThis.chrome;}
});

test('upgrade click interceptor blocks explicit upgrade but leaves unrelated actions usable',async()=>{
  const events={},node={matches:()=>true,getAttribute:()=>null,innerText:'Upgrade account'};
  let prevented=false,stopped=false;
  const context={window:{addEventListener:(type,fn)=>events[type]=fn},chrome:{runtime:{sendMessage:async()=>({ok:true,data:{enabled:true}})}},
    document:{getElementById:()=>({textContent:'',remove(){}})},location:{pathname:'/'},setInterval(){},setTimeout(){},console};
  context.window ||= {addEventListener(){}};vm.createContext(context);vm.runInContext(await readFile(new URL('../billing-page.js',import.meta.url),'utf8'),context);
  const event={composedPath:()=>[node],preventDefault:()=>prevented=true,stopImmediatePropagation:()=>stopped=true};
  events.click(event);assert(prevented && stopped);
  prevented=false;node.innerText='Create project';events.click(event);assert(!prevented);
});

test('page closure never submits a dialog without exact billing account identity',async()=>{
  const source=await readFile(new URL('../billing-page.js',import.meta.url),'utf8');
  async function simulate(identity,path="/billing/012345-ABCDEF-123456/manage",pageIdentity=identity,displayName=""){
    let start,dialogOpen=false,submissions=0,result;
    const button=(click)=>({innerText:'Close billing account',getAttribute:()=>null,getClientRects:()=>[1],disabled:false,click});
    const entry=button(()=>dialogOpen=true),confirm=button(()=>submissions++);
    const dialog={innerText:'Close billing account '+identity,getClientRects:()=>[1],querySelectorAll:()=>[confirm]};
    const context={window:{addEventListener(){}},location:{pathname:path},
      document:{querySelector:()=>({innerText:pageIdentity}),querySelectorAll:selector=>selector.startsWith('[role="dialog"]')?(dialogOpen?[dialog]:[]):[entry]},getComputedStyle:()=>({visibility:'visible'}),
      chrome:{runtime:{sendMessage:async msg=>{
        if(msg.type==='UPGRADE_GUARD_READ')return {ok:true,data:{enabled:true}};
        if(msg.type==='CLOSE_TICKET')return {ok:true,data:{allowed:true,account:'billingAccounts/012345-ABCDEF-123456',displayName,token:'test-ticket'}};
        if(msg.type==='CLOSE_CONFIRM_READY')return {ok:true,data:{allowed:true}};if(msg.type==='CLOSE_RESULT'){result=msg;return {ok:true,data:{accepted:true}};}
        return {ok:true,data:{}};
      }}},setInterval(){},setTimeout(fn,ms){if(ms===6000)start=fn;else queueMicrotask(fn);},console};
    context.window ||= {addEventListener(){}};vm.createContext(context);vm.runInContext(source,context);start();
    for(let i=0;i<10 && !result;i++)await new Promise(r=>setImmediate(r));
    return {submissions,result};
  }
  const rejected=await simulate('OTHER-ACCOUNT');assert.equal(rejected.submissions,0);assert.match(rejected.result.note,/未通过账号ID/);
  const accepted=await simulate('012345-ABCDEF-123456');assert.equal(accepted.submissions,1);assert.match(accepted.result.note,/尚未证明成功/);
  const nameOnly=await simulate('My billing account','/billing/manage','012345-ABCDEF-123456','My billing account');assert.equal(nameOnly.submissions,1);
  const foreignId=await simulate('My billing account 000000-000000-000000','/billing/manage','012345-ABCDEF-123456','My billing account');assert.equal(foreignId.submissions,0);
  const nameWithoutId=await simulate('My billing account','/billing/manage','','My billing account');assert.equal(nameWithoutId.submissions,0);
  const generic=await simulate('012345-ABCDEF-123456','/billing/manage');assert.equal(generic.submissions,1);
  const unknown=await simulate('012345-ABCDEF-123456','/billing/manage','');assert.equal(unknown.submissions,0);
  const wrong=await simulate('012345-ABCDEF-123456','/billing/manage','000000-000000-000000');assert.equal(wrong.submissions,0);
  const ambiguous=await simulate('012345-ABCDEF-123456','/billing/manage','012345-ABCDEF-123456 000000-000000-000000');assert.equal(ambiguous.submissions,0);
});

test('trial snapshot reads explicit remaining credit and ignores unrelated total charges',async()=>{
  const code=await readFile(new URL('../billing-page.js',import.meta.url),'utf8');
  async function extract(text,path="/billing/012345-ABCDEF-123456/overview",pageIdentity=""){
    let start;const sent=[];
    const box={innerText:text,parentElement:null};
    const marker={getAttribute:()=>null,textContent:'Free trial',innerText:'Free trial',getClientRects:()=>[1],parentElement:box};
    const context={window:{addEventListener(){}},location:{pathname:path},
      document:{body:{innerText:pageIdentity},querySelectorAll:()=>[marker]},getComputedStyle:()=>({visibility:'visible'}),
      chrome:{runtime:{sendMessage:async msg=>{sent.push(msg);return {ok:true,data:{enabled:true}};}}},
      setInterval(){},setTimeout(fn,ms){if(ms===6000)start=fn;},console};
    context.window ||= {addEventListener(){}};vm.createContext(context);vm.runInContext(code,context);start();await new Promise(r=>setImmediate(r));
    return sent.find(m=>m.type==='MONITOR_SNAPSHOT');
  }
  const snapshot=await extract('Free trial Remaining credits: USD 123.45 Expires in 30 days');
  assert.equal(snapshot.balance,123.45);assert.equal(snapshot.currency,'USD');assert.equal(snapshot.remainingDays,30);
  assert.equal(await extract('Free trial Total charges: USD 99.00'),undefined);
  const generic=await extract('Free trial Remaining credits: USD 123.45','/billing/overview','Account 012345-ABCDEF-123456');
  assert.equal(generic.account,'billingAccounts/012345-ABCDEF-123456');
  assert.equal(await extract('Free trial Remaining credits: USD 123.45','/billing/overview',''),undefined);
  assert.equal(await extract('Free trial Remaining credits: USD 123.45','/billing/overview','012345-ABCDEF-123456 000000-000000-000000'),undefined);
});


test('opening billing pages uses connected Google identity before a profile is saved and reports tab errors',async()=>{
  const name='billingAccounts/012345-ABCDEF-123456',opened=[];
  globalThis.chrome={runtime:{id:'test'},storage:{local:{get:async()=>({}),set:async()=>{}}},
    alarms:{create:async()=>{},onAlarm:{addListener(){}}},tabs:{create:async args=>{opened.push(args);return {id:5};}}};
  const m=installBillingMonitor({request:async()=>{throw new Error('must not call billing API');},isBusy:()=>false});
  const connection={authUser:'3',accounts:[{name}]};
  try{
    const result=await m.dashboard({type:'MONITOR_OPEN',account:name,page:'overview'},connection);
    assert.equal(result.authUser,'3');assert.equal(new URL(opened[0].url).searchParams.get('authuser'),'3');
    assert.equal(opened[0].active,true);assert.equal(new URL(opened[0].url).pathname,'/billing/overview');
    const payment=await m.dashboard({type:'MONITOR_OPEN',account:name,page:'paymentoverview'},connection);
    assert.equal(new URL(payment.url).pathname,'/billing/history');
    const manage=await m.dashboard({type:'MONITOR_OPEN',account:name,page:'manage'},connection);assert.equal(new URL(manage.url).pathname,'/billing/manage');
    await assert.rejects(()=>m.dashboard({type:'MONITOR_OPEN',account:name,page:'https://evil.test'},connection),/不支持/);
    globalThis.chrome.tabs.create=async()=>{throw new Error('tab unavailable');};
    await assert.rejects(()=>m.dashboard({type:'MONITOR_OPEN',account:name,page:'paymentoverview'},connection),/tab unavailable.*https:\/\/console/);
    await assert.rejects(()=>m.dashboard({type:'MONITOR_OPEN',account:name,page:'overview'},null),/请先连接/);
  }finally{delete globalThis.chrome;}
});

test('diagnostic checks distinguish unsaved and armed schedules without triggering closure',async()=>{
  const db={},name='billingAccounts/012345-ABCDEF-123456';let opens=0;
  globalThis.chrome={runtime:{id:'test'},storage:{local:{get:async k=>({[k]:structuredClone(db[k])}),set:async v=>Object.assign(db,structuredClone(v))}},
    alarms:{create:async()=>{},get:async()=>({scheduledTime:Date.now()+30000}),onAlarm:{addListener(){}}},tabs:{create:async()=>{opens++;return {id:1};}},
    action:{setBadgeText:async()=>{},setBadgeBackgroundColor:async()=>{},setTitle:async()=>{}}};
  const m=installBillingMonitor({request:async()=>{throw new Error('read only diagnostic must not request billing');},isBusy:()=>false});
  const conn={authUser:'2',accounts:[{name}]};
  try{
    let d=await m.dashboard({type:'MONITOR_DIAGNOSE',account:name},conn);
    assert.equal(d.saved,false);assert.equal(d.armed,false);assert.equal(opens,0);
    await m.dashboard({type:'MONITOR_SAVE',account:name,balance:0,currency:'USD',deadline:Date.now()+120000,arm:true,confirmAccount:name.split('/')[1],confirmScope:true},conn);
    d=await m.dashboard({type:'MONITOR_DIAGNOSE',account:name},conn);
    assert.equal(d.saved,true);assert.equal(d.armed,true);assert.equal(d.due,false);assert(d.savedAt);assert(d.alarmScheduledAt);
    db.trialMonitor.profiles[name].deadline=Date.now()-1;
    d=await m.dashboard({type:'MONITOR_DIAGNOSE',account:name},conn);assert.equal(d.due,true);assert.equal(opens,0);
    globalThis.chrome.alarms.create=async()=>{throw new Error('schedule denied');};
    await assert.rejects(()=>m.dashboard({type:'MONITOR_SAVE',account:name,balance:0,currency:'USD',deadline:Date.now()+120000,arm:true,confirmAccount:name.split('/')[1],confirmScope:true},conn),/schedule denied/);
  }finally{delete globalThis.chrome;}
});

test('monitor UI keeps page-opening failures visible and shows unsaved configuration',async()=>{
  const nodes=new Map(),name='billingAccounts/012345-ABCDEF-123456';
  function node(id){if(!nodes.has(id))nodes.set(id,{value:id==='billing'?name:'',textContent:'',checked:false,hidden:false,events:{},addEventListener(type,fn){this.events[type]=fn;}});return nodes.get(id);}
  const context={document:{getElementById:node},Date,Number,Math,Intl,setInterval(){},console,
    chrome:{runtime:{sendMessage:async msg=>msg.type==='MONITOR_READ'?{ok:true,data:{profiles:{},active:''}}:{ok:false,error:'真实打开错误示例'}},tabs:{create:async()=>{}}}};
  context.window ||= {addEventListener(){}};vm.createContext(context);vm.runInContext(await readFile(new URL('../monitor-ui.js',import.meta.url),'utf8'),context);
  await new Promise(r=>setImmediate(r));
  assert.match(node('monitor-saved').textContent,/尚未保存/);
  await node('sync-trial').events.click();assert.equal(node('monitor-status').textContent,'真实打开错误示例');
  node('trial-amount').events.input();assert.match(node('monitor-saved').textContent,/未保存的修改/);
});


test('official routes do not splice account IDs into URLs or trust account query hints',()=>{
  assert.equal(billingPageUrl('overview','0'),'https://console.cloud.google.com/billing/overview?authuser=0');
  assert.equal(billingPageUrl('paymentoverview','2'),'https://console.cloud.google.com/billing/history?authuser=2');
  assert.equal(billingPageUrl('manage','1'),'https://console.cloud.google.com/billing/manage?authuser=1');
  assert.throws(()=>billingPageUrl('https://evil.test','0'));
  assert.throws(()=>billingPageUrl('overview','0&evil=true'));
  assert.deepEqual(billingRoute('https://console.cloud.google.com/billing/manage?billingAccount=012345-ABCDEF-123456'),{account:'',page:'manage'});
  assert.equal(billingRoute('https://console.cloud.google.com.evil.test/billing/manage'),null);
});

test('generic management route still needs matching due account and designated tab for closure',async()=>{
  const name='billingAccounts/012345-ABCDEF-123456',db={trialMonitor:{profiles:{[name]:{name,armed:true,deadline:Date.now()-1,job:{status:'opening',tabId:9,token:'one-use'}}}}};
  globalThis.chrome={runtime:{id:'test'},storage:{local:{get:async k=>({[k]:structuredClone(db[k])}),set:async v=>Object.assign(db,structuredClone(v))}}};
  const m=installBillingMonitor({request:async()=>{},isBusy:()=>false});
  const sender={id:'test',frameId:0,tab:{id:9},url:'https://console.cloud.google.com/billing/manage?billingAccount=012345-ABCDEF-123456'};
  try{
    assert.equal((await m.content({type:'CLOSE_TICKET'},sender)).allowed,false);
    assert.equal((await m.content({type:'CLOSE_TICKET',account:'billingAccounts/000000-000000-000000'},sender)).allowed,false);
    assert.equal((await m.content({type:'CLOSE_TICKET',account:name},{...sender,tab:{id:10}})).allowed,false);
    assert.equal((await m.content({type:'CLOSE_TICKET',account:name},sender)).allowed,true);
    assert.equal((await m.content({type:'CLOSE_TICKET',account:name},sender)).allowed,false);
  }finally{delete globalThis.chrome;}
});
