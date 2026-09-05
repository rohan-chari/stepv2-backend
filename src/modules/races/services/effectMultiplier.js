// Single source of truth for the SIGNED effective step multiplier m(t)
// (buff-stacking spec §3). effectiveStepScoring.computeEffectModifiers,
// raceStateResolution.multiplierForTime, and globalStepEvent.computeGlobalEventBoost
// all delegate here so the three former copies can never drift again.
//
// Pure (no DB). `groups` carries the participant's effect rows split by type:
//   { legCramps, runnersHighs, wrongTurns, campfires, rainstorms, uprisings,
//     rallyFlags, coinFlipWins, coinFlipLoses, ghostPeppers }
// where `rainstorms` are the UMBRELLA-ADJUSTED windows (the caller subtracts each
// umbrella aura from the opponent-sourced rain windows BEFORE calling in, exactly
// as the pre-rewrite umbrella pass did).

function toMs(value) {
  return value instanceof Date ? value.getTime() : new Date(value).getTime();
}

// Retained fraction r of a reduction (RAINSTORM / COIN_FLIP lose): metadata
// multiplier clamped to [0,1], else the canonical 0.5. lostFraction = 1 − r.
function reductionLostFraction(effect) {
  const m = Number((effect.metadata || {}).multiplier);
  const r = Number.isFinite(m) && m >= 0 && m <= 1 ? m : 0.5;
  return 1 - r;
}

// Batch 2026-08-10b item 6 — kill switch for the MULTIPLICATIVE rainstorm.
//
// Read at CALL time (the idiom `discardDailyCap()` uses), not module load:
// this function is pure and DB-free, so an app setting is the wrong shape, but
// "revert the commit" is not adequate for a change that alters scoring for
// every in-flight race on restart. With this OFF a bad settlement is reverted
// by a pm2 reload rather than a deploy. Ships "false"; flipped on in prod after
// staging verification (architect R10).
function rainstormMultiplicativeEnabled() {
  return true;
}

// Every distinct multiplier-transition instant strictly inside (windowStart,
// windowEnd), plus the two endpoints — sorted and deduped. Slicing a window at
// these boundaries yields sub-intervals of constant m. windowStart/windowEnd are
// epoch ms.
function multiplierBoundaries(windowStart, windowEnd, groups = {}) {
  const bounds = new Set([windowStart, windowEnd]);
  const add = (ms) => {
    if (ms > windowStart && ms < windowEnd) bounds.add(ms);
  };
  const {
    legCramps = [],
    runnersHighs = [],
    wrongTurns = [],
    campfires = [],
    rainstorms = [],
    uprisings = [],
    rallyFlags = [],
    coinFlipWins = [],
    coinFlipLoses = [],
    ghostPeppers = [],
  } = groups;

  for (const e of [
    ...legCramps,
    ...runnersHighs,
    ...wrongTurns,
    ...rainstorms,
    ...uprisings,
    ...rallyFlags,
    ...coinFlipWins,
    ...coinFlipLoses,
  ]) {
    add(toMs(e.startsAt));
    if (e.expiresAt) add(toMs(e.expiresAt));
  }
  for (const e of campfires) {
    const startMs = toMs(e.startsAt);
    const freezeMs = (e.metadata || {}).freezeMs || 0;
    add(startMs);
    add(startMs + freezeMs); // freeze -> boost transition
    if (e.expiresAt) add(toMs(e.expiresAt));
  }
  for (const e of ghostPeppers) {
    const startMs = toMs(e.startsAt);
    const boostMs = Number((e.metadata || {}).boostMs) || 0;
    add(startMs);
    add(startMs + boostMs); // boost -> freeze transition
    if (e.expiresAt) add(toMs(e.expiresAt));
  }

  return [...bounds].sort((a, b) => a - b);
}

// Serializable, single-row arithmetic shared by ordinary scoring and durable
// scoring. The order is contractual: historical floating multipliers are added
// in precisely the old group/row order, not incrementally added/subtracted.
const MULTIPLIER_PHASES = [
  ["freeze", "legCramps"], ["campfireFreeze", "campfires"],
  ["ghostFreeze", "ghostPeppers"], ["runnerBuff", "runnersHighs"],
  ["campfireBuff", "campfires"], ["uprisingBuff", "uprisings"],
  ["rallyBuff", "rallyFlags"], ["coinBuff", "coinFlipWins"],
  ["ghostBuff", "ghostPeppers"], ["rain", "rainstorms"],
  ["coinLoss", "coinFlipLoses"], ["reverse", "wrongTurns"],
];
function newMultiplierAccumulator() {
  return { frozen: false, buffed: false, sum: 0, reduced: null, reversed: false };
}
function consumeMultiplierEffect(state, phase, effect, timeMs) {
  const start = toMs(effect.startsAt);
  const end = effect.expiresAt ? toMs(effect.expiresAt) : Infinity;
  const meta = effect.metadata || {};
  const active = start <= timeMs && timeMs < end;
  const freezeEnd = start + (meta.freezeMs || 0);
  const ghostEnd = start + (Number(meta.boostMs) || 0);
  if (phase === "freeze" && active || phase === "campfireFreeze" && start <= timeMs && timeMs < freezeEnd ||
      phase === "ghostFreeze" && ghostEnd <= timeMs && timeMs < end) state.frozen = true;
  let multiplier;
  if (phase === "runnerBuff" && active) multiplier = 2;
  if (phase === "campfireBuff" && freezeEnd <= timeMs && timeMs < end) multiplier = meta.multiplier || 1;
  if (phase === "uprisingBuff" && active) multiplier = Number(meta.multiplier) || 2;
  if (phase === "rallyBuff" && active) multiplier = Number(meta.multiplier) || 1.25;
  if (phase === "coinBuff" && active) {
    const m = Number(meta.multiplier); multiplier = Number.isFinite(m) && m > 1 ? m : 2;
  }
  if (phase === "ghostBuff" && start <= timeMs && timeMs < ghostEnd) multiplier = Number(meta.multiplier) || 3;
  if (multiplier !== undefined) { state.sum += multiplier; state.buffed = true; }
  if ((phase === "rain" || phase === "coinLoss") && active) {
    const m = state.buffed ? state.sum : 1;
    const lost = reductionLostFraction(effect);
    const candidate = phase === "rain" && rainstormMultiplicativeEnabled()
      ? m * (1 - lost) : Math.max(0, m - lost);
    state.reduced = state.reduced === null ? candidate : Math.min(state.reduced, candidate);
  }
  if (phase === "reverse" && active) state.reversed = true;
  return state;
}
function finishMultiplierAccumulator(state) {
  if (state.frozen) return 0;
  const m = state.reduced === null ? state.buffed ? state.sum : 1 : Math.max(0, state.reduced);
  return state.reversed ? -m : m;
}
function signedMultiplierAt(timeMs, groups = {}) {
  const state = newMultiplierAccumulator();
  for (const [phase, group] of MULTIPLIER_PHASES) {
    for (const effect of groups[group] || []) {
      consumeMultiplierEffect(state, phase, effect, timeMs);
      if (state.frozen) return 0;
    }
  }
  return finishMultiplierAccumulator(state);
}

// Compile metadata once, O(E log E). Only exact quarter-step dyadic buffs use
// running sums; arbitrary historical floats retain the serializable legacy
// accumulator above. Rain/coin minima never add floating point values.
// `umbrellas` remain masks rather than expanding R storms x U holes into R*U
// synthetic rows. Boundary visibility exactly matches the old subtraction.
function compileMultiplierTimeline(groups, umbrellas = [], nowMs) {
  const events = new Map();
  let safe = true;
  let firstStart = Infinity;
  const at = (time) => {
    if (!Number.isFinite(time)) return null;
    if (!events.has(time)) events.set(time, { ordinary: false, rainBoundary: false, changes: [] });
    return events.get(time);
  };
  const mark = (time, ordinary) => { const node = at(time); if (node) node[ordinary ? "ordinary" : "rainBoundary"] = true; };
  const interval = (start, end, kind, value = 1) => {
    if (!(end > start)) return;
    at(start)?.changes.push({ kind, value, direction: 1 });
    at(end)?.changes.push({ kind, value, direction: -1 });
  };
  const boundaries = (effect, rain = false) => {
    const start = toMs(effect.startsAt);
    const end = effect.expiresAt ? toMs(effect.expiresAt) : Infinity;
    mark(start, !rain);
    if (Number.isFinite(end)) mark(end, !rain);
    if (!rain) firstStart = Math.min(firstStart, start);
    return [start, end];
  };
  const buff = (start, end, value) => {
    if (typeof value !== "number" || !Number.isSafeInteger(value * 4) || Math.abs(value) > 65536) safe = false;
    interval(start, end, "buff", value);
  };
  for (const e of groups.legCramps || []) { const [s,t] = boundaries(e); interval(s,t,"freeze"); }
  for (const e of groups.wrongTurns || []) { const [s,t] = boundaries(e); interval(s,t,"reverse"); }
  for (const e of groups.runnersHighs || []) { const [s,t] = boundaries(e); buff(s,t,2); }
  for (const e of groups.campfires || []) {
    const [s,t] = boundaries(e); const phase = s + (e.metadata?.freezeMs || 0);
    mark(phase,true); interval(s,phase,"freeze"); buff(phase,t,e.metadata?.multiplier || 1);
  }
  for (const e of groups.ghostPeppers || []) {
    const [s,t] = boundaries(e); const phase = s + (Number(e.metadata?.boostMs) || 0);
    mark(phase,true); buff(s,phase,Number(e.metadata?.multiplier) || 3); interval(phase,t,"freeze");
  }
  for (const [group, fallback] of [["uprisings",2],["rallyFlags",1.25]]) {
    for (const e of groups[group] || []) { const [s,t] = boundaries(e); buff(s,t,Number(e.metadata?.multiplier) || fallback); }
  }
  for (const e of groups.coinFlipWins || []) {
    const [s,t] = boundaries(e); const m = Number(e.metadata?.multiplier); buff(s,t,Number.isFinite(m) && m > 1 ? m : 2);
  }
  for (const e of groups.coinFlipLoses || []) { const [s,t] = boundaries(e); interval(s,t,"coin",reductionLostFraction(e)); }
  const validUmbrellas = umbrellas.map((e) => [toMs(e.startsAt),e.expiresAt ? toMs(e.expiresAt) : nowMs])
    .filter(([s,t]) => Number.isFinite(s) && Number.isFinite(t) && t > s);
  for (const e of groups.rainstorms || []) {
    const start = toMs(e.startsAt);
    const end = e.expiresAt ? toMs(e.expiresAt) : validUmbrellas.length ? nowMs : Infinity;
    if (validUmbrellas.length && (!Number.isFinite(start) || !Number.isFinite(end) || end <= start)) continue;
    mark(start,!validUmbrellas.length);
    if (Number.isFinite(end)) mark(end,!validUmbrellas.length);
    if (!validUmbrellas.length) firstStart = Math.min(firstStart,start);
    interval(start,end,"rain",reductionLostFraction(e));
  }
  for (const [s,t] of validUmbrellas) { mark(s,false); mark(t,false); interval(s,t,"umbrella"); }
  // A maximum multiset implemented with a lazy max heap. Each input pushes at
  // most twice and is removed once, so repeated segments cannot rescan effects.
  const maxima = () => {
    const heap = []; const counts = new Map();
    return {
      add(value, direction) {
        counts.set(value,(counts.get(value) || 0) + direction);
        if (direction < 0) return;
        let i = heap.length; heap.push(value);
        while (i > 0) { const p = (i-1)>>1; if (heap[p] >= value) break; heap[i] = heap[p]; i=p; }
        heap[i]=value;
      },
      max() {
        while (heap.length && !(counts.get(heap[0]) > 0)) {
          const last = heap.pop(); if (!heap.length) break;
          let i=0; heap[0]=last;
          while (2*i+1<heap.length) {
            let child=2*i+1; if (child+1<heap.length && heap[child+1]>heap[child]) child++;
            if (heap[child]<=last) break; heap[i]=heap[child]; i=child;
          }
          heap[i]=last;
        }
        return heap.length ? heap[0] : null;
      },
    };
  };
  const rain = maxima(); const coin = maxima();
  const state = { freeze:0, reverse:0, buff:0, sum:0, rain:0, umbrella:0 };
  const points=[];
  for (const [time,node] of [...events].sort((a,b)=>a[0]-b[0])) {
    const rainBefore=state.rain>0 && !state.umbrella;
    for (const change of node.changes) {
      const {kind,value,direction}=change;
      if (kind === "buff") {
        state.buff+=direction;
        if (safe) { state.sum+=value*direction; if (!Number.isSafeInteger(state.sum*4)) safe=false; }
      }
      else if (kind === "coin") coin.add(value,direction);
      else if (kind === "rain") { rain.add(value,direction); state.rain+=direction; }
      else state[kind]+=direction;
    }
    const rainAfter=state.rain>0 && !state.umbrella;
    if (!node.ordinary && !(node.rainBoundary && (rainBefore || rainAfter))) continue;
    if (rainAfter) firstStart=Math.min(firstStart,time);
    const m=state.buff ? state.sum : 1;
    const rainLoss=state.umbrella ? null : rain.max(); const coinLoss=coin.max();
    let reduced=null;
    if (rainLoss !== null) reduced=m*(1-rainLoss);
    if (coinLoss !== null) { const candidate=Math.max(0,m-coinLoss); reduced=reduced===null ? candidate : Math.min(reduced,candidate); }
    const magnitude=reduced===null ? m : Math.max(0,reduced);
    points.push({ time, multiplier:safe ? state.freeze ? 0 : state.reverse ? -magnitude : magnitude : null,
      umbrella:state.umbrella>0 });
  }
  return { safe, firstStart:Number.isFinite(firstStart) ? firstStart : null, points };
}

module.exports = { signedMultiplierAt, multiplierBoundaries,
  MULTIPLIER_PHASES, newMultiplierAccumulator, consumeMultiplierEffect,
  finishMultiplierAccumulator, compileMultiplierTimeline };
