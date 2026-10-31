import {SERVICES, consoleUrl, trustedDashboard, operationError, operationPath, rulesFor} from './core.js';

const PAGE = chrome.runtime.getURL('dashboard.html');
let connection = null;
let busy = false;
let state = {running:false, logs:[], projectId:'', apiKey:'', json:'', filename:'', error:'', completed:false};
const ready = (async () => {
  await chrome.storage.session.setAccessLevel({accessLevel:'TRUSTED_CONTEXTS'});
  const saved = (await chrome.storage.session.get('state')).state;
  if (saved) {
    state = saved;
    if (state.running) {
      state.running = false;
      state.error = '后台已中断。为避免重复创建，未自动重放请求；请根据项目 ID 检查已创建资源。';
      await save();
    }
  }
  await chrome.declarativeNetRequest.updateSessionRules({removeRuleIds:[1,2,3,4,5],addRules:rulesFor(chrome.runtime.id)});
})();
async function save() { await chrome.storage.session.set({state}); }
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
      accounts.push(...(data.billingAccounts || []).filter(a => a.open));
      token = data.nextPageToken || '';
    } while (token);
    connection.accounts = accounts;
    const preference = (await chrome.storage.local.get('billingAccount')).billingAccount;
    return {accounts:accounts.map(a => ({name:a.name,displayName:a.displayName})),preference,authUser:ctx.authUser};
  } catch (e) { connection = null; throw e; }
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
  if (!SERVICES.includes(service) || !/^v[12]\//.test(path) || /[\\#]/.test(path)) throw new Error('内部接口参数不合法');
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
    lastError = new Error(reason);
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
async function waitForAccount(path) {
  for (let i=0;i<12;i++) {
    try { return await request('iam',path); }
    catch(e) { if (!/not found|does not exist/i.test(e.message) || i===11) throw e; await pause(2000); }
  }
}
async function run(billingAccount) {
  const suffix = crypto.randomUUID().replaceAll('-','').slice(0,6);
  const date = new Date().toISOString().slice(0,10).replaceAll('-','');
  const project = `ai-${date}-${suffix}`;
  const sa = `aikey-${suffix}`;
  const email = `${sa}@${project}.iam.gserviceaccount.com`;
  state = {running:true,logs:[],projectId:project,apiKey:'',json:'',filename:`${project}-sa-key.json`,error:'',completed:false,role:'roles/aiplatform.admin',authUser:connection.authUser};
  try {
    await save();
    await chrome.storage.local.set({billingAccount});
    await log(`1/5 创建项目 ${project}`);
    await poll('cloudresourcemanager','v1',await request('cloudresourcemanager','v1/projects','POST',{projectId:project,name:`AIkey-${date}-${suffix}`}));
    const projectInfo = await request('cloudresourcemanager',`v1/projects/${project}`);
    const number = String(projectInfo.projectNumber || '');
    if (!/^\d+$/.test(number)) throw new Error('未取得项目编号，已停止');
    state.projectNumber = number; await save();
    await log(`关联你选定的结算账号 ${billingAccount}`);
    await request('cloudbilling',`v1/projects/${project}/billingInfo`,'PUT',{billingAccountName:billingAccount});
    await log('2/5 启用所需 API');
    await poll('serviceusage','v1',await request('serviceusage',`v1/projects/${number}/services:batchEnable`,'POST',{serviceIds:['aiplatform.googleapis.com','apikeys.googleapis.com','iam.googleapis.com','cloudresourcemanager.googleapis.com']}));
    await pause(3000);
    await log('3/5 创建服务账号并授予 roles/aiplatform.admin');
    await request('iam',`v1/projects/${project}/serviceAccounts`,'POST',{accountId:sa,serviceAccount:{displayName:`AIkey ${date}`}});
    const saPath = `v1/projects/${project}/serviceAccounts/${encodeURIComponent(email)}`;
    await waitForAccount(saPath);
    await pause(3000);
    const policy = await request('cloudresourcemanager',`v1/projects/${project}:getIamPolicy`,'POST',{options:{requestedPolicyVersion:3}});
    if (!policy.etag) throw new Error('IAM 策略缺少 etag，已停止以免覆盖并发修改');
    policy.bindings ||= [];
    policy.bindings.push({role:'roles/aiplatform.admin',members:[`serviceAccount:${email}`]});
    await request('cloudresourcemanager',`v1/projects/${project}:setIamPolicy`,'POST',{policy});
    await log('4/5 创建仅限 aiplatform.googleapis.com 的服务账号绑定 API 密钥');
    const keyId = `aikey-${suffix}`;
    const op = await poll('apikeys','v2',await request('apikeys',`v2/projects/${number}/locations/global/keys?keyId=${keyId}`,'POST',{
      displayName:`AIkey-${date}`,serviceAccountEmail:email,restrictions:{apiTargets:[{service:'aiplatform.googleapis.com'}]}
    }));
    const key = op.response;
    const expected = `projects/${number}/locations/global/keys/`;
    if (!key?.name?.startsWith(expected) || !/^projects\/\d+\/locations\/global\/keys\/[\w-]+$/.test(key.name)) throw new Error('API 密钥资源返回异常，已停止');
    const resource = await request('apikeys',`v2/${key.name}`);
    const targets = resource.restrictions?.apiTargets;
    if (resource.serviceAccountEmail !== email || targets?.length !== 1 || targets[0].service !== 'aiplatform.googleapis.com') throw new Error('API 密钥绑定或限制未通过核验；请在控制台检查并撤销异常密钥。');
    state.apiKey = key.keyString || (await request('apikeys',`v2/${key.name}/keyString`)).keyString;
    if (!state.apiKey) throw new Error('接口未返回 API 密钥');
    state.keyResource = key.name; await save();
    await log('5/5 生成 JSON 私钥（不会自动重试此操作）');
    const privateKey = await request('iam',`${saPath}/keys`,'POST',{privateKeyType:'TYPE_GOOGLE_CREDENTIALS_FILE',keyAlgorithm:'KEY_ALG_RSA_2048'});
    if (!privateKey.privateKeyData) throw new Error('未返回私钥内容，请检查服务账号密钥列表');
    const json = atob(privateKey.privateKeyData);
    const parsed = JSON.parse(json);
    if (parsed.client_email !== email || !parsed.private_key) throw new Error('JSON 私钥身份核验失败');
    state.json = json; state.completed = true;
    await log('完成。密钥仅供扩展工作台读取，请下载保存。');
  } catch(e) { state.error = e.message; await log('停止：'+e.message); }
  finally { state.running = false; busy = false; await save(); }
}
async function handle(message,sender) {
  await ready;
  if (message?.type === 'OPEN') {
    if (sender.id !== chrome.runtime.id || !sender.tab || !consoleUrl(sender.url)) throw new Error('拒绝无效入口');
    await openDashboard(sender.tab.id); return {};
  }
  if (!trustedDashboard(sender,chrome.runtime)) throw new Error('拒绝非扩展工作台调用');
  switch(message?.type) {
    case 'STATE': return state;
    case 'CONNECT':
      if (busy) throw new Error('正在执行，不能切换账号');
      busy = true;
      try { return await connect(); } finally { busy = false; }
    case 'START':
      if (busy || state.running) throw new Error('已有任务正在执行');
      if (!connection || !connection.accounts.some(a=>a.name===message.billingAccount)) throw new Error('请连接并选择有效结算账号');
      busy = true;
      // Start only after returning a concrete acknowledgement. State polling keeps the worker active.
      void run(message.billingAccount);
      return {started:true};
    case 'CLEAR':
      if (busy) throw new Error('任务执行中不能清除');
      connection = null;
      state = {running:false,logs:[],projectId:'',apiKey:'',json:'',filename:'',error:'',completed:false};
      await save(); return {};
    default: throw new Error('不支持的操作');
  }
}
chrome.runtime.onMessage.addListener((message,sender,reply)=>{
  handle(message,sender).then(data=>reply({ok:true,data}),error=>reply({ok:false,error:error.message}));
  return true;
});
