import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import vm from 'node:vm';

async function runDialog({word='關閉',hint='輸入「關閉」即可關閉帳單帳戶',instruction='如要關閉帳單帳戶，請在下方欄位中輸入「關閉」。',mainId='012345-ABCDEF-123456',initial=''}={}){
  const id='012345-ABCDEF-123456',displayName='我的帳單帳戶';let start,opened=false,result,submissions=0,validated=false;const events=[];
  class Input{
    constructor(){this.type='text';this._value=initial;this.required=true;this.labels=[];}
    get value(){return this._value;}
    set value(v){this._value=v;}
    getAttribute(name){return name==='placeholder'?hint:null;}
    getClientRects(){return [1];}
    dispatchEvent(event){events.push(event.type);if(event.type==='input')validated=this.value===word;}
  }
  const field=new Input(),base=text=>({innerText:text,getClientRects:()=>[1],getAttribute:()=>null});
  const entry={...base('關閉帳單帳戶'),disabled:false,click:()=>opened=true};
  const confirm={...base('關閉帳單帳戶'),get disabled(){return !validated;},click(){assert.equal(this.disabled,false);submissions++;}};
  const dialog={...base(`關閉帳單帳戶「${displayName}」 ${instruction}`),querySelectorAll:selector=>selector.startsWith('input')?[field]:selector.startsWith('[role="alert"]')?[]:[confirm]};
  const context={HTMLInputElement:Input,Event:class{constructor(type){this.type=type;}},document:{querySelector:()=>({innerText:'帳單帳戶 ID '+mainId}),querySelectorAll:selector=>selector.startsWith('[role="dialog"]')?(opened?[dialog]:[]):[entry]},
    location:{pathname:'/billing/'+id+'/manage'},window:{addEventListener(){}},getComputedStyle:()=>({visibility:'visible'}),console,setInterval(){},setTimeout(fn,ms){if(ms===6000)start=fn;else queueMicrotask(fn);},
    chrome:{runtime:{sendMessage:async m=>{if(m.type==='CLOSE_TICKET')return {ok:true,data:{allowed:true,account:'billingAccounts/'+id,displayName,token:'one'}};if(m.type==='CLOSE_CONFIRM_READY')return {ok:true,data:{allowed:true}};if(m.type==='CLOSE_RESULT')result=m;return {ok:true,data:{enabled:true}};}}}};
  context.window ||= {addEventListener(){}};vm.createContext(context);vm.runInContext(await readFile(new URL('../billing-page.js',import.meta.url),'utf8'),context);start();
  for(let n=0;n<10&&!result;n++)await new Promise(r=>setImmediate(r));
  return {field,result,submissions,events};
}

test('exact screenshot dialog fills traditional 關閉 using native setter and input/change events, then submits only after Google enables button',async()=>{
  const r=await runDialog();assert.equal(r.field.value,'關閉');assert.deepEqual(r.events,['input','change']);assert.equal(r.submissions,1);assert.equal(r.result.submitted,true);
});

test('explicit simplified and English closing tokens preserve required spelling and case',async()=>{
  for(const item of [{word:'关闭',hint:'输入“关闭”即可关闭结算账号',instruction:'请输入“关闭”以确认关闭。'},{word:'CLOSE',hint:'Type "CLOSE" to close this billing account',instruction:'To close the billing account, type "CLOSE" below.'},{word:'close',hint:'Type close below',instruction:'Type close below to confirm.'}]){
    const r=await runDialog(item);assert.equal(r.field.value,item.word);assert.equal(r.submissions,1);
  }
});

test('dialog instruction fallback works for one confirmation textbox with a generic accessible label',async()=>{
  const r=await runDialog({hint:'確認輸入內容'});assert.equal(r.field.value,'關閉');assert.equal(r.submissions,1);
});

test('closing word never authorizes another account, unknown tokens, ambiguous words or overwriting existing user input',async()=>{
  const wrong=await runDialog({mainId:'000000-000000-000000'});assert.equal(wrong.field.value,'');assert.equal(wrong.submissions,0);
  const unknown=await runDialog({word:'DELETE',hint:'輸入「DELETE」',instruction:'請輸入「DELETE」'});assert.equal(unknown.field.value,'');assert.equal(unknown.submissions,0);
  const ambiguous=await runDialog({hint:'輸入「關閉」或輸入「关闭」',instruction:'輸入「關閉」或輸入「关闭」'});assert.equal(ambiguous.field.value,'');assert.equal(ambiguous.submissions,0);
  const existing=await runDialog({initial:'user-entered-value'});assert.equal(existing.field.value,'user-entered-value');assert.equal(existing.submissions,0);assert.match(existing.result.note,/已有不同内容/);
});
