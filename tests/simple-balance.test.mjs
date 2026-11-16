import {test} from 'node:test';
import assert from 'node:assert/strict';
import {BalanceGuardCore as G} from '../balance-guard-core.js';
import {installBalanceGuard} from '../balance-guard.js';
const account='billingAccounts/012345-ABCDEF-123456',project='sample-project',number='123456789012',now=Date.now();
const raw={account,currency:'EUR',threshold:30,projects:[project],authUser:'0',fallbackDelete:false},policy={...raw,projects:[{id:project,number}]};
function drive(gen,api){let r=gen.next();while(!r.done){try{r=gen.next(r.value.kind==='save'?undefined:api(r.value));}catch(e){r=gen.throw(e);}}return r.value;}
function checkApi(t){
  if(t.path==='v1/'+account)return {name:account,open:true,currencyCode:'EUR'};
  if(t.path==='v1/'+account+'/projects')return {projectBillingInfo:[{projectId:project,billingEnabled:true}]};
  if(t.path==='v1/projects/'+project)return {projectId:project,projectNumber:number,lifecycleState:'ACTIVE'};
  if(t.path.endsWith('/billingInfo'))return {billingAccountName:account,billingEnabled:true};
  if(t.path.endsWith(':testIamPermissions'))return {permissions:t.body.permissions};
  throw Error('unexpected path '+t.path);
}
test('native-currency minimum is the only trigger; 30.01 stays active and 30/29.99/zero trigger only with explicit authorization',()=>{
  for(const balance of [30.01,30,29.99,0])for(const enabled of [true,false]){
    const s=G.create(policy,now);s.enabled=enabled;s.armed=enabled;G.observe(s,{verified:true,balance,currency:'EUR',at:now},now);
    assert.equal(!!s.triggeredAt,enabled&&balance<=30);assert.equal(s.balance,balance);
  }
  const p={...policy,threshold:0},s=G.create(p,now);s.enabled=s.armed=true;G.observe(s,{verified:true,balance:.01,currency:'EUR',at:now},now);assert(!s.triggeredAt);G.observe(s,{verified:true,balance:0,currency:'EUR',at:now},now);assert.equal(s.triggeredAt,now);
});
test('unknown, manual, stale, future or wrong-currency balance cannot trigger automatic writes',()=>{
  for(const v of [null,{verified:false,balance:0,currency:'EUR',at:now},{verified:true,balance:0,currency:'USD',at:now},{verified:true,balance:0,currency:'EUR',at:now-300001},{verified:true,balance:0,currency:'EUR',at:now+60001},{verified:true,balance:null,currency:'EUR',at:now}]){
    const s=G.create(policy,now);s.enabled=s.armed=true;G.observe(s,v,now);assert.equal(s.fresh,false);assert(!s.triggeredAt);let writes=0;drive(G.stop(s,now),()=>writes++);assert.equal(writes,0);
  }
});
test('preflight is read-only, verifies the complete scope and rejects changed account or project identity before any action',()=>{
  const calls=[],checked=drive(G.preflight(raw),t=>{calls.push(t);assert(t.method==='GET'||t.path.endsWith(':testIamPermissions'));return checkApi(t);});assert.equal(checked.projects[0].number,number);
  assert(!calls.some(t=>/monitoring|skus|timeSeries/.test(t.path)));
  assert.throws(()=>drive(G.preflight(raw),t=>t.path===`v1/${account}/projects`?{projectBillingInfo:[{projectId:'another-project',billingEnabled:true}]}:checkApi(t)),/关联项目/);
  assert.throws(()=>drive(G.preflight(raw),t=>t.path===`v1/projects/${project}/billingInfo`?{billingAccountName:'billingAccounts/AAAAAA-BBBBBB-CCCCCC',billingEnabled:true}:checkApi(t)),/归属/);
});
test('stop reconciles disabled APIs and makes no deletion unless fallback deletion is separately authorized',()=>{
  const s=G.create(policy,now);s.enabled=s.armed=true;G.observe(s,{verified:true,balance:20,currency:'EUR',at:now},now);const calls=[];
  drive(G.stop(s,now+180000),t=>{calls.push(t);if(t.service==='apikeys')return {keys:[]};if(t.service==='serviceusage')throw Error('denied');if(t.method==='PUT')throw Error('denied');return checkApi(t);});
  assert(calls.some(t=>t.method==='PUT'));assert(!calls.some(t=>t.method==='DELETE'));assert.match(s.jobs[project].status,/未授权删除/);
  const changed=G.create(policy,now);changed.armed=true;changed.triggeredAt=now;let writes=0;drive(G.stop(changed,now),t=>{if(t.method!=='GET')writes++;if(t.path.endsWith('/billingInfo'))return {billingEnabled:true,billingAccountName:'billingAccounts/AAAAAA-BBBBBB-CCCCCC'};return checkApi(t);});assert.equal(writes,0);assert.match(changed.jobs[project].error,/拒绝修改或删除/);
});
test('read-only check and balance retest remain unarmed even with zero balance, and enable rejects incomplete consent or stale check',async()=>{
  const db={trialMonitor:{profiles:{[account]:{name:account,balance:0,currency:'EUR',balanceUpdatedAt:Date.now(),balanceSource:'Google Cloud试用横幅'}}}},calls=[];
  globalThis.chrome={storage:{local:{get:async k=>({[k]:structuredClone(db[k])}),set:async v=>Object.assign(db,structuredClone(v))}},alarms:{create(){},onAlarm:{addListener(){}}}};
  const conn={authUser:'0',accounts:[{name:account}]};
  try{const guard=installBalanceGuard({withConnection:fn=>fn(conn),captureBalance:async()=>{},request:async(service,path,method='GET',body)=>{const t={service,path,method,body};calls.push(t);assert(method==='GET'||path.endsWith(':testIamPermissions'));return checkApi(t);}});
    const checked=await guard.handle({type:'BALANCE_GUARD_CHECK',account,threshold:30});assert.equal(checked.enabled,false);assert.equal(checked.fresh,true);assert.equal(checked.balance,0);
    const retest=await guard.handle({type:'BALANCE_GUARD_TEST',account});assert.equal(retest.armed,false);assert.equal(db.balanceGuard.accounts[account].armed,false);
    await assert.rejects(()=>guard.handle({type:'BALANCE_GUARD_ENABLE',account,checkId:checked.checkId,confirmAccount:'wrong',confirmScope:true}),/完整结算账号/);
    db.balanceGuard.accounts[account].checkedAt=Date.now()-300001;
    await assert.rejects(()=>guard.handle({type:'BALANCE_GUARD_ENABLE',account,checkId:checked.checkId,confirmAccount:account.split('/')[1],confirmScope:true}),/已失效/);
    await guard.tick();assert.equal(db.balanceGuard.accounts[account].enabled,false);assert(calls.every(t=>t.method==='GET'||t.path.endsWith(':testIamPermissions')));
  }finally{delete globalThis.chrome;}
});
