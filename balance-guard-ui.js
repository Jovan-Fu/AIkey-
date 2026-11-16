(function(){
  const $=id=>document.getElementById(id);
  let selected='',checked=null,dirty=false,busy=false,revision=0,current=null,monitor={profiles:{}};
  const send=async(type,extra={})=>{const r=await chrome.runtime.sendMessage({type,...extra});if(!r?.ok)throw Error(r?.error || '后台未响应');return r.data;};
  const account=()=>$('billing').value || selected;
  const isActive=s=>s?.enabled===true && s?.armed===true;
  const closeSelected=()=>$('balance-close-account').checked;
  function ready(){return !busy && !dirty && checked?.account===account() && checked?.checkId && checked.fresh && !!checked.closeBillingAccount===closeSelected() && Date.now()-checked.checkedAt<=300000 && $('balance-guard-account').value.trim().toUpperCase()===account().split('/')[1] && $('balance-guard-consent').checked;}
  function enableButton(){
    $('balance-guard-enable').disabled=!ready();
    const crossed=checked?.fresh && typeof checked.balance==='number' && checked.balance<=checked.threshold;
    $('balance-guard-enable').textContent=closeSelected()?(crossed?'2. 确认并立即停用项目与结算账号':'2. 启用项目与结算账号的余额停用'):(crossed?'2. 确认授权并立即停用这些项目':'2. 确认并启用按余额停用');
  }
  function invalidate(){revision++;dirty=true;checked=null;enableButton();$('balance-guard-message').textContent='输入框有未保存修改；这不会启用余额停用，也不会改变已授权的原规则。';render(current);}
  function render(s){
    current=s;
    if(!dirty){$('minimum-balance').value=s?.threshold ?? 30;$('balance-guard-delete').checked=!!s?.fallbackDelete;$('balance-close-account').checked=s?.closeBillingAccountConfigured?s.closeBillingAccount:!isActive(s);}
    const p=monitor.profiles?.[account()],threshold=s?.threshold ?? 30,currency=s?.currency || monitor.accountCurrencies?.[account()] || p?.currency || '',active=isActive(s),stopped=s?.completed===true || !s?.closeBillingAccount && s?.status==='全部指定项目已核实停用';
    const official=typeof p?.balance==='number' && Number.isFinite(p.balance) && p.balance>=0 && p.currency===currency && p.balanceObservation?.status!=='currency-unknown' && (p.balanceSource==='官方页面可见文本'||p.balanceSource?.startsWith('Google Cloud试用横幅'));
    const fresh=!!(official && Number.isSafeInteger(p.balanceUpdatedAt) && p.balanceUpdatedAt<=Date.now()+60000 && Date.now()-p.balanceUpdatedAt<=300000);
    const low=fresh && p.balance<=threshold;
    const state=s?.completed?'项目与结算账号均已停用':stopped?'仅项目已核实停用':s?.triggeredAt?'停用尚未全部完成':active?(s.closeBillingAccount?'联合停用已启用':'已启用（仅项目）'):'未启用按余额停用';
    $('balance-guard-state').textContent=state;
    if($('balance-guard-state').dataset)$('balance-guard-state').dataset.status=stopped?'stopped':!active || s.triggeredAt?'danger':'active';
    $('balance-guard-overview').textContent='停用线：'+threshold+(currency?' '+currency:'（按账号原币种）')+(s?.projects?.length?' · '+s.projects.length+'个项目':' · 项目范围未检查');
    const notice=$('balance-guard-notice');
    if(notice){
      const parts=[];
      if(!account())parts.push('请先连接并选择结算账号。');
      else if(stopped)parts.push('已通过接口核实停用结果，详见下方各项目状态。');
      else if(!active){
        parts.push(low?'当前官方余额 '+p.balance+' '+currency+' ≤ 停用线 '+threshold+' '+currency+'。余额停用尚未启用。':'余额停用尚未启用：保存金额或启用日期关闭，都不会启用余额停用。');
        parts.push('先点“1. 核对项目与结算账号”，核对项目并完成下方授权，再点第2步。');
      }else parts.push(s.triggeredAt?'已触发余额停用，请核实各项目的处理结果。':'已授权按最低余额停用，生效金额为 '+threshold+' '+currency+'。');
      if(s?.enabled && !s.closeBillingAccount)parts.push('当前旧规则只授权停项目，未包含关闭结算账号。如需联合关闭，请先暂停，再按第1、2步重新核实并授权。');
      if(s?.closeBillingAccount)parts.push('本规则包含：撤销Key、停用AI服务、停用项目结算，并通过官方页面关闭整个结算账号。两项均核实后才显示完成。');
      if(p?.armed)parts.push('按日期关闭另行启用'+(Number.isFinite(p.deadline)?'，计划 '+new Date(p.deadline).toLocaleString():'')+'；它不能代替余额停用。');
      if(account() && !fresh && !stopped)parts.push('目前没有最近5分钟内的有效官方余额，无法据此判断阈值；请刷新余额页。');
      if(dirty)parts.push('输入框的修改尚未保存，当前生效规则没有改变。');
      notice.textContent=parts.join('\n');if(notice.dataset)notice.dataset.level=s?.completed?'ok':stopped?'warning':!active || s?.triggeredAt || low?'danger':!fresh || !s?.closeBillingAccount?'warning':'ok';
    }
    $('balance-scope-text').textContent=closeSelected()?'我授权达到最低余额后撤销列出项目的Key、停用AI服务及项目结算，并关闭整个结算账号（影响全部关联项目）。删除项目只按上方另选的授权执行。':'我授权达到最低余额后撤销列出项目的Key、停用AI服务及项目结算；本次不包含关闭整个结算账号。';
    $('balance-guard-projects').value=(s?.projects || []).map(p=>p.id).join('\n');
    $('balance-guard-health').textContent=s?[
      s.status,s.lastCheckedAt?'最近保护检查：'+new Date(s.lastCheckedAt).toLocaleString():'',
      s.balance!==null && s.balance!==undefined?'最近核对余额：'+s.balance+' '+s.currency:'',
      s.reason,s.lastError,...Object.entries(s.jobs || {}).map(([p,j])=>p+'：'+j.status+(j.error?'；'+j.error:''))
    ].filter(Boolean).join('\n'):'尚未配置余额停用。默认输入30不代表已经启用。';
    $('balance-close-status').textContent='项目停用：'+(s?.triggeredAt?(s.projectComplete?'已核实完成':'仍有未完成项'):'未触发')+'\n整个结算账号关闭：'+(!s?.closeBillingAccount?'未包含在当前授权中':s.accountClose?.status==='verified-closed' && s.accountClose.accountOpen===false?'已通过接口核实关闭':s.accountClose?.error || s.accountClose?.message || '尚未执行或核实');
    $('balance-close-retry').hidden=!(s?.accountClose?.canRetry && active);$('balance-close-retry').disabled=busy;
    enableButton();
  }
  async function refresh(){try{
    const [c,m]=await Promise.all([send('BALANCE_GUARD_READ'),send('MONITOR_READ')]);monitor=m;
    const next=$('billing').value || m.active || '';
    if(next!==selected){selected=next;revision++;dirty=false;checked=null;$('balance-guard-account').value='';$('balance-guard-consent').checked=false;}
    render(c[account()]);
  }catch(e){$('balance-guard-health').textContent=e.message;}}
  for(const id of ['minimum-balance','balance-guard-delete','balance-close-account'])$(id).addEventListener('input',invalidate);
  for(const id of ['balance-guard-account','balance-guard-consent'])for(const event of ['input','change'])$(id).addEventListener(event,enableButton);
  for(const [id,type] of [['balance-guard-save','BALANCE_GUARD_SAVE'],['balance-guard-check','BALANCE_GUARD_CHECK'],['balance-guard-test','BALANCE_GUARD_TEST'],['balance-guard-pause','BALANCE_GUARD_PAUSE']])$(id).addEventListener('click',async()=>{
    if(busy)return;const target=account(),started=revision;busy=true;$(id).disabled=true;enableButton();try{
      const raw=$('minimum-balance').value;if(raw.trim()==='')throw Error('请填写最低余额金额');
      const s=await send(type,{account:target,threshold:Number(raw),fallbackDelete:$('balance-guard-delete').checked,closeBillingAccount:closeSelected()});
      if(account()!==target || revision!==started){checked=null;$('balance-guard-message').textContent='检查期间账号或金额已修改，请按当前设置重新检查。';return;}
      if(type==='BALANCE_GUARD_SAVE' || type==='BALANCE_GUARD_CHECK')dirty=false;
      if(type==='BALANCE_GUARD_CHECK'){
        if(closeSelected() && s.closeBillingAccount!==true){checked=null;throw Error('当前后台没有确认整账号联合关闭，请在扩展管理页重新加载整个AIkey扩展后再检查。');}
        checked=s;$('balance-guard-account').value='';$('balance-guard-consent').checked=false;
        const details=$('balance-guard-authorization');if(details)details.open=true;
      }else if(type==='BALANCE_GUARD_SAVE'||type==='BALANCE_GUARD_PAUSE')checked=null;
      if(type==='BALANCE_GUARD_TEST')await refresh();else render(s);
      $('balance-guard-message').textContent=type==='BALANCE_GUARD_SAVE'?'金额已保存，但余额停用没有启用。请继续第1步检查，再完成第2步授权。':type==='BALANCE_GUARD_CHECK'?(s.fresh?'第1步完成，尚未启用。'+(s.balance<=s.threshold?'当前余额已经达到停用线，启用后会立即停用。':'')+'请核对下方项目，填写完整账号ID并勾选授权，再点击第2步。':'项目范围已检查，但余额快照过旧；先刷新余额页，再重新检查。'):type==='BALANCE_GUARD_TEST'?'只读核对完成，本次没有执行停用，也没有新增授权。':'余额保护已暂停。';
    }catch(e){$('balance-guard-message').textContent=e.message;}finally{busy=false;$(id).disabled=false;enableButton();}
  });
  $('balance-guard-enable').addEventListener('click',async()=>{
    if(!ready()){$('balance-guard-message').textContent='请先完成第1步，核对完整账号ID并勾选授权；只读检查有效期为5分钟。';return;}
    busy=true;enableButton();try{
      const s=await send('BALANCE_GUARD_ENABLE',{account:account(),checkId:checked.checkId,confirmAccount:$('balance-guard-account').value.trim().toUpperCase(),confirmScope:$('balance-guard-consent').checked,confirmCloseAccount:closeSelected() && $('balance-guard-consent').checked});
      checked=null;render(s);$('balance-guard-message').textContent='按余额停用已授权。'+s.status+'；请以各项目的核实结果为准。';
    }catch(e){checked=null;$('balance-guard-message').textContent='启用结果需核实：'+e.message;await refresh();}finally{busy=false;enableButton();}
  });
  $('balance-close-retry').addEventListener('click',async()=>{
    if(busy)return;
    if($('balance-guard-account').value.trim().toUpperCase()!==account().split('/')[1] || !$('balance-guard-consent').checked){$('balance-guard-message').textContent='重试整个账号关闭前，请再次核对完整账号ID并勾选联合停用授权。';return;}
    busy=true;enableButton();try{
      const s=await send('BALANCE_GUARD_RETRY_CLOSE',{account:account(),confirmAccount:$('balance-guard-account').value.trim().toUpperCase(),confirmCloseAccount:true});render(s);$('balance-guard-message').textContent='已重试明确未提交的账号关闭任务，请核实账号结果。';
    }catch(e){$('balance-guard-message').textContent=e.message;}finally{busy=false;$('balance-close-retry').disabled=false;enableButton();}
  });
  $('billing').addEventListener('change',()=>{revision++;dirty=false;checked=null;void refresh();});
  window.addEventListener('aikey-config-imported',()=>{revision++;dirty=false;checked=null;void refresh();});
  void refresh();setInterval(refresh,15000);
})();
