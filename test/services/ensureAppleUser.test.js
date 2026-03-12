const assert = require("node:assert/strict");
const test = require("node:test");

const { buildEnsureAppleUser } = require("../../src/services/ensureAppleUser");

test("creates a new user and emits registration events when the Apple user is missing", async () => {
  const events = [];
  const storedUsers = [];

  const ensureAppleUser = buildEnsureAppleUser({
    User: {
      async findByAppleId() {
        return null;
      },
      async create(payload) {
        storedUsers.push(payload);

        return {
          id: "user-1",
          ...payload,
        };
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

  assert.deepEqual(user, {
    id: "user-1",
    appleId: "apple-user-123",
    email: "walker@example.com",
    name: "Rohan Chari",
  });
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
