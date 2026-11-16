export function safeDiagnostic(value,max=500){
  return String(value ?? '').replace(/Bearer\s+[^\s"']+/gi,'Bearer [已隐藏]').replace(/SAPISIDHASH\s+[^\s"']+/gi,'SAPISIDHASH [已隐藏]').replace(/AIzaSy[A-Za-z0-9_-]+/g,'[API Key已隐藏]').replace(/gsk_[A-Za-z0-9_-]+/g,'[Groq Key已隐藏]').slice(0,max);
}
export function googleApiError(httpStatus,data,service,path){
  const remote=data?.error || {};
  const details=[];
  for(const item of (Array.isArray(remote.details)?remote.details:[]).slice(0,8)){
    if(Array.isArray(item.violations))for(const v of item.violations.slice(0,5))details.push([v.type,v.subject,v.description].filter(Boolean).map(x=>safeDiagnostic(x,180)).join('：'));
    if(item.reason)details.push('原因：'+safeDiagnostic(item.reason,150));
    if(item.domain)details.push('来源：'+safeDiagnostic(item.domain,150));
    for(const key of ['permission','service','consumer','resource','project','billingAccount'])if(item.metadata?.[key])details.push(key+'：'+safeDiagnostic(item.metadata[key],180));
  }
  const status=safeDiagnostic(remote.status || '',80),message=safeDiagnostic(remote.message || `HTTP ${httpStatus}`);
  const error=new Error(message);
  error.httpStatus=httpStatus;error.apiStatus=status;error.diagnostics={httpStatus,apiStatus:status,service,path:safeDiagnostic(path.split('?')[0],250),message,details};
  return error;
}
export function billingFailureHint(error){
  if(error.apiStatus==='FAILED_PRECONDITION'||/precondition check failed/i.test(error.message))return 'Google未满足结算绑定的前置条件。请检查官方结算页上的付款、身份验证或账号限制提示；新项目同步也可能尚未完成。此错误本身不能确定具体原因。';
  if(error.httpStatus===403||error.apiStatus==='PERMISSION_DENIED')return '当前Google账号可能缺少项目结算管理或结算账号关联权限，请在Google官方页面检查授权。';
  return '配置已停止。请检查结算状态与诊断信息；已有项目请使用“检查并接续现有项目”，避免反复新建。';
}
export function recoveryProjectId(value){
  if(typeof value!=='string'||!/^ai-\d{8}-[a-f0-9]{6}$/.test(value))throw new Error('接续功能只接受本插件生成的项目ID，例如ai-20000101-abcdef');
  return value;
}
export function billingAssociation(info,account){
  if(info?.billingAccountName && info.billingAccountName.toLowerCase()!==account.toLowerCase())return 'other-account';
  return info?.billingEnabled===true && info?.billingAccountName?.toLowerCase()===account.toLowerCase()?'enabled':'unlinked';
}
