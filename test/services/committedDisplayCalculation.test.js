const { it } = require('node:test');
const assert = require('node:assert/strict');
const { buildCommittedDisplayCalculationCache } = require('../../src/modules/races/services/committedDisplayCalculation');
// Pure calendar/expiry math: test both clocks independently without clock sleeps.
function fixture(timezone, jobTimezone, asOf) {
  const job = {raceId:'race',processingTimeZone:jobTimezone,processingTriggeredByUserIds:['viewer']};
  const at = new Date(asOf);
  const fingerprint = {digest:'same',race:{status:'ACTIVE',timezone,startedAt:at.getTime()-86400000,endsAt:at.getTime()+86400000},participants:[],scoringEffects:[],globalEvents:[],nextSampleBoundary:null};
  const result = {race:{participants:[]},displayCapture:{asOf:at},activeImpactCapture:{asOf:at}};
  return {job,at,fingerprint,result,cache:buildCommittedDisplayCalculationCache()};
}
for (const [raceTz,jobTz,asOf] of [
  ['America/New_York','UTC','2026-09-08T03:59:50Z'],
  [' America/New_York ','UTC','2026-09-08T03:59:50Z'],
  [null,'America/New_York','2026-09-07T23:59:50Z'],
  [null,'America/New_York','2026-09-08T03:59:50Z'],
]) it(`rejects crossed scoring/box midnight: ${raceTz}/${jobTz}/${asOf}`,()=>{
  const f=fixture(raceTz,jobTz,asOf);
  f.cache.put(f.job,f.fingerprint,f.result,f.at);
  assert.ok(f.cache.get(f.job,f.fingerprint,new Date(f.at.getTime()+1000)));
  assert.equal(f.cache.get(f.job,f.fingerprint,new Date(f.at.getTime()+20000)),null);
  // A commit after midnight must not relabel yesterday's calculation as today.
  f.cache.put(f.job,f.fingerprint,f.result,new Date(f.at.getTime()+20000));
  assert.equal(f.cache.get(f.job,f.fingerprint,new Date(f.at.getTime()+21000)),null);
});
it('expires from calculation time and at race end, never from insertion time',()=>{
 const f=fixture('UTC','UTC','2026-09-07T12:00:00Z');
 f.cache.put(f.job,f.fingerprint,f.result,new Date(f.at.getTime()+30000));
 assert.equal(f.cache.get(f.job,f.fingerprint,new Date(f.at.getTime()+60000)),null);
 f.fingerprint.race.endsAt=f.at.getTime()+20000;
 f.cache.put(f.job,f.fingerprint,f.result,f.at);
 assert.equal(f.cache.get(f.job,f.fingerprint,new Date(f.at.getTime()+20000)),null);
});
