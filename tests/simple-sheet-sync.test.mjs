import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createHmac} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import vm from 'node:vm';
import {makeSnapshot,validateEndpoint,signedEnvelope,installSheetSync} from '../sheet-sync.js';
const a='billingAccounts/012345-ABCDEF-123456',secret='a'.repeat(64),endpoint='https://script.google.com/macros/s/'+'a'.repeat(32)+'/exec',sheetUrl='https://docs.google.com/spreadsheets/d/'+'b'.repeat(40)+'/edit';
test('snapshot contains balance and minimum only, omits contacts/API keys/token history; HMAC matches receiver',async()=>{
  const p={name:a,currency:'EUR',balance:0,balanceUpdatedAt:Date.now(),balanceSource:'官方页面可见文本',cookie:'PRIVATE_COOKIE',apiKey:'PRIVATE_KEY',owner:'PRIVATE_OWNER'},g={accounts:{[a]:{threshold:0,enabled:false,savedAt:Date.now(),status:'test',jobs:{}}}};
  const snapshot=makeSnapshot({profiles:{[a]:p}},g),text=JSON.stringify(snapshot),signed=await signedEnvelope(snapshot,secret);
  assert(!text.includes('PRIVATE_'));assert(!/token|price|allowance/i.test(text));assert.equal(snapshot.accounts[0].balance,0);assert.equal(snapshot.accounts[0].protection.threshold,0);
  assert.equal(signed.signature,createHmac('sha256',secret).update(`${signed.timestamp}\n${signed.nonce}\n${signed.payload}`).digest('hex'));
  for(const url of ['https://evil.test/exec','https://script.google.com.evil.test/macros/s/'+'a'.repeat(30)+'/exec',endpoint.replace('/exec','/dev')])assert.throws(()=>validateEndpoint(url));
});
async function server(start=27,legacy=false){
  const code=await readFile(new URL('../support/Google表格同步.gs',import.meta.url),'utf8'),parse=name=>JSON.parse(code.match(new RegExp('const '+name+'=(\\[.*?\\]);'))[1].replaceAll("'",'"'));
  const cells=new Map(),formulas=new Map(),writes=[],hidden=[],cached=new Map(),props={AIKEY_SYNC_SECRET:secret,AIKEY_TARGET_ID:'bound-table'},rules=[];let copied=0,maxCols=legacy?43:34;
  parse('AIKEY_HEADERS').forEach((h,i)=>cells.set(`7:${2+i}`,h));
  if(start)parse('AIKEY_SIMPLE_HEADERS').forEach((h,i)=>cells.set(`7:${start+i}`,h));
  if(legacy){cells.set('7:27','账号累计输入Token');cells.set('7:28','账号累计输出Token');}
  for(const r of [8,9])cells.set(`${r}:9`,a.split('/')[1]);cells.set('8:10','PRIVATE_KEY');cells.set('8:5','PRIVATE_CONTACT');
  const sheet={getLastRow:()=>9,getLastColumn:()=>Math.max(...[...cells.keys()].map(k=>Number(k.split(':')[1]))),getMaxColumns:()=>maxCols,getMaxRows:()=>207,insertColumnsAfter:(_x,n)=>maxCols+=n,hideColumns:(c,n)=>hidden.push([c,n]),setColumnWidths(){},setColumnWidth(){},getConditionalFormatRules:()=>rules,setConditionalFormatRules:v=>rules.splice(0,rules.length,...v),getRange:(row,col,rows=1,cols=1)=>{
    const range={getValues:()=>Array.from({length:rows},(_,r)=>Array.from({length:cols},(_,c)=>cells.get(`${row+r}:${col+c}`)??'')),getValue:()=>cells.get(`${row}:${col}`)??'',setValues:values=>{values.forEach((r,ri)=>r.forEach((v,ci)=>{cells.set(`${row+ri}:${col+ci}`,v);writes.push([row+ri,col+ci]);}));return range;},setValue:v=>{cells.set(`${row}:${col}`,v);writes.push([row,col]);return range;},setFormulas:v=>{v.forEach((r,ri)=>r.forEach((f,ci)=>formulas.set(`${row+ri}:${col+ci}`,f)));return range;}};
    for(const k of ['setBackground','setFontColor','setFontWeight','setWrap','setNumberFormat'])range[k]=()=>range;return range;
  }};
  const book={getSheetByName:()=>sheet,getId:()=>props.AIKEY_TARGET_ID,getName:()=> '管理表',getUrl:()=>sheetUrl,setRecalculationInterval(){},copy:()=>{copied++;return {getId:()=> 'backup-id'};}};
  const context={Date,JSON,Number,Math,
    PropertiesService:{getScriptProperties:()=>({getProperty:k=>props[k],setProperty:(k,v)=>props[k]=v})},
    Session:{getScriptTimeZone:()=> 'Europe/Belgrade'},
    Utilities:{Charset:{UTF_8:'utf8'},formatDate:()=> '20261116',computeHmacSha256Signature:(text,key)=>[...createHmac('sha256',key).update(text).digest()].map(x=>x>127?x-256:x)},
    LockService:{getScriptLock:()=>({waitLock(){},hasLock:()=>true,releaseLock(){}})},CacheService:{getScriptCache:()=>({get:k=>cached.get(k),put:(k,v)=>cached.set(k,v)})},
    SpreadsheetApp:{openById:id=>{assert.equal(id,props.AIKEY_TARGET_ID);return book;},flush(){},RecalculationInterval:{MINUTE:'minute'},newConditionalFormatRule:()=>{let formula;const builder={whenFormulaSatisfied:v=>{formula=v;return builder;},setBackground:()=>builder,setFontColor:()=>builder,setRanges:()=>builder,build:()=>({getBooleanCondition:()=>({getCriteriaValues:()=>[formula]})})};return builder;}},
    ContentService:{MimeType:{JSON:'json'},createTextOutput:text=>({setMimeType:()=>text})}
  };
  context.window ||= {addEventListener(){}};vm.createContext(context);vm.runInContext(code,context);
  return {context,cells,formulas,writes,props,hidden,rules,book,get copied(){return copied;},call:v=>JSON.parse(context.doPost({postData:{contents:JSON.stringify(v)}}))};
}
function payload(now=Date.now()){return {accounts:[{account:a,balance:0,currency:'EUR',source:'官方页面可见文本',sampledAt:now,lastReadAt:now,valueChangedAt:now,deadline:null,observedDays:0,observedAt:now,accountOpen:null,accountCheckedAt:null,protection:{version:2,threshold:0,enabled:false,status:'已保存，尚未启用',checkedAt:now,updatedAt:now,jobs:''}}]};}
test('signed receiver rejects forgery and replay; preserves key/contact data and updates zero balance/days/minimum for matching rows',async()=>{
  const h=await server(),data=payload(),e=await signedEnvelope(data,secret);
  assert.equal(h.call({version:1}).ok,false);assert.equal(h.writes.length,0);
  assert.equal(h.call({...e,signature:'b'.repeat(64)}).ok,false);assert.equal(h.writes.length,0);
  const r=h.call(e);assert.equal(r.ok,true);assert.equal(r.updatedRows,2);assert.equal(r.protectionRows,2);assert.equal(r.protectionVersion,2);assert.equal(r.spreadsheetUrl,sheetUrl);
  assert.equal(h.cells.get('8:14'),0);assert.equal(h.cells.get('8:27'),0);assert.equal(h.cells.get('8:33'),0);assert.equal(h.cells.get('8:10'),'PRIVATE_KEY');assert.equal(h.cells.get('8:5'),'PRIVATE_CONTACT');
  assert(h.writes.every(([,c])=>[11,14,15,16,17,19,20,27,28,29,30,31,32,33,34].includes(c)));
  assert.equal(h.call(e).duplicate,true);
  const old=payload(data.accounts[0].sampledAt-10000);old.accounts[0].balance=999;old.accounts[0].protection.threshold=99;old.accounts[0].observedDays=99;
  assert.equal(h.call(await signedEnvelope(old,secret)).ok,true);assert.equal(h.cells.get('8:14'),0);assert.equal(h.cells.get('8:27'),0);assert.equal(h.cells.get('8:33'),0);
  const unmatched=payload();unmatched.accounts[0].account='billingAccounts/AAAAAA-BBBBBB-CCCCCC';assert.equal(h.call(await signedEnvelope(unmatched,secret)).unmatchedAccounts,1);
  assert.equal(h.call(await signedEnvelope(data,secret,Date.now()-300001)).ok,false);
});
test('existing table migration backs up once, hides legacy columns, preserves raw data and writes new columns outside the hidden area',async()=>{
  const h=await server(null,true);h.context.upgradeAIkeySimpleTable_(h.book);assert.equal(h.copied,1);assert.deepEqual(h.hidden[0],[27,17]);assert.equal(h.cells.get('8:10'),'PRIVATE_KEY');assert.equal(h.cells.get('8:5'),'PRIVATE_CONTACT');
  const start=h.context.simpleColumns_(h.book.getSheetByName());assert.equal(start,44);assert(h.formulas.get('8:12').includes('$AX8'));assert(h.formulas.get('8:12').includes('$AY8'));
  h.context.upgradeAIkeySimpleTable_(h.book);assert.equal(h.copied,1);assert.equal(h.rules.length,4);
  const r=h.call(await signedEnvelope(payload(),secret));assert.equal(r.ok,true);assert.equal(h.cells.get(`8:${start}`),0);assert.equal(h.cells.get(`8:${start+6}`),0);
});
test('manual sync works with automatic sending off, learns table URL and distinguishes an old receiver from successful protection sync',async()=>{
  const db={sheetSync:{endpoint,secret,enabled:false},trialMonitor:{profiles:{[a]:{name:a,balance:4.28,currency:'EUR',balanceUpdatedAt:Date.now(),balanceSource:'官方页面可见文本'}}},balanceGuard:{accounts:{[a]:{threshold:30}}}},fetchBefore=globalThis.fetch;let version=0,sent;
  globalThis.chrome={storage:{local:{get:async keys=>Object.fromEntries((Array.isArray(keys)?keys:[keys]).map(k=>[k,structuredClone(db[k])])),set:async v=>Object.assign(db,structuredClone(v))}},permissions:{contains:async()=>true}};
  globalThis.fetch=async(url,opts)=>{assert.equal(url,endpoint);assert.equal(opts.credentials,'omit');sent=JSON.parse(opts.body);return {ok:true,url:'https://script.googleusercontent.com/macros/echo',json:async()=>({ok:true,updatedRows:2,protectionRows:version?2:0,protectionVersion:version,spreadsheetUrl:sheetUrl})};};
  try{const sync=installSheetSync(),old=await sync.handle({type:'SHEET_SYNC'});assert.equal(old.enabled,false);assert.match(old.lastWarning,/更新简洁版/);assert.equal(old.secret,undefined);assert.equal(old.spreadsheetUrl,sheetUrl);assert.equal(JSON.parse(sent.payload).accounts[0].protection.threshold,30);
    version=2;const current=await sync.handle({type:'SHEET_SYNC'});assert.equal(current.lastWarning,'');assert.equal(current.protectionRows,2);assert.equal(current.hasSecret,true);
    await assert.rejects(()=>sync.handle({type:'SHEET_SAVE',endpoint:'https://evil.test/exec'}));
  }finally{globalThis.fetch=fetchBefore;delete globalThis.chrome;}
});
