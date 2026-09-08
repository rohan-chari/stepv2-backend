const assert = require('node:assert/strict');
const root=require('node:path').resolve(__dirname,'../..');
const target=new URL(process.env.DATABASE_URL);
assert.equal(target.hostname,'127.0.0.1');
const { Client }=require(root+'/node_modules/pg');
assert.equal(new URL(process.env.DATABASE_URL).port,'56439');
assert.match(new URL(process.env.DATABASE_URL).pathname,/_test$/);
const { prisma }=require(root+'/src/db');
const control=new Client({host:'127.0.0.1',port:56439,user:target.username,database:'pgbouncer'});
let created=false;
(async()=>{
 await control.connect();
 await prisma.$executeRawUnsafe('CREATE TABLE prepared_hook_probe (id integer PRIMARY KEY, value text NOT NULL)');
 created=true;
 const sql='/* steps:prepared-read:v1 */ SELECT value FROM prepared_hook_probe WHERE id=$1::integer';
 await prisma.$executeRawUnsafe("INSERT INTO prepared_hook_probe VALUES (1,'initial')");
 for(let i=0;i<10;i++)assert.equal((await prisma.$queryRawUnsafe(sql,1))[0].value,'initial');
 await assert.rejects(prisma.$transaction(async tx=>{
  await tx.$executeRawUnsafe("UPDATE prepared_hook_probe SET value='rollback'");
  assert.equal((await tx.$queryRawUnsafe(sql,1))[0].value,'rollback');
  await tx.$queryRawUnsafe('SELECT 1/0');
 }), error => error.code === 'P2010' && JSON.stringify(error.meta).includes('22012'));
 assert.equal((await prisma.$queryRawUnsafe(sql,1))[0].value,'initial');
 await control.query('RECONNECT steps_query_efficiency_test');
 assert.equal((await prisma.$queryRawUnsafe(sql,1))[0].value,'initial');
 await prisma.$executeRawUnsafe('ALTER TABLE prepared_hook_probe ADD COLUMN extra integer');
 assert.equal((await prisma.$queryRawUnsafe(sql,1))[0].value,'initial');
 await prisma.$executeRawUnsafe('ALTER TABLE prepared_hook_probe DROP COLUMN extra');
 await prisma.$executeRawUnsafe("UPDATE prepared_hook_probe SET value='committed'");
 assert.equal((await prisma.$queryRawUnsafe(sql,1))[0].value,'committed');
 console.log('PASS production hook: transaction error/rollback, backend reconnect, additive DDL, changed committed values');
})().catch(e=>{console.error(e);process.exitCode=1;}).finally(async()=>{
 if(created)await prisma.$executeRawUnsafe('DROP TABLE prepared_hook_probe');
 await prisma.$disconnect();await control.end();
 process.exit(process.exitCode || 0);
});
