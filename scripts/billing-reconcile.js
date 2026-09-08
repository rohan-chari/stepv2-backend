#!/usr/bin/env node
// One pass over durable due work. No grants are accepted from command arguments.
require('dotenv').config();
const {prisma}=require('../src/db');
const {runBillingReconciliation}=require('../src/modules/billing/services/reconciliationWorker');
async function main(){const arg=process.argv.slice(2).find(a=>a.startsWith('--identity-id='));const result=await runBillingReconciliation({identityId:arg?.slice(14)||null});console.log(JSON.stringify(result));if(!result.available||result.failed)process.exitCode=1;}
main().catch(error=>{console.error(error.message);process.exitCode=1;}).finally(async()=>{await prisma.$disconnect();process.exit(process.exitCode||0);});
