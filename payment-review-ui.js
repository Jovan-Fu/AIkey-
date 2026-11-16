(function(){
  'use strict';
  const el=id=>document.getElementById(id);let scanning=false,busy=false,attempts=0,expectedAccount='';
  const selected=()=>el('billing').value;
  const info=t=>{el('payment-review-status').textContent=t;};
  const send=async(type,fields={})=>{const result=await chrome.runtime.sendMessage({type,account:selected(),...fields});if(!result?.ok)throw new Error(result?.error || '付款核对失败');return result.data;};
  async function scan(){
    if(busy)return;busy=true;const account=selected();
    try{
      const data=await send('PAYMENT_SCAN',{account});if(selected()!==account)return;const lines=[`采集时间：${new Date(data.observedAt).toLocaleString()} · 本页已加载 ${data.loadedRows} 条金额记录`];
      for(const [currency,total] of Object.entries(data.totals))lines.push(`${currency}：明确的临时预授权 ${total.authorization}；明确已完成付款 ${total.completedPayments}；明确已完成退款 ${total.completedRefunds}`);
      if(!data.loadedRows)lines.push('未识别到交易表格，不代表没有银行扣款。');
      if(data.uncertainAmounts?.length)lines.push('未归类的原始金额：'+data.uncertainAmounts.map(r=>r.amount+' '+r.currency).join('，'));
      if(data.unknownRows)lines.push(`${data.unknownRows} 条记录的币种、正负号、类别或状态不确定，未计入上面的合计。`);
      lines.push(data.refundState==='official-button-visible'?'官方页出现可用的“申请退款”按钮；还需核对可退余额及原付款方式。':'退款资格未知；已付款金额不等于可退金额。');
      lines.push('临时预授权通常自动解除；本次只读取本页已显示的记录，不能读取银行卡账单。尚未自动申请退款、关闭账号或移除银行卡。');
      info(lines.join('\n'));if(data.loadedRows)scanning=false;
    }catch(e){info(e.message);}
    finally{busy=false;}
  }
  for(const [id,page] of [['payment-open-history','history'],['payment-open-summary','payment']])el(id).addEventListener('click',async()=>{
    try{const result=await send('PAYMENT_OPEN',{page});expectedAccount=result.account;attempts=0;scanning=true;info(`已打开官方页面，请在Google中选择 ${result.account}。页面加载后会自动尝试读取；本操作不申请退款或删卡。`);}catch(e){info(e.message);}
  });
  el('payment-scan').addEventListener('click',scan);
  setInterval(()=>{if(scanning && selected()===expectedAccount && ++attempts<=24)scan();else scanning=false;},5000);
})();
