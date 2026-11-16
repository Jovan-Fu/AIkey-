import {test} from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {scanPaymentsPage,summarizePayments,installPaymentReview} from '../payment-review.js';

test('payment scan separates holds from completed payments without returning card data or page text',()=>{
  const element=t=>({innerText:t,textContent:t,getClientRects:()=>[1],getAttribute:()=>null,querySelectorAll:()=>[]});
  const rows=[['Temporary authorization pending Visa 4111111111111111','USD 1.00'],['Payment completed Visa 5555555555554444','USD 3.00'],['Refund completed','USD 2.00'],['Payment pending','USD 4.00']].map(([t,amount])=>({...element(t+' '+amount),querySelectorAll:()=>[element(t),element(amount)]}));
  const context={document:{querySelector:()=>element('Billing 012345-ABCDEF-123456'),querySelectorAll:s=>s.startsWith('tr')?rows:[]},getComputedStyle:()=>({visibility:'visible'})};
  context.window ||= {addEventListener(){}};vm.createContext(context);const observation=vm.runInContext('('+scanPaymentsPage.toString()+')()',context);
  assert.equal(observation.rows.length,4);assert(!JSON.stringify(observation).includes('4111111111111111'));assert(!JSON.stringify(observation).includes('5555555555554444'));
  const summary=summarizePayments(observation);
  assert.equal(summary.totals.USD.authorization,1);assert.equal(summary.totals.USD.completedPayments,3);assert.equal(summary.totals.USD.completedRefunds,2);
  assert.equal(summary.unknownRows,1);assert.equal(summary.refundState,'eligibility-unknown');
});

test('unknown and negative ledger amounts do not become confirmed charges or refund entitlements',()=>{
  const summary=summarizePayments({rows:[{amount:-1,currency:'USD',kind:'payment',status:'completed'},{amount:3,currency:'UNKNOWN',kind:'payment',status:'completed'}],refundButtonVisible:true});
  assert.equal(summary.totals.USD.completedPayments,0);assert.equal(summary.unknownRows,2);assert.equal(summary.uncertainAmounts[0].amount,-1);
  assert.equal(summary.refundState,'official-button-visible');assert.throws(()=>summarizePayments({rows:[{amount:Infinity,currency:'USD',kind:'payment',status:'completed'}]}));
});

test('payment controller only reads fixed official pages for the selected account, rejects mismatches and does not click financial actions',async()=>{
  const account='billingAccounts/012345-ABCDEF-123456',connection={authUser:'2',tabId:7,accounts:[{name:account}]};let url='https://console.cloud.google.com/billing/history?authuser=2',ids=['012345-ABCDEF-123456'],scripts=0;
  globalThis.chrome={tabs:{get:async()=>({url}),create:async args=>{url=args.url;return {id:7};}},scripting:{executeScript:async args=>{scripts++;assert.equal(args.world,'ISOLATED');assert.equal(args.func,scanPaymentsPage);return [{frameId:0,result:{accountIds:ids,rows:[],refundButtonVisible:false}}];}}};
  try{
    const controller=installPaymentReview();
    await controller.handle({type:'PAYMENT_OPEN',account,page:'payment'},connection);assert.equal(new URL(url).pathname,'/billing/payment');
    assert.equal((await controller.handle({type:'PAYMENT_SCAN',account},connection)).loadedRows,0);
    ids=['000000-000000-000000'];await assert.rejects(()=>controller.handle({type:'PAYMENT_SCAN',account},connection),/未唯一核实/);
    url='https://evil.test/billing/history';const before=scripts;await assert.rejects(()=>controller.handle({type:'PAYMENT_SCAN',account},connection),/请先打开/);assert.equal(scripts,before);
    await assert.rejects(()=>controller.handle({type:'PAYMENT_OPEN',account,page:'https://evil.test'},connection),/不支持/);
  }finally{delete globalThis.chrome;}
});
