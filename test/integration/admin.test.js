const assert = require("node:assert/strict");
const { describe, it, before, after, beforeEach } = require("node:test");
const { cleanDatabase, prisma, request, getSharedServer } = require("./setup");

let server;
let nextAppleId = 0;

const ADMIN_EMAIL = process.env.ADMIN_EMAILS?.split(",")[0]?.trim() || "admin@test.com";

function authOverrides() {
  return {
    verifyAppleIdentityToken: async (token) => ({
      sub: token,
      email: `${token}@example.com`,
    }),
  };
}

async function createUser(displayName) {
  const appleId = `apple-admin-${++nextAppleId}`;
  const res = await request(server.baseUrl, "POST", "/auth/apple", {
    body: { identityToken: appleId },
  });
  const body = await res.json();
  const token = body.sessionToken;
  const userId = body.user.id;

  if (displayName) {
    await request(server.baseUrl, "PUT", "/auth/me/display-name", {
      body: { displayName },
      token,
    });
  }

  return { userId, token, appleId };
}

async function createAdmin(displayName) {
  const admin = await createUser(displayName);
  await prisma.user.update({
    where: { id: admin.userId },
    data: { email: ADMIN_EMAIL },
  });
  return admin;
}

describe("admin", () => {
  before(async () => {
    server = await getSharedServer();
  });

  after(async () => {
  });

  beforeEach(async () => {
    await cleanDatabase();
    nextAppleId = 0;
  });

  // === ACCESS CONTROL ===

  describe("access control", () => {
    it("non-admin gets 403 on GET /admin/weekly-challenge", async () => {
      const user = await createUser("RegularPerson");
      const res = await request(server.baseUrl, "GET", "/admin/weekly-challenge", { token: user.token });
      assert.equal(res.status, 403);
    });

    it("non-admin gets 403 on POST /admin/weekly-challenge/ensure-current", async () => {
      const user = await createUser("RegularPerson");
      const res = await request(server.baseUrl, "POST", "/admin/weekly-challenge/ensure-current", { token: user.token });
      assert.equal(res.status, 403);
    });

    it("non-admin gets 403 on POST /admin/weekly-challenge/resolve-current", async () => {
      const user = await createUser("RegularPerson");
      const res = await request(server.baseUrl, "POST", "/admin/weekly-challenge/resolve-current", { token: user.token });
      assert.equal(res.status, 403);
    });

    it("non-admin gets 403 on POST /admin/weekly-challenge/reset-current", async () => {
      const user = await createUser("RegularPerson");
      const res = await request(server.baseUrl, "POST", "/admin/weekly-challenge/reset-current", { token: user.token });
      assert.equal(res.status, 403);
    });

    it("unauthenticated request gets 401", async () => {
      const res = await request(server.baseUrl, "GET", "/admin/weekly-challenge");
      assert.equal(res.status, 401);
    });

    it("isAdmin flag is true on sign-in for admin user", async () => {
      // Create user then set admin email
      const appleId = `apple-admin-flag-test`;
      const signInRes = await request(server.baseUrl, "POST", "/auth/apple", {
        body: { identityToken: appleId, email: ADMIN_EMAIL },
      });
      const body = await signInRes.json();
      assert.equal(body.user.isAdmin, true);
    });

    it("isAdmin flag is false for regular user", async () => {
      const appleId = `apple-regular-flag-test`;
      const signInRes = await request(server.baseUrl, "POST", "/auth/apple", {
        body: { identityToken: appleId, email: "nobody@example.com" },
      });
      const body = await signInRes.json();
      assert.equal(body.user.isAdmin, false);
    });

    it("GET /auth/me returns isAdmin flag", async () => {
      const admin = await createAdmin("AdminPerson");
      const res = await request(server.baseUrl, "GET", "/auth/me", { token: admin.token });
      const body = await res.json();
      assert.equal(body.user.isAdmin, true);
    });
  });
});
