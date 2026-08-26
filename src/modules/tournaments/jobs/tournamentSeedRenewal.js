const { prisma: defaultPrisma } = require("../../../db");
const { eventBus } = require("../../../shared/events/eventBus");
const { buildAppendTournamentDomainEvent } = require("../services/appendTournamentDomainEvent");
const { appSettings } = require("../../../shared/config/appSettings");
const { generateShareToken } = require("../../../shared/lib/shareToken");
const { withTournamentLock } = require("../services/tournamentLock");
const { runTournamentStart } = require("../services/tournamentStart");
const { totalRoundsFor } = require("../constants/tournaments");
const {
  normalizePowerupConfig,
} = require("../../races/services/validateRaceConfig");

// 60s cadence (matches seeded-race renewal), tight enough that a fresh open
// bracket respawns within ~a minute of the previous one popping.
const RENEWAL_INTERVAL_MS = 60 * 1000;

// Canonical tz for featured tournaments (no creator to inherit from), matching
// seeded races.
const SEED_TIMEZONE = "America/New_York";

function buildRenewTournamentSeeds(dependencies = {}) {
  const prisma = dependencies.prisma || defaultPrisma;
  const now = dependencies.now || (() => new Date());
  const logger = dependencies.logger || console;
  const compatibilityEvents = dependencies.eventBus || eventBus;
  const appendTournamentDomainEvent = dependencies.appendTournamentDomainEvent ||
    buildAppendTournamentDomainEvent(dependencies);
  const settings = dependencies.appSettings || appSettings;
  const mintToken = dependencies.generateShareToken || generateShareToken;
  const rng = dependencies.rng;
  const stepsModel = dependencies.Steps;

  // Backup-promote: if a PENDING seeded bracket is already full (a fill-join
  // crashed between join and start), start it now under the tournament lock.
  async function backupPromote(seed) {
    const pendings = await prisma.tournament.findMany({
      where: { seedId: seed.id, status: "PENDING" },
      select: { id: true, bracketSize: true },
    });
    for (const p of pendings) {
      const acceptedCount = await prisma.tournamentParticipant.count({
        where: { tournamentId: p.id, status: "ACCEPTED" },
      });
      if (acceptedCount < p.bracketSize) continue;

      const { deferred } = await withTournamentLock(
        p.id,
        async (tx, def, tournament) => {
          if (!tournament || tournament.status !== "PENDING") return;
          const startEvents = await runTournamentStart({
            tx,
            tournament,
            now,
            rng,
            stepsModel,
          });
          if (startEvents) def.push(...startEvents);
        },
        {
          prisma,
          resolveUserIds: async (tx) => {
            const participants = await tx.tournamentParticipant.findMany({
              where: { tournamentId: p.id, status: "ACCEPTED" },
              select: { userId: true },
            });
            return participants.map((row) => row.userId);
          },
        }
      );
      for (const payload of deferred) compatibilityEvents?.emit(payload.type, payload);
      logger.log(`[CRON] Backup-promoted featured tournament ${p.id} (${seed.kind})`);
    }
  }

  // Ensure exactly one open PENDING bracket per active seed.
  async function ensureOpenLobby(seed) {
    const existing = await prisma.tournament.findFirst({
      where: { seedId: seed.id, status: "PENDING" },
      select: { id: true },
    });
    if (existing) return;

    const payoutRoundingVersion = (await settings.getFlag("payoutRoundingV1Enabled")) === true ? 1 : 0;
    let created;
    try {
      created = await prisma.tournament.create({
        data: {
          creatorId: null,
          seedId: seed.id,
          name: seed.name,
          status: "PENDING",
          bracketSize: seed.bracketSize,
          matchupDurationDays: seed.matchupDurationDays,
          buyInAmount: 0,
          potCoins: 0,
          // Immutable lobby quote: serializer + settlement prefer this over a
          // subsequently edited seed, while legacy rows safely fall back.
          championPrizeCoinsSnapshot: seed.championPrizeCoins,
          payoutRoundingVersion,
          powerupsEnabled: seed.powerupsEnabled === true,
          // Seed column no longer read — fixed 2,000-step cadence everywhere.
          powerupStepInterval: normalizePowerupConfig({
            powerupsEnabled: seed.powerupsEnabled === true,
          }),
          isPublic: true,
          shareToken: mintToken(),
          timezone: SEED_TIMEZONE,
          currentRound: 0,
          totalRounds: totalRoundsFor(seed.bracketSize),
        },
        select: { id: true },
      });
    } catch (error) {
      // Parallel workers may both observe no lobby. The partial unique index is
      // authoritative; a loser reads the winner rather than treating a normal
      // renewal race as an error or attempting another mint.
      if (error?.code !== "P2002") throw error;
      const winner = await prisma.tournament.findFirst({
        where: { seedId: seed.id, status: "PENDING" },
        select: { id: true },
      });
      if (winner) return;
      throw error;
    }
    logger.log(`[CRON] Minted featured tournament lobby ${created.id} (${seed.kind})`);
  }

  // Inactive-seed cleanup (the featured kill path): cancel the open PENDING
  // lobby (free -> no refunds) so players aren't stranded; ACTIVE brackets
  // finish naturally.
  async function cancelOpenLobbies(seed) {
    const pendings = await prisma.tournament.findMany({
      where: { seedId: seed.id, status: "PENDING" },
      include: { participants: true },
    });
    for (const t of pendings) {
      const cancelledAt = now();
      await prisma.$transaction(async (tx) => {
        await tx.tournament.update({
          where: { id: t.id },
          data: { status: "CANCELLED", completedAt: cancelledAt },
        });
        for (const p of t.participants) {
          if (p.status === "ACCEPTED" || p.status === "INVITED") {
            const payload = {
              tournamentId: t.id,
              cancellationId: t.id,
              tournamentName: t.name,
              userId: p.userId,
              buyInAmount: 0,
            };
            await appendTournamentDomainEvent(tx, { type: "TOURNAMENT_CANCELLED", ...payload }, { occurredAt: cancelledAt });
            compatibilityEvents?.emit("TOURNAMENT_CANCELLED", payload);
          }
        }
      });
      logger.log(`[CRON] Cancelled inactive-seed lobby ${t.id} (${seed.kind})`);
    }
  }

  return async function renewTournamentSeeds() {
    const seeds = await prisma.tournamentSeed.findMany();
    if (seeds.length === 0) return;

    // While the kill switch is off, mint no new lobbies (joins are blocked
    // anyway); backup-promotion of an already-full bracket still runs so a
    // crashed fill-join completes.
    const enabled = await settings.getFlag("tournamentsEnabled");

    for (const seed of seeds) {
      try {
        if (!seed.active) {
          await cancelOpenLobbies(seed);
          continue;
        }
        // Order matters: promote a full lobby first (it leaves PENDING), then
        // ensure a fresh open lobby exists.
        await backupPromote(seed);
        if (enabled) {
          await ensureOpenLobby(seed);
        }
      } catch (error) {
        logger.error(`[CRON] Tournament seed reconcile failed for ${seed.kind}:`, error);
      }
    }
  };
}

const renewTournamentSeeds = buildRenewTournamentSeeds();

function scheduleTournamentSeedRenewal(dependencies = {}) {
  const interval = dependencies.intervalMs || RENEWAL_INTERVAL_MS;
  const logger = dependencies.logger || console;
  const renewFn = dependencies.renewTournamentSeeds || renewTournamentSeeds;

  // Overlap guard (a slow run spanning the next interval), same as seeded races.
  let running = false;
  async function run() {
    if (running) return;
    running = true;
    try {
      await renewFn();
    } catch (error) {
      logger.error("[CRON] Tournament seed renewal error:", error);
    } finally {
      running = false;
    }
  }

  run();
  setInterval(run, interval);
  logger.log(`[CRON] Tournament seed renewal scheduled (every ${interval / 1000}s)`);
}

module.exports = {
  buildRenewTournamentSeeds,
  renewTournamentSeeds,
  scheduleTournamentSeedRenewal,
  RENEWAL_INTERVAL_MS,
  SEED_TIMEZONE,
};
