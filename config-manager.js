import {exportConfiguration,parseConfiguration,applyConfiguration} from './config-core.js';
const KEYS=['sheetSync','trialMonitor','balanceGuard','billingAccount'];
export function installConfiguration({isBusy}){
  return {async handle(m){
    if(m.type==='CONFIG_EXPORT')return exportConfiguration(await chrome.storage.local.get(KEYS));
    if(m.type==='CONFIG_PREVIEW'){
      const s=parseConfiguration(m.value);
      return {endpoint:s.sheetSync.endpoint,spreadsheetUrl:s.sheetSync.spreadsheetUrl,hasSecret:!!s.sheetSync.secret,accounts:Object.keys(s.profiles),minimums:s.minimums,active:s.active};
    }
    if(m.type==='CONFIG_IMPORT'){
      if(isBusy())throw Error('当前任务执行中，不能导入配置');
      const imported=parseConfiguration(m.value),current=await chrome.storage.local.get(KEYS),updated=applyConfiguration(current,imported);
      await chrome.storage.local.set(updated);return {importedAccounts:Object.keys(imported.profiles).length,importedMinimums:Object.keys(imported.minimums).length};
    }throw Error('未知配置操作');
  }};
}
