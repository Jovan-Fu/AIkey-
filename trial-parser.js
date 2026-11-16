(function(){
  'use strict';
  function parse(text){
    const t=String(text || '').replace(/\s+/g,' ').replaceAll('餘','余').replaceAll('額','额').replaceAll('還','还').replaceAll('試','试').replaceAll('費','费').replaceAll('將','将').replaceAll('後','后').replaceAll('結','结').trim();
    if(t.length>1500 || !/试用|trial|抵免额|剩余赠金/i.test(t))return null;
    const m=t.match(/(?:抵免额(?:还)?剩下|抵免额尚余|剩余抵免额|剩余(?:试用)?(?:赠金|额度|金额)|(?:remaining|available)\s+(?:trial\s+)?credits?)\s*[:：]?\s*(US\$|NT\$|HK\$|CA\$|A\$|S\$|USD|EUR|GBP|CNY|RSD|\$|€|£)?\s*([0-9][0-9.,]*)\s*(美元|美金|欧元|歐元|英镑|英鎊|人民币|人民幣|USD|EUR|GBP|CNY|RSD)?/i);
    const reverse=t.match(/(US\$|NT\$|HK\$|CA\$|A\$|S\$|USD|EUR|GBP|CNY|RSD|\$|€|£)\s*([0-9][0-9.,]*)\s*(?:剩余(?:赠金|额度)?|(?:credits?\s+)?remaining)/i);
    const hit=m || reverse;
    let balance=null,currency='',currencyConflict=false,currencyCandidates=[];
    if(hit){
      const amount=hit[2];
      if(/^\d+(?:[.,]\d{1,2})?$/.test(amount))balance=Number(amount.replace(',','.'));
      else if(/^\d{1,3}(?:,\d{3})+(?:\.\d{1,2})?$/.test(amount))balance=Number(amount.replaceAll(',',''));
      else if(/^\d{1,3}(?:\.\d{3})+(?:,\d{1,2})?$/.test(amount))balance=Number(amount.replaceAll('.','').replace(',','.'));
      const names={'美元':'USD','美金':'USD','欧元':'EUR','歐元':'EUR','英镑':'GBP','英鎊':'GBP','人民币':'CNY','人民幣':'CNY'};
      const prefix=({'$':'DOLLAR','US$':'USD','NT$':'TWD','HK$':'HKD','CA$':'CAD','A$':'AUD','S$':'SGD','€':'EUR','£':'GBP'})[hit[1]] || (hit[1] || '').toUpperCase();
      const suffix=names[hit[3]] || (hit[3] || '').toUpperCase();
      currencyCandidates=[...new Set([prefix,suffix].filter(Boolean))];
      currencyConflict=!!(prefix && suffix && prefix!=='DOLLAR' && prefix!==suffix);
      currency=currencyConflict?'CONFLICT':suffix || prefix;
      if(!Number.isFinite(balance)||balance<0||balance>1e9)balance=null;
    }
    const d=t.match(/(?:剩余|还剩)\s*(\d{1,3})\s*天|将在\s*(\d{1,3})\s*天后结束|expires?\s+in\s+(\d{1,3})\s+days?|(\d{1,3})\s+days?\s+(?:remaining|left)/i);
    let remainingDays=d?Number(d[1]||d[2]||d[3]||d[4]):/今天.{0,15}(?:结束|到期)/.test(t)?0:null;
    if(remainingDays>366)remainingDays=null;
    return balance!==null||remainingDays!==null?{balance,currency,remainingDays,currencyConflict,currencyCandidates}:null;
  }
  globalThis.AIkeyTrialParser=Object.freeze({parse});
})();
