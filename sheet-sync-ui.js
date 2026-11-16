(function(){
  'use strict';
  const el=id=>document.getElementById(id);
  const send=async(type,extra={})=>{const r=await chrome.runtime.sendMessage({type,...extra});if(!r?.ok)throw new Error(r?.error || '同步后台无响应');return r.data;};
  const show=text=>{el('sheet-status').textContent=text;};
  let dirty=false,current={};
  function render(c){
    current=c;
    if(!dirty){el('sheet-endpoint').value=c.endpoint || '';el('sheet-url').value=c.spreadsheetUrl || '';el('sheet-enabled').checked=!!c.enabled;el('sheet-refresh').checked=!!c.refreshOverview;}
    el('sheet-secret').placeholder=c.hasSecret?'已保存（无需重填）':'填写脚本生成的同步密钥';
    show(`${c.enabled?'自动同步已启用，每分钟发送一次快照':'自动同步未启用'}\n最近成功：${c.lastSuccess?new Date(c.lastSuccess).toLocaleString():'尚无'}\n最近写入：${c.updatedRows || 0} 行；保护设置：${c.protectionRows || 0} 行；未匹配账号：${c.unmatchedAccounts || 0}${c.lastWarning?'\n提示：'+c.lastWarning:''}${c.lastError?'\n错误：'+c.lastError:''}`);
  }
  el('save-sheet').addEventListener('click',async()=>{
    try{
      if(el('sheet-enabled').checked){
        const granted=await chrome.permissions.request({origins:['https://script.google.com/*','https://script.googleusercontent.com/*']});
        if(!granted)throw new Error('未授权 Google 同步服务访问');
      }
      const c=await send('SHEET_SAVE',{endpoint:el('sheet-endpoint').value.trim(),secret:el('sheet-secret').value.trim(),spreadsheetUrl:el('sheet-url').value.trim(),enabled:el('sheet-enabled').checked,refreshOverview:el('sheet-refresh').checked});
      el('sheet-secret').value='';dirty=false;render(c);
    }catch(e){show(e.message);}
  });
  el('push-sheet').addEventListener('click',async()=>{try{if(dirty)throw Error('请先保存修改后的同步设置');const granted=await chrome.permissions.request({origins:['https://script.google.com/*','https://script.googleusercontent.com/*']});if(!granted)throw Error('未授权Google同步服务访问');show('正在发送签名快照…');render(await send('SHEET_SYNC'));}catch(e){show(e.message);}});
  el('stop-sheet').addEventListener('click',async()=>{try{render(await send('SHEET_STOP'));}catch(e){show(e.message);}});
  el('open-sheet').addEventListener('click',()=>{const url=el('sheet-url').value.trim() || current.spreadsheetUrl;if(!/^https:\/\/docs\.google\.com\/spreadsheets\/d\/[A-Za-z0-9_-]{20,}\/edit(?:[?#].*)?$/.test(url || '')){show('请先同步以识别管理表格，或粘贴管理表格链接并保存。');return;}chrome.tabs.create({url});});
  for(const id of ['sheet-endpoint','sheet-url','sheet-secret','sheet-enabled','sheet-refresh'])el(id).addEventListener('input',()=>{dirty=true;});
  const refresh=()=>send('SHEET_READ').then(render).catch(e=>show(e.message));
  window.addEventListener('aikey-config-imported',()=>{dirty=false;el('sheet-secret').value='';void refresh();});
  void refresh();setInterval(refresh,15000);
})();
