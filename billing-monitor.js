import {ACCOUNT_RE,billingRoute,billingPageUrl,validAmount,due,monitorDisplay,amountLevel} from './monitor-core.js';

export function installBillingMonitor({request,isBusy,getConnection=()=>null,ensureConnection=async()=>getConnection(),waitUntilReady=async()=>{}}) {
  const storage=chrome.storage.local;
  let lock=Promise.resolve(),alarmError='',lastBannerError='';
  const projectAccounts=new Map(),pageAgents=new Map(),accountCurrencies=new Map();let cacheConnection=null;
  async function ensureAlarm(){
    if(!chrome.alarms?.create){alarmError='浏览器未提供定时任务接口';return;}
    try{await chrome.alarms.create('aikey-trial-tick',{periodInMinutes:.5});alarmError='';}
    catch(e){alarmError='无法注册定时任务：'+e.message;}
  }
  const transact=fn=>{const p=lock.then(fn);lock=p.catch(()=>{});return p;};
  const read=async()=> (await storage.get('trialMonitor')).trialMonitor || {profiles:{},active:'',upgradeGuard:true};
  const write=async config=>{await storage.set({trialMonitor:config});};
  async function prepare(account,connection,metadata){
    if(!ACCOUNT_RE.test(account || '') || !connection?.accounts?.some(a=>a.name.toUpperCase()===account.toUpperCase()))throw new Error('请先连接并选择目标结算账号');
    const name='billingAccounts/'+account.split('/')[1].toUpperCase();
    const data=metadata || await request('cloudbilling','v1/'+name);
    if(data.name?.toUpperCase()!==name.toUpperCase() || !/^[A-Z]{3}$/.test(data.currencyCode || ''))throw new Error('未核实当前结算账号的币种，未采用默认美元');
    const known=connection.accounts.find(a=>a.name.toUpperCase()===name.toUpperCase());known.currencyCode=data.currencyCode;
    accountCurrencies.set(name,data.currencyCode);
    await transact(async()=>{
      const c=await read(),p=c.profiles[name] ||= {name,balance:null,balanceSource:'尚未采集',balanceUpdatedAt:null,deadline:null,armed:false,job:null,autoRefresh:true,createdAt:Date.now(),authUser:String(connection.authUser)};
      if(p.authUser!==undefined && String(p.authUser)!==String(connection.authUser))throw new Error('监控设置属于其他Google账号索引，未更改');
      if(p.currency && p.currency!==data.currencyCode && validAmount(p.balance)){
        p.balanceObservation={amount:p.balance,currency:p.currency,at:Date.now(),status:'currency-unknown'};
        p.balance=null;p.balanceUpdatedAt=null;p.balanceSource='尚未采集';
        p.syncError='旧金额币种与Google账号不一致，已停止采用旧金额，等待重新采集；没有自动换算';
      }
      p.currency=data.currencyCode;p.currencyVerifiedAt=Date.now();p.displayName=data.displayName || p.displayName || name;
      if(!validAmount(p.balance)){p.balance=null;p.balanceUpdatedAt=null;p.balanceSource='尚未采集';}
      p.authUser=String(connection.authUser);c.active=name;await write(c);
    });
    return name;
  }
  async function capture(account,connection,metadata){
    const name=await prepare(account,connection,metadata);
    if(collecting.has(name))return {captured:false,pending:true,account:name,reason:'正在读取目标账号页面，请稍候'};
    collecting.add(name);
    try{
    const c=await read(),p=c.profiles[name],candidates=[],seen=new Set();
    const add=tab=>{if(tab?.id!==undefined && !seen.has(tab.id)){seen.add(tab.id);candidates.push(tab);}};
    for(const id of [p.overviewTabId,p.manageTabId,p.bannerTabId,connection.tabId])if(Number.isInteger(id) && chrome.tabs?.get)add(await chrome.tabs.get(id).catch(()=>null));
    if(chrome.tabs?.query)for(const tab of await chrome.tabs.query({url:'https://console.cloud.google.com/*'}))add(tab);
    let error='',eligible=0;
    for(const tab of candidates.slice(0,20)){
      try{
        const u=new URL(tab.url);if(u.origin!=='https://console.cloud.google.com')continue;
        const auth=u.searchParams.get('authuser') || u.pathname.match(/\/u\/(\d+)\//)?.[1] || '0';
        if(auth!==String(connection.authUser))continue;
        const route=billingRoute(tab.url),project=u.searchParams.get('project');
        if(['overview','manage'].includes(route?.page)){
          if(route.account && route.account!==name)continue;
        }else{
          if(route || !/^(?:[a-z][a-z0-9-]{4,28}[a-z0-9]|[0-9]{5,30})$/.test(project || ''))continue;
          const binding=await request('cloudbilling',`v1/projects/${project}/billingInfo`);
          if(binding.billingAccountName?.toUpperCase()!==name.toUpperCase())continue;
        }
        if(p.job && ['opening','executing'].includes(p.job.status) && p.job.tabId===tab.id)continue;
        eligible++;
        if(!chrome.scripting?.executeScript)throw new Error('浏览器未提供页面采集接口');
        const job={name,tabId:tab.id,url:tab.url,overview:route?.page==='overview',manage:route?.page==='manage'};
        await collectJob(job);
        await transact(async()=>{const current=await read(),profile=current.profiles[name];profile.refreshState=job.overview?'updated':job.manage?'manage-read':'project-only';profile.lastProbeFinishedAt=Date.now();await write(current);});
        return {captured:true,account:name};
      }catch(e){error=e.message;}
    }
    await transact(async()=>{const current=await read(),profile=current.profiles[name];
      profile.refreshState=eligible?'failed':'no-page';profile.lastRefreshCheckAt=Date.now();
      profile.syncError=error || '没有找到已打开且属于这个结算账号的采集页。请点“打开官方概览并同步”，在Google页面选择此账号后保持页面打开，再点自动读取。';
      await write(current);
    });
    return {captured:false,account:name,reason:error || '未找到目标账号的可采集页面'};
    }finally{collecting.delete(name);}
  }
  function sourceAccount(sender,message) {
    if(sender.id!==chrome.runtime.id || !sender.tab || sender.frameId!==0) throw new Error('拒绝非顶层结算页面');
    const route=billingRoute(sender.url);
    if(!route) throw new Error('拒绝无效结算页面');
    if(!route.account && ACCOUNT_RE.test(message?.account || ''))route.account='billingAccounts/'+message.account.split('/')[1].toUpperCase();
    return route;
  }
  async function notify(id,message) {
    try {await chrome.notifications.create('aikey-'+id,{type:'basic',iconUrl:'icons/icon128.png',title:'AIkey 试用监控',message});} catch {}
  }
  async function badge(config) {
    const p=config.profiles[config.active];
    let view=monitorDisplay(p,Date.now(),!!config.badgePhase);
    const guardConfig=(await storage.get('balanceGuard')).balanceGuard,g=guardConfig?.accounts?.[config.active];
    if(g?.enabled){
      const threshold=g.policy?.threshold ?? g.threshold ?? 30,balance=g.balance,stale=!g.sampledAt || Date.now()-g.sampledAt>300000;
      const stopped=g.status==='项目与结算账号均已核实停用' || !g.policy?.closeBillingAccount && g.status==='全部指定项目已核实停用',band=amountLevel(balance,threshold),colors={normal:'#36d998',pale:'#fff0b3',yellow:'#ffcf36',red:'#e45757',stop:'#e45757',unknown:'#63758b'};
      view={...view,text:stopped?'OFF':g.triggeredAt || stale?'!':config.badgePhase && validAmount(balance)?String(Math.round(balance)):view.text,color:stopped?'#63758b':stale || g.triggeredAt?'#e45757':colors[band],title:'AIkey 余额保护 · '+config.active+'\n最低余额：'+threshold+' '+(g.policy?.currency || '')+'\n最近核对余额：'+(validAmount(balance)?balance:'未知')+'\n'+g.status+'\n'+(stale?'余额页面快照超过5分钟，无法判断阈值':'保护已授权，按Google页面快照检查')};
    }
    if(!g?.enabled || !g?.armed){
      const minimum=g?.policy?.threshold ?? g?.threshold ?? 30;
      const low=validAmount(p?.balance) && p.balance<=minimum;
      view={...view,title:view.title+'\n余额停用：未启用（日期关闭不能代替余额停用）\n最低余额：'+minimum+' '+(p?.currency || '')};
      if(low)view={...view,text:config.badgePhase?'!':String(Math.round(p.balance)),color:'#e45757'};
    }
    config.badgePhase=!config.badgePhase;
    await write(config);
    await chrome.action.setBadgeText({text:view.text});
    await chrome.action.setBadgeBackgroundColor({color:view.color});
    await chrome.action.setTitle({title:view.title});
    if(typeof OffscreenCanvas!=='undefined') {
      const canvas=new OffscreenCanvas(64,64),ctx=canvas.getContext('2d');
      ctx.fillStyle='#0c2235';ctx.fillRect(0,0,64,64);
      ctx.lineWidth=6;ctx.strokeStyle='#355065';ctx.beginPath();ctx.arc(32,32,27,0,Math.PI*2);ctx.stroke();
      ctx.strokeStyle=view.color;ctx.beginPath();ctx.arc(32,32,27,-Math.PI/2,-Math.PI/2+Math.PI*2*Math.max(.03,view.ratio));ctx.stroke();
      ctx.fillStyle='#f1fbff';ctx.font='bold 23px sans-serif';ctx.textAlign='center';ctx.textBaseline='middle';ctx.fillText('AI',32,31);
      await chrome.action.setIcon({imageData:ctx.getImageData(0,0,64,64)});
    }
  }
  async function tick() {
    await waitUntilReady();
    await transact(async()=>{
      const config=await read();config.lastTickAt=Date.now();
      for(const p of Object.values(config.profiles)) {
        if(!due(p) || p.job) continue;
        // Persist before opening a page: an interrupted browser must not replay the destructive action.
        p.job={status:'opening',createdAt:Date.now(),token:crypto.randomUUID()};await write(config);
        await notify(p.name,'试用截止时间已到。正在打开官方账号管理页辅助关闭；如出现账号选择页，请选择此账号。请检查最终结果。');
        try {
          const tab=await chrome.tabs.create({url:billingPageUrl('manage',p.authUser || '0'),active:false});
          p.job.tabId=tab.id;await write(config);
        } catch(e) {p.job.status='failed';p.job.error='无法打开关闭页面：'+e.message;await write(config);}
      }
      // Timeout never silently retries a close operation.
      for(const p of Object.values(config.profiles)) if(p.job && ['opening','executing'].includes(p.job.status) && Date.now()-p.job.createdAt>180000) {
        p.job.status='failed';p.job.error='页面辅助关闭超时，可能未完成。请在官方账号管理页核实。';await notify(p.name,p.job.error);
      }
      await write(config);await badge(config);
    });
    await refreshBalances();
  }
  const collecting=new Set();
  const deadline=async promise=>{
    let timer;
    try{return await Promise.race([promise,new Promise((_,reject)=>{timer=setTimeout(()=>reject(new Error('后台采集超时，页面可能被冻结或已退出登录')),8000);})]);}
    finally{clearTimeout(timer);}
  };
  async function collectJob(job){
    await deadline(chrome.scripting.executeScript({target:{tabId:job.tabId},world:'ISOLATED',files:['trial-parser.js','trial-collector.js']}));
    const [result]=await deadline(chrome.scripting.executeScript({target:{tabId:job.tabId},world:'ISOLATED',func:()=>globalThis.AIkeyTrialCollector.collect()}));
    const sample=result?.result;
    if(result?.frameId!==undefined && result.frameId!==0)throw new Error('拒绝非顶层采集结果');
    if(!sample || sample.error)throw new Error(sample?.error || '页面未返回采集结果');
    const tab=await chrome.tabs.get(job.tabId);
    if(tab.url!==job.url || sample.url!==job.url)throw new Error('采集过程中页面已切换，未采用结果');
    if((job.overview || job.manage) && sample.account!==job.name)throw new Error(job.overview?'未唯一核实概览账号，请在Google概览页选择目标账号':'未唯一核实账号管理页账号，请在Google页面选择目标账号');
    const response=await content({type:'MONITOR_BANNER',expectedAccount:job.name,account:sample.account,pageStartedAt:sample.pageStartedAt,...sample.observation},{id:chrome.runtime.id,tab:{id:job.tabId},frameId:0,url:sample.url});
    if(!response.accepted || response.account!==job.name || !response.balanceAccepted)throw new Error(response.reason || '未采集到这个账号的有效金额，请检查登录、币种或页面提示');
    return response;
  }
  async function ensureRefreshOverview(p,manual=false){
    // Refresh a separate overview, never the user's interactive management page.
    if(p.overviewTabId || !manual && p.autoRefresh===false || p.job && ['opening','executing'].includes(p.job.status))return;
    const conn=getConnection();
    if(!conn || String(conn.authUser)!==String(p.authUser || '0') || !conn.accounts?.some(a=>a.name===p.name))return;
    if(!manual && p.lastOverviewOpenAttemptAt && Date.now()-p.lastOverviewOpenAttemptAt<60000)return;
    p.lastOverviewOpenAttemptAt=Date.now();
    const auth=String(p.authUser || '0');
    if(!ACCOUNT_RE.test(p.name) || !/^\d{1,3}$/.test(auth))throw Error('账号或登录索引无效，未打开刷新页');
    const tabs=chrome.tabs.query?await chrome.tabs.query({url:'https://console.cloud.google.com/billing/*'}):[];
    const reusable=tabs.find(t=>{
      const route=billingRoute(t.url);return route?.account===p.name && route.page==='overview' && (new URL(t.url).searchParams.get('authuser') || '0')===auth;
    });
    if(reusable){p.overviewTabId=reusable.id;p.overviewRefreshError='';return;}
    const url='https://console.cloud.google.com/billing/'+p.name.split('/')[1]+'?authuser='+encodeURIComponent(auth);
    const tab=await chrome.tabs.create({url,active:false});
    if(!Number.isInteger(tab?.id))throw Error('无法建立余额刷新页');
    p.overviewTabId=tab.id;p.autoOverviewTabId=tab.id;
    p.lastRefreshAt=Date.now();p.refreshPendingAt=Date.now();p.refreshState='loading';p.overviewRefreshError='';
  }
  async function refreshBalances(onlyAccount='',force=false){
    const jobs=[];let planned=false;
    try{await transact(async()=>{
      const c=await read();
      for(const p of Object.values(c.profiles)){
        if(onlyAccount && p.name!==onlyAccount || collecting.has(p.name))continue;
        if(!force && p.autoRefresh===false)continue;
        p.lastRefreshCheckAt=Date.now();
        const id=p.overviewTabId || p.manageTabId || p.bannerTabId;
        if(!id){p.refreshState='no-page';p.syncError='没有已识别的采集页，请打开官方概览并选择这个账号';continue;}
        try{
          const tab=await chrome.tabs.get(id),route=billingRoute(tab.url),u=new URL(tab.url);
          if(u.origin!=='https://console.cloud.google.com')throw new Error('已记录的采集标签页已切换，请重新打开概览并同步');
          const auth=u.searchParams.get('authuser') || u.pathname.match(/\/u\/(\d+)\//)?.[1] || '0';
          if(auth!==String(p.authUser || '0'))throw new Error('采集页Google账号索引已改变');
          const overview=route?.page==='overview',manage=route?.page==='manage',billingPage=overview || manage;
          if(p.overviewTabId===id && !billingPage)throw new Error('已记录的概览标签页已切换，请重新打开概览并同步');
          if(p.manageTabId===id && !billingPage)throw new Error('已记录的账号管理标签页已切换，请重新读取余额');
          if(u.pathname.startsWith('/billing') && !billingPage)throw new Error('已记录的结算标签页已切换，请重新读取余额');
          if(route && !billingPage || billingPage && route.account && route.account!==p.name)throw new Error('已记录的结算标签页已切换，请重新读取余额');
          if(p.job && ['opening','executing'].includes(p.job.status) && p.job.tabId===id){p.refreshState='closing';continue;}
          if(!force && !p.overviewTabId && (manage || p.bannerTabId===id)){
            try{await ensureRefreshOverview(p);}catch(e){p.overviewRefreshError=e.message;throw e;}
            if(p.overviewTabId){p.refreshState=p.refreshPendingAt?'loading':'sampling';continue;}
          }
          if(overview){
            p.overviewTabId=id;
            if(force && (!p.refreshPendingAt || Date.now()-p.refreshPendingAt>=45000) || !p.refreshPendingAt && Date.now()-(p.lastRefreshAt || 0)>=60000){
              await chrome.tabs.reload(id);p.lastRefreshAt=Date.now();p.refreshPendingAt=Date.now();p.refreshState='loading';continue;
            }
            if(tab.status==='loading' && Date.now()-(p.refreshPendingAt || Date.now())<45000){p.refreshState='loading';continue;}
          }else if(!manage && !/^(?:[a-z][a-z0-9-]{4,28}[a-z0-9]|[0-9]{5,30})$/.test(u.searchParams.get('project') || ''))throw new Error('已记录页面没有明确项目ID');
          if(!force && Date.now()-(p.lastProbeAt || 0)<30000)continue;
          if(!chrome.scripting?.executeScript){p.refreshState='failed';p.syncError='浏览器未提供后台采集接口';continue;}
          p.lastProbeAt=Date.now();p.refreshState='sampling';collecting.add(p.name);jobs.push({name:p.name,tabId:id,url:tab.url,overview,manage});
        }catch(e){
          if(p.overviewTabId===id){delete p.overviewTabId;if(p.autoOverviewTabId===id)delete p.autoOverviewTabId;p.refreshPendingAt=null;}
          p.refreshState='failed';p.syncError=e.message;
        }
      }
      await write(c);
    });planned=true;}finally{if(!planned)for(const job of jobs)collecting.delete(job.name);}
    await Promise.allSettled(jobs.map(async job=>{
      let error='',state='failed';
      try{
        await collectJob(job);
        state=job.overview?'updated':job.manage?'manage-read':'project-only';
      }catch(e){error=e.message;}
      finally{
        try{await transact(async()=>{
          const c=await read(),p=c.profiles[job.name];if(p){p.refreshState=state;p.lastProbeFinishedAt=Date.now();if(error)p.syncError=error;else if(state==='project-only')p.syncError='当前仅采集项目页横幅；要持续请求新页面，请打开官方概览并选择此账号';if(job.overview)p.refreshPendingAt=null;await write(c);}
        });}finally{collecting.delete(job.name);}
      }
    }));
  }
  function recordBalance(p,message,currency,source,sender,route){
    const now=Date.now(),started=Number.isFinite(message.pageStartedAt)&&message.pageStartedAt>0&&message.pageStartedAt<=now+60000?Math.floor(message.pageStartedAt):0;
    p.lastDomReadAt=now;
    // A stale management tab must not overwrite a newer refreshed overview snapshot.
    if(p.balancePageStartedAt && (started && started<p.balancePageStartedAt || !started && sender.tab.id!==p.balanceSourceTabId)){
      p.lastIgnoredBalanceReason='已忽略较旧页面的余额；继续采用较新页面快照';return false;
    }
    const changed=p.balance!==message.balance || p.currency!==currency || p.balanceSource==='手动记录';
    const newerPage=started>(p.balancePageStartedAt || p.balanceUpdatedAt || 0);
    p.balance=message.balance;p.currency=currency;p.balanceSource=source;p.lastBalanceReadAt=now;p.balanceSourceTabId=sender.tab.id;
    if(changed)p.balanceValueChangedAt=now;
    if(changed || !p.balanceUpdatedAt)p.balanceUpdatedAt=now;
    else if(newerPage)p.balanceUpdatedAt=Math.max(p.balanceUpdatedAt || 0,started);
    if(started)p.balancePageStartedAt=Math.max(started,p.balancePageStartedAt || 0);
    p.balanceObservation=null;p.syncError='';
    if(route?.page==='overview'){
      if(!p.autoOverviewTabId || p.autoOverviewTabId===sender.tab.id)p.overviewTabId=sender.tab.id;
      if(p.manageTabId===sender.tab.id)delete p.manageTabId;
      if(!p.refreshPendingAt || started>=p.refreshPendingAt-2000){p.refreshPendingAt=null;p.refreshState='updated';}
    }else if(route?.page==='manage'){
      p.manageTabId=sender.tab.id;p.refreshState='manage-read';
      if(p.overviewTabId===sender.tab.id)delete p.overviewTabId;
    }
    p.lastIgnoredBalanceReason='';return true;
  }
  chrome.alarms?.onAlarm.addListener(alarm=>{if(alarm.name==='aikey-trial-tick')tick().catch(console.error);});
  chrome.runtime.onStartup?.addListener(()=>tick().catch(console.error));
  ensureAlarm().catch(console.error);
  async function dashboard(message,connection) {
    if(message.type==='MONITOR_AUTO_BALANCE'){
      const conn=connection || getConnection() || await ensureConnection();
      const result=await capture(message.account,conn);return {...await read(),captureResult:result};
    }
    if(message.type==='MONITOR_REFRESH_NOW'){
      if(!(await read()).profiles[message.account])throw new Error('请先保存这个账号的监控设置');
      if(message.freshPage===true){
        const conn=connection || getConnection() || await ensureConnection();
        const name=await prepare(message.account,conn);
        await transact(async()=>{const c=await read();await ensureRefreshOverview(c.profiles[name],true);await write(c);});
      }
      await refreshBalances(message.account,true);return read();
    }
    if(message.type==='MONITOR_READ'){
      const conn=connection || getConnection(),auth=String(conn?.authUser || '0');
      const currencies=Object.fromEntries((conn?.accounts || []).filter(a=>/^[A-Z]{3}$/.test(a.currencyCode || '')).map(a=>[a.name,a.currencyCode]));
      const guards=(await storage.get('balanceGuard')).balanceGuard;
      const minimums=Object.fromEntries(Object.entries(guards?.accounts || {}).map(([a,s])=>[a,s.policy?.threshold ?? s.threshold ?? 30]));
      return {...await read(),minimums,accountCurrencies:currencies,lastBannerError,pageAgent:[...pageAgents.values()].filter(p=>p.authUser===auth).sort((a,b)=>b.lastSeen-a.lastSeen)[0] || null};
    }
    if(message.type==='MONITOR_DIAGNOSE'){
      const config=await read(),p=config.profiles[message.account];
      let alarm=null;
      try{alarm=await chrome.alarms?.get?.('aikey-trial-tick') || null;}catch(e){alarmError=e.message;}
      return {now:Date.now(),saved:!!p,armed:!!p?.armed,deadline:p?.deadline ?? null,savedAt:p?.savedAt || null,
        due:due(p),job:p?.job || null,lastTickAt:config.lastTickAt || null,alarmScheduledAt:alarm?.scheduledTime || null,alarmError,
        lastBannerError,connected:!!connection?.accounts.some(a=>a.name.toUpperCase()===message.account?.toUpperCase())};
    }
    if(message.type==='MONITOR_OPEN'){
      const config=await read(),name=message.account;
      if(!ACCOUNT_RE.test(name || ''))throw new Error('请先选择有效结算账号');
      const current=connection?.accounts.find(a=>a.name.toUpperCase()===name.toUpperCase());
      const profile=config.profiles[name];
      if(!current && !profile)throw new Error('请先连接目标Google账号并选择结算账号，再打开官方页面');
      const pages={overview:'overview',manage:'manage',paymentoverview:'paymentoverview'};
      if(!Object.hasOwn(pages,message.page))throw new Error('不支持的官方页面');
      const authUser=current?connection.authUser:(profile.authUser || '0');
      const url=billingPageUrl(message.page,authUser);
      try{const tab=await chrome.tabs.create({url,active:true});return {url,tabId:tab.id,authUser,account:name};}
      catch(e){throw new Error(`无法打开官方页面：${e.message}。可复制此链接到浏览器：${url}`);}
    }
    if(message.type==='MONITOR_RETRY_CLOSE'){
      await transact(async()=>{
        const config=await read(),p=config.profiles[message.account];
        if(isBusy() || !p?.armed || p.job?.status!=='failed' || !due(p))throw new Error('仅能重试已授权、已到期且失败的关闭任务');
        if(!connection?.accounts.some(a=>a.name.toUpperCase()===p.name.toUpperCase()))throw new Error('请先连接目标Google结算账号');
        const data=await request('cloudbilling','v1/'+p.name);
        if(data.name?.toUpperCase()!==p.name.toUpperCase() || typeof data.open!=='boolean')throw new Error('无法核实当前结算账号状态');
        if(!data.open){p.armed=false;p.accountOpen=false;p.job.status='verified-closed';}
        else p.job=null;
        await write(config);
      });
      await tick();return read();
    }
    return transact(async()=>{
      const config=await read();
      if(message.type==='MONITOR_SAVE') {
        await ensureAlarm();
        if(message.arm && alarmError)throw new Error(alarmError+'；未保存到期关闭授权');
        const name=message.account;
        if(!ACCOUNT_RE.test(name) || !connection?.accounts.some(a=>a.name.toUpperCase()===name.toUpperCase())) throw new Error('请先连接并选择你有权限的结算账号');
        if(message.arm && connection.accounts.find(a=>a.name.toUpperCase()===name.toUpperCase())?.open===false)throw new Error('此结算账号已关闭，无需再次启用关闭任务；可继续核对付款或退款。');
        const deadline=message.deadline===null?null:Number(message.deadline);
        if(deadline!==null && (!Number.isFinite(deadline)||deadline<Date.now()-86400000||deadline>Date.now()+366*86400000)) throw new Error('截止时间不合法');
        if(message.balance!==null && !validAmount(message.balance)) throw new Error('赠金余额不合法');
        if(!/^[A-Z]{3}$/.test(message.currency)) throw new Error('币种请填写三位代码，例如 USD');
        const knownCurrency=connection.accounts.find(a=>a.name.toUpperCase()===name.toUpperCase())?.currencyCode || accountCurrencies.get(name);
        if(/^[A-Z]{3}$/.test(knownCurrency || '') && message.balance!==null && message.currency!==knownCurrency)throw new Error('输入币种与Google账号实际币种不一致，请先自动读取余额；未换算或采用该金额');
        const currency=/^[A-Z]{3}$/.test(knownCurrency || '')?knownCurrency:message.currency;
        const old=config.profiles[name];
        if(old?.armed && old.job && ['opening','executing'].includes(old.job.status)) throw new Error('关闭操作进行中，不能修改配置');
        if(message.arm && deadline!==null && deadline<=Date.now())throw new Error('填写的截止时间已经过去，未保存关闭授权。可先检查任务和官方账号状态；如需真实测试，请设置将来的时间并重新保存授权。');
        if(message.arm && (deadline===null || deadline<=Date.now() || message.confirmAccount!==name.split('/')[1] || message.confirmScope!==true)) throw new Error('启用整个账号到期关闭前，请填写将来的准确截止时间、完整账号 ID 并确认影响所有项目');
        config.profiles[name]={...old,name,displayName:connection.accounts.find(a=>a.name.toUpperCase()===name.toUpperCase())?.displayName || name,
          balance:message.balance,currency,balanceSource:message.balance===null?'尚未采集':'手动记录',balanceUpdatedAt:message.balance===null?null:Date.now(),
          autoRefresh:message.autoRefresh!==false,deadline,deadlineSource:'用户确认',savedAt:Date.now(),armed:message.arm===true,authUser:connection.authUser,job:old?.deadline===deadline?old.job:null};
        if(message.balanceEdited===true){Object.assign(config.profiles[name],{balanceObservation:null,syncError:'',lastBalanceReadAt:null,balanceSourceTabId:null,balancePageStartedAt:null,balanceValueChangedAt:Date.now()});}
        if(old && message.balanceEdited===false && old.currency===currency){for(const key of ['balance','currency','balanceSource','balanceUpdatedAt'])config.profiles[name][key]=old[key];}
        config.active=name;config.upgradeGuard=message.upgradeGuard!==false;
        await write(config);await badge(config);return config;
      }
      if(message.type==='MONITOR_DISARM') {
        const p=config.profiles[message.account];if(!p)throw new Error('未找到监控账号');
        if(p.job?.status==='executing')throw new Error('页面正在提交关闭操作，请到官方页面核实；此时取消不能撤回已提交操作');
        p.armed=false;await write(config);await badge(config);return config;
      }
      if(message.type==='MONITOR_CHECK_ACCOUNT') {
        const p=config.profiles[message.account];
        if(!p || !connection)throw new Error('请连接目标 Google 账号后核实');
        const data=await request('cloudbilling','v1/'+p.name);
        if(data.name?.toUpperCase()!==p.name.toUpperCase() || typeof data.open!=='boolean') throw new Error('账号状态响应异常');
        p.accountOpen=data.open;p.accountCheckedAt=Date.now();
        if(!data.open) {p.armed=false;p.job={...p.job,status:'verified-closed'};}
        await write(config);return config;
      }
      throw new Error('不支持的监控操作');
    });
  }
  async function content(message,sender) {
    if(message.type==='MONITOR_HEARTBEAT'){
      if(sender.id!==chrome.runtime.id || !sender.tab || sender.frameId!==0)throw new Error('拒绝无效页面心跳');
      const url=new URL(sender.url);if(url.origin!=='https://console.cloud.google.com')throw new Error('拒绝无效页面域名');
      const authUser=url.searchParams.get('authuser') || url.pathname.match(/\/u\/(\d+)\//)?.[1] || '0';
      if(pageAgents.size>50)pageAgents.clear();pageAgents.set(sender.tab.id,{tabId:sender.tab.id,lastSeen:Date.now(),version:['2.4.0','2.4.1','2.4.2','2.4.3','2.4.4','2.5.0','2.5.1','2.5.2','2.5.3','2.5.4','2.5.5','2.5.6','2.5.7','2.5.8'].includes(message.version)?message.version:'未知版本',authUser});
      return {accepted:true};
    }
    if(message.type==='UPGRADE_GUARD_READ') {
      if(sender.id!==chrome.runtime.id || !sender.tab || sender.frameId!==0 || new URL(sender.url).origin!=='https://console.cloud.google.com')throw new Error('无效页面');
      return {enabled:(await read()).upgradeGuard};
    }
    if(message.type==='MONITOR_BANNER'){
      try{
        if(sender.id!==chrome.runtime.id || !sender.tab || sender.frameId!==0)throw new Error('拒绝无效横幅来源');
        const url=new URL(sender.url);if(url.origin!=='https://console.cloud.google.com')throw new Error('拒绝无效横幅域名');
        const connection=getConnection() || await ensureConnection(sender);
        if(!connection)throw new Error('读取项目横幅需要先连接目标Google账号');
        if(cacheConnection!==connection){projectAccounts.clear();accountCurrencies.clear();cacheConnection=connection;}
        const authUser=url.searchParams.get('authuser') || url.pathname.match(/\/u\/(\d+)\//)?.[1] || '0';
        if(String(connection.authUser)!==authUser)throw new Error('横幅Google账号与连接账号不一致');
        const project=url.searchParams.get('project');
        const route=billingRoute(sender.url);
        let account=route?.account || (route && ACCOUNT_RE.test(message.account || '')?'billingAccounts/'+message.account.split('/')[1].toUpperCase():'');
        if(!account){
          if(!/^(?:[a-z][a-z0-9-]{4,28}[a-z0-9]|[0-9]{5,30})$/.test(project || ''))throw new Error('页面未明确显示结算账号或项目ID，请打开官方结算概览同步');
          const cacheKey=authUser+':'+project,cached=projectAccounts.get(cacheKey);
          if(cached && Date.now()-cached.at<60000)account=cached.account;
          else{
            const billing=await request('cloudbilling',`v1/projects/${project}/billingInfo`);
            if(getConnection()!==connection)throw new Error('连接已变化，未采用旧横幅');
            account=billing.billingAccountName;
            if(!ACCOUNT_RE.test(account || ''))throw new Error('未核实此项目的结算账号');
            account='billingAccounts/'+account.split('/')[1].toUpperCase();
            if(projectAccounts.size>50)projectAccounts.clear();projectAccounts.set(cacheKey,{account,at:Date.now()});
          }
        }
        if(!connection.accounts.some(a=>a.name.toUpperCase()===account.toUpperCase()))throw new Error('横幅不属于当前连接的结算账号');
        if(message.expectedAccount && account!==message.expectedAccount)throw new Error('采集页当前结算账号已改变，未采用其他账号余额');
        let verifiedCurrency='',currencyError='';
        if(message.currencyConflict || message.currency==='CONFLICT'){
          try{
            let code=connection.accounts.find(a=>a.name.toUpperCase()===account.toUpperCase())?.currencyCode || accountCurrencies.get(account);
            if(!/^[A-Z]{3}$/.test(code || '')){
              const billing=await request('cloudbilling','v1/'+account);
              if(billing.name?.toUpperCase()!==account.toUpperCase())throw new Error('结算币种响应账号不匹配');
              code=billing.currencyCode;
            }
            if(!/^[A-Z]{3}$/.test(code || ''))throw new Error('Google未返回结算币种');
            const candidates=Array.isArray(message.currencyCandidates)?message.currencyCandidates:[];
            if(!candidates.includes(code))throw new Error('结算币种与横幅两种标识均不匹配');
            verifiedCurrency=code;accountCurrencies.set(account,code);
          }catch(e){currencyError=e.message;}
        }
        if(getConnection()!==connection)throw new Error('连接已变化，未采用旧横幅');
        return transact(async()=>{
          const c=await read(),p=c.profiles[account];if(!p)return {accepted:false};
          if(route?.page==='overview' && (!p.autoOverviewTabId || p.autoOverviewTabId===sender.tab.id))p.overviewTabId=sender.tab.id;else if(route?.page==='manage')p.manageTabId=sender.tab.id;else if(!route && project){p.bannerTabId=sender.tab.id;if(p.overviewTabId===sender.tab.id)delete p.overviewTabId;if(p.manageTabId===sender.tab.id)delete p.manageTabId;}
          let balanceAccepted=false;
          const currency=verifiedCurrency || (message.currency==='DOLLAR' && ['USD','AUD','CAD','NZD','SGD','HKD','TWD'].includes(p.currency)?p.currency:message.currency);
          if((message.currencyConflict || currency==='CONFLICT') && !verifiedCurrency){
            if(validAmount(message.balance))p.balanceObservation={amount:message.balance,at:Date.now(),status:'currency-unknown'};
            p.syncError='已读到当前金额 '+message.balance+'，币种待核实：'+currencyError+'；旧余额未当作当前值。';
          }else if(validAmount(message.balance) && /^[A-Z]{3}$/.test(currency || '')){
            balanceAccepted=recordBalance(p,message,currency,verifiedCurrency?'Google Cloud试用横幅（币种已由结算账号API核实）':'Google Cloud试用横幅',sender,route);
          }
          if(!p.lastIgnoredBalanceReason && Number.isInteger(message.remainingDays) && message.remainingDays>=0 && message.remainingDays<=366){p.observedDays=message.remainingDays;p.observedAt=Date.now();}
          lastBannerError='';await write(c);await badge(c);return {accepted:true,account,balanceAccepted,reason:balanceAccepted?'':p.lastIgnoredBalanceReason || p.syncError || '只识别到天数，没有识别到金额'};
        });
      }catch(e){lastBannerError=e.message;return {accepted:false,reason:e.message};}
    }
    const route=sourceAccount(sender,message);
    if(message.type==='MONITOR_SNAPSHOT') return transact(async()=>{
      const c=await read(),p=c.profiles[route.account];
      if(!p || route.page!=='overview')return {accepted:false};
      if(!p.autoOverviewTabId || p.autoOverviewTabId===sender.tab.id)p.overviewTabId=sender.tab.id;
      const currency=message.currency==='DOLLAR' && ['USD','AUD','CAD','NZD','SGD','HKD','TWD'].includes(p.currency)?p.currency:message.currency;
      if(validAmount(message.balance) && /^[A-Z]{3}$/.test(currency)) {
        recordBalance(p,message,currency,'官方页面可见文本',sender,route);
      }
      if(!p.lastIgnoredBalanceReason && Number.isInteger(message.remainingDays) && message.remainingDays>=0 && message.remainingDays<=366) {
        p.observedDays=message.remainingDays;p.observedAt=Date.now();
        // Rounded days are for display only, never silently change a destructive deadline.
      }
      await write(c);await badge(c);return {accepted:true};
    });
    if(message.type==='CLOSE_TICKET') return transact(async()=>{
      const c=await read(),p=c.profiles[route.account];
      if(route.page!=='manage' || !due(p) || isBusy() || p.job?.status!=='opening' || p.job.tabId!==sender.tab.id) return {allowed:false};
      p.job.status='executing';await write(c);
      return {allowed:true,account:p.name,displayName:p.displayName || '',token:p.job.token};
    });
    if(message.type==='CLOSE_CONFIRM_READY')return transact(async()=>{
      const c=await read(),p=c.profiles[route.account];
      const allowed=route.page==='manage' && due(p) && !isBusy() && p.job?.status==='executing' && p.job.tabId===sender.tab.id && p.job.token===message.token && !p.job.confirmedAt;
      if(allowed){p.job.confirmedAt=Date.now();await write(c);}return {allowed:!!allowed};
    });
    if(message.type==='CLOSE_RESULT')return transact(async()=>{
      const c=await read(),p=c.profiles[route.account];
      if(route.page!=='manage' || !p?.job || p.job.status!=='executing' || p.job.tabId!==sender.tab.id || p.job.token!==message.token)throw new Error('无效关闭结果');
      // DOM text cannot prove billing is closed. Only a subsequent authenticated API read can verify it.
      p.job.submitted=message.submitted!==false;
      p.job.status=p.job.submitted?'needs-verification':'failed';p.job.error=String(message.note || '').slice(0,300);
      if(p.job.submitted)p.armed=false;
      await write(c);await notify(p.name,'页面辅助关闭已结束，请打开 AIkey 工作台，连接账号后点击“核实是否已关闭”。退款和移除银行卡需要在官方页面处理。');
      return {accepted:true};
    });
    throw new Error('不支持的页面消息');
  }
  async function recordAccountState(account,open,checkedAt,authUser){
    if(!ACCOUNT_RE.test(account || '') || typeof open!=='boolean' || !Number.isSafeInteger(checkedAt))throw Error('结算核验结果无效');
    return transact(async()=>{
      const c=await read(),p=c.profiles[account];if(!p)return;
      if(p.authUser!==undefined && String(p.authUser)!==String(authUser))throw Error('结算核验登录索引与监控账号不一致');
      p.accountOpen=open;p.accountCheckedAt=checkedAt;
      if(!open){p.armed=false;p.job={...p.job,status:'verified-closed'};}
      else if(p.job?.status==='verified-closed')p.job={...p.job,status:'reopened',error:'结算账号已重新开放，请核实保护设置'};
      await write(c);await badge(c);
    });
  }
  return {dashboard,content,tick,capture,recordAccountState};
}
