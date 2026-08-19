# Request-path and payload optimization verification evidence

Date: 2026-08-18. Local verification only. No deployment, commit, push, production
database access, or production cache operation was performed.

## Scope and result language

The temporary verifier executed a public HTTP gate/contract and parity check for
each of the 13 flags, twice: once with a disposable local Redis on DB 15 and once
with `REDIS_URL` unset. Both runs reported 13/13 verifier rows passed,
`allFlagsResetFalse:true`, and exact DB count restoration after cleanup.

A verifier-row pass is not represented here as completion of every exhaustive
fixture combination in requirements §9. The exact gaps are called out in the
matrix below. Those gaps remain rollout blockers unless owner-reviewed existing
suite evidence or a later dedicated fixture run closes them.

## Source identity and exact commands

Verifier source SHA-256:

```text
3a80df191c59042ef32ccd5e800d3a1d4dc745614f0953f86ee87efd563dddcf  request-path-verifier.mjs
```

Captured output SHA-256:

```text
72fa558bcf6f4a086ab95db82ff84b79b4f00e4cbb5d093fa6ba32c6b69dee33  redis-on.json
4ade33dbd431e49139d70c22381930b3d692634836b251e70d760c5ba2dead4d  redis-unset.json
```

Exact materialization/execution form:

```sh
VERIFY_ROOT="$(mktemp -d /tmp/request-path-verify.XXXXXX)"
BACKEND_REPO="<backend path from CLAUDE.local.md>"
# Materialize the exact fenced source below as:
# "$VERIFY_ROOT/request-path-verifier.mjs"

REDIS_WORK="$(mktemp -d /tmp/request-path-redis.XXXXXX)"
redis-server --bind 127.0.0.1 --port 6379 --save '' --appendonly no \
  --daemonize yes --dir "$REDIS_WORK" \
  --pidfile "$REDIS_WORK/redis.pid" --logfile "$REDIS_WORK/redis.log"
redis-cli -n 15 ping
# PONG

DATABASE_URL="postgresql://rohan@localhost:5432/steps_tracker_request_path_test" \
REDIS_URL="redis://127.0.0.1:6379/15" \
NODE_ENV=test PRISMA_QUERY_EVENTS_ENABLED=true \
node "$VERIFY_ROOT/request-path-verifier.mjs" \
  --backend "$BACKEND_REPO" --output "$VERIFY_ROOT/redis-on.json"
# {"redisMode":"on","flags":13,"passed":true,"dbRestored":true}

redis-cli -n 15 shutdown nosave
# A subsequent ping returned connection refused.

DATABASE_URL="postgresql://rohan@localhost:5432/steps_tracker_request_path_test" \
REDIS_URL= NODE_ENV=test PRISMA_QUERY_EVENTS_ENABLED=true \
node "$VERIFY_ROOT/request-path-verifier.mjs" \
  --backend "$BACKEND_REPO" --output "$VERIFY_ROOT/redis-unset.json"
# {"redisMode":"unset","flags":13,"passed":true,"dbRestored":true}
```

The actual captured files were `/tmp/request-path-verifier.mjs`,
`/tmp/request-path-redis-on.json`, and
`/tmp/request-path-redis-unset.json`. The disposable Redis directory was
`/tmp/request-path-redis.iGR7XN`. Redis DB 15 was flushed by the verifier and
the process was stopped afterward.

## Fixture manifest and DB snapshots

Redis-on: run `81c58050-1f3f-4798-aaa7-e090adc48a02`; users
`7b939efb-ac62-455b-b7f7-c0b1b3795497` and
`471774c3-889c-473e-9b34-cd930ceee917`; race
`5e995165-1484-433c-9ca9-33c32dc5de7d`; 56 Prisma query events, 13 in
the SQL-summary/repeatable-read model capture.

Redis-unset: run `43f1625b-fa97-4b6f-8bd8-101ad0f239fc`; users
`a699c406-694c-4dfc-9d17-edb20aec28d1` and
`0d76e41f-3f4c-4ee5-a3bc-2aa2dc137c96`; race
`1404a8d2-41f1-40ac-a610-ebe8cb9dff8e`; 56 Prisma query events, 13 in
the model capture.

Both runs had this exact before/after count snapshot:

```json
{"users":12,"races":1,"participants":12,"powerups":0,"effects":0,"feedEvents":1,"coinTransactions":0}
```

The verifier created two unique users, one ACTIVE public race, one ACCEPTED
participant, and an uploader scoring-input version row. Its `finally` path
reset all 13 request-bound flags false, removed all fixture rows, restored the
pre-run `racePreviewEnabled` value/absence, and asserted exact count parity.

## Per-flag matrix

| Flag | Result | Exact coverage / remaining gap |
|---|---|---|
| `raceListSqlSummaryV1Enabled` | PASS | Public `GET /races` off/on canonical parity and real SQL-summary query capture on one ACTIVE fixture. NOT RUN: full finisher-null/equal-finish/identical-key fallback and zero-step/join/UUID tie fixtures. |
| `apiRaceListCompactV1Enabled` | PASS | Public capability/query/flag gating, tokenless fallback, only allowed removals, optional blocks retained; 478→342 bytes. |
| `apiRaceBootstrapCompactV1Enabled` | PASS | Direct ACTIVE solo compact; team, PENDING, COMPLETED, tournament spectator, public preview, and tokenless stayed legacy with participants. NOT RUN: Flutter malformed-summary fallback. |
| `homeRaceCardLeanLiveV1Enabled` | PASS smoke | Public off/on equality through deterministic injected core. NOT RUN: real multi-racer scoring/effects/team/fallback and bounded hydration queries. |
| `homeRaceCardParallelOptionalV1Enabled` | PASS | Success parity; injected impact failure returned exact status/body 500 `{"error":"Internal server error"}` in sequential and parallel modes. Observed harness fan-out 1 (≤3); attributable pool wait NOT RUN/null. |
| `publicRaceCountSqlV1Enabled` | PASS smoke | Production selector via public discovery: legacy 2 rows→count 1, SQL seam 1 scalar→count 1. NOT RUN: full real-DB visibility truth table. |
| `raceMessageLeanAccessV1Enabled` | PASS | Production assembler via public HTTP, exact body, one full and one lean access read, Redis on/unset. |
| `apiRaceMessageConditionalV1Enabled` | PASS | Changed 200, authorized unchanged 304/zero body, ETag/cache headers, includeUser true/false and alternate limit. NOT RUN: partial stream, rename/photo, Stealth activation/expiry changes. |
| `apiRacePowerupTargetContextV1Enabled` | PASS | Typed non-Bounty minimal keys, unknown legacy downgrade, machine `RACE_NOT_ACTIVE` code; Bounty route smoke in both Redis modes. NOT RUN: real standings/PG values, full team/forfeit/Stealth, Flutter Pinecone proof. |
| `racePowerupLeanUseContextV1Enabled` | PASS smoke | Real DB accepted-roster and extended-caster selects in one repeatable-read transaction. NOT RUN: every powerup public mutation with DB/feed/event/enqueue parity. |
| `apiLeaderboardCompactV1Enabled` | PASS | In-list compact removes only top10/duplicate caller; tokenless legacy retained. NOT RUN: dedicated compact outside-top-100 fixture. |
| `raceProgressLeanProjectionV1Enabled` | PASS smoke | Paged public contract in Redis on/unset plus focused suites. NOT RUN: full capacity warm/cold hydration/query matrix. |
| `legacyUploaderStepSamplePrefetchV1Enabled` | PASS fence smoke | Real version-row materialization plus focused uploader suites and forced mismatch retry. NOT RUN: full public upload DB/box/effect/timezone/concurrent matrix. |

These NOT RUN subcases remain rollout evidence gaps.

## Canonical verifier outputs

Redis on (long query text is normalized here; the SHA above pins the raw file):

```json
{
  "environment": {
    "node": "v24.16.0",
    "nodeEnv": "test",
    "databaseName": "steps_tracker_request_path_test",
    "databaseHost": "localhost",
    "redisMode": "on",
    "redisProbe": {
      "configured": true,
      "ping": "PONG",
      "db": 15
    }
  },
  "fixture": {
    "runId": "81c58050-1f3f-4798-aaa7-e090adc48a02",
    "userIds": [
      "7b939efb-ac62-455b-b7f7-c0b1b3795497",
      "471774c3-889c-473e-9b34-cd930ceee917"
    ],
    "raceIds": [
      "5e995165-1484-433c-9ca9-33c32dc5de7d"
    ],
    "dbModelQueryCount": 13
  },
  "dbBefore": {
    "users": 12,
    "races": 1,
    "participants": 12,
    "powerups": 0,
    "effects": 0,
    "feedEvents": 1,
    "coinTransactions": 0
  },
  "dbAfter": {
    "users": 12,
    "races": 1,
    "participants": 12,
    "powerups": 0,
    "effects": 0,
    "feedEvents": 1,
    "coinTransactions": 0
  },
  "allFlagsResetFalse": true,
  "passed": true,
  "matrix": [
    {
      "flag": "raceListSqlSummaryV1Enabled",
      "passed": true,
      "coverage": "executed",
      "evidence": {
        "offStatus": 200,
        "onStatus": 200,
        "sqlSummaryArgument": true,
        "realSqlSummaryRaceIds": [
          "5e995165-1484-433c-9ca9-33c32dc5de7d"
        ],
        "queryEvents": 13
      }
    },
    {
      "flag": "apiRaceListCompactV1Enabled",
      "passed": true,
      "coverage": "executed",
      "evidence": {
        "legacyBytes": 478,
        "compactBytes": 342,
        "compactContract": "race-list-compact-v1",
        "tokenlessContract": null
      }
    },
    {
      "flag": "apiRaceBootstrapCompactV1Enabled",
      "passed": true,
      "coverage": "executed",
      "evidence": {
        "contracts": {
          "direct": {
            "status": 200,
            "contract": "race-bootstrap-compact-v1",
            "raceParticipants": false
          },
          "team": {
            "status": 200,
            "contract": "race-bootstrap-v1",
            "raceParticipants": true
          },
          "pending": {
            "status": 200,
            "contract": "race-bootstrap-v1",
            "raceParticipants": true
          },
          "completed": {
            "status": 200,
            "contract": "race-bootstrap-v1",
            "raceParticipants": true
          },
          "spectator": {
            "status": 200,
            "contract": "race-bootstrap-v1",
            "raceParticipants": true
          },
          "preview": {
            "status": 200,
            "contract": "race-bootstrap-v1",
            "raceParticipants": true
          }
        },
        "tokenless": "race-bootstrap-v1"
      }
    },
    {
      "flag": "homeRaceCardLeanLiveV1Enabled",
      "passed": true,
      "coverage": "executed",
      "evidence": {
        "offBody": {
          "type": "ACTIVE",
          "totalSteps": 444,
          "myPlacement": 2,
          "topParticipants": [
            {
              "userId": "7b939efb-ac62-455b-b7f7-c0b1b3795497"
            }
          ],
          "teams": null,
          "effects": [],
          "characterPowersEnabled": false
        },
        "onBody": {
          "type": "ACTIVE",
          "totalSteps": 444,
          "myPlacement": 2,
          "topParticipants": [
            {
              "userId": "7b939efb-ac62-455b-b7f7-c0b1b3795497"
            }
          ],
          "teams": null,
          "effects": [],
          "characterPowersEnabled": false
        }
      }
    },
    {
      "flag": "homeRaceCardParallelOptionalV1Enabled",
      "passed": true,
      "coverage": "executed",
      "evidence": {
        "successParity": true,
        "failureLegacy": {
          "status": 500,
          "body": {
            "error": "Internal server error"
          }
        },
        "failureParallel": {
          "status": 500,
          "body": {
            "error": "Internal server error"
          }
        },
        "maxObservedDbFanout": 1,
        "observedBranchCalls": 6,
        "pool": {
          "total": null,
          "idle": null,
          "waiting": null,
          "note": "injected route harness; local pool telemetry not attributed per branch"
        }
      }
    },
    {
      "flag": "publicRaceCountSqlV1Enabled",
      "passed": true,
      "coverage": "executed",
      "evidence": {
        "off": 1,
        "on": 1,
        "legacyRowsRead": 2,
        "sqlScalarRows": 1,
        "legacyCountReads": 1,
        "sqlCountReads": 1
      }
    },
    {
      "flag": "raceMessageLeanAccessV1Enabled",
      "passed": true,
      "coverage": "executed",
      "evidence": {
        "fullAccessReads": 1,
        "leanAccessReads": 1,
        "bodyParity": true,
        "redisMode": "on"
      }
    },
    {
      "flag": "apiRaceMessageConditionalV1Enabled",
      "passed": true,
      "coverage": "executed",
      "evidence": {
        "changed": {
          "status": 200,
          "etag": "\"873ed65ff939dcc7479ea5c8329c2a8102fb88142b7d05c2229c66b487bd5eba\"",
          "revision": "873ed65ff939dcc7479ea5c8329c2a8102fb88142b7d05c2229c66b487bd5eba"
        },
        "unchanged": {
          "status": 304,
          "bytes": 0
        },
        "includeUserFalse": {
          "status": 200,
          "requested": {
            "USER": false,
            "SYSTEM": true
          }
        },
        "redisMode": "on",
        "redisProbe": {
          "configured": true,
          "ping": "PONG",
          "db": 15
        }
      }
    },
    {
      "flag": "apiRacePowerupTargetContextV1Enabled",
      "passed": true,
      "coverage": "executed",
      "evidence": {
        "typedContract": "race-powerup-target-context-v1",
        "participantKeys": [
          "displayName",
          "forfeitedAt",
          "profilePhotoUrl",
          "stealthed",
          "team",
          "userId"
        ],
        "errorEnvelope": {
          "error": "Race is not active",
          "code": "RACE_NOT_ACTIVE"
        },
        "unknownTypeContract": "race-powerup-use-context-v1",
        "redisMode": "on"
      }
    },
    {
      "flag": "racePowerupLeanUseContextV1Enabled",
      "passed": true,
      "coverage": "executed",
      "evidence": {
        "raceId": "5e995165-1484-433c-9ca9-33c32dc5de7d",
        "rosterSize": 1,
        "casterKeys": [
          "bonusSteps",
          "finishedAt",
          "forfeitedAt",
          "highMultiplierNotifiedAt",
          "id",
          "joinedAt",
          "maxBonusSteps",
          "nextBoxAtSteps",
          "placement",
          "powerupSlots",
          "status",
          "team",
          "totalSteps",
          "user",
          "userId"
        ],
        "repeatableReadQueryCapture": [
          {
            "query": "captured SQL-summary query preceding the repeatable-read call",
            "durationMs": 2.3236249999999927
          },
          {
            "query": "captured SQL-summary query preceding the repeatable-read call",
            "durationMs": 1.7620829999999899
          },
          {
            "query": "captured SQL-summary query preceding the repeatable-read call",
            "durationMs": 1.9327910000000088
          },
          {
            "query": "SELECT race_participants (accepted-roster or extended-caster projection)",
            "durationMs": 0.18504200000000992
          },
          {
            "query": "SELECT race_participants (accepted-roster or extended-caster projection)",
            "durationMs": 0.20329100000000722
          },
          {
            "query": "COMMIT",
            "durationMs": 0.08108300000000668
          }
        ]
      }
    },
    {
      "flag": "apiLeaderboardCompactV1Enabled",
      "passed": true,
      "coverage": "executed",
      "evidence": {
        "compact": {
          "contract": "leaderboard-compact-v1",
          "top100": [
            {
              "userId": "7b939efb-ac62-455b-b7f7-c0b1b3795497",
              "rank": 1
            }
          ],
          "currentUser": null
        },
        "legacyCurrentUser": {
          "userId": "7b939efb-ac62-455b-b7f7-c0b1b3795497",
          "rank": 1,
          "inTop100": true
        }
      }
    },
    {
      "flag": "raceProgressLeanProjectionV1Enabled",
      "passed": true,
      "coverage": "public-route gate smoke plus unchanged focused progress/snapshot suites; full capacity fixture matrix not re-created by this verifier",
      "evidence": {
        "status": 200,
        "contract": "race-progress-participants-v1",
        "participantCount": 2,
        "redisMode": "on"
      }
    },
    {
      "flag": "legacyUploaderStepSamplePrefetchV1Enabled",
      "passed": true,
      "coverage": "version-fence materialization plus unchanged focused uploader suites; mutation parity matrix recorded separately in scoped verification",
      "evidence": {
        "before": null,
        "after": {
          "userId": "7b939efb-ac62-455b-b7f7-c0b1b3795497",
          "generation": "1",
          "updatedAt": "2026-08-18T22:30:16.295Z"
        },
        "capturedGeneration": "1"
      }
    }
  ]
}
```

Redis unset:

```json
{
  "environment": {
    "node": "v24.16.0",
    "nodeEnv": "test",
    "databaseName": "steps_tracker_request_path_test",
    "databaseHost": "localhost",
    "redisMode": "unset",
    "redisProbe": {
      "configured": false,
      "ping": null,
      "db": null
    }
  },
  "fixture": {
    "runId": "43f1625b-fa97-4b6f-8bd8-101ad0f239fc",
    "userIds": [
      "a699c406-694c-4dfc-9d17-edb20aec28d1",
      "0d76e41f-3f4c-4ee5-a3bc-2aa2dc137c96"
    ],
    "raceIds": [
      "1404a8d2-41f1-40ac-a610-ebe8cb9dff8e"
    ],
    "dbModelQueryCount": 13
  },
  "dbBefore": {
    "users": 12,
    "races": 1,
    "participants": 12,
    "powerups": 0,
    "effects": 0,
    "feedEvents": 1,
    "coinTransactions": 0
  },
  "dbAfter": {
    "users": 12,
    "races": 1,
    "participants": 12,
    "powerups": 0,
    "effects": 0,
    "feedEvents": 1,
    "coinTransactions": 0
  },
  "allFlagsResetFalse": true,
  "passed": true,
  "matrix": [
    {
      "flag": "raceListSqlSummaryV1Enabled",
      "passed": true,
      "coverage": "executed",
      "evidence": {
        "offStatus": 200,
        "onStatus": 200,
        "sqlSummaryArgument": true,
        "realSqlSummaryRaceIds": [
          "1404a8d2-41f1-40ac-a610-ebe8cb9dff8e"
        ],
        "queryEvents": 13
      }
    },
    {
      "flag": "apiRaceListCompactV1Enabled",
      "passed": true,
      "coverage": "executed",
      "evidence": {
        "legacyBytes": 478,
        "compactBytes": 342,
        "compactContract": "race-list-compact-v1",
        "tokenlessContract": null
      }
    },
    {
      "flag": "apiRaceBootstrapCompactV1Enabled",
      "passed": true,
      "coverage": "executed",
      "evidence": {
        "contracts": {
          "direct": {
            "status": 200,
            "contract": "race-bootstrap-compact-v1",
            "raceParticipants": false
          },
          "team": {
            "status": 200,
            "contract": "race-bootstrap-v1",
            "raceParticipants": true
          },
          "pending": {
            "status": 200,
            "contract": "race-bootstrap-v1",
            "raceParticipants": true
          },
          "completed": {
            "status": 200,
            "contract": "race-bootstrap-v1",
            "raceParticipants": true
          },
          "spectator": {
            "status": 200,
            "contract": "race-bootstrap-v1",
            "raceParticipants": true
          },
          "preview": {
            "status": 200,
            "contract": "race-bootstrap-v1",
            "raceParticipants": true
          }
        },
        "tokenless": "race-bootstrap-v1"
      }
    },
    {
      "flag": "homeRaceCardLeanLiveV1Enabled",
      "passed": true,
      "coverage": "executed",
      "evidence": {
        "offBody": {
          "type": "ACTIVE",
          "totalSteps": 444,
          "myPlacement": 2,
          "topParticipants": [
            {
              "userId": "a699c406-694c-4dfc-9d17-edb20aec28d1"
            }
          ],
          "teams": null,
          "effects": [],
          "characterPowersEnabled": false
        },
        "onBody": {
          "type": "ACTIVE",
          "totalSteps": 444,
          "myPlacement": 2,
          "topParticipants": [
            {
              "userId": "a699c406-694c-4dfc-9d17-edb20aec28d1"
            }
          ],
          "teams": null,
          "effects": [],
          "characterPowersEnabled": false
        }
      }
    },
    {
      "flag": "homeRaceCardParallelOptionalV1Enabled",
      "passed": true,
      "coverage": "executed",
      "evidence": {
        "successParity": true,
        "failureLegacy": {
          "status": 500,
          "body": {
            "error": "Internal server error"
          }
        },
        "failureParallel": {
          "status": 500,
          "body": {
            "error": "Internal server error"
          }
        },
        "maxObservedDbFanout": 1,
        "observedBranchCalls": 6,
        "pool": {
          "total": null,
          "idle": null,
          "waiting": null,
          "note": "injected route harness; local pool telemetry not attributed per branch"
        }
      }
    },
    {
      "flag": "publicRaceCountSqlV1Enabled",
      "passed": true,
      "coverage": "executed",
      "evidence": {
        "off": 1,
        "on": 1,
        "legacyRowsRead": 2,
        "sqlScalarRows": 1,
        "legacyCountReads": 1,
        "sqlCountReads": 1
      }
    },
    {
      "flag": "raceMessageLeanAccessV1Enabled",
      "passed": true,
      "coverage": "executed",
      "evidence": {
        "fullAccessReads": 1,
        "leanAccessReads": 1,
        "bodyParity": true,
        "redisMode": "unset"
      }
    },
    {
      "flag": "apiRaceMessageConditionalV1Enabled",
      "passed": true,
      "coverage": "executed",
      "evidence": {
        "changed": {
          "status": 200,
          "etag": "\"873ed65ff939dcc7479ea5c8329c2a8102fb88142b7d05c2229c66b487bd5eba\"",
          "revision": "873ed65ff939dcc7479ea5c8329c2a8102fb88142b7d05c2229c66b487bd5eba"
        },
        "unchanged": {
          "status": 304,
          "bytes": 0
        },
        "includeUserFalse": {
          "status": 200,
          "requested": {
            "USER": false,
            "SYSTEM": true
          }
        },
        "redisMode": "unset",
        "redisProbe": {
          "configured": false,
          "ping": null,
          "db": null
        }
      }
    },
    {
      "flag": "apiRacePowerupTargetContextV1Enabled",
      "passed": true,
      "coverage": "executed",
      "evidence": {
        "typedContract": "race-powerup-target-context-v1",
        "participantKeys": [
          "displayName",
          "forfeitedAt",
          "profilePhotoUrl",
          "stealthed",
          "team",
          "userId"
        ],
        "errorEnvelope": {
          "error": "Race is not active",
          "code": "RACE_NOT_ACTIVE"
        },
        "unknownTypeContract": "race-powerup-use-context-v1",
        "redisMode": "unset"
      }
    },
    {
      "flag": "racePowerupLeanUseContextV1Enabled",
      "passed": true,
      "coverage": "executed",
      "evidence": {
        "raceId": "1404a8d2-41f1-40ac-a610-ebe8cb9dff8e",
        "rosterSize": 1,
        "casterKeys": [
          "bonusSteps",
          "finishedAt",
          "forfeitedAt",
          "highMultiplierNotifiedAt",
          "id",
          "joinedAt",
          "maxBonusSteps",
          "nextBoxAtSteps",
          "placement",
          "powerupSlots",
          "status",
          "team",
          "totalSteps",
          "user",
          "userId"
        ],
        "repeatableReadQueryCapture": [
          {
            "query": "captured SQL-summary query preceding the repeatable-read call",
            "durationMs": 0.8671669999999949
          },
          {
            "query": "captured SQL-summary query preceding the repeatable-read call",
            "durationMs": 2.330083000000002
          },
          {
            "query": "captured SQL-summary query preceding the repeatable-read call",
            "durationMs": 1.6424580000000049
          },
          {
            "query": "SELECT race_participants (accepted-roster or extended-caster projection)",
            "durationMs": 0.18429100000000176
          },
          {
            "query": "SELECT race_participants (accepted-roster or extended-caster projection)",
            "durationMs": 0.28245800000001964
          },
          {
            "query": "COMMIT",
            "durationMs": 0.0745420000000081
          }
        ]
      }
    },
    {
      "flag": "apiLeaderboardCompactV1Enabled",
      "passed": true,
      "coverage": "executed",
      "evidence": {
        "compact": {
          "contract": "leaderboard-compact-v1",
          "top100": [
            {
              "userId": "a699c406-694c-4dfc-9d17-edb20aec28d1",
              "rank": 1
            }
          ],
          "currentUser": null
        },
        "legacyCurrentUser": {
          "userId": "a699c406-694c-4dfc-9d17-edb20aec28d1",
          "rank": 1,
          "inTop100": true
        }
      }
    },
    {
      "flag": "raceProgressLeanProjectionV1Enabled",
      "passed": true,
      "coverage": "public-route gate smoke plus unchanged focused progress/snapshot suites; full capacity fixture matrix not re-created by this verifier",
      "evidence": {
        "status": 200,
        "contract": "race-progress-participants-v1",
        "participantCount": 2,
        "redisMode": "unset"
      }
    },
    {
      "flag": "legacyUploaderStepSamplePrefetchV1Enabled",
      "passed": true,
      "coverage": "version-fence materialization plus unchanged focused uploader suites; mutation parity matrix recorded separately in scoped verification",
      "evidence": {
        "before": null,
        "after": {
          "userId": "a699c406-694c-4dfc-9d17-edb20aec28d1",
          "generation": "1",
          "updatedAt": "2026-08-18T22:29:34.484Z"
        },
        "capturedGeneration": "1"
      }
    }
  ]
}
```

Captured query categories included 14 count snapshots, tagged `WITH accepted`
SQL summary, accepted-roster and caster participant selects plus COMMIT, version
INSERT/SELECT, fixture INSERT/DELETE, and route-support reads. No query targeted
a non-local host or database lacking the `_test` suffix.

## Existing-suite verification

```sh
node --check src/modules/races/routes.js
node --check src/modules/home/buildHomeRaceCardResponse.js
node --check src/modules/races/models/race.js
git diff --check
# pass

node --test --test-concurrency=1 --test-force-exit \
  test/commands/powerups.test.js test/http/home-global-event.test.js \
  test/http/home-step-milestones.test.js test/http/leaderboard-visibility.test.js \
  test/queries/powerupCapabilityCopy.test.js
# 20/20 pass

DATABASE_URL=postgresql://rohan@localhost:5432/steps_tracker_request_path_test \
REFERRAL_IP_HMAC_ACTIVE_VERSION=1 \
REFERRAL_IP_HMAC_SECRET_V1=integration-test-only-referral-hmac-secret-material \
NODE_ENV=test node --test --test-concurrency=1 --test-force-exit \
  test/integration/home-screen.test.js \
  test/integration/race-details-participants-paging.test.js \
  test/integration/leaderboard.test.js \
  test/integration/powerups-signal-jammer.test.js \
  test/integration/powerups-shortcut-mirror.test.js
# 69/69 pass
```

Earlier unchanged focused uploader units passed 15/15; progress/snapshot units
passed 15/15 and 3/3; Home/leaderboard/paging/Redis-chat integration passed
64/64. Forced uploader generation mismatch passed: first CAS rejected, JIT
reload, second CAS committed (`casCalls=2`, `totalSteps=2000`).

Full unchanged unit: 2396/2397. The sole failure belongs to the concurrent
admin-metrics device-token handler, which now supplies two fields beyond the
protected old assertion.

Full unchanged integration: 1874/1883. The nine failures were:

1. stale powerup catalog/copy ladder expectation;
2. shared local-DB tournament-seed unique collision;
3. stale quick-race payout expectation; and
4. six referral fallback assertions run without the newly required referral
   IP-HMAC configuration.

None exercised an optimization file. The full suite remains red and is not
claimed green.

## Test integrity and concurrent worktree

No test was added or modified for this work. The pre-work manifest has 509
files; 507 remain byte-identical. The two changed tracked files are
`test/integration/setup.js` and `test/startup/index.test.js`, changed by
concurrent admin work. New untracked admin/client-IP tests were untouched.

Concurrent admin source/schema/migration work was untouched except for the
narrow additive optimization flags in `src/shared/config/appSettings.js`.
No optimization migration was authored.

## Complete temporary verifier source

```js
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";

const args = process.argv.slice(2);
const valueFor = (name) => {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : null;
};
const backend = path.resolve(valueFor("--backend") || "");
const output = path.resolve(valueFor("--output") || "");
assert.ok(backend && output, "--backend and --output are required");

const databaseUrl = new URL(process.env.DATABASE_URL || "");
const databaseName = decodeURIComponent(databaseUrl.pathname.slice(1));
assert.match(databaseName, /_test$/, "verifier refuses a database not ending in _test");
assert.ok(["localhost", "127.0.0.1"].includes(databaseUrl.hostname), "verifier requires local PostgreSQL");

const require = createRequire(import.meta.url);
const fromBackend = (relative) => require(path.join(backend, relative));
const { createApp } = fromBackend("src/app.js");
const { prisma } = fromBackend("src/db.js");
const { Race: realRaceModel } = fromBackend("src/modules/races/models/race.js");
const { appSettings: realAppSettings } = fromBackend("src/shared/config/appSettings.js");
const { buildGetRaceMessageStreams } = fromBackend("src/modules/social/queries/getRaceMessageStreams.js");
const { buildGetRacePowerupTargetContext } = fromBackend("src/modules/races/queries/getRacePowerupTargetContext.js");
const { buildGetPublicRaceCount } = fromBackend("src/modules/races/queries/getPublicRaceCount.js");
const { buildGetRaceDiscoverySummary } = fromBackend("src/modules/races/queries/getRaceDiscoverySummary.js");
const { buildHomeRaceCardResponse } = fromBackend("src/modules/home/buildHomeRaceCardResponse.js");
const { canonicalJson } = fromBackend("src/shared/http/requestPathPayloadContracts.js");

const FLAGS = [
  "raceProgressLeanProjectionV1Enabled",
  "legacyUploaderStepSamplePrefetchV1Enabled",
  "raceMessageLeanAccessV1Enabled",
  "raceListSqlSummaryV1Enabled",
  "apiRaceListCompactV1Enabled",
  "apiRaceBootstrapCompactV1Enabled",
  "homeRaceCardLeanLiveV1Enabled",
  "homeRaceCardParallelOptionalV1Enabled",
  "publicRaceCountSqlV1Enabled",
  "apiRaceMessageConditionalV1Enabled",
  "apiRacePowerupTargetContextV1Enabled",
  "racePowerupLeanUseContextV1Enabled",
  "apiLeaderboardCompactV1Enabled",
];
const flagValues = Object.fromEntries(FLAGS.map((flag) => [flag, false]));
Object.assign(flagValues, {
  apiRaceBootstrapV1Enabled: true,
  apiRaceMessageStreamsV1Enabled: true,
  apiInboxV1Enabled: true,
  apiImpactSummariesEnabled: false,
  apiHomeShellV1Enabled: false,
  redisCacheHomeInboxUnreadEnabled: false,
  redisCacheHomeImpactSummaryEnabled: false,
  homeServiceBannerEnabled: false,
  homeServiceBannerMessage: "",
  openUserRaceDiscoveryEnabled: false,
  quickCreateRaceCtaEnabled: false,
  apiRaceChatWatermarkCacheV1Enabled: true,
});
const settings = { getFlag: async (key) => flagValues[key] };
const setFlag = (flag, value) => { flagValues[flag] = value === true; };
const matrix = [];
const queryEvents = [];
if (process.env.PRISMA_QUERY_EVENTS_ENABLED === "true") {
  prisma.$on("query", (event) => queryEvents.push({
    query: String(event.query).replace(/\s+/g, " ").trim(),
    durationMs: event.duration,
  }));
}

const countSnapshot = async () => ({
  users: await prisma.user.count(),
  races: await prisma.race.count(),
  participants: await prisma.raceParticipant.count(),
  powerups: await prisma.racePowerup.count(),
  effects: await prisma.raceActiveEffect.count(),
  feedEvents: await prisma.racePowerupEvent.count(),
  coinTransactions: await prisma.coinTransaction.count(),
});

let redis = null;
let redisMode = "unset";
let redisProbe = { configured: false, ping: null, db: null };
if (process.env.REDIS_URL) {
  const redisUrl = new URL(process.env.REDIS_URL);
  assert.ok(["localhost", "127.0.0.1"].includes(redisUrl.hostname), "verifier requires local Redis");
  assert.equal(redisUrl.pathname, "/15", "verifier may use only Redis DB 15");
  const Redis = fromBackend("node_modules/ioredis/built/index.js").default;
  redis = new Redis(process.env.REDIS_URL, { lazyConnect: true, maxRetriesPerRequest: 1 });
  await redis.connect();
  assert.equal(await redis.ping(), "PONG");
  await redis.flushdb();
  redisMode = "on";
  redisProbe = { configured: true, ping: "PONG", db: 15 };
}

const unique = crypto.randomUUID();
const fixture = { runId: unique, userIds: [], raceIds: [] };
const before = await countSnapshot();
let previewPrevious;
let previewHadRow = false;
let server;

const record = (flag, passed, evidence, coverage = "executed") => {
  matrix.push({ flag, passed, coverage, evidence });
  assert.equal(passed, true, `${flag} failed`);
};

try {
  const [user, outsider] = await Promise.all([
    prisma.user.create({ data: { appleId: `verify-${unique}`, displayName: `verify-${unique.slice(0, 12)}` } }),
    prisma.user.create({ data: { appleId: `verify-outsider-${unique}`, displayName: `verify-o-${unique.slice(0, 10)}` } }),
  ]);
  fixture.userIds.push(user.id, outsider.id);
  const dbRace = await prisma.race.create({ data: {
    creatorId: user.id,
    name: `request-path-verify-${unique}`,
    targetSteps: 10000,
    status: "ACTIVE",
    startedAt: new Date(Date.now() - 60_000),
    endsAt: new Date(Date.now() + 3_600_000),
    isPublic: true,
    powerupsEnabled: true,
  } });
  fixture.raceIds.push(dbRace.id);
  await prisma.raceParticipant.create({ data: {
    raceId: dbRace.id,
    userId: user.id,
    status: "ACCEPTED",
    totalSteps: 321,
  } });

  const sqlQueryStart = queryEvents.length;
  const sqlSummary = await realRaceModel.findSqlSummariesForUser(user.id);
  assert.equal(sqlSummary.races.some((race) => race.id === dbRace.id), true);
  const leanUse = await realRaceModel.findPowerupUseContextV1(dbRace.id, user.id);
  assert.equal(leanUse.participants.length, 1);
  assert.equal(leanUse.participants[0].userId, user.id);
  fixture.dbModelQueries = queryEvents.slice(sqlQueryStart);

  const previewRow = await prisma.appSetting.findUnique({ where: { key: "racePreviewEnabled" } });
  previewHadRow = previewRow != null;
  previewPrevious = previewRow?.value;
  await realAppSettings.setFlag("racePreviewEnabled", true);
  realAppSettings.bustCache();

  const accessContexts = {
    direct: { id: "direct", status: "ACTIVE", isPublic: true, isTeamRace: false, tournamentId: null, seededBucketId: null, participants: [{ userId: user.id, status: "ACCEPTED" }], tournament: null },
    team: { id: "team", status: "ACTIVE", isPublic: true, isTeamRace: true, tournamentId: null, seededBucketId: null, participants: [{ userId: user.id, status: "ACCEPTED" }], tournament: null },
    pending: { id: "pending", status: "PENDING", isPublic: true, isTeamRace: false, tournamentId: null, seededBucketId: null, participants: [{ userId: user.id, status: "ACCEPTED" }], tournament: null },
    completed: { id: "completed", status: "COMPLETED", isPublic: true, isTeamRace: false, tournamentId: null, seededBucketId: null, participants: [{ userId: user.id, status: "ACCEPTED" }], tournament: null },
    spectator: { id: "spectator", status: "ACTIVE", isPublic: false, isTeamRace: false, tournamentId: "tournament-1", seededBucketId: null, participants: [], tournament: { participants: [{ userId: user.id }] } },
    preview: { id: "preview", status: "ACTIVE", isPublic: true, isTeamRace: false, tournamentId: null, seededBucketId: null, participants: [], tournament: null },
    inactiveTarget: { id: "inactiveTarget", status: "PENDING", isPublic: true, isTeamRace: false, tournamentId: null, seededBucketId: null, participants: [{ userId: user.id, status: "ACCEPTED" }], tournament: null },
  };
  const legacyList = {
    active: [{ id: "a", targetSteps: 1000, payouts: [1], payoutTiers: [1], leader: { userId: "u2" }, mysteryBoxCount: 1, slotItems: [{ id: "s" }], teamATotalSteps: 4, teamBTotalSteps: 3, teams: { teamA: { totalSteps: 4 }, teamB: { totalSteps: 3 } }, creator: { id: "c", profilePhotoUrl: "c.png" }, winner: { id: "w", profilePhotoUrl: "w.png" }, retained: "yes" }],
    pending: [], completed: [], tournaments: { active: [] }, nextRace: { resolved: true }, payoutDoubleOffer: { eligible: false },
  };
  const leaderboardBody = {
    top10: [{ userId: user.id, rank: 1 }],
    top100: [{ userId: user.id, rank: 1 }],
    currentUser: { userId: user.id, rank: 1, inTop100: true },
  };
  const messageRows = {
    USER: { messages: [{ id: "m1", createdAt: "2026-08-18T12:00:00.000Z", displayName: "A", profilePhotoUrl: null, body: "hello" }], nextCursor: null },
    SYSTEM: { messages: [{ id: "e1", createdAt: "2026-08-18T11:00:00.000Z", description: "event" }], nextCursor: null },
  };
  let sqlSummaryArgument = null;
  let fullAccessReads = 0;
  let leanAccessReads = 0;
  let sqlCountReads = 0;
  let legacyCountReads = 0;
  let failInbox = false;
  let failImpact = false;
  let activeDbBranches = 0;
  let maxDbBranches = 0;
  let branchCalls = 0;
  const branch = async (value, failure = false) => {
    branchCalls += 1;
    activeDbBranches += 1;
    maxDbBranches = Math.max(maxDbBranches, activeDbBranches);
    await new Promise((resolve) => setTimeout(resolve, 2));
    activeDbBranches -= 1;
    if (failure) throw new Error("injected inbox failure");
    return typeof value === "function" ? value() : value;
  };
  const fakeRace = {
    findById: async (id) => ({ id, seededBucketId: null }),
    findBootstrapAccessContext: async (id) => accessContexts[id] || null,
    findPowerupTargetContext: async (id) => {
      const context = accessContexts[id] || accessContexts.direct;
      return {
        id,
        status: context.status,
        powerupsEnabled: true,
        participants: [
          { id: "rp1", userId: user.id, status: "ACCEPTED", totalSteps: 10, finishedAt: null, placement: null, forfeitedAt: null, team: null, joinedAt: new Date("2026-08-18T10:00:00Z"), powerupSlots: 3, user: { displayName: "Viewer", profilePhotoUrl: null } },
          { id: "rp2", userId: outsider.id, status: "ACCEPTED", totalSteps: 20, finishedAt: null, placement: null, forfeitedAt: null, team: null, joinedAt: new Date("2026-08-18T10:01:00Z"), powerupSlots: 3, user: { displayName: "Target", profilePhotoUrl: "t.png" } },
        ],
      };
    },
    findMessageAccessContext: async () => {
      leanAccessReads += 1;
      return { id: "direct", seededBucketId: null, tournamentId: null, powerupsEnabled: true, participants: [{ userId: user.id, status: "ACCEPTED" }], tournament: null };
    },
    findPublicPendingLean: async () => {
      legacyCountReads += 1;
      return [
        { id: "public", isPublic: true, status: "PENDING", isTeamRace: false, tournamentId: null, maxParticipants: null, participants: [], creator: { isReviewAccount: false } },
        { id: "member", isPublic: true, status: "PENDING", isTeamRace: false, tournamentId: null, maxParticipants: null, participants: [{ userId: user.id, status: "ACCEPTED" }], creator: { isReviewAccount: false } },
      ];
    },
    countVisiblePublicRaces: async () => { sqlCountReads += 1; return 1; },
  };
  const messageService = buildGetRaceMessageStreams({
    appSettings: settings,
    Race: fakeRace,
    prisma: { race: { findUnique: async () => {
      fullAccessReads += 1;
      return { id: "direct", seededBucketId: null, tournamentId: null, powerupsEnabled: true, participants: [{ userId: user.id, status: "ACCEPTED", user: { displayName: "Viewer" } }], tournament: null };
    } } },
    getRaceMessages: async (_userId, _raceId, options) => messageRows[options.kind],
    raceMessagesCache: {
      getWatermark: async () => {
        if (!redis) return { latestId: "m1", latestAt: "2026-08-18T12:00:00.000Z", recentIds: ["m1"] };
        await redis.set("request-path:watermark", JSON.stringify({ latestId: "m1", latestAt: "2026-08-18T12:00:00.000Z", recentIds: ["m1"] }));
        return JSON.parse(await redis.get("request-path:watermark"));
      },
    },
    logger: { error() {} },
  });
  const targetService = buildGetRacePowerupTargetContext({
    Race: fakeRace,
    RaceActiveEffect: { findActiveForRace: async () => [] },
    RacePowerup: { findInventoryForParticipants: async () => [] },
    now: () => new Date("2026-08-18T12:00:00Z"),
  });
  const publicCount = buildGetPublicRaceCount({ Race: fakeRace, appSettings: settings });
  const discovery = buildGetRaceDiscoverySummary({
    getPublicRaceCount: publicCount,
    getFeaturedRaces: async () => [],
    getPublicTournaments: async () => ({ featured: [] }),
    logger: { error() {} },
  });
  const homeCore = (params) => branch({ type: "ACTIVE", totalSteps: 444, myPlacement: 2, topParticipants: [{ userId: user.id }], teams: null, effects: [] });
  const verifierPrisma = new Proxy(prisma, {
    get(target, property) {
      if (property === "globalEventUserSummary") {
        return {
          ...target.globalEventUserSummary,
          findFirst: async (...args) => {
            if (failImpact) throw new Error("injected impact failure");
            return target.globalEventUserSummary.findFirst(...args);
          },
        };
      }
      return Reflect.get(target, property, target);
    },
  });
  const homeAssembler = buildHomeRaceCardResponse({
    getHomeRaceCard: homeCore,
    getHomeShellPresentation: () => branch({ avatar: null }),
    getFriendsSummary: () => branch({ count: 0 }),
    getNextRaceHome: () => branch({ resolved: true }),
    GlobalStepEvent: { findActiveAtCached: () => branch(null) },
    getStepMilestonesToday: () => branch(null),
    getAdExtraSpinStatus: () => branch(null),
    getInboxUnreadCount: () => branch(0, failInbox),
    adRewardsConfig: { ADS_EXTRA_SPIN_ENABLED: false },
    appSettings: settings,
    prisma: verifierPrisma,
    logger: { error() {} },
  });
  const quietLogger = { log() {}, info() {}, warn() {}, error() {} };
  const app = createApp({
    prisma: verifierPrisma,
    appSettings: settings,
    logger: quietLogger,
    capacityMetricsRandom: () => 1,
    requireAuth: (req, _res, next) => { req.user = { id: user.id, timezone: "America/New_York", lastDailyClaimDate: null }; next(); },
    Race: fakeRace,
    RaceActiveEffect: { findActiveForRace: async () => [] },
    RacePowerup: { findInventoryForParticipants: async () => [] },
    getRaces: async (_userId, _teams, options) => { sqlSummaryArgument = options.sqlSummaryEnabled; return structuredClone(legacyList); },
    getTournamentsForUser: async () => null,
    getRacePayoutDoubleOffer: async () => null,
    getRaceDetails: async (_userId, id) => ({ id, status: accessContexts[id]?.status || "ACTIVE", isTeamRace: accessContexts[id]?.isTeamRace === true, participantUserIds: [user.id], acceptedCount: 2, participants: [{ userId: user.id }, { userId: outsider.id }], participantsPagination: { offset: 0, limit: 15, total: 2, hasMore: false, nextOffset: 15 } }),
    getRaceProgress: async () => ({ status: "ACTIVE", participants: [{ userId: user.id }, { userId: outsider.id }], powerupData: { enabled: true, powerupSlots: 3, inventory: [], queuedBoxCount: 0 }, myPlacement: 1 }),
    getPowerupInventory: async () => [],
    getRaceMessageStreams: messageService,
    getRacePowerupTargetContext: targetService,
    getRaceDiscoverySummary: discovery,
    getLeaderboard: async () => structuredClone(leaderboardBody),
    getHomeRaceCard: homeCore,
    buildHomeRaceCardResponse: homeAssembler,
    GlobalStepEvent: { findActiveAtCached: () => branch(null), findActiveAt: () => branch(null) },
    getInboxUnreadCount: () => branch(0, failInbox),
    getStepMilestonesToday: () => branch(null),
    adRewardsConfig: { ADS_EXTRA_SPIN_ENABLED: false },
  });
  server = app.listen(0, "127.0.0.1");
  await new Promise((resolve, reject) => { server.once("listening", resolve); server.once("error", reject); });
  const base = `http://127.0.0.1:${server.address().port}`;
  const request = async (url, { features = [], headers = {} } = {}) => {
    const response = await fetch(`${base}${url}`, { headers: { Authorization: "Bearer verifier", "X-Client-Features": features.join(","), ...headers } });
    const text = await response.text();
    return { status: response.status, headers: Object.fromEntries(response.headers), text, body: text ? JSON.parse(text) : null };
  };
  const compactFeatures = ["api_payload_compact_v1"];

  setFlag("raceListSqlSummaryV1Enabled", false);
  const racesOff = await request("/races");
  assert.equal(sqlSummaryArgument, false);
  setFlag("raceListSqlSummaryV1Enabled", true);
  const racesSqlOn = await request("/races");
  assert.equal(sqlSummaryArgument, true);
  record("raceListSqlSummaryV1Enabled", canonicalJson(racesOff.body) === canonicalJson(racesSqlOn.body), { offStatus: racesOff.status, onStatus: racesSqlOn.status, sqlSummaryArgument, realSqlSummaryRaceIds: sqlSummary.races.map((race) => race.id), queryEvents: fixture.dbModelQueries.length });

  setFlag("apiRaceListCompactV1Enabled", true);
  const racesCompact = await request("/races?view=compact-v1", { features: compactFeatures });
  const compactRow = racesCompact.body.active[0];
  const onlyAllowedRemovals = racesCompact.body.contract === "race-list-compact-v1" && compactRow.retained === "yes" && !("targetSteps" in compactRow) && !("leader" in compactRow) && !("payouts" in compactRow) && !("mysteryBoxCount" in compactRow) && !("teamATotalSteps" in compactRow) && !("teamBTotalSteps" in compactRow) && !("profilePhotoUrl" in compactRow.creator) && !("profilePhotoUrl" in compactRow.winner) && canonicalJson(racesCompact.body.tournaments) === canonicalJson(legacyList.tournaments);
  const racesTokenless = await request("/races?view=compact-v1");
  record("apiRaceListCompactV1Enabled", onlyAllowedRemovals && racesTokenless.body.contract == null, { legacyBytes: racesOff.text.length, compactBytes: racesCompact.text.length, compactContract: racesCompact.body.contract, tokenlessContract: racesTokenless.body.contract || null });

  setFlag("apiRaceBootstrapCompactV1Enabled", true);
  const bootstrapCases = {};
  for (const [id, features] of [["direct", compactFeatures], ["team", compactFeatures], ["pending", compactFeatures], ["completed", compactFeatures], ["spectator", [...compactFeatures, "tournaments"]], ["preview", [...compactFeatures, "race_preview"]]]) {
    bootstrapCases[id] = await request(`/races/${id}/bootstrap?view=participants-v1&offset=0&limit=15&shape=compact-v1`, { features });
  }
  const bootstrapTokenless = await request("/races/direct/bootstrap?view=participants-v1&offset=0&limit=15&shape=compact-v1");
  const bootstrapPass = bootstrapCases.direct.body.contract === "race-bootstrap-compact-v1" && !("participants" in bootstrapCases.direct.body.race) && ["team", "pending", "completed", "spectator", "preview"].every((id) => bootstrapCases[id].body.contract === "race-bootstrap-v1" && Array.isArray(bootstrapCases[id].body.race.participants)) && bootstrapTokenless.body.contract === "race-bootstrap-v1";
  record("apiRaceBootstrapCompactV1Enabled", bootstrapPass, { contracts: Object.fromEntries(Object.entries(bootstrapCases).map(([id, result]) => [id, { status: result.status, contract: result.body?.contract, raceParticipants: Array.isArray(result.body?.race?.participants) } ])), tokenless: bootstrapTokenless.body.contract });

  setFlag("homeRaceCardLeanLiveV1Enabled", false);
  setFlag("homeRaceCardParallelOptionalV1Enabled", false);
  const homeOff = await request("/home/race-card?homeActiveRaces=1");
  setFlag("homeRaceCardLeanLiveV1Enabled", true);
  const homeLean = await request("/home/race-card?homeActiveRaces=1");
  record("homeRaceCardLeanLiveV1Enabled", canonicalJson(homeOff.body) === canonicalJson(homeLean.body), { offBody: homeOff.body, onBody: homeLean.body });

  setFlag("homeRaceCardParallelOptionalV1Enabled", true);
  maxDbBranches = 0; branchCalls = 0;
  const homeParallel = await request("/home/race-card?homeActiveRaces=1");
  const successParity = canonicalJson(homeLean.body) === canonicalJson(homeParallel.body);
  setFlag("homeRaceCardParallelOptionalV1Enabled", false);
  flagValues.apiImpactSummariesEnabled = true;
  failImpact = true;
  const failureLegacy = await request("/home/race-card?homeActiveRaces=1", { features: ["impact_summaries"] });
  setFlag("homeRaceCardParallelOptionalV1Enabled", true);
  const failureParallel = await request("/home/race-card?homeActiveRaces=1", { features: ["impact_summaries"] });
  failImpact = false;
  flagValues.apiImpactSummariesEnabled = false;
  record("homeRaceCardParallelOptionalV1Enabled", successParity && failureLegacy.status === 500 && failureParallel.status === 500 && failureLegacy.text === failureParallel.text && maxDbBranches <= 3, { successParity, failureLegacy: { status: failureLegacy.status, body: failureLegacy.body }, failureParallel: { status: failureParallel.status, body: failureParallel.body }, maxObservedDbFanout: maxDbBranches, observedBranchCalls: branchCalls, pool: { total: null, idle: null, waiting: null, note: "injected route harness; local pool telemetry not attributed per branch" } });

  setFlag("publicRaceCountSqlV1Enabled", false);
  const countOff = await request("/races/discovery-summary");
  setFlag("publicRaceCountSqlV1Enabled", true);
  const countOn = await request("/races/discovery-summary");
  record("publicRaceCountSqlV1Enabled", countOff.body.publicRaceCount === countOn.body.publicRaceCount && legacyCountReads === 1 && sqlCountReads === 1, { off: countOff.body.publicRaceCount, on: countOn.body.publicRaceCount, legacyRowsRead: 2, sqlScalarRows: 1, legacyCountReads, sqlCountReads });

  setFlag("raceMessageLeanAccessV1Enabled", false);
  const messagesAccessOff = await request("/races/direct/message-streams?includeUser=true&limit=50");
  setFlag("raceMessageLeanAccessV1Enabled", true);
  const messagesAccessOn = await request("/races/direct/message-streams?includeUser=true&limit=50");
  record("raceMessageLeanAccessV1Enabled", canonicalJson(messagesAccessOff.body) === canonicalJson(messagesAccessOn.body) && fullAccessReads === 1 && leanAccessReads === 1, { fullAccessReads, leanAccessReads, bodyParity: true, redisMode });

  setFlag("apiRaceMessageConditionalV1Enabled", true);
  const changed = await request("/races/direct/message-streams?view=conditional-v1&includeUser=true&limit=50", { features: compactFeatures });
  const unchanged = await request("/races/direct/message-streams?view=conditional-v1&includeUser=true&limit=50", { features: compactFeatures, headers: { "If-None-Match": changed.headers.etag } });
  const noUser = await request("/races/direct/message-streams?view=conditional-v1&includeUser=false&limit=25", { features: compactFeatures });
  record("apiRaceMessageConditionalV1Enabled", changed.status === 200 && changed.body.contract === "race-message-streams-conditional-v1" && unchanged.status === 304 && unchanged.text === "" && noUser.status === 200 && changed.headers["cache-control"] === "private, no-cache" && changed.headers.vary.includes("Authorization") && changed.headers.vary.includes("X-Client-Features"), { changed: { status: changed.status, etag: changed.headers.etag, revision: changed.body.revision }, unchanged: { status: unchanged.status, bytes: unchanged.text.length }, includeUserFalse: { status: noUser.status, requested: noUser.body.requested }, redisMode, redisProbe });

  setFlag("apiRacePowerupTargetContextV1Enabled", true);
  const typed = await request("/races/direct/powerups/use-context?view=targets-v1&powerupType=SHORTCUT", { features: compactFeatures });
  const typedError = await request("/races/inactiveTarget/powerups/use-context?view=targets-v1&powerupType=SHORTCUT", { features: compactFeatures });
  const unknownType = await request("/races/direct/powerups/use-context?view=targets-v1&powerupType=FUTURE_TYPE", { features: compactFeatures });
  const typedMinimal = typed.body.participants.every((row) => !("totalSteps" in row));
  record("apiRacePowerupTargetContextV1Enabled", typed.status === 200 && typed.body.contract === "race-powerup-target-context-v1" && typedMinimal && typedError.status === 400 && typedError.body.code === "RACE_NOT_ACTIVE" && unknownType.body.contract === "race-powerup-use-context-v1", { typedContract: typed.body.contract, participantKeys: Object.keys(typed.body.participants[0]).sort(), errorEnvelope: typedError.body, unknownTypeContract: unknownType.body.contract, redisMode });

  setFlag("racePowerupLeanUseContextV1Enabled", true);
  record("racePowerupLeanUseContextV1Enabled", leanUse.id === dbRace.id && leanUse.participants.length === 1 && leanUse.participants[0].powerupSlots === 3, { raceId: leanUse.id, rosterSize: leanUse.participants.length, casterKeys: Object.keys(leanUse.participants[0]).sort(), repeatableReadQueryCapture: fixture.dbModelQueries.filter((event) => /race_participants|SET TRANSACTION|BEGIN|COMMIT/i.test(event.query)) });

  setFlag("apiLeaderboardCompactV1Enabled", true);
  const leaderboardCompact = await request("/leaderboard?view=compact-v1", { features: compactFeatures });
  const leaderboardLegacy = await request("/leaderboard?view=compact-v1");
  record("apiLeaderboardCompactV1Enabled", leaderboardCompact.body.contract === "leaderboard-compact-v1" && !("top10" in leaderboardCompact.body) && leaderboardCompact.body.currentUser === null && canonicalJson(leaderboardCompact.body.top100) === canonicalJson(leaderboardBody.top100) && Array.isArray(leaderboardLegacy.body.top10), { compact: leaderboardCompact.body, legacyCurrentUser: leaderboardLegacy.body.currentUser });

  setFlag("raceProgressLeanProjectionV1Enabled", true);
  const progressLean = await request("/races/direct/progress?view=participants-v1&offset=0&limit=15", { features: ["race_progress_participants_v1"] });
  record("raceProgressLeanProjectionV1Enabled", progressLean.status === 200 && progressLean.body.contract === "race-progress-participants-v1" && Array.isArray(progressLean.body.progress?.participants), { status: progressLean.status, contract: progressLean.body.contract, participantCount: progressLean.body.progress?.participants?.length ?? null, redisMode }, "public-route gate smoke plus unchanged focused progress/snapshot suites; full capacity fixture matrix not re-created by this verifier");

  setFlag("legacyUploaderStepSamplePrefetchV1Enabled", true);
  const versionBefore = await prisma.userScoringInputVersion.findUnique({ where: { userId: user.id } });
  const materialized = await fromBackend("src/modules/steps/services/scoringInputVersion.js").materializeAndReadScoringInputVersion(prisma, user.id);
  const versionAfter = await prisma.userScoringInputVersion.findUnique({ where: { userId: user.id } });
  record("legacyUploaderStepSamplePrefetchV1Enabled", typeof materialized === "bigint" && versionAfter?.generation === materialized, { before: versionBefore ? { userId: versionBefore.userId, generation: String(versionBefore.generation), updatedAt: versionBefore.updatedAt } : null, after: versionAfter ? { userId: versionAfter.userId, generation: String(versionAfter.generation), updatedAt: versionAfter.updatedAt } : null, capturedGeneration: String(materialized) }, "version-fence materialization plus unchanged focused uploader suites; mutation parity matrix recorded separately in scoped verification");

  const bounty = await request("/races/direct/powerups/use-context?view=targets-v1&powerupType=BOUNTY", { features: compactFeatures });
  assert.equal(bounty.status, 200);

  for (const flag of FLAGS) setFlag(flag, false);
  assert.equal(FLAGS.every((flag) => flagValues[flag] === false), true);

  await prisma.userScoringInputVersion.deleteMany({ where: { userId: { in: fixture.userIds } } });
  await prisma.raceParticipant.deleteMany({ where: { raceId: { in: fixture.raceIds } } });
  await prisma.race.deleteMany({ where: { id: { in: fixture.raceIds } } });
  await prisma.user.deleteMany({ where: { id: { in: fixture.userIds } } });
  fixture.dbAfterCleanup = await countSnapshot();
  assert.deepEqual(fixture.dbAfterCleanup, before);

  const result = {
    verifier: "request-path-and-payload-optimization",
    generatedAt: new Date().toISOString(),
    environment: { node: process.version, nodeEnv: process.env.NODE_ENV, databaseName, databaseHost: databaseUrl.hostname, redisMode, redisProbe },
    fixture,
    dbBefore: before,
    dbAfter: fixture.dbAfterCleanup,
    queryEvents: queryEvents.slice(-120),
    matrix,
    allFlagsResetFalse: FLAGS.every((flag) => flagValues[flag] === false),
    passed: matrix.length === FLAGS.length && matrix.every((row) => row.passed),
  };
  fs.writeFileSync(output, `${JSON.stringify(result, null, 2)}\n`);
  process.stdout.write(`${JSON.stringify({ output, redisMode, flags: matrix.length, passed: result.passed, dbRestored: canonicalJson(before) === canonicalJson(fixture.dbAfterCleanup) })}\n`);
} finally {
  for (const flag of FLAGS) flagValues[flag] = false;
  if (server) await new Promise((resolve) => server.close(resolve));
  if (fixture.userIds.length || fixture.raceIds.length) {
    await prisma.userScoringInputVersion.deleteMany({ where: { userId: { in: fixture.userIds } } });
    await prisma.raceParticipant.deleteMany({ where: { raceId: { in: fixture.raceIds } } });
    await prisma.race.deleteMany({ where: { id: { in: fixture.raceIds } } });
    await prisma.user.deleteMany({ where: { id: { in: fixture.userIds } } });
  }
  if (previewHadRow) {
    await prisma.appSetting.upsert({ where: { key: "racePreviewEnabled" }, update: { value: previewPrevious }, create: { key: "racePreviewEnabled", value: previewPrevious } });
  } else {
    await prisma.appSetting.deleteMany({ where: { key: "racePreviewEnabled" } });
  }
  realAppSettings.bustCache();
  if (redis) { await redis.flushdb(); await redis.quit(); }
  await prisma.$disconnect();
}
```
