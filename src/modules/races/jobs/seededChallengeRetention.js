const { prisma: defaultPrisma } = require('../../../db');
const { JobRun: defaultJobRun } = require('../../../shared/db/jobRun');
const { dailyRunKey } = require('../../../shared/time/etSchedule');
const { createReceiptCleanupBudget } = require('../../../shared/queues/receiptCleanupBudget');
const JOB_NAME = 'seeded_challenge_receipt_retention';
const PAGE_SIZE = 500;
// Called by the single seeded coordinator; uses the established ET JobRun and
// WAL/replica budget framework. A failed or truncated pass retries next tick.
function buildSeededChallengeRetention(dependencies={}) {
  const prisma=dependencies.prisma||defaultPrisma;
  const jobRun=dependencies.JobRun||defaultJobRun;
  const now=dependencies.now||(()=>new Date());
  return async function cleanup(){
    const at=now();
    const key=dailyRunKey({now:at,targetHour:3,lastRanFor:await jobRun.lastRanFor(JOB_NAME)});
    if(!key)return {count:0};
    const cutoff=new Date(at.getTime()-30*86400000);
    const budget=createReceiptCleanupBudget({prisma});
    let count=0,done=true;
    for(const table of ['seeded_challenge_join_receipts','seeded_challenge_enrollment_requests']) {
      const terminal=table==='seeded_challenge_enrollment_requests'?"AND state='COMPLETE'":'';
      const page=await budget.runPage(async()=>{
        const removed=await prisma.$queryRawUnsafe(`DELETE FROM ${table} r USING (
          SELECT id FROM ${table} WHERE window_end<$1 ${terminal} ORDER BY window_end,id LIMIT ${PAGE_SIZE}
        ) expired WHERE r.id=expired.id RETURNING r.id`,cutoff);
        return removed.length;
      });
      count+=page.rows;
      if(page.rows===PAGE_SIZE)done=false;
      if(!page.allowedContinue){done=false;break;}
    }
    if(done)await jobRun.markRan(JOB_NAME,key);
    return {count,complete:done};
  };
}
module.exports={buildSeededChallengeRetention,PAGE_SIZE};
