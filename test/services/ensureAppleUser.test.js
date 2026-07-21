const assert = require("node:assert/strict");
const test = require("node:test");

const { buildEnsureAppleUser } = require("../../src/modules/users/services/ensureAppleUser");

test("creates a new user and emits registration events when the Apple user is missing", async () => {
  const events = [];
  const storedUsers = [];

  let createdUser;

  const ensureAppleUser = buildEnsureAppleUser({
    User: {
      async findByAppleId() {
        return null;
      },
      async create(payload) {
        storedUsers.push(payload);

        createdUser = {
          id: "user-1",
          ...payload,
        };
        return createdUser;
      },
      // New users have no displayName yet, so ensureAppleUser auto-generates
      // one and persists it via update. No name is taken in this fresh-DB test.
      async findByDisplayNameInsensitive() {
        return null;
      },
      async update(id, data) {
        return { ...createdUser, ...data };
      },
    },
    eventBus: {
      emit(event, payload) {
        events.push({ event, payload });
      },
    },
  });

  const user = await ensureAppleUser({
    appleId: "apple-user-123",
    email: "walker@example.com",
    name: "Rohan Chari",
    emitSignInEvent: true,
  });

  // Display name is generated (never derived from the Apple real name); the
  // raw name is kept on user.name only.
  assert.equal(user.id, "user-1");
  assert.equal(user.appleId, "apple-user-123");
  assert.equal(user.email, "walker@example.com");
  assert.equal(user.name, "Rohan Chari");
  assert.match(user.displayName, /^[A-Za-z0-9_]+$/);
  assert.doesNotMatch(user.displayName, /rohan|chari/i);
  assert.deepEqual(storedUsers, [
    {
      appleId: "apple-user-123",
      email: "walker@example.com",
      name: "Rohan Chari",
    },
  ]);
  assert.deepEqual(events, [
    {
      event: "USER_REGISTERED",
      payload: {
        userId: "user-1",
        appleId: "apple-user-123",
      },
    },
    {
      event: "USER_SIGNED_IN",
      payload: {
        userId: "user-1",
      },
    },
  ]);
});

test("updates an existing user when fresh Apple profile data arrives", async () => {
  const updates = [];

  const ensureAppleUser = buildEnsureAppleUser({
    User: {
      async findByAppleId() {
        return {
          id: "user-1",
          appleId: "apple-user-123",
          email: null,
          name: null,
        };
      },
      async update(id, payload) {
        updates.push({ id, payload });

        return {
          id,
          appleId: "apple-user-123",
          email: payload.email,
          name: payload.name,
        };
      },
    },
    eventBus: {
      emit() {},
    },
  });

  const user = await ensureAppleUser({
    appleId: "apple-user-123",
    email: "walker@example.com",
    name: "Rohan Chari",
    emitSignInEvent: false,
  });

  assert.deepEqual(updates, [
    {
      id: "user-1",
      payload: {
        email: "walker@example.com",
        name: "Rohan Chari",
      },
    },
  ]);
  assert.deepEqual(user, {
    id: "user-1",
    appleId: "apple-user-123",
    email: "walker@example.com",
    name: "Rohan Chari",
  });
});
