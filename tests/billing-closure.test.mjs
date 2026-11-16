import {test} from 'node:test';
import assert from 'node:assert/strict';
import {installBillingClosure} from '../billing-closure.js';

const account='billingAccounts/012345-ABCDEF-123456',project={id:'example-project',number:'123456789012'};
async function fixture(run){
  let now=Date.now(),open=true,extra=false,busy=false,failCreate=false,nextId=20,hook;
  const db={balanceGuard:{accounts:{[account]:{enabled:true,armed:true,triggeredAt:now,authorizationId:'approved-run-1',policy:{version:3,account,currency:'EUR',authUser:'0',closeBillingAccount:true,projects:[project]}}}},trialMonitor:{profiles:{[account]:{armed:true,deadline:now+11*86400000}}}},calls=[],created=[],tabs=new Map();
  const conn={authUser:'0',accounts:[{name:account}]},realNow=Date.now;Date.now=()=>now;
  globalThis.chrome={runtime:{id:'extension'},storage:{local:{get:async k=>({[k]:structuredClone(db[k])}),set:async v=>Object.assign(db,structuredClone(v))}},tabs:{create:async options=>{assert.equal(db.billingClosure.accounts[account].status,'opening');assert.equal(options.active,false);if(failCreate)throw Error('tab failed');const t={id:nextId++,url:options.url};tabs.set(t.id,t);created.push(options);return t;},get:async id=>{if(!tabs.has(id))throw Error('No tab');return {...tabs.get(id)};}}};
  const controller=installBillingClosure({isBusy:()=>busy,withConnection:fn=>fn(conn),request:async(service,path,method='GET')=>{
    calls.push({service,path,method});assert.equal(method,'GET');
    if(path==='v1/'+account)return {name:account,currencyCode:'EUR',displayName:'My billing account',open};
    if(path==='v1/'+account+'/projects'){if(hook)await hook();return {projectBillingInfo:[{projectId:project.id,billingAccountName:account},...(extra?[{projectId:'unapproved-project',billingAccountName:account}]:[])]};}
    throw Error('Unexpected path '+path);
  }});
  const sender=()=>{const t=[...tabs.values()].at(-1);return {id:'extension',frameId:0,tab:{id:t.id},url:t.url};};
  const send=(type,fields={})=>controller.content({type,account,agentVersion:'2.5.8',...fields},sender());
  try{await run({controller,db,conn,calls,created,tabs,sender,send,now:()=>now,advance:ms=>now+=ms,setOpen:v=>open=v,setExtra:v=>extra=v,setBusy:v=>busy=v,setCreateFail:v=>failCreate=v,setHook:v=>hook=v});}
  finally{Date.now=realNow;delete globalThis.chrome;}
}
test('account closure cannot be queued without explicit combined authorization or when Google identity/scope changes',async()=>fixture(async h=>{
  const s=h.db.balanceGuard.accounts[account];s.policy.closeBillingAccount=false;await assert.rejects(()=>h.controller.run(account,h.conn),/授权/);s.policy.closeBillingAccount=true;
  s.armed=false;await assert.rejects(()=>h.controller.run(account,h.conn),/授权/);s.armed=true;
  h.conn.authUser='1';await assert.rejects(()=>h.controller.run(account,h.conn),/不匹配/);h.conn.authUser='0';
  h.setExtra(true);await assert.rejects(()=>h.controller.run(account,h.conn),/新关联项目/);assert.equal(h.created.length,0);assert(h.calls.every(c=>c.method==='GET'));
}));
test('closure uses a private exact-tab ticket, checks consent again before submit, and only API open=false proves success',async()=>fixture(async h=>{
  const oldDate=structuredClone(h.db.trialMonitor);const first=await h.controller.run(account,h.conn);assert.equal(first.status,'opening');assert(!('token' in first));assert.equal(h.created.length,1);assert.deepEqual(h.db.trialMonitor,oldDate);
  assert.equal((await h.send('CLOSE_TICKET',{agentVersion:'2.5.7'})).allowed,false);
  const ticket=await h.send('CLOSE_TICKET');assert.equal(ticket.allowed,true);assert.equal(ticket.kind,'balance');assert.equal((await h.send('CLOSE_TICKET')).allowed,false);
  const otherTab={id:99,url:h.sender().url};h.tabs.set(99,otherTab);assert.equal((await h.controller.content({type:'CLOSE_TICKET',account,agentVersion:'2.5.8'},{id:'extension',frameId:0,tab:{id:99},url:otherTab.url})).allowed,false);h.tabs.delete(99);
  assert.equal((await h.send('CLOSE_CONFIRM_READY',{token:'forged'})).allowed,false);assert.equal((await h.send('CLOSE_CONFIRM_READY',{token:ticket.token})).allowed,true);
  await h.send('CLOSE_RESULT',{token:ticket.token,submitted:true,note:'UI clicked'});const pending=await h.controller.run(account,h.conn);assert.equal(pending.status,'needs-verification');assert.equal(pending.accountOpen,true);assert.equal(pending.verifiedClosedAt,null);assert.equal(h.created.length,1);
  h.setOpen(false);const done=await h.controller.run(account,h.conn);assert.equal(done.status,'verified-closed');assert.equal(done.accountOpen,false);assert(done.verifiedClosedAt);assert.equal(h.created.length,1);assert.deepEqual(h.db.trialMonitor,oldDate);
}));
test('pausing after the ticket blocks the final submit; failed-result recording still works while another task is busy',async()=>fixture(async h=>{
  await h.controller.run(account,h.conn);const ticket=await h.send('CLOSE_TICKET');h.db.balanceGuard.accounts[account].armed=false;
  assert.equal((await h.send('CLOSE_CONFIRM_READY',{token:ticket.token})).allowed,false);
  h.setBusy(true);assert.equal((await h.send('CLOSE_RESULT',{token:ticket.token,submitted:false,note:'authorization paused'})).accepted,true);
  const read=await h.controller.read(account,'approved-run-1');assert.equal(read.status,'failed');assert.equal(read.submitted,false);assert.equal(h.created.length,1);
}));
test('an unapproved newly linked project or switched browser URL is rejected immediately before confirmation',async()=>fixture(async h=>{
  await h.controller.run(account,h.conn);const ticket=await h.send('CLOSE_TICKET');h.setExtra(true);const blocked=await h.send('CLOSE_CONFIRM_READY',{token:ticket.token});assert.equal(blocked.allowed,false);assert.match(blocked.reason,/新关联项目/);
  h.setExtra(false);const t=[...h.tabs.values()][0],oldUrl=t.url;t.url='https://console.cloud.google.com/billing/manage?authuser=1';
  await assert.rejects(()=>h.controller.content({type:'CLOSE_CONFIRM_READY',account,token:ticket.token},{...h.sender(),url:oldUrl}),/网址|索引/);
  assert.equal(h.created.length,1);
}));
test('permission is revalidated after asynchronous pre-submit reads rather than trusting a stale initial grant',async()=>fixture(async h=>{
  await h.controller.run(account,h.conn);const ticket=await h.send('CLOSE_TICKET');h.setHook(()=>{h.db.balanceGuard.accounts[account].enabled=false;});
  assert.equal((await h.send('CLOSE_CONFIRM_READY',{token:ticket.token})).allowed,false);
}));
test('ambiguous submitted closure is never replayed and remains incomplete while the account stays open',async()=>fixture(async h=>{
  await h.controller.run(account,h.conn);const ticket=await h.send('CLOSE_TICKET');await h.send('CLOSE_CONFIRM_READY',{token:ticket.token});await h.send('CLOSE_RESULT',{token:ticket.token,submitted:true});
  h.advance(181000);const status=await h.controller.run(account,h.conn);assert.equal(status.status,'needs-manual');assert.equal(status.accountOpen,true);assert.equal(status.canRetry,false);
  await assert.rejects(()=>h.controller.run(account,h.conn,{retry:true}),/不盲目重复/);assert.equal(h.created.length,1);
}));
test('only a clearly unsubmitted failure can be retried; an unknown executing timeout cannot',async()=>fixture(async h=>{
  h.setCreateFail(true);assert.equal((await h.controller.run(account,h.conn)).status,'failed');h.setCreateFail(false);await h.controller.run(account,h.conn);assert.equal(h.created.length,0);
  await h.controller.run(account,h.conn,{retry:true});assert.equal(h.created.length,1);await h.send('CLOSE_TICKET');h.advance(181000);
  const status=await h.controller.run(account,h.conn);assert.equal(status.submitted,null);assert.equal(status.canRetry,false);await assert.rejects(()=>h.controller.run(account,h.conn,{retry:true}),/不盲目重复/);
}));
test('reopened accounts require human review and do not silently start a second closing attempt',async()=>fixture(async h=>{
  h.setOpen(false);assert.equal((await h.controller.run(account,h.conn)).status,'verified-closed');h.setOpen(true);
  const status=await h.controller.run(account,h.conn);assert.equal(status.status,'reopened');assert.equal(status.verifiedClosedAt,null);assert.equal(h.created.length,0);
}));
test('a pre-existing date-closure task is observed without overwriting its schedule or opening a duplicate page',async()=>fixture(async h=>{
  h.db.trialMonitor.profiles[account].job={status:'executing',token:'date-ticket',createdAt:h.now()};const before=structuredClone(h.db.trialMonitor);
  assert.equal((await h.controller.run(account,h.conn)).status,'waiting-date');assert.equal(h.created.length,0);assert.deepEqual(h.db.trialMonitor,before);
  h.setOpen(false);assert.equal((await h.controller.run(account,h.conn)).status,'verified-closed');assert.deepEqual(h.db.trialMonitor,before);
}));
