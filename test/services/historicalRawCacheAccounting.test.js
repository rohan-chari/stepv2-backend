// Internal proof-capability/budget state cannot be selected by an HTTP client.
// Real HTTP+worker suites cover the public source/scoring path and Redis failures.
const assert = require('node:assert/strict');
const { test, after } = require('node:test');
const redis = require('../../src/shared/cache/redisCache');
const { prisma } = require('../../src/db');
const { coordinatedOptimizationMetrics: metrics } = require('../../src/shared/observability/coordinatedOptimizationMetrics');
const { loadHistoricalRawSamples, captureInitialProofRead } = require('../../src/modules/races/services/historicalRawSampleCache');
const original = { enabled: redis.isEnabled, eval: redis.evalLua, query: prisma.$queryRawUnsafe };
after(() => { redis.isEnabled=original.enabled;redis.evalLua=original.eval;prisma.$queryRawUnsafe=original.query; });
const cutoff = Date.parse('2026-09-11T00:00:00Z');
const bounds = [{userId:'account',rangeStart:new Date(cutoff-4*86400000),rangeEnd:new Date(cutoff+2*86400000)}];
const proof = {userId:'account',generation:'2',historicalRawRevision:'revision',historicalRawCompleteGeneration:'2',historicalRawProtectedCutoff:new Date(cutoff)};
class Timeline {
  constructor(rows=[]){this.rows=rows;this.length=rows.length;}
  forEach(fn){for(const row of this.rows)fn(...row);}
  append(rows){this.rows.push(...rows.map(row=>[row.start,row.end,row.steps]));this.length=this.rows.length;}
}
function count(kind,reason){return metrics.snapshot().counters[`race_scoring_cache_stage_total{kind=${kind},reason=${reason}}`]||0;}
function fixture({lookup='absent_unknown',proofRows=[proof],postProofRows=null,sourceRows=1,paged=false}={}){
  metrics.reset();let queries=0,operations=0;
  redis.isEnabled=()=>true;
  prisma.$queryRawUnsafe=async()=>{queries++;return postProofRows&&queries>1?postProofRows:proofRows;};
  redis.evalLua=async(_script,keys)=>{operations++;return {ok:true,result:keys.map(()=>[lookup,0])};};
  const load=async()=>{const timeline=new Timeline(Array.from({length:sourceRows},(_,i)=>[+bounds[0].rangeStart+i*1000,+bounds[0].rangeStart+(i+1)*1000,1]));timeline.isPaged=paged;return new Map([['account',timeline]]);};
  return { options:{bounds,now:new Date(cutoff+2*86400000),load,Timeline,maxRetainedSampleRowsPerUser:50000,maxHeapGrowthBytes:32*1024*1024,
    memoryUsage:()=>({heapUsed:0,external:0})},get queries(){return queries;},get operations(){return operations;}};
}
test('initial proof must match the attempt and can be consumed only once per exact user',async()=>{
  for(const wrongAttempt of [true,false]){
    const f=fixture(),attempt={};
    const handle=captureInitialProofRead([proof],['account'],attempt);
    await loadHistoricalRawSamples({...f.options,initialProofRead:handle,sourceAttempt:wrongAttempt?{}:attempt});
    assert.equal(f.queries,wrongAttempt?2:1);
    if(!wrongAttempt){await loadHistoricalRawSamples({...f.options,initialProofRead:handle,sourceAttempt:attempt});assert.equal(f.queries,3);}
  }
});
test('proof validation has exclusive missing, malformed and incomplete generation accounting',async()=>{
  for(const [reason,row]of [['missing',null],['malformed',{...proof,historicalRawProtectedCutoff:new Date(cutoff+1)}],
    ['incomplete_generation',{...proof,historicalRawCompleteGeneration:'1'}]]){
    const f=fixture({proofRows:row?[row]:[]});await loadHistoricalRawSamples(f.options);
    assert.equal(count('raw',reason),1);assert.equal(count('publication','no_proof'),1);assert.equal(f.operations,0);
  }
});
test('bounded lookup statuses are attributed without a second Redis diagnostic operation',async()=>{
  for(const reason of ['absent_unknown','oversized','batch_byte_budget']){
    const f=fixture({lookup:reason});await loadHistoricalRawSamples(f.options);
    assert.equal(count('lookup',reason),1);assert.equal(count('raw',reason),1);
    assert.equal(f.operations,2,'one lookup and one optional publication, no extra size probe');
  }
});
test('legacy full-timeline and paged admission retain existing bounds with attributed rejected rows',async()=>{
  let f=fixture({sourceRows:20001});await loadHistoricalRawSamples(f.options);
  assert.equal(count('publication','total_timeline_cap_legacy'),1);assert.equal(f.operations,1);
  assert.equal(metrics.snapshot().counters['race_scoring_cache_reason_rows_total{kind=publication,reason=total_timeline_cap_legacy}'],20001);
  f=fixture({paged:true});await loadHistoricalRawSamples(f.options);assert.equal(count('publication','paged_source'),1);
});
test('source and memory failures remain failures but never leave terminal accounting gaps',async()=>{
  let f=fixture();await assert.rejects(loadHistoricalRawSamples({...f.options,load:async()=>{throw new Error('source unavailable');}}),/source unavailable/);
  assert.equal(count('raw','source_failure'),1);
  f=fixture();let memoryReads=0;
  await assert.rejects(loadHistoricalRawSamples({...f.options,memoryUsage:()=>({heapUsed:memoryReads++?40*1024*1024:0})}),/memory guard/);
  assert.equal(count('raw','memory_guard'),1);
});
