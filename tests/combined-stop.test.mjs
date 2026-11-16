import {test} from 'node:test';
import assert from 'node:assert/strict';
import {BalanceGuardCore as G} from '../balance-guard-core.js';
import {installBalanceGuard} from '../balance-guard.js';
import {installBillingClosure} from '../billing-closure.js';
import {installBillingMonitor} from '../billing-monitor.js';
import {exportConfiguration,parseConfiguration,applyConfiguration} from '../config-core.js';

const account='billingAccounts/012345-ABCDEF-123456',project='example-project',number='123456789012',keyName='projects/'+number+'/locations/global/keys/example-key';
function drive(gen,api){let r=gen.next();while(!r.done){try{r=gen.next(r.value.kind==='save'?undefined:api(r.value));}catch(e){r=gen.throw(e);}}return r.value;}
function cloud(options={}){
  let linked=true,deletedKey=false,deletedProject=false,otherAccount=false,open=true;const states={aiplatform:'ENABLED',generativelanguage:'ENABLED'},calls=[];
  const response=t=>{
    calls.push(t);const {service,path,method}=t;
    if(path.endsWith(':testIamPermissions'))return {permissions:t.body.permissions.filter(p=>p!==options.missingPermission)};
    if(service==='cloudresourcemanager'){
      if(method==='DELETE'){deletedProject=true;linked=false;return {};}
      return {projectId:project,projectNumber:options.changedIdentity?'999999999999':number,lifecycleState:deletedProject?'DELETE_REQUESTED':'ACTIVE'};
    }
    if(service==='cloudbilling'){
      if(path==='v1/'+account)return {name:account,currencyCode:'EUR',open};
      if(path==='v1/'+account+'/projects')return {projectBillingInfo:linked?[{projectId:project,billingEnabled:true,billingAccountName:account}]:[]};
      if(method==='PUT'){if(options.failUnlink)throw Error('unlink denied');linked=false;return {billingEnabled:false,billingAccountName:''};}
      return {billingEnabled:linked,billingAccountName:otherAccount?'billingAccounts/AAAAAA-BBBBBB-CCCCCC':linked?account:''};
    }
    if(service==='apikeys'){
      if(path.includes('?pageSize='))return {keys:deletedKey?[]:[{name:keyName}]};
      if(method==='DELETE'){if(options.failKey)throw Error('key denied');if(!options.pendingKey)deletedKey=true;return {};}
      return {name:keyName,...(deletedKey?{deleteTime:'2026-11-16T10:00:00Z'}:{})};
    }
    if(service==='serviceusage'){
      const id=path.includes('generativelanguage')?'generativelanguage':'aiplatform';
      if(method==='POST'){if(options.failApi)throw Error('service denied');states[id]='DISABLED';if(options.rebindDuringApi)otherAccount=true;return {};}
      return {name:'projects/'+number+'/services/'+id+'.googleapis.com',state:states[id]};
    }
    throw Error('unexpected '+path);
  };
  return {response,calls,states,get linked(){return linked;},setOpen:value=>open=value};
}
function state(c,extras={}){
  const raw={account,currency:'EUR',threshold:30,projects:[project],authUser:'0',closeBillingAccount:true,...extras};
  const policy=drive(G.preflight(raw),c.response),s=G.create(policy,Date.now());s.armed=s.enabled=true;s.authorizationId='approved';
  G.observe(s,{verified:true,balance:2.26,currency:'EUR',at:Date.now()},Date.now());return s;
}
test('combined stop verifies Key, both AI APIs and project billing, including when APIs can already be disabled',()=>{
  const c=cloud(),s=state(c);drive(G.stop(s,Date.now()),c.response);
  assert.equal(s.projectComplete,true);assert.equal(s.jobs[project].keysRevoked,true);assert.equal(s.jobs[project].apisDisabled,true);assert.equal(s.jobs[project].billingDisabled,true);assert.equal(c.linked,false);
  const deletes=c.calls.filter(t=>t.method==='DELETE').length,unlinks=c.calls.filter(t=>t.method==='PUT').length;drive(G.stop(s,Date.now()+30000),c.response);
  assert.equal(c.calls.filter(t=>t.method==='DELETE').length,deletes);assert.equal(c.calls.filter(t=>t.method==='PUT').length,unlinks);assert.equal(s.projectComplete,true);
});
test('unlinking by itself does not count as stopped when Key revocation or an AI API is still unverified',()=>{
  for(const option of [{failKey:true},{pendingKey:true},{failApi:true}]){const c=cloud(option),s=state(c);drive(G.stop(s,Date.now()),c.response);assert.equal(c.linked,false);assert.equal(s.projectComplete,false);assert.match(s.jobs[project].status,/尚未全部停用/);assert(!c.calls.some(t=>t.service==='cloudresourcemanager'&&t.method==='DELETE'));}
});
test('combined close requires account-close and API-key permissions before any destructive request',()=>{
  for(const missingPermission of ['billing.accounts.close','apikeys.keys.delete']){
    const c=cloud({missingPermission});assert.throws(()=>state(c),/权限/);assert(c.calls.every(t=>t.method==='GET'||t.path.endsWith(':testIamPermissions')));
  }
});
test('fallback project deletion only happens after an account-close attempt finishes, a delay and separate authorization',()=>{
  const c=cloud({failApi:true,failUnlink:true}),s=state(c,{fallbackDelete:true}),now=Date.now();
  drive(G.stop(s,now),c.response);assert(!c.calls.some(t=>t.service==='cloudresourcemanager'&&t.method==='DELETE'));
  s.accountClose={status:'opening'};drive(G.stop(s,now+150000),c.response);assert(!c.calls.some(t=>t.service==='cloudresourcemanager'&&t.method==='DELETE'));
  s.accountClose={status:'failed',submitted:false};drive(G.stop(s,now+180000),c.response);assert(c.calls.some(t=>t.service==='cloudresourcemanager'&&t.method==='DELETE'));assert.equal(s.projectComplete,true);
});
test('a project rebound to another billing account is not unlinked or deleted',()=>{
  const c=cloud({rebindDuringApi:true}),s=state(c,{fallbackDelete:true});s.accountClose={status:'failed'};drive(G.stop(s,Date.now()+180000),c.response);
  assert.equal(s.projectComplete,false);assert.match(s.jobs[project].error,/换绑/);assert(!c.calls.some(t=>t.method==='PUT'||t.service==='cloudresourcemanager'&&t.method==='DELETE'));
});
test('full completion needs both verified project stopping and API-confirmed billing-account closure',async()=>{
  const c=cloud(),db={trialMonitor:{profiles:{[account]:{name:account,currency:'EUR',balance:70,balanceSource:'Google Cloud试用横幅',balanceUpdatedAt:Date.now()}}}},conn={authUser:'0',accounts:[{name:account}]};let closing={status:'opening',accountOpen:true,checkedAt:Date.now()},closeCalls=0;
  globalThis.chrome={storage:{local:{get:async k=>({[k]:structuredClone(db[k])}),set:async v=>Object.assign(db,structuredClone(v))}},alarms:{create(){},onAlarm:{addListener(){}}}};
  try{
    const guard=installBalanceGuard({request:async(service,path,method='GET',body)=>c.response({service,path,method,body}),captureBalance:async()=>{},withConnection:fn=>fn(conn),billingClosure:{run:async()=>{closeCalls++;return closing;},read:async()=>closing}});
    const check=await guard.handle({type:'BALANCE_GUARD_CHECK',account,threshold:30,closeBillingAccount:true});
    await assert.rejects(()=>guard.handle({type:'BALANCE_GUARD_ENABLE',account,checkId:check.checkId,confirmAccount:account.split('/')[1],confirmScope:true}),/整.*账号|联合停用/);
    await guard.handle({type:'BALANCE_GUARD_ENABLE',account,checkId:check.checkId,confirmAccount:account.split('/')[1],confirmScope:true,confirmCloseAccount:true});assert.equal(closeCalls,0);
    db.trialMonitor.profiles[account].balance=2.26;await guard.tick();let current=(await guard.handle({type:'BALANCE_GUARD_READ'}))[account];assert.equal(current.projectComplete,true);assert.equal(current.completed,false);assert.match(current.status,/正在.*关闭/);
    closing={status:'verified-closed',accountOpen:true,checkedAt:Date.now()};current=(await guard.handle({type:'BALANCE_GUARD_READ'}))[account];assert.equal(current.completed,false);assert(!current.status.includes('结算账号已核实关闭'));
    closing={status:'verified-closed',accountOpen:false,checkedAt:Date.now()};await guard.tick();current=(await guard.handle({type:'BALANCE_GUARD_READ'}))[account];assert.equal(current.completed,true);assert.equal(current.status,'项目与结算账号均已核实停用');assert(!c.calls.some(t=>t.service==='cloudresourcemanager'&&t.method==='DELETE'));
  }finally{delete globalThis.chrome;}
});
test('config backup restores combined-close preference but never closure authorizations or queued jobs',()=>{
  const exported=exportConfiguration({balanceGuard:{accounts:{[account]:{threshold:30,closeBillingAccount:true,authorizationId:'PRIVATE_AUTH',accountClose:{token:'PRIVATE_TICKET'},jobs:{}}}}});
  const text=JSON.stringify(exported);assert(!text.includes('PRIVATE_'));const parsed=parseConfiguration(text);assert.equal(parsed.minimums[account].closeBillingAccount,true);
  const imported=applyConfiguration({},parsed);assert.equal(imported.balanceGuard.accounts[account].closeBillingAccount,true);assert.equal(imported.balanceGuard.accounts[account].enabled,false);assert.equal(imported.balanceGuard.accounts[account].armed,false);assert.equal(imported.balanceGuard.accounts[account].policy,null);assert.equal(imported.billingClosure,undefined);
});
test('end-to-end combined task never backdates the schedule and becomes complete only after account API verification',async()=>{
  const c=cloud(),future=Date.now()+11*86400000,db={trialMonitor:{active:account,profiles:{[account]:{name:account,authUser:'0',armed:true,deadline:future,balance:2.26,currency:'EUR',balanceSource:'Google Cloud试用横幅',balanceUpdatedAt:Date.now()}}}},conn={authUser:'0',accounts:[{name:account}]},tabs=new Map();let creates=0;
  globalThis.chrome={runtime:{id:'extension'},storage:{local:{get:async k=>({[k]:structuredClone(db[k])}),set:async v=>Object.assign(db,structuredClone(v))}},alarms:{create(){},onAlarm:{addListener(){}}},action:{setBadgeText(){},setBadgeBackgroundColor(){},setTitle(){}},tabs:{create:async o=>{creates++;const t={id:37,url:o.url};tabs.set(37,t);return t;},get:async id=>({...tabs.get(id)})}};
  try{
    const request=async(service,path,method='GET',body)=>c.response({service,path,method,body}),monitor=installBillingMonitor({request,isBusy:()=>false});
    const closure=installBillingClosure({request,withConnection:fn=>fn(conn),recordAccountState:monitor.recordAccountState});
    const guard=installBalanceGuard({request,withConnection:fn=>fn(conn),captureBalance:async()=>{},billingClosure:closure});
    const checked=await guard.handle({type:'BALANCE_GUARD_CHECK',account,threshold:30,closeBillingAccount:true});assert.equal(creates,0);assert.equal(db.trialMonitor.profiles[account].deadline,future);
    const first=await guard.handle({type:'BALANCE_GUARD_ENABLE',account,checkId:checked.checkId,confirmAccount:account.split('/')[1],confirmScope:true,confirmCloseAccount:true});assert.equal(first.projectComplete,true);assert.equal(first.completed,false);assert.equal(creates,1);assert.equal(db.trialMonitor.profiles[account].armed,true);
    const sender={id:'extension',frameId:0,tab:{id:37},url:tabs.get(37).url},ticket=await closure.content({type:'CLOSE_TICKET',account,agentVersion:'2.5.9'},sender);
    assert.equal(ticket.allowed,true);assert.equal((await closure.content({type:'CLOSE_CONFIRM_READY',account,token:ticket.token},sender)).allowed,true);assert.equal((await closure.content({type:'CLOSE_CONFIRM_READY',account,token:ticket.token},sender)).allowed,false);
    await closure.content({type:'CLOSE_RESULT',account,token:ticket.token,submitted:true},sender);assert.equal((await guard.handle({type:'BALANCE_GUARD_READ'}))[account].completed,false);
    c.setOpen(false);await guard.tick();const done=(await guard.handle({type:'BALANCE_GUARD_READ'}))[account];assert.equal(done.completed,true);assert.equal(done.accountClose.accountOpen,false);assert.equal(done.status,'项目与结算账号均已核实停用');assert.equal(db.trialMonitor.profiles[account].deadline,future);assert.equal(db.trialMonitor.profiles[account].armed,false);assert.equal(db.trialMonitor.profiles[account].accountOpen,false);assert.equal(creates,1);assert(!c.calls.some(t=>t.service==='cloudresourcemanager'&&t.method==='DELETE'));
  }finally{delete globalThis.chrome;}
});
