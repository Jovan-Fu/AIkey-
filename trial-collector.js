(function(){
  'use strict';
  function collect(){
    const url=new URL(location.href);
    if(url.origin!=='https://console.cloud.google.com')return {error:'拒绝非Google Cloud页面'};
    const legacy=url.pathname.match(/^\/billing\/([A-Z0-9]{6}-[A-Z0-9]{6}-[A-Z0-9]{6})(?:\/(overview|manage))?\/?$/i);
    const generic=url.pathname.match(/^\/billing\/(overview|manage)\/?$/);
    const billingPage=legacy?(legacy[2] || 'overview'):generic?.[1] || '';
    const overview=billingPage==='overview',manage=billingPage==='manage';
    const project=url.searchParams.get('project');
    if(!billingPage && !/^(?:[a-z][a-z0-9-]{4,28}[a-z0-9]|[0-9]{5,30})$/.test(project || ''))return {error:'当前页不是可识别的概览、账号管理或项目页'};
    const root=document.querySelector('main,[role="main"]') || document.body;
    const ids=[...new Set([...String(root?.innerText || '').matchAll(/\b[A-Z0-9]{6}-[A-Z0-9]{6}-[A-Z0-9]{6}\b/gi)].map(m=>m[0].toUpperCase()))];
    const account=legacy?'billingAccounts/'+legacy[1].toUpperCase():ids.length===1?'billingAccounts/'+ids[0]:'';
    if(legacy && ids.some(id=>id!==legacy[1].toUpperCase()))return {error:'页面可见结算账号与网址不一致，未采用余额'};
    if(billingPage && !account)return {error:'结算页面未唯一显示账号ID，请先选择目标结算账号'};
    const parse=globalThis.AIkeyTrialParser?.parse;if(!parse)return {error:'页面缺少试用解析器'};
    const values=new Map();let count=0;
    for(const e of document.querySelectorAll('[role="banner"],[role="alert"],[role="alertdialog"],[role="status"],div,p,span')){
      if(!e.getClientRects().length || getComputedStyle(e).visibility==='hidden')continue;
      const t=String(e.innerText || e.textContent || '').replace(/\s+/g,' ').trim();
      if(t.length>700 || !/试用|試用|trial|抵免額|抵免额/i.test(t))continue;
      if(++count>200)break;const v=parse(t);if(v)values.set(JSON.stringify(v),v);
    }
    const amounts=[...values.values()].filter(v=>v.balance!==null);
    if(new Set(amounts.map(v=>v.currency+':'+v.balance)).size>1)return {error:'同页出现多个不同赠金金额，未采用'};
    const observation=amounts[0] || [...values.values()][0];
    if(!observation)return {error:'当前页面未识别到试用赠金横幅'};
    return {url:url.href,kind:overview?'overview':manage?'manage':'project',account,pageStartedAt:Math.floor(globalThis.performance?.timeOrigin || 0),observation};
  }
  globalThis.AIkeyTrialCollector=Object.freeze({collect});
})();
