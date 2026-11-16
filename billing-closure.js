import {billingRoute,billingPageUrl,ACCOUNT_RE} from './monitor-core.js';

// Private controller. Only a persisted, explicitly authorized balance task can queue an account closure.
export function installBillingClosure({request,withConnection,isBusy=()=>false,recordAccountState=async()=>{}}){
  let chain=Promise.resolve();
  const serial=fn=>{const task=chain.then(fn);chain=task.catch(()=>{});return task;};
  const load=async()=> (await chrome.storage.local.get('billingClosure')).billingClosure || {accounts:{}};
  const save=c=>chrome.storage.local.set({billingClosure:c});
  function sameProjects(a,b){return JSON.stringify(a?.map(p=>({id:p.id,number:p.number})))===JSON.stringify(b?.map(p=>({id:p.id,number:p.number})));}
  async function authorization(account,job){
    const s=(await chrome.storage.local.get('balanceGuard')).balanceGuard?.accounts?.[account];
    if(!s?.enabled || !s.armed || !s.triggeredAt || s.policy?.account!==account || s.policy?.closeBillingAccount!==true || s.policy.version!==3 || !s.authorizationId)throw Error('没有当前有效的整账号关闭授权');
    if(job && (s.authorizationId!==job.authorizationId || s.triggeredAt!==job.triggeredAt || s.policy.authUser!==job.authUser || !sameProjects(s.policy.projects,job.projects)))throw Error('账号关闭授权或项目范围已变化');
    return s;
  }
  async function verifyScope(s,conn){
    const account=s.policy.account;
    if(String(conn.authUser)!==s.policy.authUser || !conn.accounts?.some(a=>a.name===account))throw Error('当前Google账号与整账号关闭授权不匹配');
    const data=await request('cloudbilling','v1/'+account);
    if(data.name!==account || typeof data.open!=='boolean' || data.currencyCode!==s.policy.currency)throw Error('无法核实结算账号身份、币种或开放状态');
    if(data.open===false)return data;
    let token='';const seen=new Set(),approved=new Set(s.policy.projects.map(p=>p.id));
    for(let i=0;i<20;i++){
      const list=await request('cloudbilling','v1/'+account+'/projects'+(token?'?pageToken='+encodeURIComponent(token):''));
      if(list.projectBillingInfo!==undefined && !Array.isArray(list.projectBillingInfo))throw Error('项目列表响应无效');
      if((list.projectBillingInfo || []).some(p=>!p || typeof p.projectId!=='string' || !approved.has(p.projectId) || p.billingAccountName && p.billingAccountName!==account))throw Error('结算账号出现了未授权的新关联项目，拒绝关闭整个账号');
      token=list.nextPageToken || '';if(!token)return data;
      if(typeof token!=='string'||seen.has(token))throw Error('账号关闭前的项目列表分页异常');seen.add(token);
    }throw Error('关联项目列表未读取完整，未关闭账号');
  }
  const snapshot=j=>j?{status:j.status,accountOpen:j.accountOpen ?? null,checkedAt:j.checkedAt || null,verifiedClosedAt:j.verifiedClosedAt || null,submitted:j.submitted ?? null,error:j.error || '',message:j.message || '',canRetry:j.status==='failed' && j.submitted===false}:null;
  async function run(account,conn,{retry=false}={}){return serial(async()=>{
    if(!ACCOUNT_RE.test(account || ''))throw Error('关闭账号标识无效');
    let s=await authorization(account),c=await load(),j=c.accounts[account];
    if(j && j.authorizationId!==s.authorizationId){
      if(j.submitted!==false && j.status!=='verified-closed')throw Error('上一个账号关闭操作结果尚未核实，不会覆盖记录或重复提交');
      j=null;
    }
    const data=await verifyScope(s,conn);s=await authorization(account,j || undefined);
    const now=Date.now();
    if(data.open===false){
      j ||= {account,authorizationId:s.authorizationId,authUser:s.policy.authUser,projects:structuredClone(s.policy.projects),triggeredAt:s.triggeredAt};
      Object.assign(j,{status:'verified-closed',accountOpen:false,checkedAt:now,verifiedClosedAt:now,message:'已通过Google接口核实结算账号关闭',error:''});c.accounts[account]=j;await save(c);await recordAccountState(account,false,now,j.authUser);return snapshot(j);
    }
    if(j?.status==='verified-closed'){
      Object.assign(j,{status:'reopened',accountOpen:true,checkedAt:now,verifiedClosedAt:null,error:'结算账号重新开放，未重复自动关闭，请人工核实'});c.accounts[account]=j;await save(c);await recordAccountState(account,true,now,j.authUser);return snapshot(j);
    }
    if(j){
      Object.assign(j,{accountOpen:true,checkedAt:now});
      if(['opening','executing'].includes(j.status) && now-j.createdAt>180000){j.submitted=j.status==='opening'?false:null;j.status='failed';j.error='关闭页面任务超时，账号仍开放，不能宣称已关闭';}
      if(j.status==='needs-verification' && now-(j.confirmedAt || j.createdAt)>180000){j.status='needs-manual';j.error='已提交关闭确认超过3分钟，但接口仍显示开放；需人工核实，不重复提交';}
      if(!retry){c.accounts[account]=j;await save(c);return snapshot(j);}
      if(j.status!=='failed' || j.submitted!==false)throw Error('上次操作可能已提交或仍在进行，不盲目重复关闭；请在官方页核实');
    }
    const profiles=(await chrome.storage.local.get('trialMonitor')).trialMonitor?.profiles || {},dateJob=profiles[account]?.job;
    if(dateJob && ['opening','executing','needs-verification'].includes(dateJob.status)){
      const waiting={account,authorizationId:s.authorizationId,authUser:s.policy.authUser,projects:structuredClone(s.policy.projects),triggeredAt:s.triggeredAt,status:'waiting-date',accountOpen:true,checkedAt:now,createdAt:now,submitted:null,error:'已有日期关闭操作正在进行，先核实该操作，不重复打开关闭页面'};
      c.accounts[account]=waiting;await save(c);return snapshot(waiting);
    }
    j={account,authorizationId:s.authorizationId,authUser:s.policy.authUser,projects:structuredClone(s.policy.projects),triggeredAt:s.triggeredAt,status:'opening',createdAt:now,accountOpen:true,checkedAt:now,token:crypto.randomUUID(),submitted:false,message:'项目停用已开始，等待官方页面关闭结算账号'};
    c.accounts[account]=j;await save(c);
    try{
      let url=billingPageUrl('manage',j.authUser);
      if(chrome.tabs.query){
        const tabs=await chrome.tabs.query({url:'https://console.cloud.google.com/billing/*'}).catch(()=>[]);
        const known=tabs.find(t=>{const route=billingRoute(t.url);return route?.page==='manage' && route.account===account && (new URL(t.url).searchParams.get('authuser') || '0')===j.authUser;});
        if(known)url=known.url;
      }
      const tab=await chrome.tabs.create({url,active:false});j.tabId=tab.id;
    }
    catch(e){j.status='failed';j.error='无法打开结算账号关闭页：'+e.message;}
    await save(c);return snapshot(j);
  });}
  async function content(message,sender){return serial(async()=>{
    if(!['CLOSE_TICKET','CLOSE_CONFIRM_READY','CLOSE_RESULT'].includes(message?.type))return null;
    if(sender.id!==chrome.runtime.id || sender.frameId!==0 || !sender.tab || !Number.isInteger(sender.tab.id))throw Error('拒绝无效关闭页面');
    const route=billingRoute(sender.url),account=route?.account || message.account;
    if(route?.page!=='manage' || !ACCOUNT_RE.test(account || ''))return null;
    const c=await load(),j=c.accounts[account];
    if(j && message.type!=='CLOSE_RESULT' && j.tabId!==sender.tab.id && ['opening','executing','needs-verification'].includes(j.status))return {allowed:false,reason:'同一结算账号已有另一个关闭任务，未授予重复票据'};
    if(!j || j.tabId!==sender.tab.id || !['opening','executing'].includes(j.status))return null;
    if(message.type==='CLOSE_TICKET' && message.agentVersion!=='2.5.8')return {allowed:false,reason:'需要刷新2.5.8官方页面脚本，未授予关闭票据'};
    const tab=await chrome.tabs.get(j.tabId);
    if(tab.url!==sender.url || (new URL(tab.url).searchParams.get('authuser') || '0')!==j.authUser)throw Error('关闭页面网址或Google登录索引已变化');
    if(message.type==='CLOSE_RESULT'){
      if(j.status!=='executing' || message.token!==j.token)throw Error('无效账号关闭结果票据');
      j.submitted=message.submitted===true;j.status=j.submitted?'needs-verification':'failed';j.message=String(message.note || '').slice(0,300);j.error=j.submitted?'尚未通过接口确认账号已关闭':j.message;await save(c);return {accepted:true};
    }
    if(isBusy())return {allowed:false,reason:'正在处理项目停用，请稍后核实'};
    if(message.type==='CLOSE_CONFIRM_READY' && (j.status!=='executing'||message.token!==j.token))return {allowed:false,reason:'关闭确认票据已失效'};
    if(message.type==='CLOSE_CONFIRM_READY' && j.confirmedAt)return {allowed:false,reason:'关闭提交票据已使用，未重复授权'};
    if(message.type==='CLOSE_TICKET' && j.status!=='opening')return {allowed:false};
    if(Date.now()-j.createdAt>180000)return {allowed:false,reason:'关闭页面票据已超时'};
    try{
      const s=await authorization(account,j);
      const data=await withConnection(conn=>verifyScope(s,conn));
      await authorization(account,j);
      if(!data.open){Object.assign(j,{status:'verified-closed',accountOpen:false,checkedAt:Date.now(),verifiedClosedAt:Date.now(),message:'已通过Google接口核实结算账号关闭',error:''});await save(c);await recordAccountState(account,false,j.checkedAt,j.authUser);return {allowed:false,alreadyClosed:true};}
      if(message.type==='CLOSE_TICKET'){j.status='executing';j.submitted=null;await save(c);return {allowed:true,account,displayName:data.displayName || '',token:j.token,kind:'balance'};}
      j.confirmedAt=Date.now();await save(c);return {allowed:true};
    }catch(e){j.error=String(e.message).slice(0,300);await save(c);return {allowed:false,reason:j.error};}
  });}
  return {run,content,read:async(account,authorizationId)=>{const j=(await load()).accounts[account];return j && j.authorizationId===authorizationId?snapshot(j):null;}};
}
