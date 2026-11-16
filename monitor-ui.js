(function(){
  'use strict';
  const el=id=>document.getElementById(id);
  let config={profiles:{},active:''},editAccount='',loading=false,dirty=false,balanceDirty=false;
  const send=async(type,fields={})=>{const r=await chrome.runtime.sendMessage({type,...fields});if(!r?.ok)throw new Error(r?.error || '后台无响应');return r.data;};
  const selected=()=>{const raw=el('billing').value || config.active;return raw?'billingAccounts/'+raw.split('/')[1].toUpperCase():'';};
  const info=text=>{el('monitor-status').textContent=text;};
  const localInput=ms=>{if(!Number.isFinite(ms))return '';const d=new Date(ms);return new Date(ms-d.getTimezoneOffset()*60000).toISOString().slice(0,16);};
  el('trial-timezone').textContent='本机时区：'+Intl.DateTimeFormat().resolvedOptions().timeZone+'。请以 Google 显示的实际到期信息为准。';
  function fill(){
    const name=selected(),p=config.profiles[name];editAccount=name;dirty=false;balanceDirty=false;
    const currency=config.accountCurrencies?.[name] || p?.currency || '';
    el('trial-amount').value=p?.currency && currency && p.currency!==currency?'':p?.balance ?? '';el('trial-currency').value=currency;
    el('trial-deadline').value=localInput(p?.deadline);el('auto-close').checked=!!p?.armed;
    el('upgrade-guard').checked=config.upgradeGuard!==false;el('auto-refresh-overview').checked=p?.autoRefresh!==false;
    el('close-consent').hidden=!el('auto-close').checked;
    el('confirm-account').value=p?.armed?name.split('/')[1]:'';el('confirm-scope').checked=!!p?.armed;
  }
  function render(){
    const name=selected(),p=config.profiles[name];
    el('monitor-account').textContent=name ? `监控目标：${name} · ${p?.displayName || '尚未保存，当前未监控'}（图标显示最近保存的账号）` : '连接并选择结算账号后可保存监控设置。';
    const mismatchCurrency=config.accountCurrencies?.[name] && p?.currency && config.accountCurrencies[name]!==p.currency;
    const unresolved=mismatchCurrency || p?.balanceObservation?.status==='currency-unknown' && p.balanceObservation.at>=(p.balanceUpdatedAt || 0);
    el('trial-balance').textContent=mismatchCurrency?'旧币种金额待重新采集':unresolved?`${p.balanceObservation.amount}（币种待核实）`:p?.balance!==null && p?.balance!==undefined ? `${p.balance} ${p.currency}` : '未知';
    const amount=p?.balance,card=el('trial-balance').parentElement;if(card?.dataset)card.dataset.level=unresolved || typeof amount!=='number'?'unknown':amount<=(config.minimums?.[name] ?? 30)?'stop':amount<=50?'red':amount<=80?'yellow':amount<=100?'pale':'normal';
    const stale=p?.balanceUpdatedAt && Date.now()-p.balanceUpdatedAt>300000;
    el('balance-source').textContent=mismatchCurrency?`Google账号币种为${config.accountCurrencies[name]}，旧${p.currency}金额未作为当前余额采用。`:typeof p?.balance!=='number'?(p?.refreshState==='loading'?'正在等待Google余额页加载，后台将自动读取；无需手动填写金额':'尚未采集到官方余额；请点“读取当前页面余额（不关闭）”查看原因'):p?.balanceUpdatedAt?`${p.balanceSource} · 页面快照：${new Date(p.balanceUpdatedAt).toLocaleString()}${stale?' · 页面快照超过5分钟，请查看刷新状态':''}`:'尚未同步；不会将未知余额显示为 0';
    el('balance-read').textContent=typeof p?.balance==='number' && p.balanceSource!=='手动记录' ? `最近成功读取：${p.lastBalanceReadAt?new Date(p.lastBalanceReadAt).toLocaleString():'暂无记录'}；金额最近变化：${p.balanceValueChangedAt?new Date(p.balanceValueChangedAt).toLocaleString():'暂无记录'}`:'';
    if(Number.isFinite(p?.deadline)){
      const ms=Math.max(0,p.deadline-Date.now()),s=Math.floor(ms/1000);
      el('trial-countdown').textContent=`${Math.floor(s/86400)}天 ${Math.floor(s%86400/3600)}时 ${Math.floor(s%3600/60)}分 ${s%60}秒`;
    }else el('trial-countdown').textContent=p?.observedDays!==undefined?`约 ${Math.max(0,p.observedDays-Math.floor((Date.now()-p.observedAt)/86400000))} 天`:'未设置';
    const approximateSetDays=Number.isFinite(p?.deadline)?Math.ceil(Math.max(0,p.deadline-Date.now())/86400000):null;
    const mismatch=Number.isInteger(p?.observedDays) && approximateSetDays!==null && Math.abs(p.observedDays-approximateSetDays)>=1;
    el('expiry-mismatch').textContent=mismatch?`Google页面显示约${p.observedDays}天，你设置的关闭任务还有约${approximateSetDays}天；两者不同。关闭仍采用你保存的时间，不会根据取整天数自动延后。`:'';
    el('trial-observed').textContent=p?.observedAt?`页面显示 ${p.observedDays} 天 · ${new Date(p.observedAt).toLocaleString()}；不用于自动修改截止时间`:'到期动作只采用你确认的准确截止时间';
    el('save-monitor').textContent=el('auto-close').checked?'保存并启用按日期关闭':'保存采集与日期设置（不启用余额停用）';
    el('arm-check').textContent=el('auto-close').checked && (!el('confirm-account').value.trim() || !el('confirm-scope').checked)?'尚未完成关闭授权：请输入完整账号ID并勾选影响全部项目。只填写日期不会启用关闭。':'';
    el('trial-close').textContent=p?.armed?'已授权到期辅助关闭':'未启用';
    el('monitor-saved').textContent=dirty?'有未保存的修改（采集/日期设置）；这不阻止只读余额采集，也不会启用余额停用。':!p?'尚未保存此账号：勾选选项不会启动定时任务。':`采集与日期设置已保存${p.savedAt?' · '+new Date(p.savedAt).toLocaleString():''} · ${p.armed?(p.deadline>Date.now()?'等待设定的截止时间':'已到设定截止时间，请检查任务状态'):'未启用按日期关闭'}；余额停用状态请看上方提示。`;

    el('page-agent').textContent=config.pageAgent && Date.now()-config.pageAgent.lastSeen<90000?`Google页面脚本已连接 · ${config.pageAgent.version} · ${new Date(config.pageAgent.lastSeen).toLocaleTimeString()}`:'尚未收到新版Google页面脚本：请刷新目标Google Cloud页面，再保持登录。';
    const refreshLabels={'no-page':'没有采集页','loading':'已请求重新加载，等待页面就绪','sampling':'后台正在读取','updated':'最近采集成功','manage-read':'账号管理页已采集（只读取，不刷新页面）','project-only':'只有项目横幅，未配置可刷新的概览页','closing':'此页正在关闭确认，暂不刷新','failed':'采集失败'};
    el('sync-health').textContent=[`自动刷新：${p?.autoRefresh===false?'未启用':'已启用'} · ${refreshLabels[p?.refreshState] || '等待检查'}`,
      `最近后台检查：${p?.lastRefreshCheckAt?new Date(p.lastRefreshCheckAt).toLocaleString():'暂无'}`,
      `最近请求重载：${p?.lastRefreshAt?new Date(p.lastRefreshAt).toLocaleString():'暂无'}`,
      `最近读取页面：${p?.lastDomReadAt?new Date(p.lastDomReadAt).toLocaleString():'暂无'}`,
      p?.overviewRefreshError || p?.syncError || config.lastBannerError || '',
      p?.autoOverviewTabId?'已建立独立的后台概览刷新页，约每分钟重新获取快照；账号管理页保持只读':p?.overviewTabId?'已登记概览页，可由后台定时重新加载采集':p?.manageTabId?'已登记账号管理页；后台将建立单独的概览刷新页，不点击账号管理按钮':'请打开此账号的结算概览或账号管理页，再点自动读取；项目页不会被插件强制重载'].filter(Boolean).join('\n');
    el('retry-close').hidden=!(p?.armed && p?.job?.status==='failed');
    const labels={'opening':'已打开管理页','executing':'正在辅助操作','failed':'需人工处理','needs-verification':'需核实关闭结果','verified-closed':'已核实关闭'};
    el('trial-job').textContent=p?.job?`${labels[p.job.status] || p.job.status}${p.job.error?' · '+p.job.error:''}`:'浏览器关闭或登录失效时无法保证执行';
  }
  async function refresh(){
    if(loading)return;loading=true;
    try{config=await send('MONITOR_READ');if(!dirty || !editAccount || editAccount!==selected())fill();render();}catch(e){info(e.message);}finally{loading=false;}
  }
  el('billing').addEventListener('change',()=>{fill();render();});
  el('auto-close').addEventListener('change',()=>{el('close-consent').hidden=!el('auto-close').checked;});
  el('save-monitor').addEventListener('click',async()=>{
    const account=selected();if(!account){info('请先连接并选择结算账号');return;}
    const amount=el('trial-amount').value,deadline=el('trial-deadline').value;
    try{config=await send('MONITOR_SAVE',{account,balance:amount===''?null:Number(amount),currency:el('trial-currency').value.trim().toUpperCase(),deadline:deadline?new Date(deadline).getTime():null,arm:el('auto-close').checked,
      confirmAccount:el('confirm-account').value.trim().toUpperCase(),confirmScope:el('confirm-scope').checked,upgradeGuard:el('upgrade-guard').checked,balanceEdited:balanceDirty,autoRefresh:el('auto-refresh-overview').checked});
      const saved=config.profiles[account];
      fill();render();info(saved?.armed?`已启用按日期关闭：将在 ${new Date(saved.deadline).toLocaleString()} 后辅助关闭 ${saved.name}（影响所有关联项目）。本次没有启用最低余额停用。`:'仅保存了余额和日期；自动关闭未启用。要自动关闭，请勾选关闭选项、填写账号ID并确认范围，再点“保存并启用按日期关闭”。这不会启用最低余额停用。');
    }catch(e){info('保存失败，原设置未改变：'+e.message);}
  });
  el('refresh-balance').addEventListener('click',async()=>{
    el('refresh-balance').disabled=true;info('正在自动核对账号币种并查找已打开的目标Cloud采集页；不会关闭账号…');
    try{config=await send('MONITOR_AUTO_BALANCE',{account:selected()});if(!dirty || !balanceDirty)fill();render();info(config.captureResult?.captured?'已自动读取这个账号的赠金余额，来源及时间见上方。':config.captureResult?.reason || '尚未读到余额，请打开官方概览并选择该账号后重试。');}
    catch(e){info(e.message);}finally{el('refresh-balance').disabled=false;}
  });
  el('retry-close').addEventListener('click',async()=>{try{config=await send('MONITOR_RETRY_CLOSE',{account:selected()});fill();render();info('已只读核实账号状态；如仍开放，已重试原来授权的整个账号关闭任务。请核实最终状态。');}catch(e){info(e.message);}});
  el('refresh-balance-page').addEventListener('click',async()=>{
    el('refresh-balance-page').disabled=true;
    try{config=await send('MONITOR_REFRESH_NOW',{account:selected(),freshPage:true});if(!dirty || !balanceDirty)fill();render();info('已请求刷新结算概览余额页；等待Google加载并读取新快照。不会关闭账号、停用服务或删除项目。');}
    catch(e){info(e.message);}finally{el('refresh-balance-page').disabled=false;}
  });
  el('disarm').addEventListener('click',async()=>{try{config=await send('MONITOR_DISARM',{account:selected()});fill();render();info('已取消后续到期关闭。已提交的官方操作无法由此撤回。');}catch(e){info(e.message);}});
  el('check-closed').addEventListener('click',async()=>{try{config=await send('MONITOR_CHECK_ACCOUNT',{account:selected()});render();const p=config.profiles[selected()];info(p?.accountOpen===false?'已通过 Google 接口核实账号关闭。请按需处理退款和付款方式。':'账号仍处于开放状态，尚未确认关闭。');}catch(e){info(e.message);}});
  async function open(page){
    try{
      const result=await send('MONITOR_OPEN',{account:selected(),page});
      info(`已请求打开Google官方入口（Google账号索引 ${result.authUser}）。如出现账号选择页，请选择 ${result.account}。付款按钮进入交易记录，退款资格以官方显示为准。`);
      el('monitor-page-link').href=result.url;el('monitor-page-link').hidden=false;
    }catch(e){info(e.message);}
  }
  el('sync-trial').addEventListener('click',()=>open('overview'));
  el('manage-account').addEventListener('click',()=>open('manage'));
  el('refund').addEventListener('click',()=>open('paymentoverview'));
  el('cards').addEventListener('click',async()=>{try{await chrome.tabs.create({url:'https://payments.google.com/'});info('已请求打开Google付款中心。');}catch(e){info('无法打开付款中心：'+e.message);}});
  el('diagnose-monitor').addEventListener('click',async()=>{
    try{
      const d=await send('MONITOR_DIAGNOSE',{account:selected()});
      const lines=[`当前本机时间：${new Date(d.now).toLocaleString()}`,`配置：${d.saved?'已保存':'未保存，不会执行关闭'}`,`关闭授权：${d.armed?'已启用':'未启用'}`];
      if(d.deadline!==null)lines.push(`保存的截止时间：${new Date(d.deadline).toLocaleString()}（${d.due?'已到时间':'尚未到时间'}）`);
      lines.push(`定时器：${d.alarmError || (d.alarmScheduledAt?'已注册，下次检查 '+new Date(d.alarmScheduledAt).toLocaleString():'未找到，请重新保存监控设置')}`);
      lines.push(`上次检查：${d.lastTickAt?new Date(d.lastTickAt).toLocaleString():'暂无记录'}`);
      if(d.job)lines.push(`关闭任务：${d.job.status}${d.job.error?' · '+d.job.error:''}`);
      lines.push(d.connected?'目标账号已连接':'目标账号未连接；请连接后核实官方账号状态');
      if(dirty)lines.push('注意：界面有未保存的修改，本次检查使用已保存的设置。');
      if(d.lastBannerError)lines.push('最近横幅采集未成功：'+d.lastBannerError);
      lines.push('本次仅检查状态，没有执行关闭。');info(lines.join('\n'));
    }catch(e){info(e.message);}
  });
  for(const id of ['trial-amount','trial-currency','trial-deadline','auto-refresh-overview','auto-close','upgrade-guard','confirm-account','confirm-scope']){
    el(id).addEventListener('input',()=>{dirty=true;if(['trial-amount','trial-currency'].includes(id))balanceDirty=true;render();});el(id).addEventListener('change',()=>{dirty=true;if(['trial-amount','trial-currency'].includes(id))balanceDirty=true;render();});
  }
  globalThis.addEventListener?.('pageshow',()=>{dirty=false;refresh();});
  window.addEventListener?.('aikey-config-imported',()=>{dirty=false;void refresh();});
  refresh();setInterval(refresh,15000);setInterval(render,1000);
})();
