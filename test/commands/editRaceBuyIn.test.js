const assert = require("node:assert/strict");
const test = require("node:test");

const { buildEditRace, RaceEditError } = require("../../src/modules/races/commands/editRace");

// Fakes around a mutable race row + participant list + per-user coin balances,
// exercising the Issue 4 buy-in reconcile. `withRaceLock` is a pass-through so
// no DB is touched; `appSettings.getFlag` is stubbed to control the kill switch.
function makeDeps({
  race = {},
  participants = [],
  coins = {},
  buyInEditEnabled = true,
} = {}) {
  const state = {
    race: {
      id: "race-1",
      creatorId: "creator",
      status: "PENDING",
      name: "Money Race",
      maxDurationDays: 7,
      powerupsEnabled: false,
      powerupStepInterval: null,
      isPublic: false,
      maxParticipants: 10,
      buyInAmount: 0,
      payoutPreset: "WINNER_TAKES_ALL",
      isTeamRace: false,
      potCoins: 0,
      participants,
      ...race,
    },
    raceUpdate: null,
    participantUpdates: [],
    awards: [],
    events: [],
    coins: { ...coins },
  };
  // Keep a working copy so reconcile re-reads see current buyInVersion/status.
  const parts = participants.map((p) => ({ ...p }));

  const deps = {
    Race: {
      async findById() {
        return state.race;
      },
      async update(id, fields) {
        state.raceUpdate = fields;
        state.race = { ...state.race, ...fields };
        return state.race;
      },
    },
    RaceParticipant: {
      async findAcceptedByRace() {
        return parts.filter((p) => p.status === "ACCEPTED");
      },
      async findChargedByRace() {
        return parts.filter(
          (p) =>
            p.buyInAmount > 0 &&
            (p.buyInStatus === "HELD" || p.buyInStatus === "COMMITTED")
        );
      },
      async countAccepted() {
        return parts.filter((p) => p.status === "ACCEPTED").length;
      },
      async update(id, fields) {
        state.participantUpdates.push({ id, fields });
        const p = parts.find((x) => x.id === id);
        if (p) Object.assign(p, fields);
        return p;
      },
    },
    User: {
      async findById(id) {
        return { id, coins: state.coins[id] ?? 0 };
      },
    },
    awardCoins: async (payload) => {
      state.awards.push(payload);
      // Reflect the movement in the local balance for realism.
      state.coins[payload.userId] =
        (state.coins[payload.userId] ?? 0) + payload.amount;
      return { awarded: true, coins: state.coins[payload.userId] };
    },
    appSettings: {
      async getFlag(key) {
        if (key === "buyInEditEnabled") return buyInEditEnabled;
        return true;
      },
    },
    withRaceLock: async (_raceId, cb) => cb(),
    eventBus: {
      emit(event, payload) {
        state.events.push({ event, payload });
      },
    },
  };

  return { state, deps, parts };
}

function member(userId, team, buyInAmount = 0, buyInStatus = "NONE", buyInVersion = 0) {
  return {
    id: `rp-${userId}`,
    userId,
    status: "ACCEPTED",
    team,
    buyInAmount,
    buyInStatus,
    buyInVersion,
    user: { displayName: userId },
  };
}

async function assertBuyInImmutable(ctx, updates) {
  const editRace = buildEditRace(ctx.deps);
  await assert.rejects(
    () => editRace({ userId: "creator", raceId: "race-1", updates }),
    (err) => {
      assert.ok(err instanceof RaceEditError);
      assert.equal(err.statusCode, 400);
      assert.equal(err.code, "IMMUTABLE_FIELD");
      assert.match(err.message, /buy-in/i);
      return true;
    },
  );
  assert.equal(ctx.state.awards.length, 0, "no coin movement");
  assert.equal(ctx.state.participantUpdates.length, 0, "no participant mutation");
  assert.equal(ctx.state.raceUpdate, null, "no race mutation");
  assert.equal(
    ctx.state.events.some((event) => event.event === "RACE_BUYIN_CHANGED"),
    false,
    "no retired buy-in event",
  );
}

// ── Lower the buy-in: refund the delta ──────────────────────────────────────
test("buy-in lower is retired: historical holds and pot stay unchanged", async () => {
  const ctx = makeDeps({
    race: { buyInAmount: 100, potCoins: 200 },
    participants: [
      member("creator", null, 100, "HELD", 1),
      member("bob", null, 100, "HELD", 1),
    ],
    coins: { creator: 0, bob: 0 },
  });
  await assertBuyInImmutable(ctx, { buyInAmount: 60 });
  assert.equal(ctx.state.race.buyInAmount, 100);
  assert.equal(ctx.state.race.potCoins, 200);
});

// ── Raise the buy-in (affordable): charge the delta ─────────────────────────
test("buy-in raise is retired even when every participant can afford it", async () => {
  const ctx = makeDeps({
    race: { buyInAmount: 50, potCoins: 100 },
    participants: [
      member("creator", null, 50, "HELD", 3),
      member("bob", null, 50, "HELD", 1),
    ],
    coins: { creator: 500, bob: 500 },
  });
  await assertBuyInImmutable(ctx, { buyInAmount: 120 });
  assert.deepEqual(ctx.state.coins, { creator: 500, bob: 500 });
});

// ── Raise the buy-in (unaffordable): block, mutate nothing ──────────────────
test("retired buy-in raise rejects before affordability inspection and mutates nothing", async () => {
  const ctx = makeDeps({
    race: { buyInAmount: 50, potCoins: 100 },
    participants: [
      member("creator", null, 50, "HELD", 1),
      member("Broke", null, 50, "HELD", 1),
    ],
    coins: { creator: 500, Broke: 10 },
  });
  await assertBuyInImmutable(ctx, { buyInAmount: 150 });
  assert.equal(ctx.state.coins.Broke, 10);
});

// ── Toggle -> free: fully refund everyone ───────────────────────────────────
test("buy-in toggle to free is retired and cannot refund historical holds", async () => {
  const ctx = makeDeps({
    race: { buyInAmount: 80, potCoins: 160 },
    participants: [
      member("creator", null, 80, "HELD", 1),
      member("bob", null, 80, "HELD", 1),
    ],
    coins: { creator: 0, bob: 0 },
  });
  await assertBuyInImmutable(ctx, { buyInEnabled: false });
  assert.equal(ctx.state.race.buyInAmount, 80);
  assert.equal(ctx.state.race.potCoins, 160);
});

// ── Toggle free -> paid: charge everyone (NONE -> HELD) ─────────────────────
test("buy-in toggle from free to paid is retired and cannot create holds", async () => {
  const ctx = makeDeps({
    race: { buyInAmount: 0, potCoins: 0 },
    participants: [
      member("creator", null, 0, "NONE", 0),
      member("bob", null, 0, "NONE", 0),
    ],
    coins: { creator: 500, bob: 500 },
  });
  await assertBuyInImmutable(ctx, { buyInEnabled: true, buyInAmount: 40 });
  assert.deepEqual(ctx.state.coins, { creator: 500, bob: 500 });
});

test("retired free-to-paid toggle rejects before affordability inspection", async () => {
  const ctx = makeDeps({
    race: { buyInAmount: 0, potCoins: 0 },
    participants: [
      member("creator", null, 0, "NONE", 0),
      member("Poor", null, 0, "NONE", 0),
    ],
    coins: { creator: 500, Poor: 5 },
  });
  await assertBuyInImmutable(ctx, { buyInEnabled: true, buyInAmount: 40 });
  assert.equal(ctx.state.coins.Poor, 5);
});

// ── Idempotency / refId: two sequential edits to the same amount both apply ──
test("repeated retired buy-in edits never mint versioned adjustment refIds", async () => {
  const ctx = makeDeps({
    race: { buyInAmount: 50, potCoins: 100 },
    participants: [member("creator", null, 50, "HELD", 0)],
    coins: { creator: 500 },
  });
  await assertBuyInImmutable(ctx, { buyInAmount: 60 });
  await assertBuyInImmutable(ctx, { buyInAmount: 60 });
  assert.deepEqual(ctx.state.awards, []);
});

// ── Kill switch off: old hard block ─────────────────────────────────────────
test("kill switch off: editing a paid buy-in with charged participants is blocked", async () => {
  const ctx = makeDeps({
    buyInEditEnabled: false,
    race: { buyInAmount: 50, potCoins: 50 },
    participants: [member("creator", null, 50, "HELD", 1)],
    coins: { creator: 500 },
  });
  const editRace = buildEditRace(ctx.deps);
  await assert.rejects(
    () =>
      editRace({
        userId: "creator",
        raceId: "race-1",
        updates: { buyInAmount: 100 },
      }),
    (err) => {
      assert.ok(err instanceof RaceEditError);
      assert.equal(err.statusCode, 400);
      assert.match(err.message, /buy-in/i);
      return true;
    }
  );
  assert.equal(ctx.state.awards.length, 0);
});

// ── Notify: affected non-owner participants surfaced for the push ───────────
test("retired buy-in changes emit no participant notification", async () => {
  const ctx = makeDeps({
    race: { buyInAmount: 50, potCoins: 100 },
    participants: [
      member("creator", null, 50, "HELD", 1),
      member("bob", null, 50, "HELD", 1),
    ],
    coins: { creator: 500, bob: 500 },
  });
  await assertBuyInImmutable(ctx, { buyInAmount: 80 });
  assert.equal(
    ctx.state.events.find((e) => e.event === "RACE_BUYIN_CHANGED"),
    undefined,
  );
});

// ── Non-owner / non-PENDING guards still intact ─────────────────────────────
test("non-owner cannot edit buy-in", async () => {
  const ctx = makeDeps({
    race: { buyInAmount: 50 },
    participants: [member("creator", null, 50, "HELD", 1)],
  });
  const editRace = buildEditRace(ctx.deps);
  await assert.rejects(
    () =>
      editRace({ userId: "someone-else", raceId: "race-1", updates: { buyInAmount: 100 } }),
    (err) => err instanceof RaceEditError && err.statusCode === 403
  );
});

test("cannot edit buy-in on a non-PENDING race", async () => {
  const ctx = makeDeps({
    race: { status: "ACTIVE", buyInAmount: 50 },
    participants: [member("creator", null, 50, "HELD", 1)],
  });
  const editRace = buildEditRace(ctx.deps);
  await assert.rejects(
    () =>
      editRace({ userId: "creator", raceId: "race-1", updates: { buyInAmount: 100 } }),
    (err) => err instanceof RaceEditError && err.statusCode === 400
  );
});
