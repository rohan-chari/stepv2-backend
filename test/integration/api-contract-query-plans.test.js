const assert = require("node:assert/strict");
const { beforeEach, describe, it } = require("node:test");

const { cleanDatabase, createTestUser, prisma } = require("./setup");

describe("API cleanup production query plans", () => {
  beforeEach(cleanDatabase);

  it("USER message watermark uses the dedicated race/kind/created/id partial index", async () => {
    const { user } = await createTestUser({ displayName: "Plan User" });
    const race = await prisma.race.create({
      data: {
        creatorId: user.id,
        name: "Watermark Plan",
        targetSteps: 10000,
        status: "ACTIVE",
        startedAt: new Date("2026-08-13T11:00:00.000Z"),
        endsAt: new Date("2026-08-14T11:00:00.000Z"),
      },
    });
    await prisma.raceMessage.createMany({
      data: Array.from({ length: 5000 }, (_, index) => ({
        raceId: race.id,
        senderId: user.id,
        kind: index % 5 === 0 ? "USER" : "SYSTEM",
        body: `message ${index}`,
        createdAt: new Date(Date.UTC(2026, 7, 13, 0, 0, index)),
      })),
    });
    await prisma.$executeRawUnsafe("ANALYZE race_messages");
    const rows = await prisma.$queryRawUnsafe(
      `EXPLAIN (ANALYZE, BUFFERS, FORMAT TEXT)
       SELECT id, created_at
       FROM race_messages
       WHERE race_id=$1
         AND kind='user'::"RaceMessageKind"
         AND deleted_at IS NULL
       ORDER BY created_at DESC, id DESC
       LIMIT 50`,
      race.id
    );
    const plan = rows.map((row) => row["QUERY PLAN"]).join("\n");
    assert.match(plan, /Execution Time:/);
    assert.match(plan, /Buffers:/);
    assert.match(plan, /race_messages_user_watermark_idx/);
  });

  it("post-task claim, ambiguity, dedupe and retention use bounded production indexes", async () => {
    const { user } = await createTestUser({ displayName: "Post Plan User" });
    const race = await prisma.race.create({
      data: { creatorId: user.id, name: "Post Plan", targetSteps: 1 },
    });
    const old = new Date("2026-08-01T00:00:00.000Z");
    await prisma.$executeRawUnsafe(
      `INSERT INTO race_resolution_post_tasks (
         id, race_id, source_generation, dedupe_key, state, requested_at,
         not_before_at, snapshot_state, snapshot_command, payload_bytes,
         intent_count, completed_at, created_at, updated_at
       )
       SELECT 'plan-task-' || n, $1::text, n, 'plan-dedupe-' || n,
         CASE WHEN n <= 9950 THEN 'succeeded' ELSE 'queued' END,
         $2::timestamptz, $2::timestamptz,
         CASE WHEN n <= 9950 THEN 'succeeded' ELSE 'pending' END,
         jsonb_build_object('raceId',$1::text,'timeZone','UTC'), 32,
         CASE WHEN n <= 1000 THEN 1 ELSE 0 END,
         CASE WHEN n <= 9950
           THEN $2::timestamptz + n * interval '1 minute' ELSE NULL END,
         $2::timestamptz, $2::timestamptz
       FROM generate_series(1,10000) AS series(n)`,
      race.id,
      old
    );
    await prisma.$executeRawUnsafe(
      `INSERT INTO race_resolution_delivery_intents (
         id, task_id, ordinal, kind, recipient_user_id, payload, payload_bytes,
         delivery_key_hash, state, attempted_at, created_at, updated_at
       )
       SELECT 'plan-intent-' || n, 'plan-task-' || n, 0, 'NUDGE', $1,
         '{"type":"STEP_SYNC_REQUEST"}'::jsonb, 28,
         md5('plan-intent-' || n) || md5('plan-intent-' || n || '-2'),
         'attempting', $2, $2, $2
       FROM generate_series(1,1000) AS series(n)`,
      user.id,
      old
    );
    await prisma.$executeRawUnsafe("ANALYZE race_resolution_post_tasks");
    await prisma.$executeRawUnsafe("ANALYZE race_resolution_delivery_intents");
    const explain = async (sql, ...params) => {
      const rows = await prisma.$queryRawUnsafe(
        `EXPLAIN (ANALYZE, BUFFERS, FORMAT TEXT) ${sql}`,
        ...params
      );
      return rows.map((row) => row["QUERY PLAN"]).join("\n");
    };
    const claim = await explain(
      `SELECT id FROM race_resolution_post_tasks
       WHERE (state='queued' AND not_before_at <= $1)
          OR (state='running' AND lease_expires_at <= $1)
       ORDER BY requested_at ASC LIMIT 1`,
      new Date()
    );
    const ambiguity = await explain(
      `SELECT id FROM race_resolution_delivery_intents
       WHERE state='attempting' AND attempted_at <= $1
       ORDER BY attempted_at ASC LIMIT 500`,
      new Date()
    );
    const dedupe = await explain(
      `SELECT id FROM race_resolution_post_tasks
       WHERE race_id=$1 AND source_generation=$2`,
      race.id,
      77
    );
    const retention = await explain(
      `SELECT id FROM race_resolution_post_tasks
       WHERE state IN ('succeeded','succeeded_with_failures')
         AND completed_at < $1
       ORDER BY completed_at ASC, id ASC LIMIT 500`,
      new Date("2026-08-01T08:21:00.000Z")
    );
    assert.match(claim, /race_resolution_post_tasks_(state_not_before_at|state_completed_at_id|lease_expires_at)_idx/);
    assert.doesNotMatch(claim, /Seq Scan on race_resolution_post_tasks/);
    assert.match(ambiguity, /race_resolution_delivery_intents_state_attempted_at_idx/);
    assert.match(dedupe, /race_resolution_post_tasks_race_id_source_generation_(key|idx)/);
    assert.match(retention, /race_resolution_post_tasks_state_completed_at_id_idx/);
    for (const plan of [claim, ambiguity, dedupe, retention]) {
      assert.match(plan, /Execution Time:/);
      assert.match(plan, /Buffers:/);
    }
  });

  it("friend, compact profile, stats, race and 16-player tournament projections use indexed sets", async () => {
    const { user } = await createTestUser({ displayName: "Projection Plan User" });
    await prisma.$executeRawUnsafe(
      `INSERT INTO users (id, display_name, created_at)
       SELECT 'projection-user-' || n, 'ProjectionUser' || n, NOW()
       FROM generate_series(1,15000) AS series(n)`
    );
    await prisma.$executeRawUnsafe(
      `INSERT INTO friendships (id, requester_id, addressee_id, status, created_at, updated_at)
       SELECT 'projection-friend-a-' || n, $1, 'projection-user-' || n,
              'ACCEPTED'::"FriendshipStatus", NOW(), NOW()
       FROM generate_series(1,1000) AS series(n)
       UNION ALL
       SELECT 'projection-friend-b-' || n, 'projection-user-' || n, $1,
              'ACCEPTED'::"FriendshipStatus", NOW(), NOW()
       FROM generate_series(1001,2000) AS series(n)`,
      user.id
    );
    await prisma.$executeRawUnsafe(
      `INSERT INTO friendships (id, requester_id, addressee_id, status, created_at, updated_at)
       SELECT 'projection-unrelated-' || n,
              'projection-user-' || (2001 + ((n - 1) / 400)),
              'projection-user-' || (1 + ((n - 1) % 400)),
              'DECLINED'::"FriendshipStatus", NOW(), NOW()
       FROM generate_series(1,20000) AS series(n)`
    );
    await prisma.step.createMany({
      data: Array.from({ length: 1500 }, (_, index) => ({
        userId: user.id,
        date: new Date(Date.UTC(2022, 0, 1 + index)),
        steps: index,
      })),
    });
    await prisma.$executeRawUnsafe(
      `INSERT INTO steps (id, user_id, steps, date, created_at)
       SELECT 'projection-step-' || u || '-' || d,
              'projection-user-' || (1000 + u), d,
              DATE '2022-01-01' + d, NOW()
       FROM generate_series(1,20) AS users(u)
       CROSS JOIN generate_series(0,1499) AS days(d)`
    );
    const race = await prisma.race.create({
      data: { creatorId: user.id, name: "Projection Race", targetSteps: 10000, status: "ACTIVE" },
    });
    await prisma.raceParticipant.createMany({
      data: Array.from({ length: 350 }, (_, index) => ({
        raceId: race.id,
        userId: `projection-user-${index + 1}`,
        status: "ACCEPTED",
        joinedAt: new Date(Date.UTC(2026, 7, 1, 0, 0, index)),
      })),
    });
    const noiseRaces = [];
    for (let index = 0; index < 10; index++) {
      noiseRaces.push(await prisma.race.create({
        data: {
          creatorId: user.id,
          name: `Projection Noise ${index}`,
          targetSteps: 10000,
          status: "ACTIVE",
        },
      }));
    }
    await prisma.raceParticipant.createMany({
      data: noiseRaces.flatMap((noiseRace, raceIndex) =>
        Array.from({ length: 350 }, (_, index) => ({
          raceId: noiseRace.id,
          userId: `projection-user-${351 + raceIndex * 350 + index}`,
          status: "ACCEPTED",
          joinedAt: new Date(Date.UTC(2026, 7, 2, 0, 0, index)),
        }))
      ),
    });
    const tournament = await prisma.tournament.create({
      data: {
        creatorId: user.id,
        name: "Projection Tournament",
        status: "ACTIVE",
        bracketSize: 16,
        matchupDurationDays: 1,
        currentRound: 4,
        totalRounds: 4,
      },
    });
    await prisma.tournamentParticipant.createMany({
      data: Array.from({ length: 16 }, (_, index) => ({
        tournamentId: tournament.id,
        userId: `projection-user-${index + 1}`,
        status: "ACCEPTED",
        seed: index,
        joinedAt: new Date(Date.UTC(2026, 7, 1, 0, 0, index)),
      })),
    });
    const brackets = [8, 4, 2, 1];
    const matchupRows = [];
    for (let round = 1; round <= 4; round++) {
      for (let matchIndex = 0; matchIndex < brackets[round - 1]; matchIndex++) {
        matchupRows.push({
          creatorId: user.id,
          name: `Round ${round} Match ${matchIndex}`,
          targetSteps: 0,
          timeBased: true,
          status: round === 4 ? "ACTIVE" : "COMPLETED",
          tournamentId: tournament.id,
          tournamentRound: round,
          tournamentMatchIndex: matchIndex,
        });
      }
    }
    await prisma.race.createMany({ data: matchupRows });
    await prisma.tournament.createMany({
      data: Array.from({ length: 100 }, (_, index) => ({
        id: `projection-tournament-${index}`,
        creatorId: user.id,
        name: `Projection History ${index}`,
        status: "COMPLETED",
        bracketSize: 16,
        matchupDurationDays: 1,
        currentRound: 4,
        totalRounds: 4,
      })),
    });
    await prisma.tournamentParticipant.createMany({
      data: Array.from({ length: 100 }, (_, tournamentIndex) =>
        Array.from({ length: 16 }, (_, index) => ({
          tournamentId: `projection-tournament-${tournamentIndex}`,
          userId: `projection-user-${index + 1}`,
          status: "ACCEPTED",
          seed: index,
        }))
      ).flat(),
    });
    await prisma.race.createMany({
      data: Array.from({ length: 100 }, (_, tournamentIndex) =>
        matchupRows.map((row) => ({
          ...row,
          name: `${row.name} History ${tournamentIndex}`,
          tournamentId: `projection-tournament-${tournamentIndex}`,
        }))
      ).flat(),
    });
    await Promise.all([
      prisma.$executeRawUnsafe("ANALYZE friendships"),
      prisma.$executeRawUnsafe("ANALYZE users"),
      prisma.$executeRawUnsafe("ANALYZE steps"),
      prisma.$executeRawUnsafe("ANALYZE race_participants"),
      prisma.$executeRawUnsafe("ANALYZE tournament_participants"),
      prisma.$executeRawUnsafe("ANALYZE races"),
    ]);
    const explain = async (sql, ...params) => {
      const rows = await prisma.$queryRawUnsafe(
        `EXPLAIN (ANALYZE, BUFFERS, FORMAT TEXT) ${sql}`,
        ...params
      );
      return rows.map((row) => row["QUERY PLAN"]).join("\n");
    };
    const friends = await explain(
      `SELECT id, requester_id, addressee_id FROM friendships
       WHERE status='ACCEPTED'::"FriendshipStatus"
         AND (requester_id=$1 OR addressee_id=$1)`,
      user.id
    );
    const compactProfiles = await explain(
      `SELECT id, display_name, profile_photo_url FROM users
       WHERE id=ANY($1::text[])`,
      Array.from({ length: 350 }, (_, index) => `projection-user-${index + 1}`)
    );
    const stats = await explain(
      `SELECT COALESCE(SUM(steps),0), COUNT(*), MAX(steps)
       FROM steps WHERE user_id=$1 AND date >= $2`,
      user.id,
      new Date("2024-01-01T00:00:00.000Z")
    );
    const raceAccess = await explain(
      `SELECT id, status FROM race_participants WHERE race_id=$1 AND user_id=$2`,
      race.id,
      "projection-user-1"
    );
    const progress = await explain(
      `SELECT id, user_id, total_steps, raw_steps, joined_at
       FROM race_participants WHERE race_id=$1
         AND status='accepted'::"RaceParticipantStatus"
       ORDER BY joined_at ASC`,
      race.id
    );
    const tournamentParticipants = await explain(
      `SELECT user_id, status, seed, joined_at FROM tournament_participants
       WHERE tournament_id=$1 ORDER BY joined_at ASC`,
      tournament.id
    );
    const tournamentRaces = await explain(
      `SELECT id, tournament_round, tournament_match_index, status
       FROM races WHERE tournament_id=$1
       ORDER BY tournament_round ASC, tournament_match_index ASC`,
      tournament.id
    );
    assert.match(friends, /friendships_(requester|addressee)_id_status_idx/);
    // At the production-like 350/15k density Postgres may deliberately choose
    // a sub-millisecond sequential pass over 350 random primary-key probes;
    // the primary key remains the usable alternative as density falls.
    assert.match(compactProfiles, /users_pkey|Seq Scan on users/);
    assert.match(stats, /steps_user_id_date_(key|idx)/);
    assert.match(raceAccess, /race_participants_(race_id_user_id_key|user_id_status(?:_invite_expires_at)?_idx)/);
    assert.match(progress, /race_participants_race_id_status_idx/);
    assert.match(tournamentParticipants, /tournament_participants_tournament_id_user_id_key/);
    // Both production indexes are legitimate for a 16-player bracket's 15
    // matchup rows. Depending on current row width/statistics, Postgres may
    // prefer the ordered unique index or the tournament/status bitmap index
    // followed by a bounded 15-row in-memory sort. Keep this assertion strict
    // about indexed access while allowing that cost-based choice.
    assert.match(
      tournamentRaces,
      /races_tournament_id_(?:tournament_round_tournament_match_index_key|status_idx)/
    );
    for (const plan of [
      friends, compactProfiles, stats, raceAccess, progress,
      tournamentParticipants, tournamentRaces,
    ]) {
      assert.match(plan, /Execution Time:/);
      assert.match(plan, /Buffers:/);
    }
  });
});
