import {BalanceGuardCore as Core} from './balance-guard-core.js';
import {canonicalAccount,thresholdAmount} from './config-core.js';

export function installBalanceGuard({withConnection,request,captureBalance,billingClosure}){
  let running=false;
  const load=async()=> (await chrome.storage.local.get('balanceGuard')).balanceGuard || {accounts:{}};
  const save=async c=>chrome.storage.local.set({balanceGuard:c});
  function summary(s,closing=s.accountClose){
    const result={...Core.summary(s),accountClose:closing || null,completed:false};
    if(s.policy?.closeBillingAccount && s.triggeredAt){
      const closed=closing?.status==='verified-closed' && closing.accountOpen===false;
      result.completed=result.projectComplete && closed;
      result.status=result.completed?'项目与结算账号均已核实停用':(result.projectComplete?'指定项目已停用；':'项目停用尚未完成；')+(closed?'结算账号已核实关闭':closing?.status==='opening'||closing?.status==='executing'?'正在通过官方页面关闭结算账号':'结算账号关闭尚未核实');
    }
    return result;
  }
  async function drive(generator,conn,persist=async()=>{}){
    let result=generator.next();
    while(!result.done){const task=result.value;try{
      if(task.kind==='save'){await persist(task.state);result=generator.next();}
      else{if(!conn.accounts.some(a=>a.name===conn.guardAccount))throw Error('目标结算账号不属于当前连接');result=generator.next(await request(task.service,task.path,task.method,task.body));}
    }catch(e){result=generator.throw(e);}}
    return result.value;
  }
  async function official(account,currency){
    const p=(await chrome.storage.local.get('trialMonitor')).trialMonitor?.profiles?.[account];
    return p?{balance:p.balance,currency:p.currency,at:p.balanceUpdatedAt,verified:p.currency===currency && p.balanceObservation?.status!=='currency-unknown' && (p.balanceSource==='官方页面可见文本'||p.balanceSource?.startsWith('Google Cloud试用横幅'))}:null;
  }
  async function exclusive(fn){if(running)throw Error('余额保护正在检查或处理，请稍后再试');running=true;try{return await withConnection(fn);}finally{running=false;}}
  async function process(account,conn,readOnly=false){
    const c=await load(),original=c.accounts[account];if(!original?.policy)throw Error('请先保存最低余额并执行只读检查');
    if(original.policy.authUser!==String(conn.authUser))throw Error('Google账号索引已变化，请切回原账号');
    const s=readOnly?structuredClone(original):original;
    if(readOnly){s.armed=false;s.enabled=false;}
    const context={...conn,guardAccount:account},persist=async state=>{if(!readOnly){c.accounts[account]=state;await save(c);}};
    if(!s.triggeredAt){
      try{await captureBalance(account,conn);}catch(e){s.lastError=e.message;}
      Core.observe(s,await official(account,s.policy.currency),Date.now());await persist(s);
    }
    if(!readOnly && s.armed && s.triggeredAt){
      await drive(Core.stop(s,Date.now()),context,persist);
      if(s.policy.closeBillingAccount){
        try{if(!billingClosure)throw Error('当前后台不支持联合关闭，请重新加载扩展');s.accountClose=await billingClosure.run(account,conn);}
        catch(e){s.accountClose={status:'failed',accountOpen:null,error:e.message,canRetry:false};}
        s.status=summary(s).status;
        const shouldAlert=!!s.accountClose?.error || !s.projectComplete && Date.now()-s.triggeredAt>180000;
        const alert=shouldAlert?s.status+'；'+(s.accountClose?.error || '指定项目仍有未核实的停用项'):'';
        if(alert && alert!==s.lastNotice){s.lastNotice=alert;try{await chrome.notifications?.create?.('aikey-combined-'+account.split('/')[1],{type:'basic',iconUrl:'icons/icon128.png',title:'AIkey联合停用未全部完成',message:alert.slice(0,220)});}catch{}}
        c.accounts[account]=s;await save(c);
      }
    }
    return summary(s);
  }
  async function tick(){
    const c=await load();if(!Object.values(c.accounts).some(s=>s.enabled && s.armed))return;
    try{await exclusive(async conn=>{for(const [account,s] of Object.entries(c.accounts)){
      if(!s.enabled || !s.armed || !conn.accounts.some(a=>a.name===account) || s.policy?.authUser!==String(conn.authUser))continue;
      try{await process(account,conn);}catch(e){const latest=await load();if(latest.accounts[account]){latest.accounts[account].lastError=e.message;latest.accounts[account].status='余额保护未完成：'+e.message;await save(latest);}}
    }});}catch(e){const latest=await load();for(const s of Object.values(latest.accounts))if(s.enabled){s.lastError=e.message;s.status='无法检查余额：'+e.message;}await save(latest);}
  }
  chrome.alarms?.create('aikey-balance-guard',{periodInMinutes:.5});
  chrome.alarms?.onAlarm.addListener(a=>{if(a.name==='aikey-balance-guard')void tick().catch(()=>{});});
  return {tick,async handle(m){
    if(m.type==='BALANCE_GUARD_READ'){
      const entries=[];for(const [k,s]of Object.entries((await load()).accounts))entries.push([k,summary(s,s.policy?.closeBillingAccount && billingClosure?await billingClosure.read(k,s.authorizationId) || s.accountClose:s.accountClose)]);
      return Object.fromEntries(entries);
    }
    if(m.type==='BALANCE_GUARD_SAVE'){
      if(running)throw Error('检查或处理期间不能修改最低余额');const name=canonicalAccount(m.account),threshold=thresholdAmount(m.threshold),c=await load(),old=c.accounts[name];
      if(old?.armed || old?.triggeredAt)throw Error('已有授权或已触发任务，请先暂停并核实，不能通过保存清除任务记录');
      c.accounts[name]={account:name,threshold,fallbackDelete:m.fallbackDelete===true,closeBillingAccount:m.closeBillingAccount===true,policy:null,enabled:false,armed:false,jobs:{},events:[],savedAt:Date.now(),status:'最低余额已保存，尚未启用保护'};c.active=name;await save(c);return summary(c.accounts[name]);
    }
    if(m.type==='BALANCE_GUARD_CHECK')return exclusive(async conn=>{
      const account=canonicalAccount(m.account),threshold=thresholdAmount(m.threshold),c=await load();
      if(c.accounts[account]?.armed || c.accounts[account]?.triggeredAt)throw Error('已有授权或已触发任务，不能通过只读检查清除任务记录');
      if(!conn.accounts.some(a=>a.name===account))throw Error('请连接并选择目标结算账号');
      const metadata=await request('cloudbilling','v1/'+account),projects=[];let token='',seen=new Set();
      for(let i=0;i<20;i++){
        const d=await request('cloudbilling','v1/'+account+'/projects'+(token?'?pageToken='+encodeURIComponent(token):''));
        projects.push(...(d.projectBillingInfo || []).filter(p=>p.billingEnabled===true).map(p=>p.projectId));token=d.nextPageToken || '';if(!token)break;if(seen.has(token))throw Error('项目分页异常');seen.add(token);
      }if(token)throw Error('项目列表未读取完整');
      if(m.closeBillingAccount===true && !billingClosure)throw Error('当前后台不支持结算账号联合关闭，请先重新加载整个扩展');
      const policy=await drive(Core.preflight({account,currency:metadata.currencyCode,projects,threshold,authUser:conn.authUser,fallbackDelete:m.fallbackDelete===true,closeBillingAccount:m.closeBillingAccount===true}),{...conn,guardAccount:account});
      await captureBalance(account,conn,metadata);
      const s=Core.create(policy,Date.now());Core.observe(s,await official(account,policy.currency),Date.now());s.checkId=crypto.randomUUID();
      c.accounts[account]=s;c.active=account;await save(c);return {...summary(s),checkId:s.checkId};
    });
    if(m.type==='BALANCE_GUARD_TEST')return exclusive(conn=>process(canonicalAccount(m.account),conn,true));
    if(m.type==='BALANCE_GUARD_ENABLE')return exclusive(async conn=>{
      const account=canonicalAccount(m.account),c=await load(),s=c.accounts[account];
      if(!s?.policy || s.armed || s.triggeredAt || s.checkId!==m.checkId || Date.now()-s.checkedAt>300000)throw Error('只读检查已失效，请重新检查');
      if(m.confirmAccount!==account.split('/')[1] || m.confirmScope!==true)throw Error('请填写完整结算账号ID并确认停用范围');
      if(s.policy.closeBillingAccount && (!billingClosure || m.confirmCloseAccount!==true))throw Error('联合停用还需要明确授权关闭整个结算账号，不能复用只停项目的授权');
      if(s.policy.authUser!==String(conn.authUser)||!conn.accounts.some(a=>a.name===account))throw Error('Google账号已变化');
      const snapshot=await official(account,s.policy.currency);Core.observe(s,snapshot,Date.now());if(!s.fresh)throw Error('余额快照不是最近5分钟内的新鲜官方数据，请先刷新余额页');
      const checked=await drive(Core.preflight(s.policy),{...conn,guardAccount:account});
      if(JSON.stringify(checked.projects)!==JSON.stringify(s.policy.projects))throw Error('关联项目身份已变化，请重新检查');
      s.armed=true;s.enabled=true;s.authorizedAt=Date.now();s.authorizationId=crypto.randomUUID();await save(c);return process(account,conn);
    });
    if(m.type==='BALANCE_GUARD_PAUSE'){
      if(running)throw Error('当前检查或处理尚未结束；暂停无法撤回已经提交的请求');
      const c=await load(),s=c.accounts[canonicalAccount(m.account)];if(!s)throw Error('此账号尚未设置余额保护');s.enabled=false;s.armed=false;s.status='余额保护已暂停；已提交的官方操作无法撤回';await save(c);return summary(s);
    }
    if(m.type==='BALANCE_GUARD_RETRY_CLOSE')return exclusive(async conn=>{
      const account=canonicalAccount(m.account),c=await load(),s=c.accounts[account];
      if(!s?.policy?.closeBillingAccount || !s.enabled || !s.armed || !s.triggeredAt || m.confirmAccount!==account.split('/')[1] || m.confirmCloseAccount!==true || !billingClosure)throw Error('只可重试当前已授权且已触发的整个结算账号关闭任务');
      s.accountClose=await billingClosure.run(account,conn,{retry:true});await save(c);return summary(s);
    });
    throw Error('未知余额保护操作');
  }};
}
