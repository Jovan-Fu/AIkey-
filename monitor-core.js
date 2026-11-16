export const ACCOUNT_RE = /^billingAccounts\/[A-Z0-9]{6}-[A-Z0-9]{6}-[A-Z0-9]{6}$/i;
export function amountLevel(v,minimum=30){return typeof v!=='number'||!Number.isFinite(v)?'unknown':v<=minimum?'stop':v<=50?'red':v<=80?'yellow':v<=100?'pale':'normal';}
export function billingRoute(value) {
  try {
    const u = new URL(value);
    if (u.origin !== 'https://console.cloud.google.com') return null;
    const m = u.pathname.match(/^\/billing\/([a-z0-9]{6}-[a-z0-9]{6}-[a-z0-9]{6})(?:\/(overview|manage|history|paymentoverview|payment|payments|settings|credits))?\/?$/i);
    if(m)return {account:'billingAccounts/'+m[1].toUpperCase(),page:(m[2] || 'overview').toLowerCase()};
    const official=u.pathname.match(/^\/billing\/(overview|manage|history|payment|settings)\/?$/);
    return official?{account:'',page:official[1]}:null;
  } catch { return null; }
}
// Routes linked by Google documentation. Let Google's own account picker resolve
// the selected billing account; don't construct an account-specific route.
export function billingPageUrl(page,authUser='0') {
  const pages={overview:'overview',manage:'manage',paymentoverview:'history',history:'history'};
  if(!Object.hasOwn(pages,page) || !/^\d{1,3}$/.test(String(authUser)))throw new Error('官方结算页面或Google账号索引不合法');
  return `https://console.cloud.google.com/billing/${pages[page]}?authuser=${encodeURIComponent(authUser)}`;
}
export function validAmount(value) {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1e9;
}
export function due(profile,now=Date.now()) {
  return !!(profile?.armed && Number.isFinite(profile.deadline) && profile.deadline <= now);
}
export function monitorDisplay(profile,now=Date.now(),phase=false) {
  if (!profile) return {text:'?',color:'#63758b',title:'AIkey：未设置试用监控',ratio:0};
  const effectiveDeadline=Number.isFinite(profile.deadline)?profile.deadline:Number.isInteger(profile.observedDays)?profile.observedAt+profile.observedDays*86400000:null;
  const hasDate=Number.isFinite(effectiveDeadline),remaining=hasDate?Math.max(0,effectiveDeadline-now):null;
  const days=remaining===null?null:Math.ceil(remaining/86400000);
  const uncertain=profile.balanceObservation?.status==='currency-unknown';
  const hasBalance=validAmount(profile.balance) && /^[A-Z]{3}$/.test(profile.currency || '');
  const hasTime=Number.isFinite(profile.balanceUpdatedAt) && profile.balanceUpdatedAt>0;
  const manual=profile.balanceSource==='手动记录';
  const age=hasTime?Math.max(0,now-profile.balanceUpdatedAt):null;
  const stale=uncertain || manual || !hasBalance || !hasTime || age>300000;
  const closed=profile.accountOpen===false || profile.job?.status==='verified-closed';
  const band=amountLevel(profile.balance),color=closed?'#63758b':days===0 || band==='stop' || band==='red' || profile.job?.status==='failed' ? '#e45757' : band==='yellow'?'#ffcf36':band==='pale'?'#fff0b3':stale || days===null || days<=7 ? '#f5ba4b' : '#36d998';
  const amount=hasBalance && !uncertain?(profile.balance>=1000?(profile.balance/1000).toFixed(1)+'k':String(Math.round(profile.balance))):'?';
  const status=uncertain?'币种待核实':!hasBalance?'尚无可用金额':manual?'手动记录，尚未验证自动同步':!hasTime?'已有金额，缺少采集时间':age>300000?'超过5分钟，显示上次采集金额':'最近5分钟内采集';
  const ageText=age===null?'':age<60000?`${Math.floor(age/1000)}秒前`:age<3600000?`${Math.floor(age/60000)}分钟前`:`${Math.floor(age/3600000)}小时前`;
  const balanceText=uncertain?`${profile.balanceObservation.amount}（币种待核实）`:hasBalance?`${profile.balance} ${profile.currency}`:'未知';
  return {text:closed?'OFF':phase?amount:(days===null?amount:days+'d'),color,ratio:days===null?0:Math.min(1,days/90),
    title:`AIkey · ${profile.name}\n赠金：${balanceText}\n来源：${profile.balanceSource || '未标记'}\n数据状态：${status}\n${manual?'记录':'采集'}时间：${hasTime?new Date(profile.balanceUpdatedAt).toLocaleString()+'（'+ageText+'）':'未知'}\n最近成功读取：${profile.lastBalanceReadAt?new Date(profile.lastBalanceReadAt).toLocaleString():'暂无记录'}\n金额最近变化：${profile.balanceValueChangedAt?new Date(profile.balanceValueChangedAt).toLocaleString():'暂无记录'}\n剩余：${days===null?'未知':days+' 天'}\n到期关闭：${profile.armed?'已启用（需浏览器和登录态）':'未启用'}\n关闭状态：${profile.job?.status || '未触发'}`};
}
