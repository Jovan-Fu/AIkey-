import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {operationError,operationPath,rulesFor,trustedDashboard,consoleUrl} from '../core.js';

test('reject forged callers, misleading origins, failed operations and malformed poll paths',()=>{
  const runtime={id:'a'.repeat(32),getURL:p=>`chrome-extension://${'a'.repeat(32)}/${p}`};
  assert(trustedDashboard({id:runtime.id,url:runtime.getURL('dashboard.html')},runtime));
  for(const sender of [{id:runtime.id,url:'https://console.cloud.google.com/'},{id:'evil',url:runtime.getURL('dashboard.html')},{id:runtime.id,url:runtime.getURL('dashboard.html'),frameId:1}]) assert(!trustedDashboard(sender,runtime));
  assert(!consoleUrl('https://console.cloud.google.com.evil.test/'));
  assert.throws(()=>operationError({done:true,error:{message:'failed'}}),/failed/);
  assert.throws(()=>operationPath('v1','https://evil.test/operations/x'));
  assert.equal(operationPath('v2','operations/abc'),'v2/operations/abc');
  for(const rule of rulesFor(runtime.id)) {
    assert.deepEqual(rule.condition.initiatorDomains,[runtime.id]);
    assert(!rule.action.responseHeaders);
  }
});

test('full workflow, secret isolation, caller rejection and uncertain write handling',async()=>{
  let listener,requests=[],mode='success';
  const session={},local={};
  const store = obj => ({setAccessLevel:async()=>{},get:async key=>({[key]:structuredClone(obj[key])}),set:async values=>{Object.assign(obj,structuredClone(values));}});
  const id='a'.repeat(32),page=`chrome-extension://${id}/dashboard.html`;
  globalThis.chrome={
    runtime:{id,getURL:p=>`chrome-extension://${id}/${p}`,onMessage:{addListener:fn=>listener=fn}},
    storage:{session:store(session),local:store(local)},
    declarativeNetRequest:{updateSessionRules:async()=>{}},action:{onClicked:{addListener:()=>{}}},
    tabs:{query:async()=>[{id:1,url:'https://console.cloud.google.com/'}],get:async()=>({id:1,url:'https://console.cloud.google.com/'})},
    scripting:{executeScript:async()=>[{result:{cookie:'MOCK_COOKIE',keys:['AIzaSy'+'a'.repeat(33)],authUser:'0'}}]}
  };
  const realFetch=globalThis.fetch,realTimeout=globalThis.setTimeout;
  globalThis.setTimeout=(fn)=>realTimeout(fn,0);
  globalThis.fetch=async(url,opts)=>{
    const u=new URL(url),body=opts.body?JSON.parse(opts.body):undefined;
    requests.push({url:u,opts,body});
    assert.equal(u.protocol,'https:');assert(u.hostname.endsWith('.clients6.google.com'));
    assert.equal(opts.redirect,'error');
    if(mode==='timeout' && u.pathname==='/v1/projects' && opts.method==='POST') throw new Error('network lost');
    let data;
    if(u.pathname==='/v1/billingAccounts') data={billingAccounts:[{open:true,name:'billingAccounts/ABC',displayName:'Test'}]};
    else if(u.pathname==='/v1/projects') data={done:true};
    else if(u.pathname.endsWith('/billingInfo')) data={billingEnabled:true};
    else if(u.pathname.endsWith(':batchEnable')) data={done:true};
    else if(u.pathname.endsWith(':getIamPolicy')) data={etag:'preserve-etag',version:3,bindings:[{role:'roles/viewer',members:['user:owner@example.test'],condition:{title:'keep',expression:'true'}}]};
    else if(u.pathname.endsWith(':setIamPolicy')) {assert.equal(body.policy.etag,'preserve-etag');assert(body.policy.bindings[0].condition);data=body.policy;}
    else if(u.pathname.endsWith('/serviceAccounts')) data={};
    else if(u.hostname==='iam.clients6.google.com' && u.pathname.endsWith('/keys')) {
      const email=decodeURIComponent(u.pathname.split('/serviceAccounts/')[1].split('/')[0]);
      data={privateKeyData:btoa(JSON.stringify({client_email:email,private_key:'MOCK_PRIVATE_KEY'}))};
    }
    else if(u.hostname==='iam.clients6.google.com') data={};
    else if(u.hostname==='apikeys.clients6.google.com' && opts.method==='POST') data={done:true,response:{name:'projects/123/locations/global/keys/mock-key'}};
    else if(u.pathname.endsWith('/keyString')) data={keyString:'MOCK_GENERATED_KEY'};
    else if(u.hostname==='apikeys.clients6.google.com') {
      const create=requests.findLast(r=>r.url.hostname==='apikeys.clients6.google.com' && r.opts.method==='POST');
      data={serviceAccountEmail:mode==='wrong-binding'?'wrong@example.test':create.body.serviceAccountEmail,restrictions:create.body.restrictions};
    }
    else data={projectNumber:'123'};
    return {ok:true,status:200,json:async()=>data};
  };
  try {
    await import('../background.js?test');
    const sender={id,url:page,frameId:0};
    const call=(message,from=sender)=>new Promise(resolve=>listener(message,from,resolve));
    assert.equal((await call({type:'GCP_EXT_FETCH',url:'https://evil.test'},{id,url:'https://console.cloud.google.com/',tab:{id:1}})).ok,false);
    assert.equal(requests.length,0);
    assert.equal((await call({type:'CONNECT'})).ok,true);
    assert.equal((await call({type:'START',billingAccount:'billingAccounts/EVIL'})).ok,false);
    assert.equal((await call({type:'START',billingAccount:'billingAccounts/ABC'})).ok,true);
    assert.equal((await call({type:'START',billingAccount:'billingAccounts/ABC'})).ok,false);
    let state;
    for(let i=0;i<100;i++){state=(await call({type:'STATE'})).data;if(!state.running)break;await new Promise(r=>realTimeout(r,3));}
    assert.equal(state.completed,true,state.error);assert.equal(state.apiKey,'MOCK_GENERATED_KEY');assert.match(state.json,/MOCK_PRIVATE_KEY/);
    assert.equal(requests.filter(r=>r.url.hostname==='iam.clients6.google.com' && r.url.pathname.endsWith('/keys')).length,1);
    assert.equal((await call({type:'STATE'},{id,url:'https://console.cloud.google.com/',tab:{id:1}})).ok,false);
    mode='wrong-binding';requests=[];
    await call({type:'START',billingAccount:'billingAccounts/ABC'});
    for(let i=0;i<100;i++){state=(await call({type:'STATE'})).data;if(!state.running)break;await new Promise(r=>realTimeout(r,3));}
    assert.match(state.error,/绑定或限制未通过核验/);
    assert.equal(requests.filter(r=>r.url.hostname==='iam.clients6.google.com' && r.url.pathname.endsWith('/keys')).length,0);
    mode='timeout';requests=[];
    await call({type:'START',billingAccount:'billingAccounts/ABC'});
    for(let i=0;i<100;i++){state=(await call({type:'STATE'})).data;if(!state.running)break;await new Promise(r=>realTimeout(r,3));}
    assert.match(state.error,/未重复提交/);assert.equal(requests.length,1);assert.equal(state.completed,false);
    await call({type:'CLEAR'});assert.equal((await call({type:'STATE'})).data.json,'');
    const scripts=await Promise.all(['background.js','launcher.js','dashboard.js'].map(p=>readFile(new URL('../'+p,import.meta.url),'utf8')));
    for(const code of scripts) assert(!code.includes('postMessage('));
  } finally {globalThis.fetch=realFetch;globalThis.setTimeout=realTimeout;delete globalThis.chrome;}
});
