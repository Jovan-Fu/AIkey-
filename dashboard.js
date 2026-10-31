'use strict';
const $ = id => document.getElementById(id);
let latest = null, connected = false, downloadedProject = '';
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
    $('connect').disabled=latest.running;
    $('billing').disabled=!connected || latest.running;
    $('clear').disabled=latest.running;
    $('result').hidden=!latest.projectId;
    $('project').textContent=`项目：${latest.projectId}（Google 账号索引 ${latest.authUser || '0'}）`;
    $('key').value=latest.apiKey || '';
    $('download').disabled=!latest.json;
    $('copy').disabled=!latest.apiKey;
    if (latest.error) status('已停止：'+latest.error+'\n请先检查当前项目；再次点击会创建新项目。');
    else if(latest.running) status('正在执行，请保持工作台开启。');
    else if(latest.completed) {
      status('配置完成。请妥善保存 API 密钥和 JSON 私钥。');
      if(downloadedProject!==latest.projectId && latest.json) { downloadedProject=latest.projectId;download(); }
    }
  } catch(e) { status(e.message); }
}
$('connect').addEventListener('click',async()=>{
  $('connect').disabled=true; status('正在连接并读取结算账号…');
  try {
    const data=await send('CONNECT'); connected=true;
    $('account').textContent=`已连接 · 账号索引 ${data.authUser}`;
    $('billing').replaceChildren(new Option('请选择结算账号',''));
    for(const a of data.accounts) $('billing').append(new Option(`${a.displayName || a.name} · ${a.name}`,a.name));
    if(data.accounts.some(a=>a.name===data.preference)) $('billing').value=data.preference;
    status(data.accounts.length ? '选择结算账号后即可一键配置。' : '没有可用结算账号，请先在 Google Cloud 配置。');
  } catch(e) { connected=false; status(e.message); }
  finally { await refresh(); }
});
$('billing').addEventListener('change',()=>{$('start').disabled=!connected || !$('billing').value || latest?.running;});
$('start').addEventListener('click',async()=>{
  $('start').disabled=true;
  try { await send('START',{billingAccount:$('billing').value}); await refresh(); } catch(e) {status(e.message);$('start').disabled=false;}
});
$('reveal').addEventListener('click',()=>{$('key').type=$('key').type==='password'?'text':'password';});
$('copy').addEventListener('click',async()=>{try{await navigator.clipboard.writeText(latest.apiKey);status('API 密钥已复制。');}catch{status('复制失败，请显示密钥后手动复制。');}});
$('download').addEventListener('click',download);
$('open').addEventListener('click',()=>{if(latest?.projectId)chrome.tabs.create({url:`https://console.cloud.google.com/welcome?project=${encodeURIComponent(latest.projectId)}&authuser=${encodeURIComponent(latest.authUser || '0')}`});});
$('clear').addEventListener('click',async()=>{try{await send('CLEAR');connected=false;$('key').value='';$('account').textContent='';status('本地会话已清除；云端资源和密钥保持有效。');await refresh();}catch(e){status(e.message);}});
refresh(); setInterval(refresh,2000);
