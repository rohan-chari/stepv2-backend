#!/usr/bin/env node
require('dotenv').config();
const {prisma}=require('../src/db');
const {publishCosmetic}=require('../src/modules/billing/commands/publishCosmetic');
async function main(){const args=process.argv.slice(2),value=name=>args.find(a=>a.startsWith(`--${name}=`))?.slice(name.length+3);const result=await publishCosmetic({db:prisma,month:value('month'),itemId:value('item-id'),apply:args.includes('--apply')});console.log(JSON.stringify(result));}
main().catch(error=>{console.error(error.message);process.exitCode=1;}).finally(async()=>{await prisma.$disconnect();process.exit(process.exitCode||0);});
