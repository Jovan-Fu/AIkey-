import {ACCOUNT_RE,billingRoute} from './monitor-core.js';

// Runs in an isolated top frame. Returns numeric observations only: no row text,
// card numbers, names, inputs, cookies, or credentials cross the script boundary.
export function scanPaymentsPage(){
  const visible=e=>!!(e?.getClientRects().length && getComputedStyle(e).visibility!=='hidden');
  const text=e=>String(e?.innerText || e?.textContent || '').replace(/\s+/g,' ').trim();
  const root=document.querySelector('main,[role="main"]') || document.body;
  const identities=[...new Set([...text(root).matchAll(/\b[A-Z0-9]{6}-[A-Z0-9]{6}-[A-Z0-9]{6}\b/gi)].map(m=>m[0].toUpperCase()))];
  const money=value=>{
    const hits=[...value.matchAll(/(USD|EUR|GBP|CNY|CAD|AUD|HKD|TWD|SGD|RSD|US\$|€|£|\$)\s*(-?[0-9][0-9.,]*)|(-?[0-9][0-9.,]*)\s*(USD|EUR|GBP|CNY|CAD|AUD|HKD|TWD|SGD|RSD|美元|欧元|歐元)/gi)];
    if(hits.length!==1)return null;
    const m=hits[0],raw=m[2] || m[3],c=m[1] || m[4];let amount;
    if(/^-?\d+(?:[.,]\d{1,2})?$/.test(raw))amount=Number(raw.replace(',','.'));
    else if(/^-?\d{1,3}(?:,\d{3})+(?:\.\d{1,2})?$/.test(raw))amount=Number(raw.replaceAll(',',''));
    else if(/^-?\d{1,3}(?:\.\d{3})+(?:,\d{1,2})?$/.test(raw))amount=Number(raw.replaceAll('.','').replace(',','.'));
    if(!Number.isFinite(amount)||Math.abs(amount)>1e9)return null;
    const currency=({'US$':'USD','美元':'USD','欧元':'EUR','歐元':'EUR','€':'EUR','£':'GBP','$':'UNKNOWN'})[c] || c.toUpperCase();
    return {amount,currency};
  };
  const rows=[];
  for(const row of document.querySelectorAll('tr,[role="row"]')){
    if(!visible(row))continue;
    const cells=[...row.querySelectorAll('td,[role="cell"],[role="gridcell"]')].filter(visible);
    const amounts=cells.map(e=>money(text(e))).filter(Boolean);if(amounts.length!==1)continue;
    const t=text(row);let kind='unknown',status='unknown';
    if(/authorization|temporary hold|pre.?authori[sz]|预授权|預授權|暫時保留|临时冻结|臨時凍結/i.test(t)){kind='authorization';status='pending';}
    else{
      if(/refund|退款|退費|退费/i.test(t))kind='refund';
      else if(/payment|付款|支付/i.test(t))kind='payment';
      else if(/usage|用量|使用费|使用費|charge|费用|費用/i.test(t))kind='usage';
      if(/pending|processing|待处理|待處理|处理中|處理中/i.test(t))status='pending';
      else if(/reversed|voided|cancelled|canceled|撤销|撤銷|已取消/i.test(t))status='reversed';
      else if(/completed|settled|successful|已完成|已入账|已入帳|成功/i.test(t))status='completed';
    }
    rows.push({...amounts[0],kind,status});if(rows.length>=200)break;
  }
  const refundButtons=[...document.querySelectorAll('button,[role="button"]')].filter(visible).filter(e=>/^(?:Request a refund|申请退款|申請退款|请求退款|請求退款)$/i.test(text(e)) && !e.disabled && e.getAttribute('aria-disabled')!=='true');
  return {accountIds:identities,rows,refundButtonVisible:refundButtons.length===1,observedAt:Date.now()};
}
export function summarizePayments(observation){
  if(!observation || !Array.isArray(observation.rows) || observation.rows.length>200)throw new Error('付款页采集结果不合法');
  const totals={};let unknownRows=0;const uncertainAmounts=[];
  for(const r of observation.rows){
    if(!Number.isFinite(r.amount)||Math.abs(r.amount)>1e9 || !/^(?:[A-Z]{3}|UNKNOWN)$/.test(r.currency || '') || !['authorization','payment','refund','usage','unknown'].includes(r.kind) || !['pending','completed','reversed','unknown'].includes(r.status))throw new Error('付款记录格式异常');
    const currency=r.currency;
    totals[currency] ||= {authorization:0,completedPayments:0,completedRefunds:0};
    if(r.amount<0 || currency==='UNKNOWN'){unknownRows++;uncertainAmounts.push({amount:r.amount,currency});continue;}
    if(r.kind==='authorization' && r.status==='pending')totals[currency].authorization+=r.amount;
    else if(r.kind==='payment' && r.status==='completed')totals[currency].completedPayments+=r.amount;
    else if(r.kind==='refund' && r.status==='completed')totals[currency].completedRefunds+=r.amount;
    else {unknownRows++;uncertainAmounts.push({amount:r.amount,currency});}
  }
  return {totals,unknownRows,uncertainAmounts:uncertainAmounts.slice(0,50),loadedRows:observation.rows.length,refundState:observation.refundButtonVisible?'official-button-visible':'eligibility-unknown',observedAt:Date.now()};
}
export function installPaymentReview(){
  const tabs=new Map();
  return {async handle(message,connection){
    const account=message.account;
    if(!ACCOUNT_RE.test(account || '') || !connection?.accounts.some(a=>a.name.toUpperCase()===account.toUpperCase()))throw new Error('请先连接并选择目标Google结算账号');
    if(message.type==='PAYMENT_OPEN'){
      const page=message.page==='history'?'history':message.page==='payment'?'payment':null;if(!page)throw new Error('不支持的付款页面');
      const url=`https://console.cloud.google.com/billing/${page}?authuser=${encodeURIComponent(connection.authUser)}`;
      const tab=await chrome.tabs.create({url,active:true});tabs.set(account,tab.id);return {tabId:tab.id,account};
    }
    if(message.type==='PAYMENT_SCAN'){
      const id=tabs.get(account) || connection.tabId,tab=await chrome.tabs.get(id),route=billingRoute(tab.url);
      if(!route || !['history','paymentoverview','payment'].includes(route.page))throw new Error('请先打开此账号的交易记录或付款总览页面');
      const user=new URL(tab.url).searchParams.get('authuser') || '0';if(user!==String(connection.authUser))throw new Error('付款页Google账号与连接账号不一致');
      const [result]=await chrome.scripting.executeScript({target:{tabId:id},world:'ISOLATED',func:scanPaymentsPage});
      if(result?.frameId!==undefined && result.frameId!==0)throw new Error('拒绝非顶层付款页');
      if((await chrome.tabs.get(id)).url!==tab.url)throw new Error('付款页面已变化，请重新读取');
      const ids=result?.result?.accountIds;
      if(route.account && route.account.toUpperCase()!==account.toUpperCase() || !route.account && (!Array.isArray(ids)||ids.length!==1||ids[0]!==account.split('/')[1].toUpperCase()))throw new Error('未唯一核实付款页的结算账号，请先在Google页面选择目标账号');
      return summarizePayments(result.result);
    }
    throw new Error('不支持的付款核对操作');
  }};
}
