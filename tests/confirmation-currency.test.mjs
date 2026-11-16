import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import vm from 'node:vm';
import {installBillingMonitor} from '../billing-monitor.js';
import {makeSnapshot} from '../sheet-sync.js';

async function currencyScenario(code,callback){
  const name='billingAccounts/EEEEEE-DDDDDD-CCCCCC',db={trialMonitor:{profiles:{[name]:{name,balance:78,currency:'USD',balanceUpdatedAt:1,balanceSource:'手动记录'}},active:name}};
  const connection={authUser:'0',accounts:[{name}]},calls=[];
  globalThis.chrome={runtime:{id:'extension'},storage:{local:{get:async k=>({[k]:structuredClone(db[k])}),set:async v=>Object.assign(db,structuredClone(v))}},action:{setBadgeText:async()=>{},setBadgeBackgroundColor:async()=>{},setTitle:async()=>{}}};
  const m=installBillingMonitor({request:async(...args)=>{calls.push(args);return {name,currencyCode:code};},isBusy:()=>false,getConnection:()=>connection});
  const sender={id:'extension',tab:{id:9},frameId:0,url:'https://console.cloud.google.com/billing/EEEEEE-DDDDDD-CCCCCC/overview'};
  try{await callback({name,db,calls,send:message=>m.content({type:'MONITOR_BANNER',balance:11.22,currency:'CONFLICT',currencyConflict:true,currencyCandidates:['EUR','USD'],remainingDays:14,...message},sender)});}finally{delete globalThis.chrome;}
}

test('conflicting euro symbol and dollar text use matching official account currency without converting the numeric amount',async()=>{
  for(const code of ['USD','EUR'])await currencyScenario(code,async h=>{
    await h.send({});const p=h.db.trialMonitor.profiles[h.name];
    assert.equal(p.balance,11.22);assert.equal(p.currency,code);assert.match(p.balanceSource,/API核实/);assert.equal(p.syncError,'');
    assert.equal(h.calls[0][0],'cloudbilling');assert.equal(h.calls[0][1],'v1/'+h.name);
    await h.send({balance:11.21});assert.equal(h.calls.length,1);assert.equal(p.observedDays,14);
    assert.equal(makeSnapshot(h.db.trialMonitor).accounts[0].source,'官方页面可见文本');
  });
});

test('absent or unrelated authoritative currency exposes a pending observation and excludes stale amount from sheet sync',async()=>{
  for(const code of [undefined,'JPY'])await currencyScenario(code,async h=>{
    await h.send({});const p=h.db.trialMonitor.profiles[h.name];
    assert.equal(p.balance,78);assert.equal(p.balanceObservation.amount,11.22);assert.equal(p.balanceObservation.status,'currency-unknown');
    assert.match(p.syncError,/币种待核实/);assert.equal(makeSnapshot(h.db.trialMonitor).accounts[0].balance,null);assert(['手动记录','官方页面可见文本'].includes(makeSnapshot(h.db.trialMonitor).accounts[0].source));
  });
});

async function dialogScenario({legal=false,foreign=false,unknownRequired=false}={}){
  const id='012345-ABCDEF-123456';let start,opened=false,submitted=0,result,ticks=0;
  const base=t=>({innerText:t,getAttribute:()=>null,getClientRects:()=>[1]});
  const checkbox={...base(''),type:'checkbox',checked:false,labels:[{innerText:legal?'I agree to new Terms of Service':'I understand closing this billing account stops all projects'}],click(){this.checked=true;}};
  const field={...base(''),type:'text',value:'',required:true,labels:[{innerText:unknownRequired?'Enter your cancellation reason':'Enter billing account ID to confirm closure'}],dispatchEvent(){}};
  const entry={...base('Close billing account'),disabled:false,click:()=>opened=true};
  const confirm={...base('确认'),get disabled(){return ticks<6 || !checkbox.checked || field.value!==id;},click:()=>submitted++};
  const dialog={...base('Close billing account '+(foreign?'000000-000000-000000':id)),querySelectorAll:s=>s.startsWith('input')?[checkbox,field]:[confirm]};
  const context={window:{addEventListener(){}},document:{querySelector:()=>({innerText:id}),querySelectorAll:s=>s.startsWith('[role="dialog"]')?(opened&&ticks>=3?[dialog]:[]):[entry]},location:{pathname:'/billing/'+id+'/manage'},getComputedStyle:()=>({visibility:'visible'}),
    Event:class {constructor(type){this.type=type;}},console,setInterval(){},setTimeout(fn,ms){if(ms===6000)start=fn;else queueMicrotask(()=>{if(ms===500)ticks++;fn();});},
    chrome:{runtime:{sendMessage:async message=>{
      if(message.type==='CLOSE_TICKET')return {ok:true,data:{allowed:true,account:'billingAccounts/'+id,token:'once'}};
      if(message.type==='CLOSE_CONFIRM_READY')return {ok:true,data:{allowed:true}};if(message.type==='CLOSE_RESULT')result=message;
      return {ok:true,data:{enabled:true}};
    }}}};
  context.window ||= {addEventListener(){}};vm.createContext(context);vm.runInContext(await readFile(new URL('../billing-page.js',import.meta.url),'utf8'),context);start();
  for(let i=0;i<10&&!result;i++)await new Promise(r=>setImmediate(r));
  return {submitted,result,ticks,checkbox,field};
}

test('closure waits for delayed dialog and enabled generic confirmation, acknowledges only authorized impact and fills explicit account ID',async()=>{
  const result=await dialogScenario();
  assert.equal(result.submitted,1);assert.equal(result.checkbox.checked,true);assert.equal(result.field.value,'012345-ABCDEF-123456');assert(result.ticks>=6);assert.equal(result.result.submitted,true);
});

test('closure never bypasses disabled buttons, new legal agreements, unknown required reasons or a mismatched account',async()=>{
  const legal=await dialogScenario({legal:true});assert.equal(legal.submitted,0);assert.equal(legal.checkbox.checked,false);assert.match(legal.result.note,/Terms/);
  const reason=await dialogScenario({unknownRequired:true});assert.equal(reason.submitted,0);assert.equal(reason.field.value,'');assert.match(reason.result.note,/cancellation reason/);
  const foreign=await dialogScenario({foreign:true});assert.equal(foreign.submitted,0);assert.equal(foreign.checkbox.checked,false);assert.equal(foreign.field.value,'');assert.match(foreign.result.note,/交叉核验/);
});
