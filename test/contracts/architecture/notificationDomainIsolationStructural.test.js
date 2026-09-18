const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const fixtures = require("../fixtures/notificationDomainEventV1");
const {
  EVENT_TYPES,
  PRODUCER_MATRIX,
  deliveryKeyFor,
  legacyPayloadForRecipient,
  projectionKindFor,
} = require("../../src/modules/domainEvents/services/producerMatrix");
const {
  V1_PROJECTOR_HANDLER_NAMES,
  buildNotificationProjector,
  buildTypedV1Projection,
} = require("../../src/modules/domainEvents/services/notificationProjector");
const {
  destinationForPayload,
} = require("../../src/modules/notifications/services/notificationDelivery");
const {
  registerNotificationHandlers,
} = require("../../src/modules/notifications/notificationHandlers");

const ROOT = path.resolve(__dirname, "../..");

test("visible-handler registry, V1 producer matrix, and literal key fixtures have exact parity", () => {
  const handlersSource = fs.readFileSync(
    path.join(ROOT, "src/modules/notifications/notificationHandlers.js"),
    "utf8",
  );
  const visibleHandlers = [...handlersSource.matchAll(/events\.on\("([A-Z_a-z0-9]+)"/g)]
    .map((match) => match[1])
    .sort();
  const matrixHandlers = Object.values(PRODUCER_MATRIX)
    .map((row) => row.legacyHandler)
    .filter(Boolean)
    .sort();
  assert.deepEqual(matrixHandlers, visibleHandlers);
  assert.deepEqual(fixtures.map((fixture) => fixture.eventType).sort(), [...EVENT_TYPES].sort());
  assert.deepEqual(
    Object.keys(V1_PROJECTOR_HANDLER_NAMES).sort(),
    Object.values(PRODUCER_MATRIX).filter((row) => row.legacyHandler).map((row) => row.eventType).sort(),
  );
  assert.deepEqual(
    fixtures.map((fixture) => fixture.legacyHandler).filter(Boolean).sort(),
    visibleHandlers,
  );
});

test("every active producer row is named by real integration-path coverage", () => {
  const integrationRoot = path.join(ROOT, "test/integration");
  const integrationSource = fs.readdirSync(integrationRoot)
    .filter((name) => name.endsWith(".test.js"))
    .map((name) => fs.readFileSync(path.join(integrationRoot, name), "utf8"))
    .join("\n");
  const dormant = new Set([
    "RACE_BUYIN_CHANGED_V1",
    "DAILY_REWARD_REMINDER_V1",
    "TOURNAMENT_COMPLETED_V1",
  ]);
  for (const row of Object.values(PRODUCER_MATRIX)) {
    if (dormant.has(row.eventType)) {
      assert.equal(row.producerStatus, "DORMANT_COMPATIBILITY_ONLY");
      assert.equal(row.owner, null);
      assert.equal(row.durableSource, null);
      continue;
    }
    assert.equal(row.producerStatus, "ACTIVE", row.eventType);
    assert.equal(row.durableSource, "DomainEventOutbox", row.eventType);
    assert.match(
      integrationSource,
      new RegExp(`\\b${row.eventType}\\b`),
      `${row.eventType} requires checked-in real command/job/request integration evidence`,
    );
  }
});

test("projection uses an explicit V1 registry and no event-bus dispatch engine", () => {
  const source = fs.readFileSync(
    path.join(ROOT, "src/modules/domainEvents/services/notificationProjector.js"),
    "utf8",
  );
  assert.doesNotMatch(source, /buildLegacyHandlerProjection|\.dispatch\(/);
  assert.doesNotMatch(source, /registerNotificationHandlers|typedHandlers|collector/);
  assert.match(source, /V1_PROJECTOR_HANDLER_NAMES/);
});

test("literal V1 fixtures lock every canonical visible delivery key", () => {
  const priorSecret = process.env.SESSION_TOKEN_SECRET;
  process.env.SESSION_TOKEN_SECRET = "domain-event-fixture-secret";
  try {
    for (const fixture of fixtures) {
      const event = { eventType: fixture.eventType, payload: fixture.payload };
      assert.equal(projectionKindFor(event, fixture.audience), "VISIBLE", fixture.eventType);
      assert.equal(
        deliveryKeyFor(event, fixture.audience, "VISIBLE"),
        fixture.deliveryKey,
        fixture.eventType,
      );
      const producer = PRODUCER_MATRIX[fixture.eventType];
      if ([
        "RACE_BUYIN_CHANGED_V1",
        "DAILY_REWARD_REMINDER_V1",
        "TOURNAMENT_COMPLETED_V1",
      ].includes(fixture.eventType)) {
        assert.deepEqual(
          {
            producerStatus: producer.producerStatus,
            owner: producer.owner,
            durableSource: producer.durableSource,
          },
          {
            producerStatus: "DORMANT_COMPATIBILITY_ONLY",
            owner: null,
            durableSource: null,
          },
          "dormant handlers keep projector compatibility without claiming a producer",
        );
      } else {
        assert.equal(producer.producerStatus, "ACTIVE");
        assert.equal(producer.durableSource, "DomainEventOutbox");
      }
    }
  } finally {
    if (priorSecret == null) delete process.env.SESSION_TOKEN_SECRET;
    else process.env.SESSION_TOKEN_SECRET = priorSecret;
  }
});

test("every V1 fixture locks full copy, destination, provider payload, audience, and suppression", () => {
  for (const fixture of fixtures) {
    assert.equal(typeof fixture.expected.title, "string", `${fixture.eventType} title`);
    assert.ok(fixture.expected.title.length > 0, `${fixture.eventType} non-empty title`);
    assert.equal(typeof fixture.expected.body, "string", `${fixture.eventType} body`);
    assert.ok(fixture.expected.body.length > 0, `${fixture.eventType} non-empty body`);
    assert.equal(typeof fixture.expected.destination.route, "string", `${fixture.eventType} destination`);
    assert.equal(typeof fixture.expected.providerPayload.type, "string", `${fixture.eventType} public type`);
    assert.equal(typeof fixture.expected.providerPayload.route, "string", `${fixture.eventType} provider route`);
    assert.deepEqual(fixture.expected.audience, [fixture.audience.recipientId]);
    assert.deepEqual(fixture.expected.suppression, {
      eligible: "DELIVER",
      missingRecipient: "RECIPIENT_DELETED",
    });
  }
});

test("every visible typed V1 handler produces the full locked parity fixture", async () => {
  const priorSecret = process.env.SESSION_TOKEN_SECRET;
  process.env.SESSION_TOKEN_SECRET = "domain-event-fixture-secret";
  try {
    for (const fixture of fixtures.filter((row) => row.legacyHandler)) {
      const submissions = [];
      const event = {
        id: `event-${fixture.eventType}`,
        eventType: fixture.eventType,
        occurredAt: new Date(),
        payload: { ...fixture.payload },
      };
      if (fixture.eventType === "RACE_ENDING_SOON_V1") {
        event.payload.endsAt = new Date(Date.now() + 2 * 60 * 60_000);
      } else if (fixture.eventType === "TEAM_FINAL_STRETCH_V1") {
        event.payload.endsAt = new Date(Date.now() + 30 * 60_000);
      } else {
        event.payload.endsAt = new Date(Date.now() + 60 * 60_000);
      }
      const project = buildTypedV1Projection({
        prisma: {},
        logger: { log() {}, warn() {}, error() {} },
        notificationIntentService: {
          async submit(input) {
            submissions.push(input);
            return { alertId: `alert-${fixture.eventType}` };
          },
        },
        User: { async findById() { return { displayName: "Actor" }; } },
        Race: {
          async findUnique() {
            return { status: "ACTIVE", endsAt: new Date(Date.now() + 60 * 60_000), name: "Fixture race" };
          },
        },
        RaceParticipant: { async findMany() { return []; }, async update() {} },
        Notification: {
          async create() {},
          async findFirstByUserTypeSince() { return null; },
          async findFirstByUserTypeRaceSince() { return null; },
          async claimDelivery() { return true; },
        },
        getPerformanceFlags: () => ({ placementInertPushSuppressionEnabled: true }),
      });
      const result = await project({
        event,
        audience: fixture.audience,
        projection: { deliveryKey: fixture.deliveryKey },
      });
      assert.equal(result.status, "COMPLETED", fixture.eventType);
      assert.equal(submissions.length, 1, `${fixture.eventType} submit count`);
      const [submission] = submissions;
      assert.equal(submission.recipientUserId, fixture.expected.audience[0], `${fixture.eventType} audience`);
      assert.equal(submission.title, fixture.expected.title, `${fixture.eventType} title`);
      assert.equal(submission.body, fixture.expected.body, `${fixture.eventType} body`);
      assert.deepEqual(submission.payload, fixture.expected.providerPayload, `${fixture.eventType} provider payload`);
      assert.deepEqual(destinationForPayload(submission.payload), fixture.expected.destination, `${fixture.eventType} destination`);

      const legacySubmissions = [];
      const legacyHandlers = new Map();
      registerNotificationHandlers({
        prisma: {},
        eventBus: { on(name, handler) { legacyHandlers.set(name, handler); } },
        logger: { log() {}, warn() {}, error() {} },
        notificationIntentService: {
          async submit(input) {
            legacySubmissions.push(input);
            return { alertId: `legacy-alert-${fixture.eventType}` };
          },
        },
        User: { async findById() { return { displayName: "Actor" }; } },
        Race: {
          async findUnique() {
            return { status: "ACTIVE", endsAt: new Date(Date.now() + 60 * 60_000), name: "Fixture race" };
          },
        },
        RaceParticipant: {
          async findMany() { return [{ id: "participant-1", userId: fixture.audience.recipientId }]; },
          async update() {},
        },
        Notification: {
          async create() {},
          async findFirstByUserTypeSince() { return null; },
          async findFirstByUserTypeRaceSince() { return null; },
          async claimDelivery() { return true; },
        },
        getPerformanceFlags: () => ({ placementInertPushSuppressionEnabled: true }),
      });
      await legacyHandlers.get(fixture.legacyHandler)(legacyPayloadForRecipient(event, fixture.audience));
      assert.equal(legacySubmissions.length, 1, `${fixture.eventType} legacy submit count`);
      const [legacy] = legacySubmissions;
      assert.deepEqual(
        {
          recipientUserId: legacy.recipientUserId,
          type: legacy.type,
          title: legacy.title,
          body: legacy.body,
          payload: legacy.payload,
          deliveryKey: legacy.deliveryKey,
        },
        {
          recipientUserId: submission.recipientUserId,
          type: submission.type,
          title: submission.title,
          body: submission.body,
          payload: submission.payload,
          deliveryKey: submission.deliveryKey,
        },
        `${fixture.eventType} legacy/V1 full output parity`,
      );
    }
  } finally {
    if (priorSecret == null) delete process.env.SESSION_TOKEN_SECRET;
    else process.env.SESSION_TOKEN_SECRET = priorSecret;
  }
});

test("every legacy/V1 fixture executes the same missing-recipient suppression", async () => {
  const quietLogger = { log() {}, warn() {}, error() {} };

  async function executeV1MissingRecipient(fixture) {
    const materialized = [];
    const terminal = [];
    const leaseToken = `lease-${fixture.eventType}`;
    const event = {
      id: `event-${fixture.eventType}`,
      eventType: fixture.eventType,
      schemaVersion: 1,
      occurredAt: new Date("2026-08-25T12:00:00.000Z"),
      availableAt: new Date("2026-08-25T12:00:00.000Z"),
      payload: { ...fixture.payload },
      audience: [fixture.audience],
    };
    const projection = {
      id: `projection-${fixture.eventType}`,
      domainEventId: event.id,
      recipientUserId: fixture.audience.recipientId,
      deliveryKey: fixture.deliveryKey,
      projectionKind: "VISIBLE",
      leaseToken,
      event,
    };
    const repository = {
      async loadProjectionContext() { return projection; },
      async loadRaceMessage() {
        return { body: fixture.payload.body || "Fixture message", deletedAt: null };
      },
      async loadRecipient() { return null; },
      async finishProjection(_prisma, outcome) { terminal.push(outcome); },
      async finishEventIfTerminal() {},
    };
    const projector = buildNotificationProjector({
      prisma: {},
      repository,
      logger: quietLogger,
      notificationIntentService: {
        async submit(input) { materialized.push(input); },
      },
    });
    assert.equal(await projector.processOne({ id: projection.id, leaseToken }), true);
    assert.equal(materialized.length, 0, `${fixture.eventType} V1 missing user materialization`);
    assert.equal(terminal.length, 1, `${fixture.eventType} V1 terminal outcome`);
    return {
      status: terminal[0].status,
      reason: terminal[0].errorCode,
    };
  }

  for (const fixture of fixtures.filter((row) => row.legacyHandler)) {
    const materialized = [];
    const terminal = [];
    const legacyHandlers = new Map();
    registerNotificationHandlers({
      prisma: {},
      eventBus: { on(name, handler) { legacyHandlers.set(name, handler); } },
      logger: quietLogger,
      notificationIntentService: {
        async submit(input) {
          if (input.recipientUserId === fixture.audience.recipientId) {
            terminal.push({ status: "SUPPRESSED", reason: "RECIPIENT_DELETED" });
            return null;
          }
          materialized.push(input);
          return { alertId: `unexpected-${fixture.eventType}` };
        },
      },
      User: { async findById() { return { displayName: "Actor" }; } },
      Race: {
        async findUnique() {
          return { status: "ACTIVE", endsAt: new Date(Date.now() + 60 * 60_000), name: "Fixture race" };
        },
      },
      RaceParticipant: {
        async findMany() {
          return [{ id: "participant-1", userId: fixture.audience.recipientId }];
        },
        async update() {},
      },
      Notification: {
        async create() {},
        async findFirstByUserTypeSince() { return null; },
        async findFirstByUserTypeRaceSince() { return null; },
        async claimDelivery() { return true; },
      },
      getPerformanceFlags: () => ({ placementInertPushSuppressionEnabled: true }),
    });
    const event = {
      eventType: fixture.eventType,
      payload: {
        ...fixture.payload,
        endsAt: new Date(Date.now() + 60 * 60_000),
      },
    };
    await legacyHandlers.get(fixture.legacyHandler)(
      legacyPayloadForRecipient(event, fixture.audience),
    );
    assert.equal(materialized.length, 0, `${fixture.eventType} legacy missing user materialization`);
    assert.deepEqual(terminal, [{
      status: "SUPPRESSED",
      reason: fixture.expected.suppression.missingRecipient,
    }], `${fixture.eventType} legacy missing-recipient outcome`);
    assert.deepEqual(
      terminal[0],
      await executeV1MissingRecipient(fixture),
      `${fixture.eventType} executable legacy/V1 suppression parity`,
    );
  }

  const support = fixtures.find((fixture) => fixture.eventType === "SUPPORT_REPLY_CREATED_V1");
  assert.deepEqual(await executeV1MissingRecipient(support), {
    status: "SUPPRESSED",
    reason: support.expected.suppression.missingRecipient,
  }, "support has no legacy handler and suppresses at the V1 missing-recipient boundary");
});

test("mixed visible/silent handlers use immutable distinct projection kinds and transport keys", () => {
  const cases = [
    ["RACE_MESSAGE_SENT_V1", { messageId: "message-1" }, "silent:RACE_MESSAGE_SENT:message-1:user-1"],
    ["PLACEMENT_CHANGED_V1", { transitionId: "placement-1" }, "silent:PLACEMENT_CHANGED:placement-1:user-1"],
  ];
  for (const [eventType, payload, expected] of cases) {
    const event = { eventType, payload };
    const audience = { recipientId: "user-1", facts: { projectionKind: "SILENT_REFRESH" } };
    assert.equal(
      projectionKindFor(event, audience),
      "VISIBLE",
      "occurrence-time facts cannot choose the final transport route",
    );
    assert.equal(deliveryKeyFor(event, audience, "SILENT_REFRESH"), expected);
    assert.notEqual(expected, deliveryKeyFor(event, { ...audience, facts: {} }, "VISIBLE"));
  }
});

test("domain producers do not read or stamp notification cooldown/classification state", () => {
  const chat = fs.readFileSync(
    path.join(ROOT, "src/modules/social/commands/sendRaceMessage.js"),
    "utf8",
  );
  const placement = fs.readFileSync(
    path.join(ROOT, "src/modules/races/jobs/placementRecompute.js"),
    "utf8",
  );
  assert.doesNotMatch(chat, /lastChatPushAt|projectionKind/);
  assert.doesNotMatch(placement, /projectionKind/);
});

test("domain producers cannot import notification, Inbox, provider, token, or notification Redis implementations", () => {
  const files = [
    "src/modules/feedback/commands/sendStaffReply.js",
    "src/modules/social/commands/sendFriendRequest.js",
    "src/modules/social/commands/respondToFriendRequest.js",
    "src/modules/social/commands/sendRaceMessage.js",
    "src/modules/social/commands/grantReferralReward.js",
    "src/modules/steps/models/globalStepEvent.js",
    "src/modules/steps/services/globalStepEventEntitlement.js",
    "src/modules/powerups/commands/usePowerup.js",
    "src/modules/tournaments/services/appendTournamentDomainEvent.js",
  ];
  const forbidden = [
    /notificationIntentService/,
    /createInboxAlert/,
    /NotificationSchedule/,
    /modules\/inbox/,
    /shared\/push\/(?:apns|fcm|deviceToken)/,
    /notificationRedis/i,
  ];
  for (const file of files) {
    const source = fs.readFileSync(path.join(ROOT, file), "utf8");
    for (const pattern of forbidden) assert.doesNotMatch(source, pattern, `${file}: ${pattern}`);
  }
});

test("mixed handlers contain no inline provider send", () => {
  const source = fs.readFileSync(
    path.join(ROOT, "src/modules/notifications/notificationHandlers.js"),
    "utf8",
  );
  assert.doesNotMatch(source, /\.sendSilentNotification\s*\(/);
});

test("domain-event Prisma IDs match the UUID migration exactly", () => {
  const schema = fs.readFileSync(path.join(ROOT, "prisma/schema.prisma"), "utf8");
  for (const model of ["DomainEventOutbox", "DomainEventAudience", "DomainEventNotificationProjection"]) {
    const block = schema.match(new RegExp(`model ${model} \\{([\\s\\S]*?)\\n\\}`))?.[1];
    assert.ok(block, `missing ${model}`);
    assert.match(block, /\bid\s+String\s+@id[^\n]*@db\.Uuid/, `${model}.id must map to PostgreSQL UUID`);
  }
  for (const model of ["DomainEventAudience", "DomainEventNotificationProjection"]) {
    const block = schema.match(new RegExp(`model ${model} \\{([\\s\\S]*?)\\n\\}`))?.[1];
    assert.match(block, /domainEventId\s+String[^\n]*@db\.Uuid/, `${model}.domainEventId must map to PostgreSQL UUID`);
  }
});
