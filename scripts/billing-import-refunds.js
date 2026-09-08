#!/usr/bin/env node
require('dotenv').config();
const {createReadStream}=require('node:fs');
const {prisma}=require('../src/db');
const {readBillingConfig}=require('../src/modules/billing/catalog');
const {importTransactionExport}=require('../src/modules/billing/services/transactionExport');
async function main(){const args=process.argv.slice(2),file=args.find(a=>a.startsWith('--file='))?.slice(7);if(!file)throw new Error('Usage: node scripts/billing-import-refunds.js --file=transactions.csv [--apply] (default: dry run)');const result=await importTransactionExport({db:prisma,config:readBillingConfig(),stream:createReadStream(file,{encoding:'utf8'}),apply:args.includes('--apply')});console.log(JSON.stringify(result));}
main().catch(error=>{console.error(error.message);process.exitCode=1;}).finally(async()=>{await prisma.$disconnect();process.exit(process.exitCode||0);});
