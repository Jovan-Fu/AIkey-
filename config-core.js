const ACCOUNT=/^billingAccounts\/[A-Z0-9]{6}-[A-Z0-9]{6}-[A-Z0-9]{6}$/i;
const own=(o,k)=>Object.prototype.hasOwnProperty.call(o,k);
const record=x=>x && typeof x==='object' && !Array.isArray(x);
const finite=x=>typeof x==='number' && Number.isFinite(x);
export function canonicalAccount(v){if(!ACCOUNT.test(v || ''))throw Error('配置里的结算账号无效');return 'billingAccounts/'+v.split('/')[1].toUpperCase();}
export function thresholdAmount(v){if(!finite(v)||v<0||v>1e9)throw Error('最低余额必须为不小于0的金额');return v;}
export function endpointUrl(v){if(typeof v!=='string'||!/^https:\/\/script\.google\.com\/macros\/s\/[A-Za-z0-9_-]{20,}\/exec$/.test(v))throw Error('请填写以 /exec 结尾的Google Apps Script部署地址');return v;}
export function spreadsheetUrl(v){
  if(!v)return '';
  const m=typeof v==='string' && v.match(/^https:\/\/docs\.google\.com\/spreadsheets\/d\/([A-Za-z0-9_-]{20,})(?:\/[^?#]*)?(?:\?[^#]*)?(?:#.*)?$/);
  if(!m)throw Error('管理表格链接必须是Google表格网址');return 'https://docs.google.com/spreadsheets/d/'+m[1]+'/edit';
}
const stamp=x=>Number.isSafeInteger(x)&&x>=946684800000&&x<=4102444800000?x:null;
function profile(v,name){
  if(!record(v))throw Error('监控配置格式无效');
  const authUser=String(v.authUser ?? '0');if(!/^\d{1,3}$/.test(authUser))throw Error('Google账号索引无效');
  const currency=typeof v.currency==='string'&&/^[A-Z]{3}$/.test(v.currency)?v.currency:'';
  return {name,displayName:String(v.displayName || '').slice(0,150),currency,authUser,autoRefresh:v.autoRefresh!==false,
    balance:finite(v.balance)&&v.balance>=0&&v.balance<=1e9?v.balance:null,deadline:stamp(v.deadline),
    observedDays:Number.isInteger(v.observedDays)&&v.observedDays>=0&&v.observedDays<=366?v.observedDays:null,observedAt:stamp(v.observedAt)};
}
function settings(value){
  if(!record(value))throw Error('配置文件缺少设置内容');
  const sheet=record(value.sheetSync)?value.sheetSync:{},endpoint=sheet.endpoint || '',secret=sheet.secret || '';
  if(endpoint)endpointUrl(endpoint);if(secret && !/^[a-f0-9]{64}$/.test(secret))throw Error('表格同步密钥格式无效');
  const profiles={},minimums={},entries=Object.entries(value.profiles || {});
  if(entries.length>100 || Object.keys(value.minimums || {}).length>100)throw Error('配置账号过多');
  for(const [key,p] of entries){const name=canonicalAccount(key);if(own(profiles,name))throw Error('配置账号重复');profiles[name]=profile(p,name);}
  for(const [key,p] of Object.entries(value.minimums || {})){
    const name=canonicalAccount(key);if(!record(p)||own(minimums,name))throw Error('最低余额配置无效或重复');
    minimums[name]={threshold:thresholdAmount(p.threshold ?? 30),fallbackDelete:p.fallbackDelete===true,closeBillingAccount:p.closeBillingAccount===true};
  }
  const active=value.active?canonicalAccount(value.active):'';
  return {sheetSync:{endpoint,secret,spreadsheetUrl:spreadsheetUrl(sheet.spreadsheetUrl || ''),enabled:sheet.enabled===true,refreshOverview:sheet.refreshOverview===true},profiles,minimums,active,upgradeGuard:value.upgradeGuard!==false};
}
export function exportConfiguration(stored,now=Date.now()){
  const minimums={};for(const [account,s] of Object.entries(stored.balanceGuard?.accounts || {}))minimums[account]={threshold:s.policy?.threshold ?? s.threshold ?? 30,fallbackDelete:s.policy?.fallbackDelete ?? s.fallbackDelete ?? false,closeBillingAccount:s.policy?.closeBillingAccount ?? s.closeBillingAccount ?? false};
  return {app:'AIkey',schemaVersion:1,exportedAt:new Date(now).toISOString(),notice:'含表格同步密钥，请留在本机，不要公开上传。导入后自动停用、到期关闭及表格自动发送均保持关闭。',
    settings:settings({sheetSync:stored.sheetSync || {},profiles:stored.trialMonitor?.profiles || {},minimums,active:stored.billingAccount || stored.trialMonitor?.active || '',upgradeGuard:stored.trialMonitor?.upgradeGuard})};
}
export function parseConfiguration(value){
  if(typeof value==='string'){if(value.length>250000)throw Error('配置文件过大');try{value=JSON.parse(value);}catch{throw Error('配置文件不是有效JSON');}}
  if(!record(value)||value.app!=='AIkey'||value.schemaVersion!==1)throw Error('不是支持的AIkey配置备份');
  return settings(value.settings);
}
export function applyConfiguration(current,imported,now=Date.now()){
  const s=settings(imported);
  if(Object.values(current.trialMonitor?.profiles || {}).some(p=>p.armed || ['opening','executing'].includes(p.job?.status)) || Object.values(current.balanceGuard?.accounts || {}).some(p=>p.armed || p.enabled || p.triggeredAt))throw Error('已有授权或正在处理的保护任务，不能导入覆盖；请先暂停并核实任务');
  const trialMonitor=structuredClone(current.trialMonitor || {profiles:{}}),balanceGuard=structuredClone(current.balanceGuard || {accounts:{}});
  trialMonitor.profiles ||= {};balanceGuard.accounts ||= {};
  for(const [name,p] of Object.entries(s.profiles)){
    const old=trialMonitor.profiles[name],restored={...old,...p,armed:false};
    if(old){for(const k of ['balance','currency','balanceSource','balanceUpdatedAt','balanceObservation','balanceSourceTabId','balancePageStartedAt','lastBalanceReadAt','lastDomReadAt','balanceValueChangedAt'])if(own(old,k))restored[k]=old[k];}
    else Object.assign(restored,{balanceSource:'配置导入（历史记录，待采集）',balanceUpdatedAt:null,lastBalanceReadAt:null,balancePageStartedAt:null,job:null});
    if(restored.observedDays===null){delete restored.observedDays;delete restored.observedAt;}
    restored.savedAt=now;trialMonitor.profiles[name]=restored;
  }
  for(const [name,p] of Object.entries(s.minimums))balanceGuard.accounts[name]={account:name,threshold:p.threshold,fallbackDelete:p.fallbackDelete,closeBillingAccount:p.closeBillingAccount,policy:null,enabled:false,armed:false,jobs:{},events:[],savedAt:now,status:'已导入最低余额，尚未启用保护'};
  trialMonitor.active=s.active || trialMonitor.active || '';trialMonitor.upgradeGuard=s.upgradeGuard;
  return {trialMonitor,balanceGuard,billingAccount:s.active || current.billingAccount || '',sheetSync:{...s.sheetSync,enabled:false,lastError:'',lastWarning:'已恢复配置，表格自动同步尚未启用；请勾选每分钟自动同步，再点击保存并授权同步。'}};
}
export async function migrateSimpleConfiguration(storage,alarms){
  const data=await storage.get(['simpleConfigVersion','trialMonitor','costGuard','tokenMonitor','balanceGuard']);
  if(data.simpleConfigVersion===1)return;
  const update={simpleConfigVersion:1};
  if(data.trialMonitor){const c=structuredClone(data.trialMonitor);for(const p of Object.values(c.profiles || {}))p.armed=false;update.trialMonitor=c;}
  if(data.costGuard){const c=structuredClone(data.costGuard);for(const p of Object.values(c.accounts || {})){p.armed=false;p.enabled=false;}update.costGuard=c;}
  if(data.tokenMonitor){const c=structuredClone(data.tokenMonitor);for(const p of Object.values(c.accounts || {}))p.enabled=false;update.tokenMonitor=c;}
  if(!data.balanceGuard){const accounts={};for(const name of Object.keys(data.trialMonitor?.profiles || {}))if(ACCOUNT.test(name))accounts[canonicalAccount(name)]={account:canonicalAccount(name),threshold:30,fallbackDelete:false,policy:null,enabled:false,armed:false,jobs:{},events:[],savedAt:Date.now(),status:'最低余额默认30，尚未启用保护'};update.balanceGuard={accounts};}
  await storage.set(update);
  for(const name of ['aikey-cost-guard','aikey-token-readonly'])await alarms?.clear?.(name);
}
