export const SERVICES = ['cloudresourcemanager','cloudbilling','serviceusage','iam','apikeys'];
export function consoleUrl(value) {
  try { const u = new URL(value); return u.origin === 'https://console.cloud.google.com'; } catch { return false; }
}
export function trustedDashboard(sender, runtime) {
  return sender.id === runtime.id && sender.url === runtime.getURL('dashboard.html') && (sender.frameId === undefined || sender.frameId === 0);
}
export function operationError(op) {
  if (!op || typeof op !== 'object') throw new Error('接口未返回有效操作结果');
  if (op.error) throw new Error(op.error.message || JSON.stringify(op.error));
  return op;
}
export function operationPath(version, name) {
  const path = name.startsWith(version + '/') ? name : version + '/' + name;
  if (!/^v[12]\/(?:[a-zA-Z0-9_.:-]+\/)*operations\/[a-zA-Z0-9_.:-]+$/.test(path)) throw new Error('接口返回了无效操作路径');
  return path;
}
export function rulesFor(extensionId) {
  return SERVICES.map((service, index) => ({id:index+1,priority:100,
    action:{type:'modifyHeaders',requestHeaders:[
      {header:'Origin',operation:'set',value:`https://${service}.clients6.google.com`},
      {header:'Referer',operation:'set',value:`https://${service}.clients6.google.com/static/proxy.html`},
      {header:'X-Origin',operation:'set',value:'https://console.cloud.google.com'}]},
    condition:{requestDomains:[`${service}.clients6.google.com`],initiatorDomains:[extensionId],resourceTypes:['xmlhttprequest']}
  }));
}
