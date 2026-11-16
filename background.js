import {SERVICES, consoleUrl, trustedDashboard, operationError, operationPath, rulesFor} from './core.js';
import {installBillingMonitor} from './billing-monitor.js';
import {installPaymentReview} from './payment-review.js';
import {installSheetSync} from './sheet-sync.js';
import {installBalanceGuard} from './balance-guard.js';
import {installBillingClosure} from './billing-closure.js';
import {installConfiguration} from './config-manager.js';
import {migrateSimpleConfiguration} from './config-core.js';
import {googleApiError,billingFailureHint,recoveryProjectId,billingAssociation} from './billing-errors.js';

const PAGE = chrome.runtime.getURL('dashboard.html');
let connection = null;
let busy = false,monitorReconnect=null;
const downloadClaims = new Set();
let state = {running:false, logs:[], projectId:'', apiKey:'', json:'', filename:'', error:'', completed:false};
const ready = (async () => {
  await chrome.storage.session.setAccessLevel({accessLevel:'TRUSTED_CONTEXTS'});
  await chrome.storage.local.setAccessLevel({accessLevel:'TRUSTED_CONTEXTS'});
  await migrateSimpleConfiguration(chrome.storage.local,chrome.alarms);
  const saved = (await chrome.storage.session.get('state')).state;
  if (saved) {
    state = saved;
    if (state.running) {
      state.running = false;
      state.error = '后台已中断。为避免重复创建，未自动重放请求；请根据项目 ID 检查已创建资源。';
      await save();
    }
  }
  await chrome.declarativeNetRequest.updateSessionRules({removeRuleIds:[1,2,3,4,5,6],addRules:rulesFor(chrome.runtime.id)});
})();
async function save() { await chrome.storage.session.set({state}); }
const monitor = installBillingMonitor({request,isBusy:()=>busy,getConnection:()=>connection,ensureConnection:restoreMonitorConnection,waitUntilReady:()=>ready});
const sheetSync = installSheetSync();
const paymentReview=installPaymentReview();
async function withGoogleConnection(fn){
  await ready;const c=connection || await restoreMonitorConnection();
  if(busy)throw Error('其他Google任务执行中，请稍后再试');busy=true;try{return await fn(c);}finally{busy=false;}
}
const billingClosure=installBillingClosure({request,withConnection:withGoogleConnection,isBusy:()=>busy,recordAccountState:monitor.recordAccountState});
const balanceGuard=installBalanceGuard({request,captureBalance:(account,conn,metadata)=>monitor.capture(account,conn,metadata),withConnection:withGoogleConnection,billingClosure});
const configuration=installConfiguration({isBusy:()=>busy || sheetSync.isBusy()});
ready.then(()=>monitor.tick()).catch(console.error);
async function log(text) { state.logs.push(text); await save(); }
async function openDashboard(tabId) {
  if (Number.isInteger(tabId)) await chrome.storage.session.set({consoleTabId:tabId});
  const existing = (await chrome.tabs.query({})).find(t => t.url === PAGE);
  if (existing) await chrome.tabs.update(existing.id,{active:true});
  else await chrome.tabs.create({url:PAGE});
}
chrome.action.onClicked.addListener(tab => { openDashboard(consoleUrl(tab.url) ? tab.id : undefined).catch(console.error); });

// Executed in an ISOLATED world. Results return directly to the extension, never via the page message bus.
function readConsoleContext() {
  const keys = new Set();
  const observedUsers = new Set();
  const collect = text => { for (const m of String(text).matchAll(/AIzaSy[A-Za-z0-9_-]{33}/g)) keys.add(m[0]); };
  for (const r of performance.getEntriesByType('resource')) {
    try { const u = new URL(r.name); if (u.hostname.endsWith('.google.com') || u.hostname.endsWith('.googleapis.com')) { collect(u.searchParams.get('key') || ''); if (u.searchParams.has('authuser')) observedUsers.add(u.searchParams.get('authuser')); } } catch {}
  }
  for (const s of document.querySelectorAll('script:not([src])')) collect(s.textContent);
  const cookie = document.cookie.match(/(?:^|;\s*)SAPISID=([^;]+)/) || document.cookie.match(/(?:^|;\s*)__Secure-3PAPISID=([^;]+)/);
  const u = new URL(location.href);
  const explicitUser = u.searchParams.get('authuser') || location.pathname.match(/\/u\/(\d+)\//)?.[1];
  const authUser = explicitUser || (observedUsers.size === 1 ? [...observedUsers][0] : observedUsers.size > 1 ? 'ambiguous' : '0');
  return {keys:[...keys], cookie:cookie ? decodeURIComponent(cookie[1]) : '', authUser};
}
async function connect() {
  connection = null;
  const stored = await chrome.storage.session.get('consoleTabId');
  let tab;
  if (stored.consoleTabId) tab = await chrome.tabs.get(stored.consoleTabId).catch(() => null);
  if (!tab || !consoleUrl(tab.url)) {
    const tabs = await chrome.tabs.query({url:'https://console.cloud.google.com/*'});
    if (tabs.length !== 1) throw new Error('请在你要使用的 Google Cloud 控制台标签页，点击右下角 AIkey 入口或浏览器扩展图标，再点连接。');
    tab = tabs[0];
  }
  const [result] = await chrome.scripting.executeScript({target:{tabId:tab.id},world:'ISOLATED',func:readConsoleContext});
  const ctx = result?.result;
  if (!ctx?.cookie || !ctx.keys?.length) throw new Error('未读取到登录态或控制台配置。请刷新已登录的控制台，等页面加载完成后重试。');
  if (!/^\d{1,3}$/.test(ctx.authUser)) throw new Error('无法唯一确定 Google 账号。请在控制台网址中明确 authuser=0（或目标账号索引）后重新连接。');
  connection = {...ctx,tabId:tab.id,accounts:[]};
  try {
    const accounts = [];
    let token = '';
    do {
      const data = await request('cloudbilling','v1/billingAccounts' + (token ? `?pageToken=${encodeURIComponent(token)}` : ''));
      accounts.push(...(data.billingAccounts || []));
      token = data.nextPageToken || '';
    } while (token);
    connection.accounts = accounts;
    await chrome.storage.session.set({consoleTabId:tab.id,monitorConnected:true});
    const preferences=await chrome.storage.local.get(['billingAccount','trialMonitor']);
    const preference=preferences.billingAccount || preferences.trialMonitor?.active;
    return {accounts:accounts.map(a => ({name:a.name,displayName:a.displayName,open:a.open,currencyCode:a.currencyCode})),preference,authUser:ctx.authUser};
  } catch (e) { connection = null; throw e; }
}
// Restore only the previously selected console context for read-only monitoring.
// No cookies are persisted, no cloud write or interrupted setup is replayed.
async function restoreMonitorConnection(source){
  await ready;
  if(connection)return connection;
  if(monitorReconnect)return monitorReconnect;
  if(busy)throw new Error('正在连接或配置，稍后重试采集');
  busy=true;
  monitorReconnect=(async()=>{
    try{
      const saved=await chrome.storage.session.get('monitorConnected');
      if(!saved.monitorConnected)throw new Error('请先在工作台连接目标Google账号');
      if(source?.tab?.id && consoleUrl(source.url)){
        const tab=await chrome.tabs.get(source.tab.id);
        if(tab.url!==source.url || !consoleUrl(tab.url))throw new Error('监控来源页已切换，未恢复连接');
        await chrome.storage.session.set({consoleTabId:tab.id});
      }
      await connect();return connection;
    }finally{busy=false;}
  })();
  try{return await monitorReconnect;}finally{monitorReconnect=null;}
}
async function authorization() {
  if (!connection) throw new Error('请先连接 Google Cloud');
  const time = Math.floor(Date.now()/1000);
  const input = new TextEncoder().encode(`${time} ${connection.cookie} https://console.cloud.google.com`);
  const digest = await crypto.subtle.digest('SHA-1',input);
  return `SAPISIDHASH ${time}_${[...new Uint8Array(digest)].map(v=>v.toString(16).padStart(2,'0')).join('')}`;
}
// Internal only: no runtime message accepts URLs, paths, headers or HTTP methods.
async function request(service,path,method='GET',body) {
  if (!SERVICES.includes(service) || !/^v[123]\//.test(path) || /[\\#]/.test(path)) throw new Error('内部接口参数不合法');
  if (!connection) throw new Error('连接已失效，请重新连接');
  const auth = await authorization();
  let lastError;
  for (const key of connection.keys) {
    const url = new URL(`https://${service}.clients6.google.com/${path}`);
    url.searchParams.set('alt','json'); url.searchParams.set('prettyPrint','false'); url.searchParams.set('key',key);
    let resp;
    try {
      resp = await fetch(url.href,{method,credentials:'include',redirect:'error',signal:AbortSignal.timeout(25000),
        headers:{Authorization:auth,'X-Origin':'https://console.cloud.google.com','X-Goog-AuthUser':connection.authUser,'Content-Type':'application/json'},
        body:body === undefined ? undefined : JSON.stringify(body)});
    } catch {
      throw new Error(`网络中断或超时（${service}）；写入请求可能已经成功，已停止，未重复提交。请检查项目资源。`);
    }
    const data = await resp.json().catch(()=>null);
    if (!data) throw new Error('接口返回无法解析的响应；已停止，未重放请求');
    if (resp.ok) return data;
    const reason = data.error?.message || `HTTP ${resp.status}`;
    lastError = googleApiError(resp.status,data,service,path);
    // Only an explicitly rejected invalid bootstrap key permits trying a different bootstrap key.
    if ((resp.status===400 || resp.status===403) && /API_KEY_INVALID|API key not valid/i.test(reason)) continue;
    throw lastError;
  }
  throw lastError || new Error('控制台 API 配置不可用');
}
const pause = ms => new Promise(resolve=>setTimeout(resolve,ms));
async function poll(service,version,op) {
  operationError(op);
  if (op.done) return op;
  if (!op.name) throw new Error('接口未返回操作 ID，已停止');
  const path = operationPath(version,op.name);
  for (let i=0;i<90;i++) {
    await pause(2000);
    const result = operationError(await request(service,path));
    if (result.done) return result;
  }
  throw new Error('等待操作超时；未重复创建，请检查该项目。');
}
// Retry only explicit "this service account does not exist" rejections.
// Network/parse errors and unfinished operations never replay a credential write.
function accountNotVisible(error,email,allowHttp) {
  return (allowHttp && [400,404].includes(error.httpStatus) || [3,5].includes(error.rpcCode)) &&
    error.message.toLowerCase().includes(email.toLowerCase()) &&
    /service\s*account/i.test(error.message) && /not found|does not exist/i.test(error.message);
}
async function waitForAccount(path) {
  for (let i=0;;i++) {
    try { return await request('iam',path); }
    catch(e) {
      if(e.httpStatus!==404 || i===7)throw e;
      await pause((Math.min(2**i,30)+Math.random())*1000);
    }
  }
}
async function createBoundKey(path,body,email) {
  for(let i=0;;i++) {
    let accepted=false;
    try { const op=await request('apikeys',path,'POST',body);accepted=true;return await poll('apikeys','v2',op); }
    catch(e) {
      if(!accountNotVisible(e,email,!accepted) || i===7)throw e;
      const seconds=Math.min(2**(i+1),30);
      await log(`Google尚未同步服务账号，${seconds}秒后重试 API 密钥创建（${i+1}/7）`);
      await pause((seconds+Math.random())*1000);
    }
  }
}
async function run(billingAccount,existingProject='') {
  const historyBefore=(await chrome.storage.session.get('history')).history || {};
  const previous=existingProject?(state.projectId===existingProject?structuredClone(state):historyBefore[existingProject]):null;
  const suffix = existingProject?existingProject.slice(-6):crypto.randomUUID().replaceAll('-','').slice(0,6);
  const date = new Date().toISOString().slice(0,10).replaceAll('-','');
  const project = existingProject || `ai-${date}-${suffix}`;
  const sa = `aikey-${suffix}`;
  const email = `${sa}@${project}.iam.gserviceaccount.com`;
  if (state.projectId) {
    const history=(await chrome.storage.session.get('history')).history || {};
    history[state.projectId]=structuredClone(state);
    await chrome.storage.session.set({history});
  }
  state = {running:true,logs:[],projectId:project,apiKey:'',json:'',filename:`${project}-sa-key.json`,error:'',completed:false,role:'roles/aiplatform.admin',authUser:connection.authUser,billingAccount,stage:'billing-preflight',resumable:false,privateKeyRequested:!!previous?.privateKeyRequested,diagnostics:null};
  try {
    await save();
    if(previous?.privateKeyRequested){state.stage='private-key';state.apiKey=previous.apiKey || '';state.keyResource=previous.keyResource;throw new Error('此项目已提交过 JSON 私钥创建，不能再次获取原私钥；为避免重复生成，请检查历史下载和Google服务账号密钥列表。');}
    await chrome.storage.local.set({billingAccount});
    await log('检查结算账号开放状态及关联权限（只读检查）');
    const selected=await request('cloudbilling',`v1/${billingAccount}`);
    if(selected.name?.toLowerCase()!==billingAccount.toLowerCase() || selected.open!==true)throw new Error('所选结算账号未处于开放状态或响应不匹配，请到Google结算页面检查；不会自动升级或付款。');
    const billingPermissions=await request('cloudbilling',`v1/${billingAccount}:testIamPermissions`,'POST',{permissions:['billing.resourceAssociations.create']});
    if(!billingPermissions.permissions?.includes('billing.resourceAssociations.create'))throw new Error('缺少 billing.resourceAssociations.create 权限，尚未创建项目。请由结算账号管理员授权。');
    if(existingProject)await log(`1/5 检查并接续现有项目 ${project}（不会新建项目）`);
    else {
      state.stage='project-create';await save();
      await log(`1/5 创建项目 ${project}`);
      await poll('cloudresourcemanager','v1',await request('cloudresourcemanager','v1/projects','POST',{projectId:project,name:`AIkey-${date}-${suffix}`}));
    }
    state.stage='billing';state.resumable=true;await save();
    const projectInfo = await request('cloudresourcemanager',`v1/projects/${project}`);
    const number = String(projectInfo.projectNumber || '');
    if (!/^\d+$/.test(number)) throw new Error('未取得项目编号，已停止');
    state.projectNumber = number; await save();
    if(projectInfo.projectId && projectInfo.projectId!==project || projectInfo.lifecycleState && projectInfo.lifecycleState!=='ACTIVE')throw new Error('项目ID不匹配或项目不是ACTIVE状态，已停止接续。');
    const projectPermissions=await request('cloudresourcemanager',`v1/projects/${project}:testIamPermissions`,'POST',{permissions:['resourcemanager.projects.createBillingAssignment']});
    if(!projectPermissions.permissions?.includes('resourcemanager.projects.createBillingAssignment'))throw new Error('缺少项目的 resourcemanager.projects.createBillingAssignment 权限；新项目权限可能尚未同步，请稍后检查并接续。');
    const billingPath=`v1/projects/${project}/billingInfo`;
    const before=await request('cloudbilling',billingPath);
    const association=billingAssociation(before,billingAccount);
    if(association==='other-account')throw new Error('项目已关联其他结算账号；本插件不会自动转移已有费用，请在Google官方页面处理。');
    if(association==='enabled')await log('已核实项目绑定了所选结算账号，跳过重复绑定。');
    else {
      await log(`关联你选定的结算账号 ${billingAccount}`);
      try{await request('cloudbilling',billingPath,'PUT',{billingAccountName:billingAccount});}
      catch(e){
        const reconciled=await request('cloudbilling',billingPath).catch(()=>null);
        if(billingAssociation(reconciled,billingAccount)!=='enabled')throw e;
        await log('绑定请求返回错误，但只读核实确认已经绑定成功；未重复提交。');
      }
      const verified=await request('cloudbilling',billingPath);
      if(billingAssociation(verified,billingAccount)!=='enabled')throw new Error('Google尚未确认结算绑定生效，已停止；请稍后检查并接续同一个项目。');
    }
    state.stage='services';state.resumable=true;await save();
    await log('2/5 启用所需 API');
    await poll('serviceusage','v1',await request('serviceusage',`v1/projects/${number}/services:batchEnable`,'POST',{serviceIds:['aiplatform.googleapis.com','apikeys.googleapis.com','iam.googleapis.com','cloudresourcemanager.googleapis.com']}));
    await pause(3000);
    const saPath = `v1/projects/${project}/serviceAccounts/${encodeURIComponent(email)}`;
    let existingSa;
    if(existingProject){
      try{existingSa=await request('iam',saPath);}
      catch(e){if(e.httpStatus!==404)throw e;}
      if(existingSa && existingSa.email!==email)throw new Error('已有服务账号身份不匹配，已停止。');
    }
    state.stage='service-account';await save();
    await log('3/5 检查服务账号并授予 roles/aiplatform.admin');
    if(existingSa)await log('已核实预期服务账号，复用现有账号，不重复创建。');
    else await request('iam',`v1/projects/${project}/serviceAccounts`,'POST',{accountId:sa,serviceAccount:{displayName:`AIkey ${date}`}});
    const visibleSa=await waitForAccount(saPath);
    if(visibleSa.email!==email)throw new Error('服务账号身份核验失败');
    await pause(3000);
    const policy = await request('cloudresourcemanager',`v1/projects/${project}:getIamPolicy`,'POST',{options:{requestedPolicyVersion:3}});
    if (!policy.etag) throw new Error('IAM 策略缺少 etag，已停止以免覆盖并发修改');
    policy.bindings ||= [];
    if(!policy.bindings.some(b=>b.role==='roles/aiplatform.admin' && !b.condition && b.members?.includes(`serviceAccount:${email}`))){
      policy.bindings.push({role:'roles/aiplatform.admin',members:[`serviceAccount:${email}`]});
      await request('cloudresourcemanager',`v1/projects/${project}:setIamPolicy`,'POST',{policy});
    }
    await log('4/5 创建仅限 aiplatform.googleapis.com 的服务账号绑定 API 密钥');
    const keyId = `aikey-${suffix}`;
    state.stage='api-key';await save();
    const fixedName=`projects/${number}/locations/global/keys/${keyId}`;
    let key;
    if(existingProject){
      try{key=await request('apikeys',`v2/${fixedName}`);}
      catch(e){if(e.httpStatus!==404)throw e;}
      if(key && key.name!==fixedName)throw new Error('已有API密钥资源身份不匹配，已停止');
      if(key)await log('发现同名 API 密钥，核验后复用，不重复创建。');
    }
    if(!key){
      const op=await createBoundKey(`v2/projects/${number}/locations/global/keys?keyId=${keyId}`,{
        displayName:`AIkey-${date}`,serviceAccountEmail:email,restrictions:{apiTargets:[{service:'aiplatform.googleapis.com'}]}
      },email);
      key=op.response;
    }
    const expected = `projects/${number}/locations/global/keys/`;
    if (!key?.name?.startsWith(expected) || !/^projects\/\d+\/locations\/global\/keys\/[\w-]+$/.test(key.name)) throw new Error('API 密钥资源返回异常，已停止');
    const resource = await request('apikeys',`v2/${key.name}`);
    const targets = resource.restrictions?.apiTargets;
    if (resource.serviceAccountEmail !== email || targets?.length !== 1 || targets[0].service !== 'aiplatform.googleapis.com') throw new Error('API 密钥绑定或限制未通过核验；请在控制台检查并撤销异常密钥。');
    state.apiKey = key.keyString || (await request('apikeys',`v2/${key.name}/keyString`)).keyString;
    if (!state.apiKey) throw new Error('接口未返回 API 密钥');
    state.keyResource = key.name; await save();
    if(existingSa){
      const listed=await request('iam',`${saPath}/keys?keyTypes=USER_MANAGED`);
      if(listed.keys!==undefined && !Array.isArray(listed.keys))throw new Error('无法核实已有JSON私钥，已停止');
      if(listed.keys?.length)throw new Error('此服务账号已有用户管理的私钥；为避免重复生成，请使用之前下载的JSON。已核验的API密钥可在上方复制。');
    }
    state.stage='private-key';state.privateKeyRequested=true;state.resumable=false;await save();
    await log('5/5 生成 JSON 私钥（不会自动重试此操作）');
    const privateKey = await request('iam',`${saPath}/keys`,'POST',{privateKeyType:'TYPE_GOOGLE_CREDENTIALS_FILE',keyAlgorithm:'KEY_ALG_RSA_2048'});
    if (!privateKey.privateKeyData) throw new Error('未返回私钥内容，请检查服务账号密钥列表');
    const json = atob(privateKey.privateKeyData);
    const parsed = JSON.parse(json);
    if (parsed.client_email !== email || !parsed.private_key) throw new Error('JSON 私钥身份核验失败');
    state.json = json; state.completed = true;state.stage='completed';state.resumable=false;
    await log('完成。密钥仅供扩展工作台读取，请下载保存。');
  } catch(e) {
    state.diagnostics=e.diagnostics || null;
    const billingStage=state.stage==='billing'||state.stage==='billing-preflight';
    state.error=e.message+(billingStage?'\n'+billingFailureHint(e):'');
    await log('停止：'+state.error);
    if(e.diagnostics)await log('Google诊断：'+JSON.stringify(e.diagnostics));
  }
  finally { state.running = false; busy = false; await save(); }
}
async function handle(message,sender) {
  await ready;
  if(['CLOSE_TICKET','CLOSE_CONFIRM_READY','CLOSE_RESULT'].includes(message?.type)){
    const result=await billingClosure.content(message,sender);return result===null?monitor.content(message,sender):result;
  }
  if (['UPGRADE_GUARD_READ','MONITOR_HEARTBEAT','MONITOR_BANNER','MONITOR_SNAPSHOT'].includes(message?.type)) return monitor.content(message,sender);
  if (message?.type === 'OPEN') {
    if (sender.id !== chrome.runtime.id || !sender.tab || !consoleUrl(sender.url)) throw new Error('拒绝无效入口');
    await openDashboard(sender.tab.id); return {};
  }
  if (!trustedDashboard(sender,chrome.runtime)) throw new Error('拒绝非扩展工作台调用');
  if (message?.type?.startsWith('CONFIG_')) return configuration.handle(message);
  if (message?.type?.startsWith('BALANCE_GUARD_')) return balanceGuard.handle(message);
  if (message?.type?.startsWith('PAYMENT_')) return paymentReview.handle(message,connection);
  if (message?.type?.startsWith('SHEET_')) return sheetSync.handle(message);
  if (message?.type?.startsWith('MONITOR_')) return monitor.dashboard(message,connection);
  switch(message?.type) {
    case 'STATE': return state;
    case 'BILLING_PREFERENCE': {
      if(!connection?.accounts.some(a=>a.name===message.account))throw Error('请先连接并选择目标账号');
      await chrome.storage.local.set({billingAccount:message.account});return {};
    }
    case 'HISTORY': {
      const history=(await chrome.storage.session.get('history')).history || {};
      return Object.values(history).map(item=>({projectId:item.projectId,completed:item.completed}));
    }
    case 'RESTORE_RESULT': {
      if(busy || state.running)throw new Error('任务执行中不能切换结果');
      const history=(await chrome.storage.session.get('history')).history || {};
      if(!Object.hasOwn(history,message.projectId))throw new Error('没有这份历史结果');
      if(state.projectId)history[state.projectId]=structuredClone(state);
      state=structuredClone(history[message.projectId]);
      await chrome.storage.session.set({history});await save();return state;
    }
    case 'CLAIM_AUTO_DOWNLOAD': {
      if(message.projectId!==state.projectId || !state.completed || !state.json)return {allowed:false};
      const projectId=state.projectId;
      if(downloadClaims.has(projectId))return {allowed:false};
      downloadClaims.add(projectId);
      const claimed=(await chrome.storage.session.get('downloadAttempts')).downloadAttempts || {};
      if(claimed[projectId])return {allowed:false};
      claimed[projectId]=Date.now();await chrome.storage.session.set({downloadAttempts:claimed});return {allowed:true};
    }
    case 'CONNECT':
      if (busy) throw new Error('正在执行，不能切换账号');
      busy = true;
      try { return await connect(); } finally { busy = false; }
    case 'START':
      if (busy || state.running) throw new Error('已有任务正在执行');
      if (!connection || !connection.accounts.some(a=>a.name===message.billingAccount && a.open===true)) throw new Error('请连接并选择有效结算账号');
      busy = true;
      // Start only after returning a concrete acknowledgement. State polling keeps the worker active.
      void run(message.billingAccount).catch(error=>{busy=false;console.error('AIkey task failed before start:',error);});
      return {started:true};
    case 'RESUME_BILLING': {
      if(busy || state.running)throw new Error('已有任务正在执行');
      if(!connection || !connection.accounts.some(a=>a.name===message.billingAccount && a.open===true))throw new Error('请先连接并选择可用结算账号');
      const projectId=recoveryProjectId(message.projectId);
      const history=(await chrome.storage.session.get('history')).history || {};
      const result=state.projectId===projectId?state:history[projectId];
      if(result?.completed && result.json){state=structuredClone(result);await save();return {restored:true,projectId};}
      busy=true;
      void run(message.billingAccount,projectId).catch(error=>{busy=false;console.error('AIkey recovery failed before start:',error);});
      return {started:true,projectId};
    }
    case 'CLEAR':
      if (busy) throw new Error('任务执行中不能清除');
      connection = null;
      state = {running:false,logs:[],projectId:'',apiKey:'',json:'',filename:'',error:'',completed:false};
      await chrome.storage.session.remove(['history','downloadAttempts','monitorConnected']);
      downloadClaims.clear();
      await save(); return {};
    default: throw new Error('不支持的操作');
  }
}
chrome.runtime.onMessage.addListener((message,sender,reply)=>{
  handle(message,sender).then(data=>reply({ok:true,data}),error=>reply({ok:false,error:error.message}));
  return true;
});
