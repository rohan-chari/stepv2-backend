const assert = require("node:assert/strict");
const { after, before, beforeEach, describe, it } = require("node:test");

const {
  cleanDatabase,
  prisma,
  request,
  startServer,
} = require("./setup");
const { appSettings } = require("../../src/shared/config/appSettings");

const FLAG = "quickRaceShareAutoFriendEnabled";

describe("home quick-race friend-share capability contract", () => {
  let server;
  const originalReviewEmail = process.env.APP_REVIEW_EMAIL;
  const originalReviewPassword = process.env.APP_REVIEW_PASSWORD;

  before(async () => {
    process.env.APP_REVIEW_EMAIL = "quick-share-review@test.com";
    process.env.APP_REVIEW_PASSWORD = "quick-share-review-password";
    server = await startServer({
      verifyAppleIdentityToken: async (token) => ({
        sub: token,
        email: `${token}@example.com`,
      }),
      verifyGoogleIdentityToken: async (token) => ({
        sub: token,
        email: `${token}@example.com`,
      }),
      isAdminUser: () => false,
      profilePhotoStorage: {
        validateManagedUpload: () => true,
        deleteObject: async () => {},
      },
    });
  });

  after(async () => {
    await appSettings.setFlag(FLAG, false);
    await appSettings.setFlag("redisCacheAuthMeEnabled", false);
    if (originalReviewEmail === undefined) {
      delete process.env.APP_REVIEW_EMAIL;
    } else {
      process.env.APP_REVIEW_EMAIL = originalReviewEmail;
    }
    if (originalReviewPassword === undefined) {
      delete process.env.APP_REVIEW_PASSWORD;
    } else {
      process.env.APP_REVIEW_PASSWORD = originalReviewPassword;
    }
    await server.close();
  });

  beforeEach(async () => {
    await cleanDatabase();
    await appSettings.setFlag(FLAG, false);
    await appSettings.setFlag("redisCacheAuthMeEnabled", false);
  });

  async function appleSignIn(identityToken) {
    const response = await request(server.baseUrl, "POST", "/auth/apple", {
      body: { identityToken },
    });
    assert.equal(response.status, 200);
    return response.json();
  }

  function assertCapability(body, expected, label) {
    assert.ok(body.user, `${label} keeps its user envelope`);
    assert.ok(body.user.featureFlags, `${label} keeps featureFlags`);
    assert.equal(
      body.user.featureFlags[FLAG],
      expected,
      `${label} serves ${FLAG}=${expected}`
    );
    assert.equal(
      typeof body.user.featureFlags[FLAG],
      "boolean",
      `${label} serves a literal boolean`
    );
  }

  it("defaults false and changes no pre-existing /auth/me feature flag", async () => {
    await prisma.appSetting.deleteMany({ where: { key: FLAG } });
    appSettings.bustCache();

    const signedIn = await appleSignIn("quick-share-default");
    assertCapability(signedIn, false, "POST /auth/apple");

    const beforeResponse = await request(server.baseUrl, "GET", "/auth/me", {
      token: signedIn.sessionToken,
    });
    assert.equal(beforeResponse.status, 200);
    const before = await beforeResponse.json();
    assertCapability(before, false, "GET /auth/me with default flag");
    const existingFlags = { ...before.user.featureFlags };
    delete existingFlags[FLAG];

    await appSettings.setFlag(FLAG, true);
    const afterResponse = await request(server.baseUrl, "GET", "/auth/me", {
      token: signedIn.sessionToken,
    });
    assert.equal(afterResponse.status, 200);
    const enabled = await afterResponse.json();
    assertCapability(enabled, true, "GET /auth/me with enabled flag");
    const enabledExistingFlags = { ...enabled.user.featureFlags };
    delete enabledExistingFlags[FLAG];
    assert.deepEqual(
      enabledExistingFlags,
      existingFlags,
      "the additive capability must not alter frozen feature-flag keys or values"
    );
  });

  it("serves literal true from every authenticated own-user featureFlags envelope", async () => {
    await appSettings.setFlag(FLAG, true);

    const apple = await appleSignIn("quick-share-apple");
    assertCapability(apple, true, "POST /auth/apple");

    const googleResponse = await request(
      server.baseUrl,
      "POST",
      "/auth/google",
      { body: { idToken: "quick-share-google" } }
    );
    assert.equal(googleResponse.status, 200);
    assertCapability(await googleResponse.json(), true, "POST /auth/google");

    const reviewResponse = await request(
      server.baseUrl,
      "POST",
      "/auth/review",
      {
        body: {
          email: process.env.APP_REVIEW_EMAIL,
          password: process.env.APP_REVIEW_PASSWORD,
        },
      }
    );
    assert.equal(reviewResponse.status, 200);
    assertCapability(await reviewResponse.json(), true, "POST /auth/review");

    const token = apple.sessionToken;
    const authenticatedRequests = [
      ["GET /auth/me", "GET", "/auth/me"],
      ["GET /auth/session", "GET", "/auth/session"],
      ["PUT /auth/me/step-goal", "PUT", "/auth/me/step-goal", { stepGoal: 7000 }],
      [
        "PUT /auth/me/discoverable-name",
        "PUT",
        "/auth/me/discoverable-name",
        { firstName: "Quick", lastName: "Share" },
      ],
      [
        "PUT /auth/me/display-name",
        "PUT",
        "/auth/me/display-name",
        { displayName: "QuickShare" },
      ],
      [
        "PUT /auth/me/leaderboard-visibility",
        "PUT",
        "/auth/me/leaderboard-visibility",
        { hidden: true },
      ],
      [
        "PUT /auth/me/featured-auto-join",
        "PUT",
        "/auth/me/featured-auto-join",
        { enabled: false },
      ],
      [
        "PUT /auth/me/profile-photo",
        "PUT",
        "/auth/me/profile-photo",
        {
          key: "profile-photos/quick-share-apple/avatar.png",
          url: "https://example.com/avatar.png",
        },
      ],
      ["DELETE /auth/me/profile-photo", "DELETE", "/auth/me/profile-photo"],
      [
        "POST /auth/me/profile-photo/prompt-dismiss",
        "POST",
        "/auth/me/profile-photo/prompt-dismiss",
        {},
      ],
      [
        "POST /auth/me/rename-chip/shown",
        "POST",
        "/auth/me/rename-chip/shown",
        {},
      ],
      [
        "POST /auth/me/rename-chip/dismiss",
        "POST",
        "/auth/me/rename-chip/dismiss",
        {},
      ],
    ];

    for (const [label, method, path, body] of authenticatedRequests) {
      const response = await request(server.baseUrl, method, path, {
        token,
        ...(body === undefined ? {} : { body }),
      });
      const payload = await response.json();
      assert.equal(response.status, 200, `${label}: ${JSON.stringify(payload)}`);
      assertCapability(payload, true, label);
    }
  });
});
