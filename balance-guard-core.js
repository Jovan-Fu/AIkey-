// Balance snapshots and explicit authorization only. No usage or price queries.
export const BalanceGuardCore=(()=>{
  const ACCOUNT=/^billingAccounts\/[A-Z0-9]{6}-[A-Z0-9]{6}-[A-Z0-9]{6}$/;
  const PROJECT=/^[a-z][a-z0-9-]{4,28}[a-z0-9]$/;
  const clone=x=>JSON.parse(JSON.stringify(x));
  function validate(raw){
    if(!raw || !ACCOUNT.test(raw.account || '') || !/^[A-Z]{3}$/.test(raw.currency || '') || !/^\d{1,3}$/.test(String(raw.authUser ?? '0')))throw Error('结算账号或币种无效');
    if(typeof raw.threshold!=='number'||!Number.isFinite(raw.threshold)||raw.threshold<0||raw.threshold>1e9)throw Error('最低余额必须为不小于0的金额');
    if(!Array.isArray(raw.projects)||!raw.projects.length||raw.projects.length>30)throw Error('需要核实1至30个关联项目');
    const ids=raw.projects.map(p=>typeof p==='string'?p:p.id);
    if(ids.some(p=>!PROJECT.test(p)) || new Set(ids).size!==ids.length)throw Error('项目ID无效或重复');
    return {version:raw.closeBillingAccount===true?3:2,account:raw.account,currency:raw.currency,threshold:raw.threshold,projects:ids.map(id=>({id})),authUser:String(raw.authUser ?? '0'),fallbackDelete:raw.fallbackDelete===true,closeBillingAccount:raw.closeBillingAccount===true};
  }
  const api=(service,path,method='GET',body)=>({kind:'api',service,path,method,body});
  const checkpoint=s=>({kind:'save',state:clone(s)});
  function* pages(service,path,field,max=20){
    const rows=[],seen=new Set();let token='';
    for(let i=0;i<max;i++){
      const data=yield api(service,path+(token?(path.includes('?')?'&':'?')+'pageToken='+encodeURIComponent(token):''));
      if(!data || data[field]!==undefined && !Array.isArray(data[field]))throw Error('Google列表响应无效');
      rows.push(...(data[field] || []));token=data.nextPageToken || '';if(!token)return rows;
      if(typeof token!=='string'||seen.has(token))throw Error('Google分页标记无效');seen.add(token);
    }throw Error('Google列表过长，未忽略剩余项目');
  }
  function* preflight(raw){
    const checked=validate(raw),account=yield api('cloudbilling','v1/'+checked.account);
    if(account.name!==checked.account||account.open!==true||account.currencyCode!==checked.currency)throw Error('结算账号状态或币种无法核实');
    if(checked.closeBillingAccount){
      const permissions=['billing.accounts.get','billing.accounts.close'];
      const granted=yield api('cloudbilling','v1/'+checked.account+':testIamPermissions','POST',{permissions});
      if(permissions.some(p=>!granted.permissions?.includes(p)))throw Error('缺少关闭整个结算账号的权限，未启用联合停用');
    }
    const linked=yield* pages('cloudbilling','v1/'+checked.account+'/projects','projectBillingInfo');
    const active=linked.filter(p=>p.billingEnabled===true).map(p=>p.projectId).sort();
    if(active.join('|')!==checked.projects.map(p=>p.id).sort().join('|'))throw Error('关联项目已变化，请重新检查保护范围');
    for(const p of checked.projects){
      const info=yield api('cloudresourcemanager','v1/projects/'+p.id);
      if(info.projectId!==p.id||info.lifecycleState!=='ACTIVE'||!/^\d{5,30}$/.test(String(info.projectNumber)))throw Error('项目身份或状态无法核实：'+p.id);
      p.number=String(info.projectNumber);
      const billing=yield api('cloudbilling','v1/projects/'+p.id+'/billingInfo');
      if(billing.billingAccountName!==checked.account||billing.billingEnabled!==true)throw Error('项目结算归属不匹配：'+p.id);
      const permissions=['serviceusage.services.get','serviceusage.services.disable','resourcemanager.projects.get','resourcemanager.projects.deleteBillingAssignment',...(checked.closeBillingAccount?['apikeys.keys.list','apikeys.keys.get','apikeys.keys.delete']:[]),...(checked.fallbackDelete?['resourcemanager.projects.delete']:[])];
      const granted=yield api('cloudresourcemanager','v1/projects/'+p.id+':testIamPermissions','POST',{permissions});
      const missing=permissions.filter(x=>!granted.permissions?.includes(x));if(missing.length)throw Error(p.id+' 缺少权限：'+missing.join(', '));
    }return checked;
  }
  function create(policy,now){return {account:policy.account,threshold:policy.threshold,fallbackDelete:policy.fallbackDelete,policy:clone(policy),enabled:false,armed:false,checkedAt:now,balance:null,sampledAt:null,lastCheckedAt:null,fresh:false,jobs:{},events:[],status:'只读检查完成，尚未启用保护'};}
  function event(s,text,now){s.events.push({at:now,text:String(text).slice(0,350)});s.events=s.events.slice(-60);}
  function trigger(s,reason,now){if(s.triggeredAt)return;s.triggeredAt=now;s.reason=reason;s.status='已触发余额停用';event(s,reason,now);}
  function observe(s,official,now){
    s.lastCheckedAt=now;
    s.fresh=!!(official?.verified===true && official.currency===s.policy.currency && typeof official.balance==='number' && Number.isFinite(official.balance) && official.balance>=0 && Number.isSafeInteger(official.at) && official.at<=now+60000 && now-official.at<=300000);
    if(!s.fresh){s.status='余额未知或页面快照超过5分钟，无法判断最低余额';return s;}
    s.balance=official.balance;s.sampledAt=official.at;
    s.status=s.enabled?'余额保护已启用':'只读检查完成，保护未启用';
    if(s.balance<=s.policy.threshold){s.status=s.enabled?'余额已达到停用线':'当前余额已达到停用线，启用后会立即停用';if(s.enabled && s.armed)trigger(s,'官方页面余额低于或等于最低余额 '+s.policy.threshold+' '+s.policy.currency,now);}
    return s;
  }
  function* attempt(s,j,label,service,path,method,body,now) {
    if(j.actions[label])return; // reconcile by reads, never blindly replay an ambiguous write
    j.actions[label]={submittedAt:now,status:'submitted'};yield checkpoint(s);
    try{yield api(service,path,method,body);j.actions[label].status='accepted';}
    catch(e){j.actions[label].status='uncertain';j.actions[label].error=String(e.message).slice(0,200);}
    yield checkpoint(s);
  }
  function* stopCombined(s,now){
    s.projectComplete=false;yield checkpoint(s);
    for(const p of s.policy.projects){
      const j=s.jobs[p.id] ||= {startedAt:now,actions:{},status:'等待核实'};
      j.projectSafe=false;j.projectUnavailable=false;j.keysRevoked=false;j.apisDisabled=false;j.billingDisabled=false;delete j.error;delete j.keyError;delete j.apiError;
      try{
        let info=yield api('cloudresourcemanager','v1/projects/'+p.id);
        if(info.projectId!==p.id || String(info.projectNumber)!==p.number)throw Error('项目身份已变化，停止写入');
        let billing=yield api('cloudbilling','v1/projects/'+p.id+'/billingInfo');
        if(billing.billingAccountName && billing.billingAccountName!==s.policy.account)throw Error('项目已换绑其他结算账号，拒绝修改或删除');
        if(info.lifecycleState==='DELETE_REQUESTED'){
          j.projectUnavailable=true;j.billingDisabled=billing.billingEnabled===false;j.projectSafe=j.billingDisabled;
          j.status=j.projectSafe?'已核实项目删除请求及结算停用，资源删除由Google继续处理':'项目删除已请求，结算状态仍待核实';yield checkpoint(s);continue;
        }
        if(info.lifecycleState!=='ACTIVE')throw Error('项目当前状态不支持自动处理');
        let listComplete=false;
        try{
          const keys=yield* pages('apikeys','v2/projects/'+p.number+'/locations/global/keys?pageSize=300','keys');
          const names=keys.filter(k=>!k.deleteTime).map(k=>k.name);
          if(names.some(n=>!new RegExp('^projects/'+p.number+'/locations/global/keys/[A-Za-z0-9_-]+$').test(n)))throw Error('Key资源不属于已授权项目');
          j.keys=[...new Set([...(j.keys || []),...names])];listComplete=true;
        }catch(e){j.keyError=String(e.message).slice(0,200);}
        let revoked=0;
        for(const name of j.keys || []){
          if(!new RegExp('^projects/'+p.number+'/locations/global/keys/[A-Za-z0-9_-]+$').test(name))throw Error('已记录Key不属于已授权项目');
          try{
            let key=yield api('apikeys','v2/'+name);
            if(key.name!==name)throw Error('Key身份不匹配');
            if(!key.deleteTime){yield* attempt(s,j,'key:'+name,'apikeys','v2/'+name,'DELETE',undefined,now);key=yield api('apikeys','v2/'+name);}
            if(key.name===name && key.deleteTime)revoked++;
          }catch(e){if(e.httpStatus===404)revoked++;else j.keyError=String(e.message).slice(0,200);}
        }
        j.keysRevoked=listComplete && revoked===(j.keys || []).length;
        let disabled=0;
        for(const service of ['aiplatform.googleapis.com','generativelanguage.googleapis.com']){
          const path='v1/projects/'+p.number+'/services/'+service;
          try{
            let data=yield api('serviceusage',path);
            if(data.name!=='projects/'+p.number+'/services/'+service || !['ENABLED','DISABLED'].includes(data.state))throw Error('API状态或身份无法核实');
            if(data.state==='ENABLED'){yield* attempt(s,j,service,'serviceusage',path+':disable','POST',{disableDependentServices:false,checkIfServiceHasUsage:'SKIP'},now);data=yield api('serviceusage',path);}
            if(data.name==='projects/'+p.number+'/services/'+service && data.state==='DISABLED')disabled++;
          }catch(e){j.apiError=String(e.message).slice(0,200);}
        }
        j.apisDisabled=disabled===2;yield checkpoint(s);
        // Always disable project billing in the combined workflow, even when AI APIs are already disabled.
        billing=yield api('cloudbilling','v1/projects/'+p.id+'/billingInfo');
        if(billing.billingAccountName && billing.billingAccountName!==s.policy.account)throw Error('项目已换绑其他结算账号，拒绝解除结算或删除');
        if(billing.billingEnabled!==false || billing.billingAccountName){
          yield* attempt(s,j,'unlink','cloudbilling','v1/projects/'+p.id+'/billingInfo','PUT',{billingAccountName:''},now);
          billing=yield api('cloudbilling','v1/projects/'+p.id+'/billingInfo');
        }
        if(billing.billingAccountName && billing.billingAccountName!==s.policy.account)throw Error('解除结算后账号归属发生变化，拒绝删除');
        j.billingDisabled=billing.billingEnabled===false;
        const unresolvedProject=!(j.keysRevoked && j.apisDisabled && j.billingDisabled);
        const accountAttemptFinished=['failed','reopened','verified-closed','needs-manual'].includes(s.accountClose?.status);
        if(unresolvedProject && s.policy.fallbackDelete && accountAttemptFinished && now-j.startedAt>=120000){
          info=yield api('cloudresourcemanager','v1/projects/'+p.id);
          billing=yield api('cloudbilling','v1/projects/'+p.id+'/billingInfo');
          if(info.projectId!==p.id || String(info.projectNumber)!==p.number || billing.billingAccountName && billing.billingAccountName!==s.policy.account)throw Error('删除前项目身份或结算归属已变化，拒绝删除');
          yield* attempt(s,j,'delete-project','cloudresourcemanager','v1/projects/'+p.id,'DELETE',undefined,now);
          info=yield api('cloudresourcemanager','v1/projects/'+p.id);j.projectUnavailable=info.projectId===p.id && String(info.projectNumber)===p.number && info.lifecycleState==='DELETE_REQUESTED';
          billing=yield api('cloudbilling','v1/projects/'+p.id+'/billingInfo');j.billingDisabled=billing.billingEnabled===false;
        }
        j.projectSafe=j.billingDisabled && (j.projectUnavailable===true || j.keysRevoked && j.apisDisabled);
        j.status=j.projectSafe?(j.projectUnavailable?'已核实项目删除请求及结算停用，资源删除由Google继续处理':'Key、AI服务和项目结算均已核实停用'):'尚未全部停用：'+[!j.keysRevoked?'Key撤销未核实':'',!j.apisDisabled?'AI服务停用未核实':'',!j.billingDisabled?'项目结算停用未核实':''].filter(Boolean).join('；');
      }catch(e){j.status='需要人工处理';j.error=String(e.message).slice(0,300);}
      yield checkpoint(s);
    }
    s.projectComplete=s.policy.projects.every(p=>s.jobs[p.id]?.projectSafe===true);
    s.status=s.projectComplete?'全部指定项目已核实停用':'项目仍有未完成的停用项';yield checkpoint(s);return s;
  }
  function* stop(s,now) {
    if(!s.armed || !s.triggeredAt)return s;
    if(s.policy.closeBillingAccount)return yield* stopCombined(s,now);
    for(const p of s.policy.projects) {
      const j=s.jobs[p.id] ||= {startedAt:now,actions:{},status:'等待核实'};
      // Keep reconciling even after success: a later manual re-enable must not stay green forever.
      try {
        const info=yield api('cloudresourcemanager','v1/projects/'+p.id);
        if(info.projectId!==p.id || String(info.projectNumber)!==p.number)throw Error('项目身份已变化，停止写入');
        if(info.lifecycleState==='DELETE_REQUESTED'){j.status='已核实删除请求，等待Google完成停用';yield checkpoint(s);continue;}
        if(info.lifecycleState!=='ACTIVE')throw Error('项目当前状态不支持自动处理');
        const billing=yield api('cloudbilling',`v1/projects/${p.id}/billingInfo`);
        if(billing.billingEnabled===false && !billing.billingAccountName){j.status='已核实解除结算';yield checkpoint(s);continue;}
        if(billing.billingAccountName!==s.policy.account)throw Error('项目已换绑其他结算账号，拒绝修改或删除');
        if(!j.actions['keys-listed']){
          try {
            const keys=yield* pages('apikeys',`v2/projects/${p.number}/locations/global/keys?pageSize=300`,'keys');
            j.keys=keys.filter(k=>!k.deleteTime).map(k=>k.name);
            if(j.keys.some(k=>!new RegExp('^projects/'+p.number+'/locations/global/keys/[A-Za-z0-9_-]+$').test(k)))throw Error('Key资源不属于已授权项目');
            j.actions['keys-listed']={status:'complete'};
          }catch(e){j.keyError=String(e.message).slice(0,200);}
          yield checkpoint(s);
        }
        for(const name of j.keys || []){
          try {
            const key=yield api('apikeys','v2/'+name);
            if(key.name!==name)throw Error('Key身份不匹配');
            if(!key.deleteTime)yield* attempt(s,j,'key:'+name,'apikeys','v2/'+name,'DELETE',undefined,now);
          }catch(e){j.keyError=String(e.message).slice(0,200);}
        }
        let disabled=0;
        for(const service of ['aiplatform.googleapis.com','generativelanguage.googleapis.com']){
          const path=`v1/projects/${p.number}/services/${service}`;
          try {
            let d=yield api('serviceusage',path);
            if(d.name!==`projects/${p.number}/services/${service}` || !['ENABLED','DISABLED'].includes(d.state))throw Error('API状态或身份无法核实');
            if(d.state==='ENABLED'){
              yield* attempt(s,j,service,'serviceusage',path+':disable','POST',{disableDependentServices:false,checkIfServiceHasUsage:'SKIP'},now);
              d=yield api('serviceusage',path);
            }
            if(d.state==='DISABLED')disabled++;
          }catch(e){j.apiError=String(e.message).slice(0,200);}
        }
        if(disabled===2){j.status='已核实停用';yield checkpoint(s);continue;}
        j.status='API停用未核实，准备解除项目结算';yield checkpoint(s);
        // Allow in-progress disable operations two minutes, unless they explicitly failed.
        const uncertain=Object.values(j.actions).some(a=>a.status==='uncertain');
        if(now-j.startedAt<120000 && !uncertain && !j.apiError)continue;
        yield* attempt(s,j,'unlink','cloudbilling',`v1/projects/${p.id}/billingInfo`,'PUT',{billingAccountName:''},now);
        const after=yield api('cloudbilling',`v1/projects/${p.id}/billingInfo`);
        if(after.billingEnabled===false && !after.billingAccountName){j.status='已核实解除结算';yield checkpoint(s);continue;}
        if(after.billingAccountName!==s.policy.account)throw Error('解除结算后账号归属发生变化，拒绝删除');
        if(s.policy.fallbackDelete && (j.actions.unlink.status==='uncertain' || now-j.actions.unlink.submittedAt>=120000)){
          yield* attempt(s,j,'delete-project','cloudresourcemanager','v1/projects/'+p.id,'DELETE',undefined,now);
          const end=yield api('cloudresourcemanager','v1/projects/'+p.id);
          j.status=end.projectId===p.id && end.lifecycleState==='DELETE_REQUESTED'?'已核实删除请求，等待Google完成停用':'删除未核实，需要人工处理';
        }else j.status=s.policy.fallbackDelete?'等待解除结算结果':'解除结算未核实，未授权删除项目';
      }catch(e){j.status='需要人工处理';j.error=String(e.message).slice(0,300);}
      yield checkpoint(s);
    }
    s.status=Object.values(s.jobs).length===s.policy.projects.length && Object.values(s.jobs).every(j=>['已核实停用','已核实解除结算'].includes(j.status))?'全部指定项目已核实停用':'停用处理中或需要人工处理';
    yield checkpoint(s);return s;
  }
  function summary(s){return {account:s.account || s.policy?.account,threshold:s.policy?.threshold ?? s.threshold ?? 30,currency:s.policy?.currency || '',projects:s.policy?.projects?.map(p=>({id:p.id,number:p.number})) || [],fallbackDelete:s.policy?.fallbackDelete ?? s.fallbackDelete ?? false,closeBillingAccount:s.policy?.closeBillingAccount ?? s.closeBillingAccount ?? false,closeBillingAccountConfigured:Object.prototype.hasOwnProperty.call(s.policy || {},'closeBillingAccount') || Object.prototype.hasOwnProperty.call(s,'closeBillingAccount'),projectComplete:s.projectComplete===true,enabled:!!s.enabled,armed:!!s.armed,fresh:!!s.fresh,balance:s.balance ?? null,sampledAt:s.sampledAt || null,lastCheckedAt:s.lastCheckedAt || null,checkedAt:s.checkedAt || null,status:s.status || '尚未检查',triggeredAt:s.triggeredAt || null,reason:s.reason || '',lastError:s.lastError || '',jobs:clone(s.jobs || {})};}
  return {validate,preflight,create,observe,stop,summary};
})();
