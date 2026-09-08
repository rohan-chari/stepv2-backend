#!/usr/bin/env node
const { prisma } = require('../src/db');
async function main() {
  const args = process.argv.slice(2);
  const userId = args.find(arg => arg.startsWith('--user-id='))?.slice(10);
  if (!userId || args.some(arg => !arg.startsWith('--user-id=') && arg !== '--apply')) {
    throw new Error('Usage: node scripts/billing-provision-sandbox.js --user-id=<UUID> [--apply]');
  }
  const result = await prisma.$transaction(async tx => {
    await tx.$queryRawUnsafe('SELECT id FROM users WHERE id=$1 FOR UPDATE',userId);
    const user = await tx.user.findUnique({where:{id:userId}});
    if (!user) throw new Error('Account not found');
    if (user.billingRealm === 'sandbox') return {userId,realm:'sandbox',changed:false};
    // The permanent DB guard rejects any production economic/social history.
    await tx.user.update({where:{id:userId},data:{billingRealm:'sandbox'}});
    if (!args.includes('--apply')) throw Object.assign(new Error('Dry run verified'),{dryRun:true,result:{userId,realm:'sandbox',eligible:true,applied:false}});
    return {userId,realm:'sandbox',changed:true};
  }).catch(error => { if (error.dryRun) return error.result; throw error; });
  console.log(JSON.stringify(result));
}
main().catch(error => { console.error(error.message); process.exitCode=1; }).finally(async () => {
  await prisma.$disconnect();
  process.exit(process.exitCode || 0);
});
