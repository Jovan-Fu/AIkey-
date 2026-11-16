import {test} from 'node:test';
import assert from 'node:assert/strict';
import {googleApiError,billingFailureHint,recoveryProjectId,billingAssociation} from '../billing-errors.js';

test('billing diagnostics retain Google reasons without logging credentials or claiming a specific payment cause',()=>{
  const e=googleApiError(400,{error:{status:'FAILED_PRECONDITION',message:'Precondition check failed.',details:[{'@type':'type.googleapis.com/google.rpc.PreconditionFailure',violations:[{type:'BILLING_NOT_READY',subject:'projects/example',description:'Further verification required'}]},{reason:'NOT_READY',metadata:{permission:'billing.resourceAssociations.create',secret:'must-not-appear',api_key:'must-not-appear'}}]}},'cloudbilling','v1/projects/example/billingInfo?key=SECRET');
  assert.equal(e.apiStatus,'FAILED_PRECONDITION');assert(e.diagnostics.details.some(s=>s.includes('BILLING_NOT_READY')));
  assert(!JSON.stringify(e.diagnostics).includes('must-not-appear'));assert(!JSON.stringify(e.diagnostics).includes('?key='));
  assert.match(billingFailureHint(e),/不能确定具体原因/);
  assert.equal(recoveryProjectId('ai-20000101-abcdef'),'ai-20000101-abcdef');assert.throws(()=>recoveryProjectId('../../other'));
  assert.equal(billingAssociation({billingEnabled:true,billingAccountName:'billingAccounts/OTHER'},'billingAccounts/SELECTED'),'other-account');
});

async function scenario(mode,callback){
  let listener,project='',linked='',sa=false,saEmail='',keyBody,keyName='',privateCount=0,apiAttempts=0,policy={etag:'keep-etag',version:3,bindings:[]};
  const calls=[],session={},local={},realFetch=globalThis.fetch,realTimeout=globalThis.setTimeout;
  const account='billingAccounts/123456-ABCDEF-654321';
  const store=obj=>({setAccessLevel:async()=>{},get:async key=>({[key]:structuredClone(obj[key])}),set:async values=>Object.assign(obj,structuredClone(values)),remove:async keys=>{for(const k of Array.isArray(keys)?keys:[keys])delete obj[k];}});
  const id='a'.repeat(32),url=`chrome-extension://${id}/dashboard.html`;
  globalThis.chrome={runtime:{id,getURL:p=>`chrome-extension://${id}/${p}`,onMessage:{addListener:f=>listener=f}},storage:{session:store(session),local:store(local)},
    declarativeNetRequest:{updateSessionRules:async()=>{}},action:{onClicked:{addListener(){}},setBadgeText:async()=>{},setBadgeBackgroundColor:async()=>{},setTitle:async()=>{}},
    tabs:{query:async()=>[{id:1,url:'https://console.cloud.google.com/'}],get:async()=>({id:1,url:'https://console.cloud.google.com/'})},
    scripting:{executeScript:async()=>[{result:{cookie:'MOCK',keys:['MOCK_BOOTSTRAP_KEY'],authUser:'0'}}]}};
  globalThis.setTimeout=fn=>realTimeout(fn,0);
  globalThis.fetch=async(value,opts)=>{
    const u=new URL(value),body=opts.body?JSON.parse(opts.body):null,path=u.pathname;calls.push({path,method:opts.method,body});
    const success=data=>({ok:true,status:200,json:async()=>data});
    if(path==='/v1/billingAccounts')return success({billingAccounts:[{name:account,displayName:'Trial',open:mode!=='closed-list'}]});
    if(path==='/v1/'+account)return success({name:account,open:mode!=='closed'});
    if(path.endsWith(':testIamPermissions'))return success({permissions:mode==='missing-permission'?[]:body.permissions});
    if(path==='/v1/projects') {project=body.projectId;return success({done:true});}
    if(path===`/v1/projects/${project}`)return success({projectId:project,projectNumber:'123',lifecycleState:'ACTIVE'});
    if(path.endsWith('/billingInfo')){
      if(opts.method==='PUT'){
        if(mode==='precondition')return {ok:false,status:400,json:async()=>({error:{status:'FAILED_PRECONDITION',message:'Precondition check failed.',details:[{reason:'BILLING_NOT_READY'}]}})};
        linked=account;if(mode==='uncertain-success')throw new Error('connection lost after write');
      }
      return success({billingEnabled:!!linked,billingAccountName:linked});
    }
    if(path.endsWith(':batchEnable'))return success({done:true});
    if(path.endsWith('/serviceAccounts')){sa=true;saEmail=body.accountId+'@'+project+'.iam.gserviceaccount.com';return success({email:saEmail});}
    if(u.hostname==='iam.clients6.google.com' && path.endsWith('/keys')){
      if(opts.method==='GET')return success({keys:privateCount || mode==='existing-private'?[{name:'old',keyType:'USER_MANAGED'}]:[]});
      privateCount++;
      if(mode==='private-network')throw new Error('lost private key response');
      return success({privateKeyData:btoa(JSON.stringify({client_email:saEmail,private_key:'MOCK_PRIVATE'}))});
    }
    if(u.hostname==='iam.clients6.google.com')return sa?success({email:saEmail}):{ok:false,status:404,json:async()=>({error:{status:'NOT_FOUND',message:'Service account not found'}})};
    if(path.endsWith(':getIamPolicy'))return success(policy);
    if(path.endsWith(':setIamPolicy')){policy=body.policy;return success(policy);}
    if(u.hostname==='apikeys.clients6.google.com' && opts.method==='POST'){
      apiAttempts++;
      if(mode==='api-network')throw new Error('unknown write result');
      const msg=`Service Account '${saEmail}' not found.`;
      if(mode==='sa-never' || mode==='sa-delay' && apiAttempts<4 || mode==='sa-forbidden' || mode==='sa-operation'){
        if(mode==='sa-operation')return success({done:true,error:{code:5,message:msg}});
        return {ok:false,status:mode==='sa-forbidden'?403:400,json:async()=>({error:{status:'INVALID_ARGUMENT',message:msg}})};
      }
      keyBody=body;keyName='projects/123/locations/global/keys/'+u.searchParams.get('keyId');return success({done:true,response:{name:keyName}});
    }
    if(path.endsWith('/keyString'))return success({keyString:'MOCK_API_KEY'});
    if(u.hostname==='apikeys.clients6.google.com'){if(!keyBody)return {ok:false,status:404,json:async()=>({error:{status:'NOT_FOUND',message:'Key not found'}})};return success({name:keyName,serviceAccountEmail:keyBody.serviceAccountEmail,restrictions:keyBody.restrictions});}
    throw new Error('Unexpected mock endpoint '+path);
  };
  try{
    await import('../background.js?billing-recovery='+Math.random());
    const call=message=>new Promise(resolve=>listener(message,{id,url,frameId:0},resolve));
    assert.equal((await call({type:'CONNECT'})).ok,true);
    const finished=async()=>{for(let i=0;i<200;i++){const s=(await call({type:'STATE'})).data;if(!s.running)return s;await new Promise(r=>realTimeout(r,2));}throw new Error('mock job did not finish');};
    await callback({account,calls,call,finished,setMode:v=>mode=v,setLinked:v=>linked=v,getProject:()=>project});
  }finally{globalThis.fetch=realFetch;globalThis.setTimeout=realTimeout;delete globalThis.chrome;}
}

test('precondition failure preserves project and exact diagnostics; recovery skips new project and duplicate credential creation',async()=>{
  await scenario('precondition',async h=>{
    await h.call({type:'START',billingAccount:h.account});const failed=await h.finished();
    assert.equal(failed.stage,'billing');assert.equal(failed.resumable,true);assert.equal(failed.diagnostics.apiStatus,'FAILED_PRECONDITION');
    assert.match(failed.error,/不能确定具体原因/);assert.equal(h.calls.filter(c=>c.path==='/v1/projects').length,1);
    assert.equal(h.calls.filter(c=>c.path.endsWith('/serviceAccounts')).length,0);
    h.setMode('success');h.setLinked(h.account);const before=h.calls.length;
    await h.call({type:'RESUME_BILLING',projectId:failed.projectId,billingAccount:h.account});const recovered=await h.finished();
    assert.equal(recovered.completed,true,recovered.error);assert.equal(recovered.projectId,failed.projectId);
    const resumeCalls=h.calls.slice(before);assert.equal(resumeCalls.filter(c=>c.path==='/v1/projects').length,0);
    assert.equal(resumeCalls.filter(c=>c.path.endsWith('/billingInfo')&&c.method==='PUT').length,0);
    const keysBefore=h.calls.filter(c=>c.path.endsWith('/keys')&&c.method==='POST').length;
    await h.call({type:'RESUME_BILLING',projectId:failed.projectId,billingAccount:h.account});const stopped=await h.finished();
    assert.equal(stopped.completed,true);assert.equal(stopped.json,recovered.json);
    assert.equal(h.calls.filter(c=>c.path.endsWith('/keys')&&c.method==='POST').length,keysBefore);
  });
});

test('uncertain billing PUT is reconciled by reads without replaying the write',async()=>{
  await scenario('uncertain-success',async h=>{
    await h.call({type:'START',billingAccount:h.account});const result=await h.finished();
    assert.equal(result.completed,true,result.error);
    assert.equal(h.calls.filter(c=>c.path.endsWith('/billingInfo')&&c.method==='PUT').length,1);
    assert(result.logs.some(s=>s.includes('未重复提交')));
  });
});

test('closed account or absent association permission stops before creating a project',async()=>{
  for(const mode of ['closed','missing-permission'])await scenario(mode,async h=>{
    await h.call({type:'START',billingAccount:h.account});const result=await h.finished();
    assert.equal(result.completed,false);assert.equal(h.calls.filter(c=>c.path==='/v1/projects').length,0);
  });
});


test('new service account propagation retries explicit rejections, then succeeds',async()=>{
  await scenario('sa-delay',async h=>{
    await h.call({type:'START',billingAccount:h.account});const result=await h.finished();
    assert.equal(result.completed,true,result.error);
    assert.equal(h.calls.filter(c=>c.path==='/v1/projects').length,1);
    assert.equal(h.calls.filter(c=>c.path.endsWith('/serviceAccounts')&&c.method==='POST').length,1);
    assert.equal(h.calls.filter(c=>c.path.startsWith('/v2/')&&c.method==='POST').length,4);
    assert(result.logs.some(s=>s.includes('尚未同步服务账号')));
  });
});

test('bounded retries can resume stage 4 with existing service account and unchanged IAM binding',async()=>{
  for(const mode of ['sa-never','sa-operation'])await scenario(mode,async h=>{
    await h.call({type:'START',billingAccount:h.account});const failed=await h.finished();
    assert.equal(failed.stage,'api-key');assert.equal(failed.resumable,true);
    assert.equal(h.calls.filter(c=>c.path.startsWith('/v2/')&&c.method==='POST').length,8);
    h.setMode('success');const before=h.calls.length;
    await h.call({type:'RESUME_BILLING',projectId:failed.projectId,billingAccount:h.account});const result=await h.finished();
    assert.equal(result.completed,true,result.error);
    const resumed=h.calls.slice(before);
    assert.equal(resumed.filter(c=>c.path==='/v1/projects'||c.path.endsWith('/serviceAccounts')||c.path.endsWith(':setIamPolicy')).length,0);
  });
});

test('network ambiguity and permission failures never replay API key writes',async()=>{
  for(const mode of ['api-network','sa-forbidden'])await scenario(mode,async h=>{
    await h.call({type:'START',billingAccount:h.account});const result=await h.finished();
    assert.equal(result.completed,false);
    assert.equal(h.calls.filter(c=>c.path.startsWith('/v2/')&&c.method==='POST').length,1);
    assert.equal(h.calls.filter(c=>c.path.endsWith('/keys')&&c.path.startsWith('/v1/')&&c.method==='POST').length,0);
  });
});

test('resuming reuses existing API key and stops when a JSON private key already exists',async()=>{
  await scenario('sa-never',async h=>{
    await h.call({type:'START',billingAccount:h.account});const failed=await h.finished();
    h.setMode('existing-private');
    await h.call({type:'RESUME_BILLING',projectId:failed.projectId,billingAccount:h.account});const stopped=await h.finished();
    assert.match(stopped.error,/已有用户管理的私钥/);assert.equal(stopped.apiKey,'MOCK_API_KEY');
    const before=h.calls.length;
    await h.call({type:'RESUME_BILLING',projectId:failed.projectId,billingAccount:h.account});const again=await h.finished();
    assert.match(again.error,/已有用户管理的私钥/);
    assert.equal(h.calls.slice(before).filter(c=>c.path.startsWith('/v2/')&&c.method==='POST').length,0);
    assert.equal(h.calls.filter(c=>c.path.startsWith('/v1/')&&c.path.endsWith('/keys')&&c.method==='POST').length,0);
  });
});

test('uncertain JSON creation stays blocked across repeated resumes',async()=>{
  await scenario('private-network',async h=>{
    await h.call({type:'START',billingAccount:h.account});const failed=await h.finished();
    assert.equal(failed.privateKeyRequested,true);
    h.setMode('success');
    for(let i=0;i<2;i++){
      await h.call({type:'RESUME_BILLING',projectId:failed.projectId,billingAccount:h.account});const result=await h.finished();
      assert.match(result.error,/已提交过 JSON/);assert.equal(result.privateKeyRequested,true);
    }
    assert.equal(h.calls.filter(c=>c.path.startsWith('/v1/')&&c.path.endsWith('/keys')&&c.method==='POST').length,1);
  });
});


test('closed billing accounts remain visible for review but cannot start a new project',async()=>{
  await scenario('closed-list',async h=>{
    const connected=await h.call({type:'CONNECT'});
    assert.equal(connected.data.accounts[0].open,false);
    assert.equal((await h.call({type:'START',billingAccount:h.account})).ok,false);
    assert.equal(h.calls.filter(c=>c.path==='/v1/projects').length,0);
  });
});
