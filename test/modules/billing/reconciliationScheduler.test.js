const {it}=require('node:test');const assert=require('node:assert/strict');
const {scheduleBillingReconciliation}=require('../../../src/modules/billing/services/reconciliationWorker');
it('does not start unconfigured store polling and stops an in-flight configured worker cleanly',async()=>{
 assert.equal(scheduleBillingReconciliation({config:{}}),null);
 const tasks=[];let runs=0;const handle=scheduleBillingReconciliation({config:{projectId:'p',secretApiKey:'s',iosAppId:'i',androidAppId:'a',webhookAuthorization:'Bearer s',termsUrl:'https://example.com/terms',privacyUrl:'https://example.com/privacy'},run:async()=>{runs++;},setInterval:fn=>{tasks.push(fn);return 1;},clearInterval:()=>{},logger:{error(){}}});
 await new Promise(resolve=>setImmediate(resolve));assert.equal(runs,1);handle.stop();await tasks[0]();assert.equal(runs,1);
});
