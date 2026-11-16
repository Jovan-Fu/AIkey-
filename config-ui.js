(function(){
  const $=id=>document.getElementById(id);let pending='';
  async function send(type,extra={}){const r=await chrome.runtime.sendMessage({type,...extra});if(!r?.ok)throw Error(r?.error || '后台未响应');return r.data;}
  $('config-export').addEventListener('click',async()=>{try{
    const value=await send('CONFIG_EXPORT'),url=URL.createObjectURL(new Blob([JSON.stringify(value,null,2)],{type:'application/json'})),a=document.createElement('a');
    a.href=url;a.download='AIkey-config-'+new Date().toISOString().replace(/[:.]/g,'-')+'.json';a.click();setTimeout(()=>URL.revokeObjectURL(url),10000);
    $('config-status').textContent='已导出已保存的配置。文件含表格同步密钥，请留在本机，不要上传公开仓库。';
  }catch(e){$('config-status').textContent=e.message;}});
  $('config-import').addEventListener('click',()=>$('config-file').click());
  $('config-file').addEventListener('change',async()=>{try{
    pending='';$('config-apply').hidden=true;const f=$('config-file').files?.[0];if(!f)return;if(f.size>250000)throw Error('配置文件过大');
    const text=await f.text(),preview=await send('CONFIG_PREVIEW',{value:text});pending=text;
    $('config-status').textContent=['待导入配置：','管理表格：'+(preview.spreadsheetUrl || '同步后自动识别'),'部署地址：'+(preview.endpoint || '未配置'),'同步密钥：'+(preview.hasSecret?'已包含':'未包含'),'监控账号：'+(preview.accounts.join('、') || '无'),'最低余额：'+Object.entries(preview.minimums).map(([a,p])=>a+' = '+p.threshold+(p.closeBillingAccount?'（含整个结算账号关闭）':'（仅项目）')).join('；'),'导入后自动停用、到期关闭和表格自动发送均保持关闭。'].join('\n');$('config-apply').hidden=false;
  }catch(e){$('config-status').textContent=e.message;}});
  $('config-apply').addEventListener('click',async()=>{try{
    if(!pending)throw Error('请先选择配置文件');await send('CONFIG_IMPORT',{value:pending});pending='';$('config-file').value='';$('config-apply').hidden=true;
    $('config-status').textContent='配置已导入，无需重填。请连接Google Cloud核对余额；表格自动发送需勾选“每分钟自动同步”并点击“保存并授权同步”，保护授权保持关闭。';
    window.dispatchEvent(new Event('aikey-config-imported'));
  }catch(e){$('config-status').textContent=e.message;}});
})();
