const assert = require("node:assert/strict");
const test = require("node:test");

const { buildEnsureAppleUser } = require("../../src/modules/users/services/ensureAppleUser");

function makeUserModel({ takenOnFirstLookup = false } = {}) {
  let nextId = 1;
  let lookups = 0;
  const created = [];
  const updates = [];

  return {
    created,
    updates,
    firstLookupName: () => null,
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
        lookups += 1;
        if (takenOnFirstLookup && lookups === 1) {
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

test("assigns a generated displayName that ignores the Apple real name", async () => {
  const ctx = makeUserModel();
  const ensureAppleUser = buildEnsureAppleUser({
    User: ctx.model,
    eventBus: silentEvents(),
  });

  const user = await ensureAppleUser({
    appleId: "apple-1",
    email: null,
    name: "Rohan Chari",
  });

  assert.ok(user.displayName, "displayName should be populated");
  assert.ok(
    user.displayName.length >= 4,
    `displayName "${user.displayName}" should be at least 4 chars`
  );
  assert.match(
    user.displayName,
    /^[A-Za-z0-9_]+$/,
    `displayName "${user.displayName}" must be charset-valid`
  );
  assert.doesNotMatch(
    user.displayName,
    /rohan|chari/i,
    "displayName must not be derived from the Apple real name"
  );
});

test("generates a fun name when Apple shares no name", async () => {
  const ctx = makeUserModel();
  const ensureAppleUser = buildEnsureAppleUser({
    User: ctx.model,
    eventBus: silentEvents(),
  });

  const user = await ensureAppleUser({
    appleId: "apple-2",
    email: null,
    name: null,
  });

  assert.ok(user.displayName);
  assert.ok(user.displayName.length >= 4);
  assert.match(user.displayName, /^[A-Za-z0-9_]+$/);
});

test("retries on displayName collision to ensure uniqueness", async () => {
  const ctx = makeUserModel({ takenOnFirstLookup: true });
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
  assert.ok(user.displayName.length >= 4);
  assert.match(user.displayName, /^[A-Za-z0-9_]+$/);
});

test("stays charset-valid even when Apple shares an accented name", async () => {
  const ctx = makeUserModel();
  const ensureAppleUser = buildEnsureAppleUser({
    User: ctx.model,
    eventBus: silentEvents(),
  });

  const user = await ensureAppleUser({
    appleId: "apple-4",
    email: null,
    name: "José García",
  });

  assert.ok(user.displayName, "displayName should be populated");
  assert.match(
    user.displayName,
    /^[A-Za-z0-9_]+$/,
    `displayName "${user.displayName}" must be charset-valid`
  );
  assert.doesNotMatch(
    user.displayName,
    /jose|garcia/i,
    "displayName must not be derived from the Apple real name"
  );
});

test("still stores the raw Apple name on the user record", async () => {
  const ctx = makeUserModel();
  const ensureAppleUser = buildEnsureAppleUser({
    User: ctx.model,
    eventBus: silentEvents(),
  });

  await ensureAppleUser({
    appleId: "apple-5",
    email: null,
    name: "Rohan Chari",
  });

  assert.equal(ctx.created[0].name, "Rohan Chari");
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
