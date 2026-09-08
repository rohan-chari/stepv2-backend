const {createHash}=require('node:crypto');
const {PRODUCTS}=require('../catalog');
const {enqueue}=require('../commands/inbox');
// Streaming RFC4180-style records; never load a whole transaction export into RAM.
async function* readCsv(stream){
 let row=[],cell='',quoted=false,afterQuote=false,size=0;
 for await(const chunk of stream){for(const c of String(chunk)){
  if(++size>1024*1024)throw new Error('CSV record exceeds 1 MiB');
  if(quoted){if(c==='"'){quoted=false;afterQuote=true;}else cell+=c;continue;}
  if(afterQuote&&c==='"'){quoted=true;afterQuote=false;cell+='"';continue;}
  if(c===','){row.push(cell);cell='';afterQuote=false;continue;}
  if(c==='\n'){row.push(cell);yield row;row=[];cell='';afterQuote=false;size=0;continue;}
  if(c==='\r')continue;
  if(c==='"'&&!cell&&!afterQuote){quoted=true;continue;}
  if(afterQuote){if(c===' '||c==='\t')continue;throw new Error('Invalid character after CSV quote');}
  cell+=c;
 }}
 if(quoted)throw new Error('Unterminated CSV quoted field');
 if(row.length||cell||afterQuote){row.push(cell);yield row;}
}
const REQUIRED=['store_transaction_id','product_identifier','store','is_sandbox','rc_original_app_user_id','refunded_at','updated_at'];
function exportDate(value){let text=String(value||'').trim();if(!text||text.toLowerCase()==='null')return null;if(/^\d{4}-\d\d-\d\d \d\d:/.test(text))text=text.replace(' ','T')+'Z';const date=new Date(text);if(!Number.isFinite(date.getTime()))throw new Error('Invalid export timestamp');return date;}
async function importTransactionExport({db,config,stream,apply=false}){
 let headers=null,line=0;const report={apply,rows:0,queued:0,unmatched:0,ignored:0};
 for await(const values of readCsv(stream)){line++;if(!headers){headers=values.map(h=>h.replace(/^\uFEFF/,'').trim());if(REQUIRED.some(k=>!headers.includes(k)))throw new Error(`Export requires columns: ${REQUIRED.join(', ')}`);continue;}
  if(values.every(v=>!v.trim()))continue;if(values.length!==headers.length)throw new Error(`Invalid CSV column count on record ${line}`);report.rows++;
  const row=Object.fromEntries(headers.map((h,i)=>[h,values[i]]));
  const platform=row.store==='app_store'?'ios':row.store==='play_store'?'android':null;if(!platform){report.ignored++;continue;}
  if(!['true','false'].includes(row.is_sandbox.toLowerCase()))throw new Error(`Invalid sandbox field on record ${line}`);
  const environment=row.is_sandbox.toLowerCase()==='true'?'sandbox':'production';
  const identity=await db.billingIdentity.findUnique({where:{id:row.rc_original_app_user_id}});
  if(!identity||identity.deletedAt||identity.environment!==environment){report.unmatched++;continue;}
  const candidates=PRODUCTS.filter(p=>p[platform]===row.product_identifier||(platform==='android'&&p[platform].split(':')[0]===row.product_identifier));if(!candidates.length){report.ignored++;continue;}
  const updated=exportDate(row.updated_at),refunded=exportDate(row.refunded_at);if(!updated)throw new Error(`Missing updated_at on record ${line}`);
  const receipt=await db.billingPurchase.findFirst({where:{identityId:identity.id,projectId:config.projectId,store:row.store,environment,transactionId:row.store_transaction_id}});
  if(receipt&&!candidates.some(p=>p.id===receipt.productId))throw new Error(`Export product does not match verified transaction on record ${line}`);
  const product=receipt?PRODUCTS.find(p=>p.id===receipt.productId):candidates[0];
  const appId=config[`${platform}AppId`];if(!config.projectId||!appId)throw new Error('RevenueCat project/app configuration is required');
  const id='export:'+createHash('sha256').update(JSON.stringify([config.projectId,identity.id,row.store,environment,row.store_transaction_id,row.product_identifier,updated.toISOString(),refunded?.toISOString()||null])).digest('hex');
  const event={id,type:refunded?'CANCELLATION':'REFUND_REVERSED',cancel_reason:refunded?'CUSTOMER_SUPPORT':undefined,app_user_id:identity.id,app_id:appId,environment:environment.toUpperCase(),store:platform==='ios'?'APP_STORE':'PLAY_STORE',product_id:receipt?product[platform]:row.product_identifier,transaction_id:row.store_transaction_id,event_timestamp_ms:updated.getTime(),refunded_at_ms:refunded?.getTime()||null};
  if(apply)await db.$transaction(async tx=>{await tx.$executeRawUnsafe('INSERT INTO billing_inbox (id, identity_id, payload, created_at) VALUES ($1, $2, $3::jsonb, NOW()) ON CONFLICT (id) DO NOTHING',id,identity.id,JSON.stringify({source:'revenuecat_transactions_export',event}));await enqueue(tx,identity.id);});
  report.queued++;if(!receipt)report.unmatched++;
 }
 if(!headers)throw new Error('Empty export file');return report;
}
module.exports={readCsv,importTransactionExport,exportDate};
