const { createBaseAdjustedPlan, startDayContribution,preLeechScoringTotal } = require("../../races/services/raceStateResolution");
const { subsequentDayWindow, subsequentDayContribution } = require("../../races/raceSteps");
const { addDaysToDateString } = require("../../../shared/time/week");
const { compileMultiplierTimeline, MULTIPLIER_PHASES, newMultiplierAccumulator,
  consumeMultiplierEffect, finishMultiplierAccumulator } = require("../../races/services/effectMultiplier");
const { computeEffectModifiersFallback, mergeRainstormWindows, reduceEffectSegment } = require("../../races/services/effectiveStepScoring");
const { computeLeechEarnedTransfer, resolveLeechDrain } = require("../../powerups/leechTransfers");
const { hitchhikeCopyRatio,hitchhikeScoringWindow,hitchhikeExactContribution,hitchhikeFlooredBalance } = require("../../powerups/hitchhikeCopies");
const { globalEventSegmentBoost } = require("../globalStepEvent");
const { capturedHitchhikeInputs } = require("./capturedHitchhikeInputs");
const { SETTLEMENT_EFFECT_TYPES } = require("../../races/services/raceScoringEffectTypes");

const COPY_TYPES = ["LEG_CRAMP","QUICKSAND","RUNNERS_HIGH","WRONG_TURN","CAMPFIRE_REST","RAINSTORM"];
const FAILURE = (message, code = "INPUTS_NOT_RETAINED") => Object.assign(new Error(message),{ code });
const ms = (value) => new Date(value).getTime();
const chronological = (a,b) => ms(a.startsAt)-ms(b.startsAt) || String(a.id).localeCompare(String(b.id));
const blankTerms = () => ({ frozenSteps:0,buffedSteps:0,reversedSteps:0,globalBoostedSteps:0 });
const json = (value) => JSON.stringify(value);
function groupsFor(effects) {
  const byType = new Map();
  for (const effect of effects) { if (!byType.has(effect.type)) byType.set(effect.type,[]); byType.get(effect.type).push(effect); }
  const get = (type) => byType.get(type) || [];
  return { legCramps:[...get("LEG_CRAMP"),...get("QUICKSAND")],runnersHighs:get("RUNNERS_HIGH"),wrongTurns:get("WRONG_TURN"),
    campfires:get("CAMPFIRE_REST"),rainstorms:get("RAINSTORM"),uprisings:get("UPRISING"),rallyFlags:get("RALLY_FLAG"),
    coinFlipWins:get("COIN_FLIP").filter((e)=>Number(e.metadata?.multiplier)>1),
    coinFlipLoses:get("COIN_FLIP").filter((e)=>Number.isFinite(Number(e.metadata?.multiplier)) && Number(e.metadata?.multiplier)<1),
    ghostPeppers:get("GHOST_PEPPER"),umbrellas:get("UMBRELLA") };
}

// Fences both cursor and immutable-item writes. A late worker may finish a
// read-only scalar projection, but cannot advance accepted scoring or publish.
async function fenced(client, requestId, leaseToken, action) {
  return client.$transaction(async (tx) => {
    const rows = await tx.$queryRawUnsafe(`SELECT id FROM durable_global_event_capture_requests
      WHERE id=$1::uuid AND status='PROCESSING' AND lease_token=$2::uuid
        AND lease_until>clock_timestamp() AND expires_at>clock_timestamp() FOR UPDATE`,requestId,leaseToken);
    if (!rows.length) throw FAILURE("Durable scoring lease was lost","CAPTURE_LEASE_LOST");
    return action(tx);
  });
}

async function advanceDurableCaptureScore({ client,requestId,raceId,leaseToken,capture,models,budget = { operations:64 } }) {
  const payload = capture.payload;
  const participants = payload.participants || [];
  const byId = new Map(participants.map((p)=>[p.id,p]));
  const byUser = new Map(participants.map((p)=>[p.userId,p]));
  const evaluatedIds = payload.scoringPlan?.evaluatedParticipantIds || participants.map((p)=>p.id);
  // Context is already limited to16MiB at intake. This metadata indexing is
  // linear; no raw facts or scored participant arrays are rebuilt on resume.
  const effectsByParticipant = new Map(); const copiesByUser = new Map();
  for (const effect of payload.effects || []) {
    if (!effectsByParticipant.has(effect.targetParticipantId)) effectsByParticipant.set(effect.targetParticipantId,[]);
    effectsByParticipant.get(effect.targetParticipantId).push(effect);
    if (effect.type === "HITCHHIKE") {
      if (!copiesByUser.has(effect.sourceUserId)) copiesByUser.set(effect.sourceUserId,[]);
      copiesByUser.get(effect.sourceUserId).push(effect);
    }
  }
  for (const list of effectsByParticipant.values()) list.sort(chronological);
  for (const list of copiesByUser.values()) list.sort(chronological);
  const contextCache = new Map();
  function effectContext(participant,copy = false) {
    const key = `${copy ? "copy" : "local"}:${participant.id}`;
    if (contextCache.has(key)) return contextCache.get(key);
    const types = copy ? COPY_TYPES : SETTLEMENT_EFFECT_TYPES;
    const list = payload.race.powerupsEnabled ? effectsByParticipant.get(participant.id) || [] : [];
    const effects = types.flatMap((type)=>list.filter((e)=>e.type===type));
    const groups = groupsFor(effects);
    const rows = MULTIPLIER_PHASES.flatMap(([phase,group])=>(groups[group] || []).map((effect)=>({ phase,effect })));
    const result = { key,effects,groups,rows,leeches:list.filter((effect)=>effect.type==="LEECH") };
    contextCache.set(key,result); return result;
  }
  let [stored] = await client.$queryRawUnsafe(`SELECT *,state_digest=encode(sha256(convert_to(state::text,'UTF8')),'hex') AS valid
    FROM durable_capture_score_progress WHERE request_id=$1::uuid AND race_id=$2`,requestId,raceId);
  if (stored && !stored.valid) throw FAILURE("Durable score cursor is corrupt");
  if (!stored) {
    const initial = { version:1,stage:"PLAN",participantIndex:0,uploaderRemaining:[0,0],credit:[0,0],transferCount:0,readTransferCount:0 };
    await fenced(client,requestId,leaseToken,async (tx)=>{
      await tx.$executeRawUnsafe(`INSERT INTO durable_capture_score_owners(id,live_request_id)
        VALUES($1::uuid,$1::uuid) ON CONFLICT DO NOTHING`,requestId);
      return tx.$executeRawUnsafe(`INSERT INTO durable_capture_score_progress
      (request_id,race_id,state,state_digest) VALUES($1::uuid,$2,$3::jsonb,encode(sha256(convert_to(($3::jsonb)::text,'UTF8')),'hex'))
      ON CONFLICT DO NOTHING`,requestId,raceId,json(initial));
    });
    [stored] = await client.$queryRawUnsafe(`SELECT *,state_digest=encode(sha256(convert_to(state::text,'UTF8')),'hex') AS valid
      FROM durable_capture_score_progress WHERE request_id=$1::uuid AND race_id=$2`,requestId,raceId);
    if (!stored?.valid) throw FAILURE("Durable score cursor is missing");
  }
  let state = stored.state; let revision = stored.revision; let operations = 0;
  const planCache = new Map();
  const hitchAdapter = capturedHitchhikeInputs(payload.hitchhikeCaptures || []);
  const eventEnd = ms(payload.event.endsAt);
  const isFrozen = (p) => [p.finishedAt,p.forfeitedAt].filter(Boolean).some((v)=>ms(v)<=eventEnd);
  async function checkpoint(next, charge = 1, transfer = null, additionalWrite = null) {
    await fenced(client,requestId,leaseToken,async (tx)=>{
      const updated = await tx.$executeRawUnsafe(`UPDATE durable_capture_score_progress
        SET state=$4::jsonb,state_digest=encode(sha256(convert_to(($4::jsonb)::text,'UTF8')),'hex'),
          stage=$5,revision=revision+1,completed_operations=completed_operations+$6,updated_at=clock_timestamp()
        WHERE request_id=$1::uuid AND race_id=$2 AND revision=$3`,requestId,raceId,revision,json(next),next.stage,charge);
      if (!updated) throw FAILURE("Durable score cursor was advanced by another worker","CAPTURE_LEASE_LOST");
      if (additionalWrite) await additionalWrite(tx);
      if (transfer) await tx.$executeRawUnsafe(`INSERT INTO durable_capture_score_transfers
        (request_id,race_id,effect_id,starts_ms,payload,payload_digest)
        VALUES($1::uuid,$2,$3,$4,$5::jsonb,encode(sha256(convert_to(($5::jsonb)::text,'UTF8')),'hex'))`,
        requestId,raceId,transfer.effectId,transfer.startsMs,json(transfer));
    });
    state=next; revision=BigInt(revision)+1n; operations+=charge; budget.operations-=charge;
  }
  async function ensurePlan(context, now) {
    if (planCache.has(context.key)) return planCache.get(context.key);
    let [plan] = await client.$queryRawUnsafe(`SELECT metadata,point_count,build_cursor,
      metadata_digest=encode(sha256(convert_to(metadata::text,'UTF8')),'hex') AS valid
      FROM durable_capture_score_plans WHERE request_id=$1::uuid AND race_id=$2 AND plan_key=$3`,requestId,raceId,context.key);
    if (plan && (!plan.valid || plan.point_count!==plan.metadata.pointCount ||
        plan.build_cursor>plan.point_count || plan.build_cursor<0)) throw FAILURE("Durable multiplier plan is corrupt");
    if (!plan) {
      // One-time immutable metadata compilation, not billed as one arbitrary
      // arithmetic operation: its explicit16MiB source cap bounds this sort.
      // Endpoint persistence/scoring below is separately operation-budgeted.
      const compiled = compileMultiplierTimeline(context.groups,context.groups.umbrellas,now);
      const metadata = { safe:compiled.safe,firstStart:compiled.firstStart,pointCount:compiled.points.length };
      await fenced(client,requestId,leaseToken,(tx)=>tx.$executeRawUnsafe(`INSERT INTO durable_capture_score_plans
        (request_id,race_id,plan_key,metadata,metadata_digest,pending_points,point_count)
        VALUES($1::uuid,$2,$3,$4::jsonb,encode(sha256(convert_to(($4::jsonb)::text,'UTF8')),'hex'),
          (SELECT coalesce(jsonb_agg(jsonb_build_object('point',point,
            'digest',encode(sha256(convert_to(point::text,'UTF8')),'hex'))),'[]'::jsonb)
           FROM jsonb_array_elements($5::jsonb) point),$6) ON CONFLICT DO NOTHING`,
        requestId,raceId,context.key,json(metadata),json(compiled.points),compiled.points.length));
      return null;
    }
    if (plan.build_cursor < plan.point_count) {
      const count=Math.min(128,budget.operations,plan.point_count-plan.build_cursor);
      await checkpoint({...state},count,null,async (tx)=>{
        const inserted=await tx.$executeRawUnsafe(`INSERT INTO durable_capture_score_points
          (request_id,race_id,plan_key,position,time_ms,payload,payload_digest)
          SELECT request_id,race_id,plan_key,n,(pending_points->n->'point'->>'time')::bigint,pending_points->n->'point',
            pending_points->n->>'digest'
          FROM durable_capture_score_plans,generate_series($4::int,$5::int) n
          WHERE request_id=$1::uuid AND race_id=$2 AND plan_key=$3
            AND pending_points->n->>'digest'=encode(sha256(convert_to((pending_points->n->'point')::text,'UTF8')),'hex')`,
          requestId,raceId,context.key,plan.build_cursor,plan.build_cursor+count-1);
        if(inserted!==count) throw FAILURE("Pending durable multiplier point is corrupt or missing");
        await tx.$executeRawUnsafe(`UPDATE durable_capture_score_plans SET build_cursor=$4,
          pending_points=CASE WHEN $4=point_count THEN NULL ELSE pending_points END,
          pending_digest=CASE WHEN $4=point_count THEN NULL ELSE pending_digest END
          WHERE request_id=$1::uuid AND race_id=$2 AND plan_key=$3`,requestId,raceId,context.key,plan.build_cursor+count);
      });
      return null;
    }
    planCache.set(context.key,plan.metadata); return plan.metadata;
  }
  async function segment(context,start,end) {
    const nodes=await client.$queryRawUnsafe(`(SELECT position,time_ms,payload,payload_digest=encode(sha256(convert_to(payload::text,'UTF8')),'hex') AS valid
       FROM durable_capture_score_points WHERE request_id=$1::uuid AND race_id=$2 AND plan_key=$3 AND time_ms<=$4
       ORDER BY time_ms DESC LIMIT 1) UNION ALL
      (SELECT position,time_ms,payload,payload_digest=encode(sha256(convert_to(payload::text,'UTF8')),'hex') AS valid
       FROM durable_capture_score_points WHERE request_id=$1::uuid AND race_id=$2 AND plan_key=$3 AND time_ms>$4
       ORDER BY time_ms LIMIT 1)`,requestId,raceId,context.key,start);
    if (nodes.some((node)=>!node.valid || Number(node.time_ms)!==node.payload.time)) throw FAILURE("Durable multiplier point is corrupt");
    const before=nodes.find((node)=>node.payload.time<=start); const after=nodes.find((node)=>node.payload.time>start);
    const plan=planCache.get(context.key);
    if ((after ? after.position : plan.pointCount)!==(before ? before.position+1 : 0)) throw FAILURE("Durable multiplier point is missing");
    return { start,end:Math.min(end,after ? after.payload.time : end),
      multiplier:plan.safe ? before ? before.payload.multiplier : 1 : null,
      umbrella:before?.payload.umbrella || false };
  }
  // A modifier engine owns one cursor and one set of terms. Each sample read,
  // exact float accumulation row, and completed segment consumes a bounded op.
  async function modifierStep(engine,context,userId,now,hasSamples,raw,clip = null) {
    const next=structuredClone(engine);
    const plan=await ensurePlan(context,now);
    if (!plan) return { pending:true };
    if (next.mode === "START") {
      next.terms=blankTerms(); next.mode=hasSamples ? "LOCAL" : "FALLBACK";
      next.time=plan.firstStart; next.index=0;
      return { engine:next };
    }
    if (next.mode === "FALLBACK") {
      const g=context.groups;
      context.fallback ||= [...g.legCramps,...g.runnersHighs,...g.uprisings,...g.rallyFlags,
        ...context.effects.filter((e)=>e.type==="COIN_FLIP")];
      context.rainWindows ||= mergeRainstormWindows(g.rainstorms);
      const fallback=context.fallback;
      const rains=context.rainWindows;
      if (next.index<fallback.length) {
        const term=computeEffectModifiersFallback([fallback[next.index]],raw);
        next.terms.frozenSteps+=term.frozenSteps; next.terms.buffedSteps+=term.buffedSteps;
        next.terms.reversedSteps+=term.reversedSteps;
      } else if (next.index<fallback.length+g.campfires.length) {
        const effect=g.campfires[next.index-fallback.length]; const meta=effect.metadata || {};
        const end=effect.status==="EXPIRED" && meta.stepsAtExpiry!==undefined ? meta.stepsAtExpiry : raw;
        next.terms.frozenSteps+=Math.max(0,end-(meta.stepsAtRestStart || 0));
      } else if (next.index<fallback.length+g.campfires.length+rains.length) {
        const window=rains[next.index-fallback.length-g.campfires.length];
        const start=window.startEffect.metadata?.stepsAtStart || 0; const endMeta=window.endEffect.metadata || {};
        const end=window.endEffect.status==="EXPIRED" && endMeta.stepsAtExpiry!==undefined ? endMeta.stepsAtExpiry : raw;
        next.terms.frozenSteps+=Math.round(Math.max(0,end-start)*window.lostFraction);
      } else { next.mode="EVENT"; next.time=ms(payload.event.startsAt); }
      next.index++; return { engine:next };
    }
    if (next.mode === "LOCAL" && (next.time===null || !(next.time<now))) {
      next.mode="EVENT"; next.time=ms(payload.event.startsAt); return { engine:next };
    }
    if (next.mode === "EVENT" && (userId!==payload.userId || !(Number(payload.event.multiplier)>1) ||
        !(next.time<Math.min(eventEnd,now)))) { next.mode="DONE"; return { engine:next }; }
    if (next.mode === "DONE") return { engine:next,done:true };
    if (!next.segment) {
      next.segment=await segment(context,next.time,next.mode==="LOCAL" ? now : Math.min(eventEnd,now));
      if (next.segment.multiplier===null) { next.multiplier=newMultiplierAccumulator(); next.multiplierIndex=0; }
      return { engine:next };
    }
    if (next.segment.multiplier===null) {
      const row=context.rows[next.multiplierIndex];
      if (row) {
        if (!(row.phase==="rain" && next.segment.umbrella)) consumeMultiplierEffect(next.multiplier,row.phase,row.effect,next.segment.start);
        next.multiplierIndex++;
      }
      if (!row || next.multiplier.frozen) {
        next.segment.multiplier=finishMultiplierAccumulator(next.multiplier);
        delete next.multiplier; delete next.multiplierIndex;
      }
      return { engine:next };
    }
    const {multiplier}=next.segment;
    let start=next.segment.start; let end=next.segment.end;
    if (clip) { start=Math.max(start,clip.start); end=Math.min(end,clip.end); }
    const needed=next.mode==="LOCAL" ? multiplier!==1 : multiplier!==0;
    let steps=0;
    if (needed && end>start) steps=next.mode==="LOCAL" && !clip
      ? await models.sampleModel.sumClosedStepsInWindow(userId,new Date(start),new Date(end),new Date(now))
      : await models.sampleModel.sumStepsInWindow(userId,new Date(start),new Date(end));
    if (next.mode==="LOCAL") reduceEffectSegment(next.terms,steps,multiplier);
    else next.terms.globalBoostedSteps+=globalEventSegmentBoost(steps,multiplier,Number(payload.event.multiplier));
    next.time=next.segment.end; delete next.segment;
    return { engine:next };
  }

  while (budget.operations>0 && !(state.stage==="FINAL" && state.done)) {
    const next=structuredClone(state);
    const participant=byId.get(evaluatedIds[state.participantIndex]);
    if (!participant && state.stage!=="FINAL") { next.stage="FINAL"; await checkpoint(next); continue; }
    const now=participant ? ms(participant.cutoffAt) : eventEnd;
    const context=participant ? effectContext(participant) : null;
    if (state.stage==="PLAN") {
      if (!(await ensurePlan(context,now))) continue;
      next.stage="BASE"; next.base={mode:"START",subsequent:0}; await checkpoint(next); continue;
    }
    if (state.stage==="BASE") {
      const plan=createBaseAdjustedPlan({ participant,raceStartedAt:payload.race.startedAt,timeZone:payload.race.timezone,
        now:new Date(now),raceEndsAt:new Date(now) });
      const base=next.base;
      if (base.mode==="START") {
        base.startSamples=await models.sampleModel.sumStepsInWindow(participant.userId,plan.effectiveStart,plan.startDayWindowEnd);
        base.mode=plan.allowStartDayDaily ? "START_DAILY" : "DAYS";
        base.startSteps=startDayContribution(plan,base.startSamples,0); base.nextDate=plan.dayAfterStartDate;
      } else if (base.mode==="START_DAILY") {
        const daily=await models.stepsModel.findByUserIdAndDate(participant.userId,plan.startDate);
        base.startSteps=startDayContribution(plan,base.startSamples,daily?.steps); base.mode="DAYS";
      } else if (base.mode==="DAYS") {
        const window=base.nextDate<=plan.today ? subsequentDayWindow({date:base.nextDate,timeZone:payload.race.timezone,now:plan.scoringNow}) : null;
        if (!window) base.mode="HAS_ANY";
        else {
          const sample=await models.sampleModel.sumStepsInWindow(participant.userId,window.start,window.end);
          const daily=window.isCompleteDay || plan.allowPartialDayDaily
            ? await models.stepsModel.findByUserIdAndDate(participant.userId,window.date) : null;
          base.subsequent+=subsequentDayContribution(window,sample,daily?.steps,plan.allowPartialDayDaily);
          base.nextDate=addDaysToDateString(base.nextDate,1);
        }
      } else {
        base.hasSamples=base.startSamples>0 || await models.sampleModel.hasAnyInWindow(participant.userId,plan.effectiveStart,plan.scoringNow);
        base.total=Math.max(0,base.startSteps+base.subsequent);
        next.stage="LOCAL"; next.modifier={mode:"START"};
      }
      await checkpoint(next); continue;
    }
    if (state.stage==="LOCAL") {
      const result=await modifierStep(state.modifier,context,participant.userId,now,state.base.hasSamples,state.base.total);
      if (result.pending) continue;
      next.modifier=result.engine;
      if (result.done) {
        const terms=result.engine.terms;
        const bonus=payload.race.powerupsEnabled ? participant.bonusSteps || 0 : 0;
        next.remaining=[preLeechScoringTotal({...terms,baseAdjusted:state.base.total,bonusSteps:bonus,globalBoostedSteps:0}),
          preLeechScoringTotal({...terms,baseAdjusted:state.base.total,bonusSteps:bonus})];
        next.copyIndex=0; next.copied=[0,0]; next.stage="COPIES"; delete next.modifier;
      }
      await checkpoint(next); continue;
    }
    if (state.stage==="COPIES") {
      const copies=payload.race.powerupsEnabled && !isFrozen(participant) ? copiesByUser.get(participant.userId) || [] : [];
      const effect=copies[state.copyIndex];
      if (!effect) {
        if (!isFrozen(participant)) next.remaining=state.remaining.map((value,index)=>hitchhikeFlooredBalance(value,state.copied[index]));
        next.stage="DRAINS"; next.drainIndex=0; await checkpoint(next); continue;
      }
      const target=byId.get(effect.targetParticipantId) || byUser.get(effect.targetUserId);
      const version=Number(effect.metadata?.scoringVersion) || 1;
      if (!state.copy) {
        const frozen=version===3 ? await hitchAdapter.findFrozen(effect.id) : null;
        if (frozen) { const value=Number(frozen.effectiveContribution) || 0; next.copied=state.copied.map((n)=>n+value); next.copyIndex++; }
        else {
          const window=hitchhikeScoringWindow(effect,new Date(eventEnd),{raceEndsAt:payload.event.endsAt,
            targetFinishedAt:target?.finishedAt,targetForfeitedAt:target?.forfeitedAt});
          if (!window) next.copyIndex++;
          else next.copy={start:window.windowStart,end:window.windowEnd,rawEnd:window.rawEnd,mode:"RAW"};
        }
        await checkpoint(next); continue;
      }
      const copy=next.copy;
      if (!(copy.end>copy.start) || !effect.targetUserId || !effect.sourceUserId) { delete next.copy; next.copyIndex++; await checkpoint(next); continue; }
      if (copy.mode==="RAW") {
        copy.raw=Math.max(0,Number(await models.sampleModel.sumStepsInWindow(effect.targetUserId,new Date(copy.start),new Date(copy.end))) || 0);
        if (version<2 || !target || (!(copy.raw>0) && version<3)) {
          const amount=Math.floor(copy.raw*hitchhikeCopyRatio(effect)); next.copied=state.copied.map((n)=>n+amount); delete next.copy; next.copyIndex++;
        } else { copy.mode="MODIFIERS"; copy.modifier={mode:"START"}; }
        await checkpoint(next); continue;
      }
      const copyContext=effectContext(target,true);
      const result=await modifierStep(copy.modifier,copyContext,effect.targetUserId,copy.end,true,copy.raw,{start:copy.start,end:copy.end});
      if (result.pending) continue;
      copy.modifier=result.engine;
      if (result.done) {
        const terms=result.engine.terms;
        const amounts=[hitchhikeExactContribution(effect,copy.raw,{...terms,globalBoostedSteps:0}),
          hitchhikeExactContribution(effect,copy.raw,terms)];
        for (let index=0;index<2;index++) {
          const amount=version===3 ? hitchAdapter.selectBoundaryContribution({effectId:effect.id,exactSteps:copy.raw,
            exactCopiedSteps:amounts[index],rawEnd:copy.rawEnd,nowMs:eventEnd}) : amounts[index];
          next.copied[index]+=amount;
        }
        delete next.copy; next.copyIndex++;
      }
      await checkpoint(next); continue;
    }
    if (state.stage==="DRAINS") {
      const leeches=payload.race.powerupsEnabled && !isFrozen(participant)
        ? context.leeches : [];
      const effect=leeches[state.drainIndex];
      if (!effect) {
        if (participant.userId===payload.userId) next.uploaderRemaining=state.remaining;
        next.participantIndex++; next.stage="PLAN";
        for (const key of ["base","remaining","copyIndex","copied","drainIndex"]) delete next[key];
        await checkpoint(next); continue;
      }
      const earned=await computeLeechEarnedTransfer(effect,models.sampleModel,new Date(now));
      const amounts=state.remaining.map((value)=>resolveLeechDrain(earned,value));
      next.remaining=state.remaining.map((value,index)=>value-amounts[index]); next.drainIndex++; next.transferCount++;
      await checkpoint(next,1,{effectId:effect.id,startsMs:ms(effect.startsAt),sourceUserId:effect.sourceUserId,amounts}); continue;
    }
    if (state.stage==="FINAL") {
      const rows=await client.$queryRawUnsafe(`SELECT starts_ms,effect_id,payload,
        payload_digest=encode(sha256(convert_to(payload::text,'UTF8')),'hex') AS valid
        FROM durable_capture_score_transfers WHERE request_id=$1::uuid AND race_id=$2
          AND ($3::bigint IS NULL OR (starts_ms,effect_id)>($3::bigint,$4::text)) ORDER BY starts_ms,effect_id LIMIT 1`,
        requestId,raceId,state.transferAfter?.time ?? null,state.transferAfter?.id ?? "");
      const row=rows[0];
      if (!row) {
        if (state.readTransferCount!==state.transferCount) throw FAILURE("Durable score transfer checkpoint is missing");
        next.done=true; next.deltaSteps=Math.round((state.uploaderRemaining[1]+state.credit[1])-(state.uploaderRemaining[0]+state.credit[0]));
      }
      else {
        if (!row.valid || Number(row.starts_ms)!==row.payload.startsMs || row.effect_id!==row.payload.effectId) throw FAILURE("Durable score transfer is corrupt");
        const uploader=byUser.get(payload.userId);
        if (row.payload.sourceUserId===payload.userId && !isFrozen(uploader)) next.credit=state.credit.map((value,index)=>value+row.payload.amounts[index]);
        next.transferAfter={time:Number(row.starts_ms),id:row.effect_id};
        next.readTransferCount++;
      }
      await checkpoint(next); continue;
    }
    throw FAILURE("Unknown durable score stage");
  }
  return { done:Boolean(state.done),deltaSteps:state.done ? state.deltaSteps : undefined,operations,stage:state.stage };
}

// Call before deleting30-day-old terminal requests. All child deletion is
// bounded; the parent request-deletion query checks these tables are empty.
// Account deletion detaches one tiny owner; its pages are collected immediately
// without waiting30days or extending an account-deletion transaction.
async function compactDurableScoreProgress({client,limit=128}) {
  const bounded=Math.max(1,Math.min(128,Number(limit)||128));
  const owners=await client.$queryRawUnsafe(`(SELECT id FROM durable_capture_score_owners
      WHERE live_request_id IS NULL ORDER BY created_at,id LIMIT 32)
    UNION (SELECT o.id FROM durable_global_event_capture_requests r JOIN durable_capture_score_owners o ON o.live_request_id=r.id
      WHERE r.status IN ('COMPLETE','EXPIRED','FAILED') AND r.completed_at<clock_timestamp()-interval '30 days'
      ORDER BY r.completed_at,r.id LIMIT 32)`);
  if (!owners.length) return 0;
  const ids=owners.map((row)=>row.id);
  let deleted=0;
  for (const table of ["durable_capture_score_points","durable_capture_score_transfers","durable_capture_score_plans","durable_capture_score_progress"]) {
    const empty=table==="durable_capture_score_plans" ? `AND NOT EXISTS (SELECT 1 FROM durable_capture_score_points p
      WHERE p.request_id=s.request_id AND p.race_id=s.race_id AND p.plan_key=s.plan_key)` : "";
    deleted+=await client.$executeRawUnsafe(`WITH selected AS MATERIALIZED (SELECT s.ctid FROM ${table} s
      WHERE s.request_id=ANY($1::uuid[]) ${empty} LIMIT $2 FOR UPDATE OF s SKIP LOCKED)
      DELETE FROM ${table} s USING selected WHERE s.ctid=selected.ctid`,ids,bounded);
  }
  deleted+=await client.$executeRawUnsafe(`DELETE FROM durable_capture_score_owners o WHERE id=ANY($1::uuid[])
    AND NOT EXISTS(SELECT 1 FROM durable_capture_score_points p WHERE p.request_id=o.id)
    AND NOT EXISTS(SELECT 1 FROM durable_capture_score_plans p WHERE p.request_id=o.id)
    AND NOT EXISTS(SELECT 1 FROM durable_capture_score_transfers p WHERE p.request_id=o.id)
    AND NOT EXISTS(SELECT 1 FROM durable_capture_score_progress p WHERE p.request_id=o.id)`,ids);
  return deleted;
}

module.exports={advanceDurableCaptureScore,compactDurableScoreProgress};
