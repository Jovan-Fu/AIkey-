'use strict';
const $ = id => document.getElementById(id);
let latest = null, connected = false, downloadedProject = '',connectedAuthUser='0',prefilledRecovery='';
async function send(type,extra={}) {
  const reply = await chrome.runtime.sendMessage({type,...extra});
  if (!reply?.ok) throw new Error(reply?.error || '扩展后台无响应');
  return reply.data;
}
function download() {
  if (!latest?.json) return;
  const url = URL.createObjectURL(new Blob([latest.json],{type:'application/json'}));
  const a = document.createElement('a'); a.href=url; a.download=latest.filename; a.click();
  setTimeout(()=>URL.revokeObjectURL(url),10000);
}
function status(text) { $('status').textContent=text; }
async function refresh() {
  try {
    latest = await send('STATE');
    $('logs').textContent=latest.logs.join('\n');
    $('start').disabled=!connected || latest.running || !$('billing').value;
    $('resume-billing').disabled=!connected || latest.running || !$('billing').value;
    $('resume-project').disabled=latest.running;
    if(latest.resumable && latest.projectId && prefilledRecovery!==latest.projectId && document.activeElement!==$('resume-project')){
      $('resume-project').value=latest.projectId;prefilledRecovery=latest.projectId;
    }
    $('connect').disabled=latest.running;
    $('billing').disabled=!connected || latest.running;
    $('clear').disabled=latest.running;
    $('result').hidden=!latest.projectId;
    $('project').textContent=`项目：${latest.projectId}（Google 账号索引 ${latest.authUser || '0'}）`;
    $('key').value=latest.apiKey || '';
    $('download').disabled=!latest.json;
    $('copy').disabled=!latest.apiKey;
    if (latest.error) {
      const next=latest.stage==='billing-preflight'?'本次未创建新项目。请先解决结算预检问题。':latest.stage==='billing'?'已有项目和历史结果已保留，请使用下方“检查并接续现有项目”。':latest.stage==='project-create'?'项目创建结果需要在Google控制台核实，勿直接重复点击新建。':latest.resumable?'请使用下方“检查并接续现有项目”，复用已有项目和服务账号。':'已有结果已保留，请查看诊断和历史下载；JSON私钥创建不会自动重试。';
      status('已停止：'+latest.error+'\n'+next);
    }
    else if(latest.running) status('正在执行，请保持工作台开启。');
    else if(latest.completed) {
      status('配置完成。请妥善保存 API 密钥和 JSON 私钥。');
      if(downloadedProject!==latest.projectId && latest.json) {
        downloadedProject=latest.projectId;
        if((await send('CLAIM_AUTO_DOWNLOAD',{projectId:latest.projectId})).allowed)download();
      }
    }
  } catch(e) { status(e.message); }
}
$('connect').addEventListener('click',async()=>{
  $('connect').disabled=true; status('正在连接并读取结算账号…');
  try {
    const data=await send('CONNECT'); connected=true;
    connectedAuthUser=data.authUser;
    $('account').textContent=`已连接 · 账号索引 ${data.authUser}`;
    $('billing').replaceChildren(new Option('请选择结算账号',''));
    for(const a of data.accounts){const option=new Option(`${a.displayName || a.name}${a.open===false?' · 已关闭（仅核对/退款）':''} · ${a.name}`,a.name);$('billing').append(option);}
    if(data.accounts.some(a=>a.name===data.preference)) $('billing').value=data.preference;
    $('billing').dispatchEvent(new Event('change'));
    status(data.accounts.length ? '选择结算账号后即可一键配置。' : '没有可用结算账号，请先在 Google Cloud 配置。');
  } catch(e) { connected=false; status(e.message); }
  finally { await refresh(); }
});
$('billing').addEventListener('change',()=>{if($('billing').value)void send('BILLING_PREFERENCE',{account:$('billing').value}).catch(()=>{});$('start').disabled=!connected || !$('billing').value || latest?.running;$('resume-billing').disabled=$('start').disabled;});
window.addEventListener('aikey-config-imported',async()=>{
  try{const c=await send('MONITOR_READ');if([...$('billing').options].some(o=>o.value===c.active)){$('billing').value=c.active;$('billing').dispatchEvent(new Event('change'));}}catch(e){status(e.message);}
});
$('start').addEventListener('click',async()=>{
  $('start').disabled=true;
  try { await send('START',{billingAccount:$('billing').value}); await refresh(); } catch(e) {status(e.message);$('start').disabled=false;}
});
$('resume-billing').addEventListener('click',async()=>{
  $('resume-billing').disabled=true;
  try{await send('RESUME_BILLING',{projectId:$('resume-project').value.trim(),billingAccount:$('billing').value});await refresh();}
  catch(e){status(e.message);$('resume-billing').disabled=false;}
});
$('open-billing-help').addEventListener('click',()=>{
  const account=$('billing').value || latest?.billingAccount;
  if(!/^billingAccounts\/[a-z0-9]{6}-[a-z0-9]{6}-[a-z0-9]{6}$/i.test(account || '')){status('请先选择结算账号');return;}
  chrome.tabs.create({url:`https://console.cloud.google.com/billing/manage?authuser=${encodeURIComponent(connectedAuthUser)}`}).catch(e=>status('无法打开官方账号管理入口：'+e.message));
});
$('open-project-billing').addEventListener('click',()=>{
  const project=$('resume-project').value.trim() || latest?.projectId;
  if(!/^ai-\d{8}-[a-f0-9]{6}$/.test(project || '')){status('请先输入完整的AIkey项目ID');return;}
  chrome.tabs.create({url:`https://console.cloud.google.com/billing/linkedaccount?project=${encodeURIComponent(project)}&authuser=${encodeURIComponent(connectedAuthUser)}`});
});
$('copy-diagnostics').addEventListener('click',async()=>{
  try{await navigator.clipboard.writeText(JSON.stringify({projectId:latest?.projectId,billingAccount:latest?.billingAccount,stage:latest?.stage,error:latest?.error,diagnostics:latest?.diagnostics},null,2));status('已复制项目/结算错误诊断，不包含API密钥、Cookie或JSON私钥。');}
  catch{status('复制失败，请复制日志中的Google诊断信息。');}
});
$('reveal').addEventListener('click',()=>{$('key').type=$('key').type==='password'?'text':'password';});
$('copy').addEventListener('click',async()=>{try{await navigator.clipboard.writeText(latest.apiKey);status('API 密钥已复制。');}catch{status('复制失败，请显示密钥后手动复制。');}});
$('download').addEventListener('click',download);
async function historyList(){
  try{const items=await send('HISTORY'),chosen=$('history').value;$('history').replaceChildren(new Option('选择之前的任务结果',''));for(const item of items)$('history').append(new Option(item.projectId+(item.completed?' · 已完成':' · 未完成'),item.projectId));$('history').value=chosen;}catch{}
}
$('restore').addEventListener('click',async()=>{try{await send('RESTORE_RESULT',{projectId:$('history').value});await refresh();}catch(e){status(e.message);}});
$('open').addEventListener('click',()=>{if(latest?.projectId)chrome.tabs.create({url:`https://console.cloud.google.com/welcome?project=${encodeURIComponent(latest.projectId)}&authuser=${encodeURIComponent(latest.authUser || '0')}`});});
$('clear').addEventListener('click',async()=>{try{await send('CLEAR');connected=false;$('key').value='';$('account').textContent='';status('本地会话已清除；云端资源和密钥保持有效。');await refresh();}catch(e){status(e.message);}});
refresh();historyList();setInterval(refresh,2000);setInterval(historyList,10000);
