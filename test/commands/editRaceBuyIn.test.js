const assert = require("node:assert/strict");
const test = require("node:test");

const { buildEditRace, RaceEditError } = require("../../src/commands/editRace");

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

// ── Lower the buy-in: refund the delta ──────────────────────────────────────
test("buy-in lower: charged participants refunded the delta; pot + version updated", async () => {
  const ctx = makeDeps({
    race: { buyInAmount: 100, potCoins: 200 },
    participants: [
      member("creator", null, 100, "HELD", 1),
      member("bob", null, 100, "HELD", 1),
    ],
    coins: { creator: 0, bob: 0 },
  });
  const editRace = buildEditRace(ctx.deps);
  await editRace({
    userId: "creator",
    raceId: "race-1",
    updates: { buyInAmount: 60 },
  });

  // Each participant refunded +40.
  const byUser = Object.fromEntries(ctx.state.awards.map((a) => [a.userId, a]));
  assert.equal(ctx.state.awards.length, 2);
  assert.equal(byUser.creator.amount, 40);
  assert.equal(byUser.bob.amount, 40);
  assert.equal(byUser.creator.reason, "race_buy_in_adjust");
  assert.equal(byUser.creator.refId, "race-1:creator:v2");
  // Participant rows updated to new amount + incremented version + HELD.
  const upd = Object.fromEntries(
    ctx.state.participantUpdates.map((u) => [u.id, u.fields])
  );
  assert.equal(upd["rp-creator"].buyInAmount, 60);
  assert.equal(upd["rp-creator"].buyInStatus, "HELD");
  assert.equal(upd["rp-creator"].buyInVersion, 2);
  // Pot recomputed: 2 * 60.
  assert.equal(ctx.state.raceUpdate.buyInAmount, 60);
  assert.equal(ctx.state.raceUpdate.potCoins, 120);
});

// ── Raise the buy-in (affordable): charge the delta ─────────────────────────
test("buy-in raise (affordable): participants debited the delta with versioned refId", async () => {
  const ctx = makeDeps({
    race: { buyInAmount: 50, potCoins: 100 },
    participants: [
      member("creator", null, 50, "HELD", 3),
      member("bob", null, 50, "HELD", 1),
    ],
    coins: { creator: 500, bob: 500 },
  });
  const editRace = buildEditRace(ctx.deps);
  await editRace({
    userId: "creator",
    raceId: "race-1",
    updates: { buyInAmount: 120 },
  });

  const byUser = Object.fromEntries(ctx.state.awards.map((a) => [a.userId, a]));
  assert.equal(byUser.creator.amount, -70);
  assert.equal(byUser.bob.amount, -70);
  assert.equal(byUser.creator.refId, "race-1:creator:v4");
  assert.equal(byUser.bob.refId, "race-1:bob:v2");
  assert.equal(ctx.state.raceUpdate.buyInAmount, 120);
  assert.equal(ctx.state.raceUpdate.potCoins, 240);
});

// ── Raise the buy-in (unaffordable): block, mutate nothing ──────────────────
test("buy-in raise (unaffordable): 400 BUYIN_UNAFFORDABLE naming the player, no mutation", async () => {
  const ctx = makeDeps({
    race: { buyInAmount: 50, potCoins: 100 },
    participants: [
      member("creator", null, 50, "HELD", 1),
      member("Broke", null, 50, "HELD", 1),
    ],
    coins: { creator: 500, Broke: 10 },
  });
  const editRace = buildEditRace(ctx.deps);
  await assert.rejects(
    () =>
      editRace({
        userId: "creator",
        raceId: "race-1",
        updates: { buyInAmount: 150 },
      }),
    (err) => {
      assert.ok(err instanceof RaceEditError);
      assert.equal(err.statusCode, 400);
      assert.equal(err.code, "BUYIN_UNAFFORDABLE");
      assert.match(err.message, /Broke/);
      return true;
    }
  );
  assert.equal(ctx.state.awards.length, 0, "no coin movement");
  assert.equal(ctx.state.participantUpdates.length, 0, "no participant writes");
  assert.equal(ctx.state.raceUpdate, null, "no race write");
});

// ── Toggle -> free: fully refund everyone ───────────────────────────────────
test("buy-in toggle -> free (buyInEnabled:false): everyone refunded, REFUNDED, pot 0", async () => {
  const ctx = makeDeps({
    race: { buyInAmount: 80, potCoins: 160 },
    participants: [
      member("creator", null, 80, "HELD", 1),
      member("bob", null, 80, "HELD", 1),
    ],
    coins: { creator: 0, bob: 0 },
  });
  const editRace = buildEditRace(ctx.deps);
  await editRace({
    userId: "creator",
    raceId: "race-1",
    updates: { buyInEnabled: false },
  });

  const byUser = Object.fromEntries(ctx.state.awards.map((a) => [a.userId, a]));
  assert.equal(byUser.creator.amount, 80);
  assert.equal(byUser.bob.amount, 80);
  const upd = Object.fromEntries(
    ctx.state.participantUpdates.map((u) => [u.id, u.fields])
  );
  assert.equal(upd["rp-creator"].buyInStatus, "REFUNDED");
  assert.equal(upd["rp-creator"].buyInAmount, 0);
  assert.equal(ctx.state.raceUpdate.buyInAmount, 0);
  assert.equal(ctx.state.raceUpdate.potCoins, 0);
});

// ── Toggle free -> paid: charge everyone (NONE -> HELD) ─────────────────────
test("buy-in toggle free -> paid: NONE participants charged and moved to HELD", async () => {
  const ctx = makeDeps({
    race: { buyInAmount: 0, potCoins: 0 },
    participants: [
      member("creator", null, 0, "NONE", 0),
      member("bob", null, 0, "NONE", 0),
    ],
    coins: { creator: 500, bob: 500 },
  });
  const editRace = buildEditRace(ctx.deps);
  await editRace({
    userId: "creator",
    raceId: "race-1",
    updates: { buyInEnabled: true, buyInAmount: 40 },
  });

  const byUser = Object.fromEntries(ctx.state.awards.map((a) => [a.userId, a]));
  assert.equal(byUser.creator.amount, -40);
  assert.equal(byUser.bob.amount, -40);
  const upd = Object.fromEntries(
    ctx.state.participantUpdates.map((u) => [u.id, u.fields])
  );
  assert.equal(upd["rp-creator"].buyInStatus, "HELD");
  assert.equal(upd["rp-creator"].buyInAmount, 40);
  assert.equal(upd["rp-creator"].buyInVersion, 1);
  assert.equal(ctx.state.raceUpdate.buyInAmount, 40);
  assert.equal(ctx.state.raceUpdate.potCoins, 80);
});

test("buy-in toggle free -> paid unaffordable is blocked naming the player", async () => {
  const ctx = makeDeps({
    race: { buyInAmount: 0, potCoins: 0 },
    participants: [
      member("creator", null, 0, "NONE", 0),
      member("Poor", null, 0, "NONE", 0),
    ],
    coins: { creator: 500, Poor: 5 },
  });
  const editRace = buildEditRace(ctx.deps);
  await assert.rejects(
    () =>
      editRace({
        userId: "creator",
        raceId: "race-1",
        updates: { buyInEnabled: true, buyInAmount: 40 },
      }),
    (err) => {
      assert.equal(err.code, "BUYIN_UNAFFORDABLE");
      assert.match(err.message, /Poor/);
      return true;
    }
  );
  assert.equal(ctx.state.awards.length, 0);
});

// ── Idempotency / refId: two sequential edits to the same amount both apply ──
test("two sequential edits to the same amount produce distinct versioned refIds", async () => {
  const ctx = makeDeps({
    race: { buyInAmount: 50, potCoins: 100 },
    participants: [member("creator", null, 50, "HELD", 0)],
    coins: { creator: 500 },
  });
  const editRace = buildEditRace(ctx.deps);
  // 50 -> 60
  await editRace({ userId: "creator", raceId: "race-1", updates: { buyInAmount: 60 } });
  // 60 -> 50
  await editRace({ userId: "creator", raceId: "race-1", updates: { buyInAmount: 50 } });

  assert.equal(ctx.state.awards.length, 2);
  assert.equal(ctx.state.awards[0].refId, "race-1:creator:v1");
  assert.equal(ctx.state.awards[1].refId, "race-1:creator:v2");
  assert.notEqual(ctx.state.awards[0].refId, ctx.state.awards[1].refId);
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
test("buy-in change emits RACE_BUYIN_CHANGED for charged non-owner participants", async () => {
  const ctx = makeDeps({
    race: { buyInAmount: 50, potCoins: 100 },
    participants: [
      member("creator", null, 50, "HELD", 1),
      member("bob", null, 50, "HELD", 1),
    ],
    coins: { creator: 500, bob: 500 },
  });
  const editRace = buildEditRace(ctx.deps);
  await editRace({ userId: "creator", raceId: "race-1", updates: { buyInAmount: 80 } });

  const evt = ctx.state.events.find((e) => e.event === "RACE_BUYIN_CHANGED");
  assert.ok(evt, "RACE_BUYIN_CHANGED emitted");
  assert.deepEqual(evt.payload.affectedUserIds, ["bob"]);
  assert.equal(evt.payload.newBuyIn, 80);
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
