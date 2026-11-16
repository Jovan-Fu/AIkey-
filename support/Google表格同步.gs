/** AIkey简洁余额版。Web应用只接收HMAC签名快照，不执行Google Cloud停用操作。 */
const AIKEY_SHEET_NAME='AIkey管理';
const AIKEY_HEADERS=['记录编号','G邮箱','G邮箱主人','主人联系方式','注册日期','注册人','项目ID','结算账号ID','Key（完整）','准确到期时间','剩余天数','到期状态','剩余赠金余额','币种','余额采集时间','表格同步时间','数据状态','余额来源','结算状态','最近扣款日期','最近扣款金额','扣款币种','扣款细节','退款状态','备注'];
const AIKEY_SIMPLE_HEADERS=['最低余额阈值','余额保护状态','最近保护检查','最近余额读取','金额变化记录','项目处理结果','页面剩余天数','天数读取时间'];
function onOpen(){SpreadsheetApp.getUi().createMenu('AIkey同步').addItem('初始化或保留同步配置','setupAIkeySync').addItem('升级现有表格（自动备份）','upgradeAIkeySimpleTable').addItem('查看同步密钥（仅填插件）','showAIkeySyncSecret').addToUi();}
function verifyAIkeyLayout_(book){
  const sheet=book.getSheetByName(AIKEY_SHEET_NAME);if(!sheet)throw Error('请先导入简洁管理台账，并保留AIkey管理工作表名称');
  const headers=sheet.getRange(7,2,1,25).getValues()[0];if(!AIKEY_HEADERS.every((h,i)=>headers[i]===h))throw Error('第7行B:Z的原列名或顺序不匹配，已停止写入');return sheet;
}
function stopRetiredAIkeyTasks_(){
  for(const trigger of ScriptApp.getProjectTriggers())if(trigger.getHandlerFunction()==='runAIkeyCloudGuard')ScriptApp.deleteTrigger(trigger);
}
function setupAIkeySync(){
  const book=SpreadsheetApp.getActiveSpreadsheet();if(!book)throw Error('请从自己的管理表格打开绑定的Apps Script项目');verifyAIkeyLayout_(book);
  const props=PropertiesService.getScriptProperties();let secret=props.getProperty('AIKEY_SYNC_SECRET');
  if(!secret){secret=(Utilities.getUuid()+Utilities.getUuid()).replace(/-/g,'');props.setProperty('AIKEY_SYNC_SECRET',secret);}
  if(!/^[a-f0-9]{64}$/.test(secret))throw Error('已有同步密钥格式不匹配，未自动重置，请先保留原配置');
  props.setProperty('AIKEY_TARGET_ID',book.getId());upgradeAIkeySimpleTable_(book);stopRetiredAIkeyTasks_();
  SpreadsheetApp.getUi().alert('同步配置已初始化或保留。原同步密钥没有重置，已保存过的插件不用重填。表格：'+book.getUrl()+'。若首次配置，可用菜单“查看同步密钥”复制到自己的插件。');
}
function showAIkeySyncSecret(){
  const secret=PropertiesService.getScriptProperties().getProperty('AIKEY_SYNC_SECRET');if(!secret)throw Error('请先运行初始化同步配置');
  SpreadsheetApp.getUi().alert('同步密钥（只填自己的AIkey插件，不要公开）',secret,SpreadsheetApp.getUi().ButtonSet.OK);
}
function aiColumn_(n){let s='';for(;n>0;n=Math.floor((n-1)/26))s=String.fromCharCode(65+(n-1)%26)+s;return s;}
function simpleColumns_(sheet){
  const width=Math.max(0,Math.min(150,sheet.getLastColumn())-26);if(!width)return null;
  const headers=sheet.getRange(7,27,1,width).getValues()[0],index=headers.indexOf(AIKEY_SIMPLE_HEADERS[0]);
  if(index<0)return null;if(!AIKEY_SIMPLE_HEADERS.every((h,i)=>headers[index+i]===h))throw Error('简洁保护列顺序不匹配，停止写入');return 27+index;
}
function upgradeAIkeySimpleTable(){
  const book=SpreadsheetApp.getActiveSpreadsheet();if(!book)throw Error('请从管理表格运行升级');
  upgradeAIkeySimpleTable_(book);stopRetiredAIkeyTasks_();
  SpreadsheetApp.getUi().alert('简洁版升级完成。原表已自动备份，B:Z原资料保留，旧版用量列已隐藏。最低余额在插件03设置，再同步到本表。备份ID：'+PropertiesService.getScriptProperties().getProperty('AIKEY_SIMPLE_BACKUP_ID'));
}
function upgradeAIkeySimpleTable_(book){
  const sheet=verifyAIkeyLayout_(book),props=PropertiesService.getScriptProperties();
  if(!props.getProperty('AIKEY_SIMPLE_BACKUP_ID')){const backup=book.copy(book.getName()+'-简洁版升级前备份-'+Utilities.formatDate(new Date(),Session.getScriptTimeZone(),'yyyyMMdd-HHmmss'));props.setProperty('AIKEY_SIMPLE_BACKUP_ID',backup.getId());}
  if(sheet.getMaxRows()<207)sheet.insertRowsAfter(sheet.getMaxRows(),207-sheet.getMaxRows());
  const existingWidth=Math.max(0,Math.min(17,sheet.getMaxColumns()-26));let retiredEnd=26;
  if(existingWidth>=2){const legacy=sheet.getRange(7,27,1,existingWidth).getValues()[0];if(legacy[0]==='账号累计输入Token' && legacy[1]==='账号累计输出Token'){sheet.hideColumns(27,existingWidth);retiredEnd=26+existingWidth;}}
  let start=simpleColumns_(sheet);if(!start)start=Math.max(27,sheet.getLastColumn()+1,retiredEnd+1);
  if(sheet.getMaxColumns()<start+7)sheet.insertColumnsAfter(sheet.getMaxColumns(),start+7-sheet.getMaxColumns());
  const rows=Math.min(5000,Math.max(200,sheet.getMaxRows()-7));
  sheet.getRange(7,start,1,8).setValues([AIKEY_SIMPLE_HEADERS]).setBackground('#246f89').setFontColor('#ffffff').setFontWeight('bold').setWrap(true);
  sheet.setColumnWidths(start,8,165);sheet.setColumnWidth(start+1,285);sheet.setColumnWidth(start+5,320);
  sheet.getRange(8,start,rows,8).setBackground('#eaf4fc').setFontColor('#173951');
  sheet.getRange(8,start,rows,1).setNumberFormat('0.00');sheet.getRange(8,start+2,rows,3).setNumberFormat('yyyy/mm/dd hh:mm:ss');sheet.getRange(8,start+7,rows,1).setNumberFormat('yyyy/mm/dd hh:mm:ss');
  const daysCol=aiColumn_(start+6),dayAtCol=aiColumn_(start+7),minCol=aiColumn_(start);
  sheet.getRange(8,12,rows,1).setFormulas(Array.from({length:rows},(_,i)=>{const r=i+8;return ['=IF($I'+r+'="","",IF(ISNUMBER($K'+r+'),MAX(0,ROUNDUP($K'+r+'-NOW(),0)),IF(AND(ISNUMBER($'+daysCol+r+'),ISNUMBER($'+dayAtCol+r+')),MAX(0,$'+daysCol+r+'-INT(MAX(0,NOW()-$'+dayAtCol+r+'))),"")))'];}));
  sheet.getRange(8,13,rows,1).setFormulas(Array.from({length:rows},(_,i)=>{const r=i+8;return ['=IF($I'+r+'="","",IF(ISNUMBER($K'+r+'),IF($K'+r+'<=NOW(),"已到期","未到期"),IF(ISNUMBER($L'+r+'),IF($L'+r+'=0,"页面显示今天到期","页面约剩"&$L'+r+'&"天"),"待采集到期信息")))'];}));
  sheet.getRange(8,18,rows,1).setFormulas(Array.from({length:rows},(_,i)=>{const r=i+8;return ['=IF($I'+r+'="","",IF(NOT(ISNUMBER($P'+r+')),"待采集",IF(NOW()-$P'+r+'>5/1440,"页面快照超过5分钟","近期页面快照")))'];}));
  const marker='AIKEY_SIMPLE_256',oldRules=sheet.getConditionalFormatRules().filter(r=>!(r.getBooleanCondition() && r.getBooleanCondition().getCriteriaValues().some(v=>/AIKEY_SIMPLE_256|AIKEY_GUARD_250/.test(String(v)))));
  const amount='$N8',minimum='IF(ISNUMBER($'+minCol+'8),$'+minCol+'8,30)',bands=[[amount+'<='+minimum,'#f4a6a0'],[amount+'>'+minimum+','+amount+'<=50','#ffd1cc'],[amount+'>'+minimum+','+amount+'>50,'+amount+'<=80','#ffdf68'],[amount+'>'+minimum+','+amount+'>80,'+amount+'<=100','#fff4cc']];
  const rules=bands.map(([test,color])=>SpreadsheetApp.newConditionalFormatRule().whenFormulaSatisfied('=AND(N("'+marker+'")=0,$I8<>"",ISNUMBER('+amount+'),'+test+')').setBackground(color).setFontColor('#173951').setRanges([sheet.getRange(8,14,rows,7),sheet.getRange(8,start,rows,8)]).build());
  sheet.setConditionalFormatRules(rules.concat(oldRules));book.setRecalculationInterval(SpreadsheetApp.RecalculationInterval.MINUTE);props.setProperty('AIKEY_SIMPLE_TABLE_VERSION','2');SpreadsheetApp.flush();return sheet;
}
function jsonAIkey_(v){return ContentService.createTextOutput(JSON.stringify(v)).setMimeType(ContentService.MimeType.JSON);}
function doGet(){return jsonAIkey_({ok:false,error:'此地址只接受签名同步请求，不提供表格读取',schemaVersion:2});}
function safeAIText_(v){const s=String(v || '').slice(0,2200);return /^[=+@-]/.test(s)?"'"+s:s;}
function validAIStamp_(v){return v===null || Number.isSafeInteger(v)&&v>=946684800000&&v<=Date.now()+300000;}
function doPost(e){
  let lock;
  try{
    const text=e?.postData?.contents;if(typeof text!=='string'||text.length>65000)throw Error('请求大小无效');
    const envelope=JSON.parse(text),props=PropertiesService.getScriptProperties(),secret=props.getProperty('AIKEY_SYNC_SECRET'),target=props.getProperty('AIKEY_TARGET_ID');
    if(!secret || !target)throw Error('服务尚未初始化，请从管理表格运行初始化同步配置');
    if(envelope.version!==1 || !Number.isSafeInteger(envelope.timestamp)||Math.abs(Date.now()-envelope.timestamp)>300000 || !/^[a-zA-Z0-9-]{20,80}$/.test(envelope.nonce || '') || typeof envelope.payload!=='string'||envelope.payload.length>50000||!/^[0-9a-f]{64}$/.test(envelope.signature || ''))throw Error('签名格式或请求时间无效');
    const input=envelope.timestamp+'\n'+envelope.nonce+'\n'+envelope.payload,expected=Utilities.computeHmacSha256Signature(input,secret,Utilities.Charset.UTF_8).map(b=>((b+256)%256).toString(16).padStart(2,'0')).join('');
    let difference=0;for(let i=0;i<64;i++)difference|=expected.charCodeAt(i)^envelope.signature.charCodeAt(i);if(difference!==0)throw Error('签名验证失败');
    const data=JSON.parse(envelope.payload);if(!Array.isArray(data.accounts)||data.accounts.length>100)throw Error('账号列表无效');
    const seen={};for(const a of data.accounts){
      if(!a || !/^billingAccounts\/[A-Z0-9]{6}-[A-Z0-9]{6}-[A-Z0-9]{6}$/.test(a.account)||seen[a.account])throw Error('账号格式无效或重复');seen[a.account]=true;
      if(a.balance!==null && (typeof a.balance!=='number'||!Number.isFinite(a.balance)||a.balance<0||a.balance>1e9))throw Error('余额无效');
      if(!/^[A-Z]{3}$/.test(a.currency || '')||!['官方页面可见文本','手动记录'].includes(a.source))throw Error('币种或来源无效');
      for(const key of ['sampledAt','lastReadAt','valueChangedAt','accountCheckedAt','observedAt'])if(!validAIStamp_(a[key] ?? null))throw Error('采集或检查时间无效');
      if(a.balance!==null && !Number.isSafeInteger(a.sampledAt))throw Error('余额缺少有效快照时间');
      if(a.deadline!==null && a.deadline!==undefined && (!Number.isSafeInteger(a.deadline)||a.deadline<946684800000||a.deadline>4102444800000))throw Error('截止时间无效');
      if(a.observedDays!==null && a.observedDays!==undefined && (!Number.isInteger(a.observedDays)||a.observedDays<0||a.observedDays>366||!Number.isSafeInteger(a.observedAt)))throw Error('页面剩余天数无效');
      if(a.accountOpen!==null && a.accountOpen!==undefined && (typeof a.accountOpen!=='boolean'||!Number.isSafeInteger(a.accountCheckedAt)))throw Error('结算状态无效');
      const p=a.protection;if(p){
        if(p.version!==2||typeof p.threshold!=='number'||!Number.isFinite(p.threshold)||p.threshold<0||p.threshold>1e9||typeof p.enabled!=='boolean'||typeof p.status!=='string'||p.status.length>700||typeof p.jobs!=='string'||p.jobs.length>1500||!validAIStamp_(p.checkedAt ?? null)||!validAIStamp_(p.updatedAt ?? null))throw Error('最低余额或保护状态无效');
      }
    }
    lock=LockService.getScriptLock();lock.waitLock(20000);const cache=CacheService.getScriptCache();
    if(cache.get('aikey:'+envelope.nonce))return jsonAIkey_({ok:true,duplicate:true,updatedRows:0,protectionRows:0,unmatchedAccounts:0,protectionVersion:2});
    const book=SpreadsheetApp.openById(target),sheet=verifyAIkeyLayout_(book),start=simpleColumns_(sheet),count=Math.max(0,Math.min(5000,sheet.getLastRow()-7));
    const ids=count?sheet.getRange(8,9,count,1).getValues():[],previous=count?sheet.getRange(8,14,count,7).getValues():[],dates=count?sheet.getRange(8,11,count,1).getValues():[],matched={};let updatedRows=0,protectionRows=0;
    const received=new Date();
    for(const a of data.accounts)for(let i=0;i<count;i++){
      if('billingAccounts/'+String(ids[i][0] || '').trim().replace(/^billingAccounts\//i,'').toUpperCase()!==a.account)continue;
      matched[a.account]=true;const row=i+8,oldAt=previous[i][2] instanceof Date?previous[i][2].getTime():null;
      if(a.balance!==null && (oldAt===null||a.sampledAt>=oldAt)){sheet.getRange(row,14,1,4).setValues([[a.balance,a.currency,new Date(a.sampledAt),received]]);sheet.getRange(row,19).setValue(a.source);}else sheet.getRange(row,17).setValue(received);
      if(dates[i][0]==='' && Number.isSafeInteger(a.deadline))sheet.getRange(row,11).setValue(new Date(a.deadline));
      if(typeof a.accountOpen==='boolean' && Date.now()-a.accountCheckedAt<300000)sheet.getRange(row,20).setValue(a.accountOpen?'开放':'已关闭');else sheet.getRange(row,20).setValue('未实时核实');
      if(start){
        const p=a.protection,thresholdKey='AIKEY_MINIMUM_AT_'+a.account,previousSetting=Number(props.getProperty(thresholdKey) || 0),settingAt=p?.updatedAt || envelope.timestamp;
        if(p && settingAt>=previousSetting){sheet.getRange(row,start).setValue(p.threshold);props.setProperty(thresholdKey,String(settingAt));}
        if(p && settingAt>=previousSetting){sheet.getRange(row,start+1).setValue(safeAIText_((p.enabled?'已启用；':'未启用；')+p.status));sheet.getRange(row,start+2).setValue(p.checkedAt?new Date(p.checkedAt):'');sheet.getRange(row,start+5).setValue(safeAIText_(p.jobs));protectionRows++;}
        if(a.lastReadAt)sheet.getRange(row,start+3).setValue(new Date(a.lastReadAt));if(a.valueChangedAt)sheet.getRange(row,start+4).setValue(new Date(a.valueChangedAt));
        if(Number.isInteger(a.observedDays)){const oldDayAt=sheet.getRange(row,start+7).getValue();if(!(oldDayAt instanceof Date)||a.observedAt>=oldDayAt.getTime())sheet.getRange(row,start+6,1,2).setValues([[a.observedDays,new Date(a.observedAt)]]);}
      }updatedRows++;
    }
    SpreadsheetApp.flush();cache.put('aikey:'+envelope.nonce,'1',600);
    return jsonAIkey_({ok:true,updatedRows,protectionRows,unmatchedAccounts:data.accounts.filter(a=>!matched[a.account]).length,protectionVersion:start?2:0,spreadsheetUrl:book.getUrl(),needsUpgrade:!start});
  }catch(error){return jsonAIkey_({ok:false,error:String(error.message || '同步失败').slice(0,220)});}finally{if(lock?.hasLock())lock.releaseLock();}
}
