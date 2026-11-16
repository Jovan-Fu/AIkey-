import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import vm from 'node:vm';
import {installBillingMonitor} from '../billing-monitor.js';

const name='billingAccounts/012345-ABCDEF-123456',other='billingAccounts/AAAAAA-BBBBBB-CCCCCC',project='example-project';
async function fixture(callback,{tabs=true,binding=name,observation={balance:11.06,currency:'EUR'},changed=false,overview=false,sampleAccount=name,old={}}={}){
  const url=overview?'https://console.cloud.google.com/billing/overview?authuser=0':`https://console.cloud.google.com/home/dashboard?project=${project}&authuser=0`;
  const existing={name,authUser:'0',balance:null,currency:'USD',balanceSource:'手动记录',balanceUpdatedAt:Date.now(),armed:true,deadline:Date.now()-60000,job:{status:'failed',error:'old failure'},...old};
  const db={trialMonitor:{profiles:{[name]:existing},active:name}},conn={authUser:'0',tabId:tabs?8:undefined,accounts:[{name}]},calls=[],injected=[];let reads=0,opens=0;
  const storage={get:async key=>({[key]:structuredClone(db[key])}),set:async value=>Object.assign(db,structuredClone(value))};
  const request=async(service,path,method='GET')=>{calls.push({service,path,method});if(path==='v1/'+name)return {name,currencyCode:'EUR',displayName:'My billing',open:true};if(path.endsWith('/billingInfo'))return {billingAccountName:binding,billingEnabled:true};throw Error('Unexpected request '+path);};
  globalThis.chrome={runtime:{id:'extension'},storage:{local:storage},alarms:{create:async()=>{},onAlarm:{addListener(){}}},
    tabs:{query:async()=>tabs?[{id:8,url},{id:9,url:'https://not-cloud.example/'}]:[],get:async id=>({id,url:changed && reads?'https://console.cloud.google.com/billing/manage?authuser=0':url,status:'complete'}),create:async()=>{opens++;throw Error('No opening allowed in readonly capture');}},
    scripting:{executeScript:async options=>{injected.push(options.target.tabId);assert.equal(options.world,'ISOLATED');if(options.files)return [];reads++;return [{frameId:0,result:{url,kind:overview?'overview':'project',account:overview?sampleAccount:'',pageStartedAt:Date.now()-1000,observation}}];}},
    action:{setBadgeText:async()=>{},setBadgeBackgroundColor:async()=>{},setTitle:async()=>{}}};
  const monitor=installBillingMonitor({request,isBusy:()=>false,getConnection:()=>conn});
  try{await callback({monitor,conn,db,calls,injected,get opens(){return opens;}});}finally{delete globalThis.chrome;}
}
test('automatic capture finds an already open verified project, fixes empty USD default, and never triggers a due close',async()=>fixture(async h=>{
  const oldDeadline=h.db.trialMonitor.profiles[name].deadline;
  const result=await h.monitor.capture(name,h.conn);assert(result.captured);
  const p=h.db.trialMonitor.profiles[name];assert.equal(p.balance,11.06);assert.equal(p.currency,'EUR');assert(p.balanceSource.startsWith('Google Cloud试用横幅'));assert.equal(p.bannerTabId,8);
  assert.equal(p.armed,true);assert.equal(p.deadline,oldDeadline);assert.equal(p.job.status,'failed');assert.equal(h.opens,0);assert(h.calls.every(c=>c.method==='GET'));assert(h.injected.every(id=>id===8));
}));
test('missing source stays unknown, gets the real currency and never labels an empty amount as a manual record',async()=>fixture(async h=>{
  const r=await h.monitor.capture(name,h.conn);assert.equal(r.captured,false);const p=h.db.trialMonitor.profiles[name];
  assert.equal(p.balance,null);assert.equal(p.balanceUpdatedAt,null);assert.equal(p.balanceSource,'尚未采集');assert.equal(p.currency,'EUR');assert.match(p.syncError,/没有找到/);
},{tabs:false}));
test('a previously entered USD value is not relabeled as EUR when authoritative metadata corrects the currency',async()=>fixture(async h=>{
  await h.monitor.capture(name,h.conn);const p=h.db.trialMonitor.profiles[name];assert.equal(p.balance,null);assert.equal(p.currency,'EUR');assert.equal(p.balanceObservation.amount,100);assert.equal(p.balanceObservation.currency,'USD');
},{tabs:false,old:{balance:100,currency:'USD'}}));
test('another account project is rejected before reading its page and does not replace the selected account balance',async()=>fixture(async h=>{
  const r=await h.monitor.capture(name,h.conn);assert.equal(r.captured,false);assert.equal(h.injected.length,0);assert.equal(h.db.trialMonitor.profiles[name].balance,null);
},{binding:other}));
test('a switched page or an overview displaying the other account cannot supply an amount',async()=>{
  await fixture(async h=>{const r=await h.monitor.capture(name,h.conn);assert.equal(r.captured,false);assert.equal(h.db.trialMonitor.profiles[name].balance,null);},{changed:true});
  await fixture(async h=>{const r=await h.monitor.capture(name,h.conn);assert.equal(r.captured,false);assert.equal(h.db.trialMonitor.profiles[name].balance,null);},{overview:true,sampleAccount:other});
});
test('manual nonempty amount in wrong currency is refused while empty save follows authoritative currency',async()=>fixture(async h=>{
  await h.monitor.capture(name,h.conn);
  const msg={type:'MONITOR_SAVE',account:name,balance:100,currency:'USD',deadline:null,arm:false,balanceEdited:true};
  await assert.rejects(()=>h.monitor.dashboard(msg,h.conn),/实际币种不一致/);
  const result=await h.monitor.dashboard({...msg,balance:null},h.conn);assert.equal(result.profiles[name].currency,'EUR');assert.equal(result.profiles[name].balanceSource,'尚未采集');
},{tabs:false}));
test('03 UI uses authoritative EUR and shows an uncaptured amount as unknown instead of a manual timestamp',async()=>{
  const nodes=new Map(),profile={name,balance:null,currency:'USD',balanceSource:'手动记录',balanceUpdatedAt:Date.now()};
  const node=id=>{if(!nodes.has(id))nodes.set(id,{value:id==='billing'?name:'',textContent:'',checked:false,hidden:false,events:{},addEventListener(type,fn){this.events[type]=fn;}});return nodes.get(id);};
  const ctx={document:{getElementById:node},Date,Number,Math,Intl,setInterval(){},console,chrome:{runtime:{sendMessage:async()=>({ok:true,data:{profiles:{[name]:profile},active:name,accountCurrencies:{[name]:'EUR'}}})},tabs:{create:async()=>{}}}};
  ctx.window ||= {addEventListener(){}};vm.createContext(ctx);vm.runInContext(await readFile(new URL('../monitor-ui.js',import.meta.url),'utf8'),ctx);await new Promise(r=>setImmediate(r));
  assert.equal(node('trial-currency').value,'EUR');assert.equal(node('trial-amount').value,'');assert(!node('balance-source').textContent.includes('手动记录'));
});
