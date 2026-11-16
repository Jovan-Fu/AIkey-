(function(){
  'use strict';
  let guard=true,closing=false;
  const send=async message=>{const r=await chrome.runtime.sendMessage(message);if(!r?.ok)throw new Error(r?.error || '扩展后台无响应');return r.data;};
  const normalize=t=>String(t || '').replace(/\s+/g,' ').trim();
  const visible=el=>!!(el && el.getClientRects().length && getComputedStyle(el).visibility!=='hidden');
  const label=el=>normalize(el.getAttribute('aria-label') || el.innerText || el.textContent);
  const upgrade=t=>/^(?:升级|升級|立即升級|升級帳戶|升級帳號|升級至付費帳戶|升級為付費帳戶|啟用完整帳戶|立即升级|升级账号|升级帐号|升级帐户|升级为付费账号|升级到付费(?:账号|帐号)?|激活完整(?:账号|帐号)|Upgrade|Upgrade now|Upgrade account|Activate full account|Activate paid account)(?:[.!！。])?$/i.test(t);
  const guarded=new Map();
  function applyGuard(){
    if(!document.querySelectorAll)return;
    if(guard){
      for(const el of document.querySelectorAll('button,a,[role="button"],[role="menuitem"]')){
        if(!upgrade(label(el)) || guarded.has(el))continue;
        guarded.set(el,{aria:el.getAttribute('aria-disabled'),tab:el.getAttribute('tabindex')});
        el.setAttribute('data-aikey-upgrade-guard','blocked');el.setAttribute('aria-disabled','true');el.setAttribute('tabindex','-1');
      }
    }else{
      for(const [el,old] of guarded){
        el.removeAttribute('data-aikey-upgrade-guard');
        for(const [key,value] of [['aria-disabled',old.aria],['tabindex',old.tab]]){
          if(value===null)el.removeAttribute(key);else el.setAttribute(key,value);
        }
      }
      guarded.clear();
    }
  }
  function block(event){
    if(!guard)return;
    const el=event.composedPath().find(e=>e?.matches?.('button,a,[role="button"],[role="menuitem"]'));
    if(el && upgrade(label(el))) {
      event.preventDefault();event.stopImmediatePropagation();
      let toast=document.getElementById('aikey-upgrade-warning');
      if(!toast){toast=document.createElement('div');toast.id='aikey-upgrade-warning';Object.assign(toast.style,{position:'fixed',top:'20px',right:'20px',zIndex:'2147483647',background:'#512321',color:'white',padding:'15px',borderRadius:'10px'});document.body.append(toast);}
      toast.textContent='AIkey 已拦截升级到付费账号。此保护只覆盖已识别的当前浏览器按钮。';
      setTimeout(()=>toast.remove(),6000);
    }
  }
  for(const name of ['click','auxclick'])window.addEventListener(name,block,true);
  window.addEventListener('keydown',e=>{if(e.key==='Enter'||e.key===' ')block(e);},true);
  async function settings(){try{guard=(await send({type:'UPGRADE_GUARD_READ'})).enabled!==false;}catch{/* keep the upgrade-button guard enabled */}applyGuard();send({type:'MONITOR_HEARTBEAT',version:'2.5.9'}).catch(()=>{});}
  // A generic official route does not identify a billing account. Never trust
  // a query parameter as identity; require a single visible account ID.
  function pageContext(){
    const legacy=location.pathname.match(/^\/billing\/([a-z0-9]{6}-[a-z0-9]{6}-[a-z0-9]{6})(?:\/(overview|manage))?\/?$/i);
    if(legacy)return {page:legacy[2] || 'overview',account:'billingAccounts/'+legacy[1].toUpperCase()};
    const generic=location.pathname.match(/^\/billing\/(overview|manage)\/?$/);
    if(!generic)return null;
    const root=document.querySelector?.('main,[role="main"]') || document.body;
    const ids=[...new Set([...String(root?.innerText || '').matchAll(/\b[A-Z0-9]{6}-[A-Z0-9]{6}-[A-Z0-9]{6}\b/gi)].map(m=>m[0].toUpperCase()))];
    return ids.length===1?{page:generic[1],account:'billingAccounts/'+ids[0]}:null;
  }
  function trialBanner(){
    const parse=globalThis.AIkeyTrialParser?.parse;if(!parse || !document.querySelectorAll)return;
    const observations=new Map();let examined=0;
    for(const el of document.querySelectorAll('[role="banner"],[role="alert"],[role="alertdialog"],[role="status"],div,p,span')){
      if(!visible(el))continue;
      const text=normalize(el.innerText || el.textContent);
      if(text.length>700 || !/试用|試用|trial|抵免額|抵免额/i.test(text))continue;
      if(++examined>200)break;
      const parsed=parse(text);if(parsed)observations.set(JSON.stringify(parsed),parsed);
    }
    // Distinct balances on one page cannot safely be collapsed to one account balance.
    const amounts=[...observations.values()].filter(p=>p.balance!==null);
    if(new Set(amounts.map(p=>p.currency+':'+p.balance)).size>1)return;
    const result=amounts[0] || [...observations.values()][0];
    if(result)send({type:'MONITOR_BANNER',account:pageContext()?.account || '',pageStartedAt:Math.floor(globalThis.performance?.timeOrigin || 0),...result}).catch(()=>{});
  }
  function trialSnapshot(){
    const context=pageContext();if(context?.page!=='overview')return;
    // Read only text near an explicit Free Trial / 试用 marker. Never infer remaining credit from arbitrary monetary totals.
    const markers=[...document.querySelectorAll('h1,h2,h3,h4,span,p,div')].filter(e=>visible(e) && /^(?:免费试用|免费试用赠金|试用赠金|Free trial|Free trial credit)$/i.test(normalize(e.textContent)));
    let balance=null,currency='',remainingDays=null;
    for(const marker of markers.slice(0,10)) {
      let box=marker;
      for(let depth=0;depth<4 && box;depth++,box=box.parentElement) {
        const text=normalize(box.innerText);if(text.length>1000)break;
        let m=text.match(/(?:剩余(?:试用)?(?:赠金|额度|金额)|(?:remaining|available)\s+(?:trial\s+)?credits?)\s*[:：]?\s*(USD|EUR|GBP|CNY|RSD|\$|€|£)\s*([\d,]+(?:\.\d{1,2})?)/i);
        if(!m)m=text.match(/(USD|EUR|GBP|CNY|RSD|\$|€|£)\s*([\d,]+(?:\.\d{1,2})?)\s*(?:剩余(?:赠金|额度)?|(?:credits?\s+)?remaining)/i);
        if(m){currency=({'$':'DOLLAR','€':'EUR','£':'GBP'})[m[1]] || m[1].toUpperCase();balance=Number(m[2].replaceAll(',',''));}
        const d=text.match(/(?:剩余|还剩)\s*(\d{1,3})\s*天|(?:expires?\s+in\s+|)(\d{1,3})\s+days?\s+(?:remaining|left)|expires?\s+in\s+(\d{1,3})\s+days?/i);
        if(d)remainingDays=Number(d[1]||d[2]||d[3]);
      }
    }
    if(balance!==null || remainingDays!==null)send({type:'MONITOR_SNAPSHOT',account:context.account,pageStartedAt:Math.floor(globalThis.performance?.timeOrigin || 0),balance,currency,remainingDays}).catch(()=>{});
  }
  const find=(root,rx)=>[...root.querySelectorAll('button,[role="button"],[role="menuitem"]')].filter(visible).filter(e=>rx.test(label(e)));
  const wait=ms=>new Promise(r=>setTimeout(r,ms));
  async function closeDueAccount(){
    const context=pageContext();if(closing || context?.page!=='manage')return;
    let ticket;try{ticket=await send({type:'CLOSE_TICKET',account:context.account,agentVersion:'2.5.9'});}catch{return;}
    if(!ticket.allowed || ticket.account!==context.account)return;
    closing=true;let submitted=false,note='未找到可识别的关闭账号控件，请手动处理。';
    try{
      const closeRx=/^(?:Close billing account|Close account|关闭账号|關閉帳戶|关闭结算账号|关闭结算帐号|关闭结算账户|關閉帳單帳戶|關閉帳單帳號|關閉結算帳戶|關閉結算帳號)$/i;
      const confirmRx=/^(?:Close billing account|Close account|Close|Confirm|关闭账号|关闭账户|關閉帳戶|关闭结算账号|关闭结算帐号|关闭结算账户|關閉帳單帳戶|關閉帳單帳號|關閉結算帳戶|關閉結算帳號|关闭|關閉|确认|確認|确定|確定)$/i;
      const disabled=e=>!!e.disabled || e.getAttribute('aria-disabled')==='true' || e.matches?.(':disabled')===true;
      let buttons=find(document,closeRx);
      if(!buttons.length){
        const actions=find(document,/^(?:Account actions|帳戶操作|帳號操作|帳戶動作|結算帳戶操作|账号操作|帐号操作|账户操作|结算账号操作|结算帐号操作)$/i);
        if(actions.length===1){actions[0].click();await wait(1200);buttons=find(document,closeRx);}
      }
      if(buttons.length!==1)throw new Error('关闭入口不唯一或不可见，未提交操作。');
      if(disabled(buttons[0]))throw new Error('Google管理页的关闭入口已禁用，请核对账号权限和官方提示，未提交操作。');
      buttons[0].click();
      const id=ticket.account.split('/')[1],displayName=normalize(ticket.displayName);
      const verifiedDialog=()=>{
        const root=document.querySelector?.('main,[role="main"]') || document.body;
        const pageIds=[...new Set([...String(root?.innerText || '').matchAll(/\b[A-Z0-9]{6}-[A-Z0-9]{6}-[A-Z0-9]{6}\b/gi)].map(m=>m[0].toUpperCase()))];
        const matches=[...document.querySelectorAll('[role="dialog"],dialog[open]')].filter(visible).filter(d=>{
          const text=normalize(d.innerText),ids=[...new Set([...text.matchAll(/\b[A-Z0-9]{6}-[A-Z0-9]{6}-[A-Z0-9]{6}\b/gi)].map(m=>m[0].toUpperCase()))];
          if(!/close (?:billing )?account|关闭(?:结算)?(?:账号|帐号|账户)|關閉(?:帳單|結算)?(?:帳戶|帳號)/i.test(text))return false;
          if(ids.length)return ids.length===1 && ids[0]===id.toUpperCase();
          return pageIds.length===1 && pageIds[0]===id.toUpperCase() && displayName.length>=4 && text.includes(displayName);
        });
        return matches.length===1?matches[0]:null;
      };
      const controlLabel=e=>normalize(e.getAttribute('aria-label') || [...(e.labels || [])].map(l=>l.innerText || l.textContent).join(' ') || e.closest?.('label')?.innerText || e.getAttribute('placeholder') || e.parentElement?.innerText).slice(0,200);
      // Google may require a literal closing word instead of the account ID/name.
      // Use only a unique, explicitly instructed close token; never guess or translate it.
      const closingWord=text=>{
        const words=[];
        for(const match of normalize(text).matchAll(/(?:输入|輸入|type|enter)\s*(?:(?:the\s+)?(?:word|text)\s*)?[:：]?\s*[「『“"'](關閉|关闭|close)[」』”"']/gi))words.push(match[1]);
        for(const match of normalize(text).matchAll(/\b(?:type|enter)\s+(?:the\s+word\s+)?(close)\s+(?:below|to\s+confirm|to\s+close)\b/gi))words.push(match[1]);
        const unique=[...new Set(words)];return unique.length===1?unique[0]:'';
      };
      const acted=new Set();let acknowledged=0,lastReason='确认框及管理页未通过账号ID/账号名称交叉核验';
      for(let attempt=0;attempt<60;attempt++){
        await wait(500);
        const dialog=verifiedDialog();if(!dialog)continue;
        const controls=[...dialog.querySelectorAll('input,[role="checkbox"],[role="combobox"],select,textarea')].filter(visible);
        for(const e of controls){
          if(disabled(e) || acted.has(e))continue;
          const text=controlLabel(e),role=e.getAttribute('role'),type=String(e.type || '').toLowerCase();
          if(type==='checkbox' || role==='checkbox'){
            if(e.checked===true || e.getAttribute('aria-checked')==='true')continue;
            // Only acknowledge the already-authorized closure impact. Never accept
            // new terms/privacy agreements or pick cancellation reasons.
            if(/条款|條款|隐私|隱私|terms|privacy|agreement|订阅|訂閱|subscribe/i.test(text))continue;
            if(/我(?:已)?(?:了解|理解|确认|確認|明白|知悉)|I (?:understand|acknowledge|confirm)/i.test(text) && /关闭|關閉|停止|停用|项目|項目|结算|結算|帳單|close|stop|suspend|project|billing/i.test(text)){
              if(acknowledged>=4)throw new Error('关闭确认勾选项过多，已停止以待核实');
              acted.add(e);acknowledged++;e.click();
            }
          }else if(['text','search'].includes(type)){
            const hint=normalize(text+' '+(e.getAttribute('placeholder') || ''));
            let value='';
            if(!/reason|feedback|原因|理由|反馈|反饋/i.test(hint)){
              value=closingWord(hint);
              const textFields=controls.filter(c=>['text','search'].includes(String(c.type || '').toLowerCase()) && !disabled(c));
              if(!value && textFields.length===1 && (!hint || /输入|輸入|enter|type|confirm|确认|確認/i.test(hint)))value=closingWord(dialog.innerText);
            }
            if(!value && /账号|帐号|账户|帳戶|帳號|account/i.test(text) && /输入|輸入|enter|type/i.test(text)){
              value=/编号|編號|识别码|識別碼|\bID\b/i.test(text)?id:/名称|名稱|name/i.test(text)?ticket.displayName:'';
            }
            if(!value)continue;
            if(String(e.value || '').trim() && e.value!==value)throw new Error('Google关闭确认字段已有不同内容，未覆盖，未提交');
            if(e.value===value)continue;
            const setter=Object.getOwnPropertyDescriptor(globalThis.HTMLInputElement?.prototype || {},'value')?.set;
            if(setter)setter.call(e,value);else e.value=value;
            e.dispatchEvent(new Event('input',{bubbles:true}));e.dispatchEvent(new Event('change',{bubbles:true}));acted.add(e);
          }
        }
        const confirm=find(dialog,confirmRx);
        if(confirm.length===1 && !disabled(confirm[0])){
          // Revalidate account identity after any checkbox/input-triggered render.
          if(verifiedDialog()!==dialog){lastReason='确认操作后页面重新渲染，正在重新核验';continue;}
          const permission=await send({type:'CLOSE_CONFIRM_READY',account:context.account,token:ticket.token});
          if(!permission.allowed)throw Error(permission.reason || '关闭授权已暂停、失效或当前范围无法核实，未提交关闭');
          if(verifiedDialog()!==dialog || disabled(confirm[0]))throw Error('提交前确认框身份或按钮状态已变化，未提交关闭');
          confirm[0].click();submitted=true;note='已在官方页面点击关闭确认；需在工作台核实账号 open 状态，尚未证明成功。';break;
        }
        const unchecked=controls.filter(e=>(e.type==='checkbox'||e.getAttribute('role')==='checkbox') && !e.checked && e.getAttribute('aria-checked')!=='true');
        const missing=controls.filter(e=>(e.required || e.getAttribute('aria-required')==='true') && !String(e.value || '').trim());
        const labels=[...unchecked,...missing].map(controlLabel).filter(Boolean).slice(0,4);
        lastReason=confirm.length===0?'未识别到关闭确认按钮':confirm.length>1?'关闭确认按钮不唯一':'Google仍禁用关闭确认按钮';
        if(labels.length)lastReason+='；待处理条件：'+labels.join(' / ');
        const alerts=[...dialog.querySelectorAll('[role="alert"],[aria-live="assertive"]')].filter(visible).filter(e=>e.getAttribute('role')==='alert' || e.getAttribute('aria-live')==='assertive').map(e=>normalize(e.innerText || e.textContent).slice(0,160)).filter(Boolean);
        if(alerts.length)lastReason+='；Google提示：'+alerts.slice(0,2).join(' / ');
      }
      if(!submitted)throw new Error(lastReason+'（已等待30秒，未提交操作）');
    }catch(e){note=e.message;}
    await send({type:'CLOSE_RESULT',account:context.account,token:ticket.token,submitted,note}).catch(()=>{});
  }
  settings();
  if(typeof MutationObserver==='function'){let pending=false;new MutationObserver(()=>{if(pending)return;pending=true;setTimeout(()=>{pending=false;applyGuard();},100);}).observe(document.documentElement,{childList:true,subtree:true,characterData:true});}
  setInterval(()=>{settings();trialBanner();trialSnapshot();closeDueAccount();},15000);
  setTimeout(()=>{trialBanner();trialSnapshot();closeDueAccount();},6000);
})();
