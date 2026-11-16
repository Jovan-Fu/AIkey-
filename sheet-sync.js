import {billingRoute,ACCOUNT_RE} from './monitor-core.js';
import {endpointUrl,spreadsheetUrl} from './config-core.js';
export const SHEET_ORIGINS=['https://script.google.com/*','https://script.googleusercontent.com/*'];
export const validateEndpoint=endpointUrl;
export function makeSnapshot(config,guards={accounts:{}}){
  return {accounts:Object.values(config?.profiles || {}).filter(p=>ACCOUNT_RE.test(p.name) && /^[A-Z]{3}$/.test(p.currency || '')).map(p=>{
    const s=guards.accounts?.[p.name],threshold=s?.policy?.threshold ?? s?.threshold ?? 30;
    return {account:'billingAccounts/'+p.name.split('/')[1].toUpperCase(),balance:p.balanceObservation?.status==='currency-unknown'?null:typeof p.balance==='number'&&Number.isFinite(p.balance)&&p.balance>=0?p.balance:null,
      currency:p.currency,source:p.balanceSource?.startsWith('Google Cloud试用横幅')||p.balanceSource==='官方页面可见文本'?'官方页面可见文本':'手动记录',
      sampledAt:Number.isSafeInteger(p.balanceUpdatedAt)?p.balanceUpdatedAt:null,lastReadAt:Number.isSafeInteger(p.lastBalanceReadAt)?p.lastBalanceReadAt:null,valueChangedAt:Number.isSafeInteger(p.balanceValueChangedAt)?p.balanceValueChangedAt:null,
      deadline:Number.isSafeInteger(p.deadline)?p.deadline:null,observedDays:Number.isInteger(p.observedDays)?p.observedDays:null,observedAt:Number.isSafeInteger(p.observedAt)?p.observedAt:null,
      accountOpen:s?.accountClose?.status==='verified-closed' && s.accountClose.accountOpen===false?false:typeof p.accountOpen==='boolean'?p.accountOpen:null,accountCheckedAt:s?.accountClose?.status==='verified-closed'?s.accountClose.checkedAt:Number.isSafeInteger(p.accountCheckedAt)?p.accountCheckedAt:null,
      protection:{version:2,threshold,enabled:s?.enabled===true,status:String(s?.status || '尚未启用余额保护').slice(0,700),checkedAt:s?.lastCheckedAt || null,updatedAt:s?.savedAt || s?.checkedAt || null,jobs:[...Object.entries(s?.jobs || {}).map(([id,j])=>id+'：'+j.status),...(s?.policy?.closeBillingAccount?['结算账号：'+(s.accountClose?.status==='verified-closed'?'已核实关闭':s.accountClose?.error || s.accountClose?.message || '尚未核实关闭')]:[])].join('；').slice(0,1500)}};
  })};
}
export async function signedEnvelope(payload,secret,timestamp=Date.now(),nonce=crypto.randomUUID()){
  const value=JSON.stringify(payload),input=`${timestamp}\n${nonce}\n${value}`;
  const key=await crypto.subtle.importKey('raw',new TextEncoder().encode(secret),{name:'HMAC',hash:'SHA-256'},false,['sign']);
  const signature=await crypto.subtle.sign('HMAC',key,new TextEncoder().encode(input));
  return {version:1,timestamp,nonce,payload:value,signature:[...new Uint8Array(signature)].map(b=>b.toString(16).padStart(2,'0')).join('')};
}
export function installSheetSync(){
  let busy=false;
  const get=async()=> (await chrome.storage.local.get('sheetSync')).sheetSync || {enabled:false,endpoint:'',refreshOverview:false};
  const save=c=>chrome.storage.local.set({sheetSync:c});
  const publicConfig=c=>({enabled:!!c.enabled,endpoint:c.endpoint || '',hasSecret:!!c.secret,spreadsheetUrl:c.spreadsheetUrl || '',refreshOverview:!!c.refreshOverview,lastAttempt:c.lastAttempt,lastSuccess:c.lastSuccess,lastError:c.lastError,lastWarning:c.lastWarning,updatedRows:c.updatedRows,unmatchedAccounts:c.unmatchedAccounts,protectionRows:c.protectionRows});
  async function sync(manual=false){
    if(busy)throw Error('同步正在进行');busy=true;
    try{
      const c=await get();if(!c.enabled && !manual)return {skipped:true};endpointUrl(c.endpoint);
      if(!c.secret || !await chrome.permissions.contains({origins:SHEET_ORIGINS}))throw Error('同步未授权或未设置同步密钥');
      const stored=await chrome.storage.local.get(['trialMonitor','balanceGuard']),payload=makeSnapshot(stored.trialMonitor,stored.balanceGuard);
      if(!payload.accounts.length)throw Error('请先读取至少一个结算账号的余额与币种');
      c.lastAttempt=Date.now();await save(c);
      try{
        const envelope=await signedEnvelope(payload,c.secret),response=await fetch(c.endpoint,{method:'POST',headers:{'Content-Type':'text/plain;charset=UTF-8'},body:JSON.stringify(envelope),credentials:'omit',cache:'no-store',referrerPolicy:'no-referrer',redirect:'follow',signal:AbortSignal.timeout(25000)});
        if(!['https://script.google.com','https://script.googleusercontent.com'].includes(new URL(response.url).origin))throw Error('同步服务跳转到了未授权域名');
        const data=await response.json().catch(()=>null);if(!response.ok || !data?.ok)throw Error(data?.error || '同步接口没有返回有效确认');
        c.lastSuccess=Date.now();c.lastError='';c.updatedRows=data.updatedRows || 0;c.unmatchedAccounts=data.unmatchedAccounts || 0;c.protectionRows=data.protectionRows || 0;
        c.lastWarning=data.protectionVersion===2?'':'余额已同步；最低余额和保护状态需更新简洁版Apps Script后同步。';
        if(data.spreadsheetUrl)c.spreadsheetUrl=spreadsheetUrl(data.spreadsheetUrl);
        await save(c);return publicConfig(c);
      }catch(e){c.lastError=e.message;await save(c);throw e;}
    }finally{busy=false;}
  }
  async function refreshOverviews(){
    const c=await get();if(!c.enabled || !c.refreshOverview)return;
    const profiles=(await chrome.storage.local.get('trialMonitor')).trialMonitor?.profiles || {};
    for(const tab of await chrome.tabs.query({url:'https://console.cloud.google.com/billing/*'})){
      const route=billingRoute(tab.url),p=route&&(route.account?profiles[route.account]:Object.values(profiles).find(p=>p.overviewTabId===tab.id));
      if(route?.page==='overview' && p && (new URL(tab.url).searchParams.get('authuser') || '0')===String(p.authUser || '0'))await chrome.tabs.reload(tab.id);
    }
  }
  chrome.alarms?.create('aikey-sheet-sync',{periodInMinutes:1});chrome.alarms?.create('aikey-sheet-refresh',{periodInMinutes:5});
  chrome.alarms?.onAlarm.addListener(a=>{if(a.name==='aikey-sheet-sync')void sync().catch(()=>{});if(a.name==='aikey-sheet-refresh')void refreshOverviews().catch(()=>{});});
  return {isBusy:()=>busy,async handle(m){
    const c=await get();if(m.type==='SHEET_READ')return publicConfig(c);
    if(m.type==='SHEET_SAVE'){
      if(busy)throw Error('同步中不能修改设置');endpointUrl(m.endpoint);const secret=m.secret || c.secret;
      if(!/^[a-f0-9]{64}$/.test(secret || ''))throw Error('同步密钥应为脚本生成的64位字符串');
      if(m.enabled && !await chrome.permissions.contains({origins:SHEET_ORIGINS}))throw Error('请允许插件访问Google同步服务');
      const updated={...c,endpoint:m.endpoint,secret,spreadsheetUrl:spreadsheetUrl(m.spreadsheetUrl ?? c.spreadsheetUrl ?? ''),enabled:m.enabled===true,refreshOverview:m.refreshOverview===true,lastError:'',lastWarning:''};await save(updated);return publicConfig(updated);
    }
    if(m.type==='SHEET_STOP'){if(busy)throw Error('当前请求仍在进行');c.enabled=false;await save(c);return publicConfig(c);}
    if(m.type==='SHEET_SYNC')return sync(true);throw Error('未知同步操作');
  }};
}
