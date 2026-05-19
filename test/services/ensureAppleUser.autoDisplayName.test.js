const assert = require("node:assert/strict");
const test = require("node:test");

const { buildEnsureAppleUser } = require("../../src/services/ensureAppleUser");

function makeUserModel({ existingByDisplayName = new Set() } = {}) {
  let nextId = 1;
  const created = [];
  const updates = [];

  return {
    created,
    updates,
    model: {
      async findByAppleId() {
        return null;
      },
      async create(payload) {
        const user = { id: `user-${nextId++}`, displayName: null, ...payload };
        created.push(user);
        return user;
      },
      async update(id, fields) {
        updates.push({ id, fields });
        const created0 = created.find((u) => u.id === id) || { id };
        return { ...created0, ...fields };
      },
      async findByDisplayNameInsensitive(displayName) {
        if (existingByDisplayName.has(displayName.toLowerCase())) {
          return { id: "someone-else", displayName };
        }
        return null;
      },
    },
  };
}

function silentEvents() {
  return { emit() {} };
}

test("auto-generates displayName from Apple fullName for a new user", async () => {
  const ctx = makeUserModel();
  const ensureAppleUser = buildEnsureAppleUser({
    User: ctx.model,
    eventBus: silentEvents(),
  });

  const user = await ensureAppleUser({
    appleId: "apple-1",
    email: null,
    name: "Walker Capybara",
  });

  assert.ok(user.displayName, "displayName should be populated");
  assert.ok(
    user.displayName.length >= 8,
    `displayName "${user.displayName}" should be at least 8 chars`
  );
  assert.match(
    user.displayName,
    /walker|capybara/i,
    "displayName should be derived from Apple fullName"
  );
});

test("pads short Apple names to meet 8-char minimum", async () => {
  const ctx = makeUserModel();
  const ensureAppleUser = buildEnsureAppleUser({
    User: ctx.model,
    eventBus: silentEvents(),
  });

  const user = await ensureAppleUser({
    appleId: "apple-2",
    email: null,
    name: "Ada",
  });

  assert.ok(user.displayName.length >= 8);
  assert.match(user.displayName, /^Ada/);
});

test("falls back to a fun generated name when Apple shares no name", async () => {
  const ctx = makeUserModel();
  const ensureAppleUser = buildEnsureAppleUser({
    User: ctx.model,
    eventBus: silentEvents(),
  });

  const user = await ensureAppleUser({
    appleId: "apple-3",
    email: null,
    name: null,
  });

  assert.ok(user.displayName);
  assert.ok(user.displayName.length >= 8);
});

test("retries on displayName collision to ensure uniqueness", async () => {
  const ctx = makeUserModel({
    existingByDisplayName: new Set(["walker capybara"]),
  });
  const ensureAppleUser = buildEnsureAppleUser({
    User: ctx.model,
    eventBus: silentEvents(),
  });

  const user = await ensureAppleUser({
    appleId: "apple-4",
    email: null,
    name: "Walker Capybara",
  });

  assert.ok(user.displayName);
  assert.notEqual(user.displayName.toLowerCase(), "walker capybara");
  assert.ok(user.displayName.length >= 8);
});

test("does not regenerate displayName for existing users that already have one", async () => {
  const updates = [];
  const ensureAppleUser = buildEnsureAppleUser({
    User: {
      async findByAppleId() {
        return {
          id: "user-7",
          appleId: "apple-7",
          email: null,
          name: null,
          displayName: "ChosenByUser",
        };
      },
      async update(id, fields) {
        updates.push({ id, fields });
        return { id, ...fields };
      },
      async findByDisplayNameInsensitive() {
        return null;
      },
    },
    eventBus: silentEvents(),
  });

  await ensureAppleUser({
    appleId: "apple-7",
    email: null,
    name: "Some Newly Shared Name",
  });

  for (const u of updates) {
    assert.ok(
      !("displayName" in u.fields),
      "should not overwrite existing displayName"
    );
  }
});
