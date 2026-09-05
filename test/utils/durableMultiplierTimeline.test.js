const assert=require("node:assert/strict");
const {describe,it}=require("node:test");
const {signedMultiplierAt,multiplierBoundaries,compileMultiplierTimeline,
  MULTIPLIER_PHASES,newMultiplierAccumulator,consumeMultiplierEffect,finishMultiplierAccumulator}=require("../../src/modules/races/services/effectMultiplier");
const {umbrellaAdjustedRainstorms}=require("../../src/modules/races/services/effectiveStepScoring");

// Pure math property: test every generated boundary, including shapes that
// cannot be emitted by the public power-up cast endpoint. The HTTP stage suite
// separately proves real sync/worker/cursor behaviour.
const effect=(start,end,metadata={})=>({startsAt:new Date(start),expiresAt:end===null ? null : new Date(end),metadata});
function check(groups,umbrellas=[],end=1000) {
  const legacy={...groups,rainstorms:umbrellaAdjustedRainstorms(groups.rainstorms || [],umbrellas,end)};
  const compiled=compileMultiplierTimeline(groups,umbrellas,end);
  const expected=multiplierBoundaries(0,end,legacy);
  assert.deepEqual([0,...compiled.points.map((p)=>p.time).filter((t)=>t>0 && t<end),end],expected);
  for (const time of expected.slice(0,-1)) {
    const point=compiled.points.findLast((p)=>p.time<=time);
    if (compiled.safe) assert.equal(point?.multiplier ?? 1,signedMultiplierAt(time,legacy),`at ${time}`);
    else {
      const state=newMultiplierAccumulator();
      for (const [phase,key] of MULTIPLIER_PHASES) for (const row of groups[key] || []) {
        if (!(phase==="rain" && point?.umbrella)) consumeMultiplierEffect(state,phase,row,time);
      }
      assert.equal(finishMultiplierAccumulator(state),signedMultiplierAt(time,legacy));
    }
  }
  return compiled;
}
describe("durable multiplier endpoint plan",()=>{
  it("matches freeze, reverse, summed buffs, mixed reductions, and overlapping umbrella holes",()=>{
    check({legCramps:[effect(110,140)],runnersHighs:[effect(0,900)],wrongTurns:[effect(300,600)],
      campfires:[effect(100,800,{freezeMs:120,multiplier:2})],ghostPeppers:[effect(50,700,{boostMs:400,multiplier:3})],
      uprisings:[effect(0,1000,{multiplier:2})],rallyFlags:[effect(10,1000,{multiplier:1.25})],
      rainstorms:[effect(0,1000,{multiplier:.5}),effect(200,750,{multiplier:.25})],
      coinFlipWins:[effect(30,500,{multiplier:2})],coinFlipLoses:[effect(40,950,{multiplier:.25})]},
      [effect(70,240),effect(150,320),effect(500,510)]);
  });
  it("keeps legacy floating group order for non-dyadic and string metadata",()=>{
    const groups={campfires:[effect(0,1000,{multiplier:"1.1"})],rallyFlags:[effect(0,1000,{multiplier:.1}),effect(0,1000,{multiplier:.2})]};
    assert.equal(check(groups).safe,false);
    assert.equal(signedMultiplierAt(10,groups),"01.10.10.2");
    assert.equal(check({rallyFlags:[effect(0,1000,{multiplier:.1}),effect(0,1000,{multiplier:.2})]}).safe,false);
  });
  it("preserves unusual phase/expiry ordering and fully hidden storm boundaries",()=>{
    check({campfires:[effect(200,300,{freezeMs:600,multiplier:2})],ghostPeppers:[effect(100,400,{boostMs:700,multiplier:3})],
      rainstorms:[effect(150,250),effect(350,450)]},[effect(0,1000)]);
    check({rainstorms:[effect(100,null),effect(300,350)]},[effect(50,150),effect(350,400)]);
  });
  it("matches generated boundary sets without storm-by-umbrella expansion",()=>{
    let seed=5; const random=()=>{ seed=(seed*1664525+1013904223)>>>0; return seed%1000; };
    for (let repetition=0;repetition<50;repetition++) {
      const storms=[],umbrellas=[],buffs=[];
      for (let i=0;i<12;i++) { const s=random(); storms.push(effect(s,s+1+random(),{multiplier:.5}));
        const u=random(); umbrellas.push(effect(u,u+1+random())); const b=random(); buffs.push(effect(b,b+1+random())); }
      check({rainstorms:storms,runnersHighs:buffs},umbrellas);
    }
  });
});
