const { Race } = require("../models/race");
const { RaceParticipant } = require("../models/raceParticipant");
const { RaceActiveEffect } = require("../../powerups/models/raceActiveEffect");
const { RacePowerupEvent } = require("../../powerups/models/racePowerupEvent");
const { buildResolveRaceState } = require("./raceStateResolution");
const crypto = require("node:crypto");

// READ-ONLY race-state computation (C0, spec §5a).
//
// `resolveRaceState` computes AND persists. Persisting is a MULTI-ROW write to
// race_participants, and after C0 exactly one actor may do that for a given
// race: the fenced race-keyed worker (or raceExpiry, through the same fence).
// Every other caller that reached for `resolveRaceState` only ever wanted the
// numbers — a fresh effective total to rank by, to gate on, or to plant a mine
// at. This module gives them the numbers with the writes discarded.
//
// Critically it does NOT fork the scoring math. It runs the SAME
// `buildResolveRaceState` pipeline (bases -> effects -> hitchhike -> leech ->
// trail mines) with the write surface swapped for a recorder, so there is no
// fourth assembly site to keep in lockstep — a change to the scoring logic
// reaches this path by construction. This is the same capture proxy the v2
// worker uses; the worker replays the recorded writes inside its fence, and
// this module throws them away.

// The complete write surface of resolveRaceState's processRace: participant
// totals, trail-mine bonus subtraction, trail-mine effect status, and the
// trail-mine feed row. Everything else it does is a read.
//
// If a write is ever added to processRace without being captured here, it will
// escape both the worker's fence and this module's read-only guarantee. The
// "zero participant writes" assertions in
// test/integration/race-queue-v2-single-writer.test.js are the guard.
function createWriteCapture({ participantModel, effectModel, eventModel }) {
  const writes = [];
  const capturedTotals = new Map();
  return {
    writes,
    participants: {
      ...participantModel,
      // `rawSteps` rides the SAME capture record as `totalSteps` (2026-08-09,
      // docs/box-raw-steps-position-and-option-h-requirements.md). It must:
      // an uncaptured write escapes both the worker's fence and this module's
      // read-only guarantee, and the v2 worker is the PROD writer — miss it and
      // `raw_steps` stays NULL forever in production.
      async updateStepTotals(id, { totalSteps, rawSteps } = {}) {
        capturedTotals.set(id, Math.max(0, Math.round(Number(totalSteps) || 0)));
        writes.push({
          kind: "participantTotal",
          participantId: id,
          totalSteps,
          rawSteps,
        });
        return { id, totalSteps, rawSteps };
      },
      async updateTotalSteps(id, totalSteps) {
        capturedTotals.set(id, Math.max(0, Math.round(Number(totalSteps) || 0)));
        writes.push({ kind: "participantTotal", participantId: id, totalSteps });
        return { id, totalSteps };
      },
      async subtractBonusSteps(id, amount) {
        const nominal = Math.max(0, Math.round(Number(amount) || 0));
        const available = capturedTotals.has(id)
          ? capturedTotals.get(id)
          : nominal;
        const actualPenalty = Math.min(nominal, available);
        capturedTotals.set(id, Math.max(0, available - actualPenalty));
        writes.push({
          kind: "participantBonus",
          participantId: id,
          amount: actualPenalty,
        });
        return { id, actualPenalty };
      },
    },
    effects: {
      ...effectModel,
      async update(id, fields) {
        writes.push({ kind: "effectUpdate", id, fields });
        return { id, ...fields };
      },
    },
    events: {
      ...eventModel,
      async create(data) {
        const row = { id: data.id || crypto.randomUUID(), ...data };
        writes.push({ kind: "eventCreate", data: row });
        return row;
      },
    },
  };
}

// Run one race's full resolution WITHOUT writing anything.
//
// Returns:
//   result                   the resolveRaceState result (race, box totals, …),
//                            or null when the race is not live-resolvable
//                            (PENDING/COMPLETED, or past endsAt where settlement
//                            owns it) — callers then keep their stored values
//   writes                   the recorded-and-discarded writes, in order
//   totalsByParticipantId    Map<participantId, effective total>
//   totalsByUserId           Map<userId, effective total>
//   boxEffectiveStepsByUser  plain object, for the requested userIds
//
// The totals are exactly what resolveRaceState WOULD have persisted: frozen
// (finished/forfeited) participants keep their stored value, everyone else gets
// the freshly computed one, and trail-mine penalties are folded in in the order
// the resolver applied them.
async function computeRaceState({
  raceId,
  timeZone = "UTC",
  userIds = null,
  includeAllAcceptedBoxUsers = false,
  dependencies = {},
} = {}) {
  const participantModel = dependencies.RaceParticipant || RaceParticipant;
  const effectModel = dependencies.RaceActiveEffect || RaceActiveEffect;
  const eventModel = dependencies.RacePowerupEvent || RacePowerupEvent;
  const raceModel = dependencies.Race || Race;

  const capture = createWriteCapture({ participantModel, effectModel, eventModel });
  const resolve = buildResolveRaceState({
    Race: raceModel,
    RaceParticipant: capture.participants,
    RaceActiveEffect: capture.effects,
    RacePowerupEvent: capture.events,
    ...(dependencies.now ? { now: dependencies.now } : {}),
    ...(dependencies.activeImpactEnabled === true
      ? { activeImpactEnabled: true }
      : {}),
    ...(dependencies.activeImpactSelectedSourceIds
      ? { activeImpactSelectedSourceIds: dependencies.activeImpactSelectedSourceIds }
      : {}),
    ...(dependencies.activeImpactFreezeSourceIds
      ? { activeImpactFreezeSourceIds: dependencies.activeImpactFreezeSourceIds }
      : {}),
  });

  const processed = await resolve({
    raceId, userIds, timeZone, includeAllAcceptedBoxUsers,
  });
  const result = Array.isArray(processed) ? processed[0] : null;

  const totalsByParticipantId = new Map();
  const participantUserId = new Map();
  for (const p of result?.race?.participants || []) {
    participantUserId.set(p.id, p.userId);
    totalsByParticipantId.set(
      p.id,
      p.finishedAt ? (p.finishTotalSteps ?? p.totalSteps ?? 0) : (p.totalSteps ?? 0)
    );
  }
  for (const write of capture.writes) {
    if (write.kind === "participantTotal") {
      totalsByParticipantId.set(write.participantId, write.totalSteps);
    } else if (write.kind === "participantBonus") {
      const current = totalsByParticipantId.get(write.participantId) ?? 0;
      totalsByParticipantId.set(
        write.participantId,
        Math.max(0, current - write.amount)
      );
    }
  }

  const totalsByUserId = new Map();
  for (const [participantId, total] of totalsByParticipantId) {
    const uid = participantUserId.get(participantId);
    if (uid) totalsByUserId.set(uid, total);
  }

  return {
    result,
    writes: capture.writes,
    totalsByParticipantId,
    totalsByUserId,
    boxEffectiveStepsByUser: result?.boxEffectiveStepsByUser || {},
  };
}

// Overlay computed totals onto in-memory participant rows. Nothing is persisted
// — the caller reads/ranks/gates off the returned objects, and the trailing
// enqueue lets the worker persist the same numbers moments later.
//
// Returns a NEW array of shallow copies so the caller can never accidentally
// hand a mutated Prisma row to a write path.
function overlayComputedTotals(participants, totalsByParticipantId) {
  return (participants || []).map((p) => {
    const total = totalsByParticipantId.get(p.id);
    return typeof total === "number" ? { ...p, totalSteps: total } : { ...p };
  });
}

module.exports = { computeRaceState, createWriteCapture, overlayComputedTotals };
