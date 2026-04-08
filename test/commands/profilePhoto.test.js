const assert = require("node:assert/strict");
const test = require("node:test");

const {
  buildCreateProfilePhotoUpload,
  buildSetProfilePhoto,
  buildRemoveProfilePhoto,
  buildDismissProfilePhotoPrompt,
  InvalidProfilePhotoError,
} = require("../../src/commands/profilePhoto");

function createStorage(overrides = {}) {
  return {
    async createUpload({ userId, contentType }) {
      return {
        uploadUrl: "https://uploads.example.com/presigned",
        publicUrl: `https://cdn.example.com/profile-photos/${userId}/avatar.jpg`,
        key: `profile-photos/${userId}/avatar.jpg`,
        contentType,
        expiresIn: 300,
      };
    },
    async deleteObject() {},
    validateManagedUpload({ userId, key, url }) {
      return (
        key.startsWith(`profile-photos/${userId}/`) &&
        url.startsWith(`https://cdn.example.com/profile-photos/${userId}/`)
      );
    },
    ...overrides,
  };
}

test("createProfilePhotoUpload delegates to storage with user-scoped payload", async () => {
  let receivedPayload;
  const createProfilePhotoUpload = buildCreateProfilePhotoUpload({
    profilePhotoStorage: createStorage({
      async createUpload(payload) {
        receivedPayload = payload;
        return {
          uploadUrl: "https://uploads.example.com/presigned",
          publicUrl: "https://cdn.example.com/profile-photos/user-1/avatar.jpg",
          key: "profile-photos/user-1/avatar.jpg",
          contentType: payload.contentType,
          expiresIn: 300,
        };
      },
    }),
  });

  const upload = await createProfilePhotoUpload({
    userId: "user-1",
    contentType: "image/jpeg",
  });

  assert.deepEqual(receivedPayload, {
    userId: "user-1",
    contentType: "image/jpeg",
  });
  assert.equal(upload.key, "profile-photos/user-1/avatar.jpg");
});

test("setProfilePhoto stores a first-time profile photo", async () => {
  let updatedFields;
  const setProfilePhoto = buildSetProfilePhoto({
    User: {
      async findById(id) {
        assert.equal(id, "user-1");
        return {
          id,
          profilePhotoKey: null,
          profilePhotoUrl: null,
          profilePhotoPromptDismissedAt: new Date("2026-04-08T12:00:00.000Z"),
        };
      },
      async update(id, fields) {
        assert.equal(id, "user-1");
        updatedFields = fields;
        return {
          id,
          ...fields,
        };
      },
    },
    profilePhotoStorage: createStorage(),
  });

  const user = await setProfilePhoto({
    userId: "user-1",
    key: "profile-photos/user-1/avatar.jpg",
    url: "https://cdn.example.com/profile-photos/user-1/avatar.jpg",
  });

  assert.deepEqual(updatedFields, {
    profilePhotoKey: "profile-photos/user-1/avatar.jpg",
    profilePhotoUrl: "https://cdn.example.com/profile-photos/user-1/avatar.jpg",
    profilePhotoPromptDismissedAt: null,
  });
  assert.equal(
    user.profilePhotoUrl,
    "https://cdn.example.com/profile-photos/user-1/avatar.jpg"
  );
});

test("setProfilePhoto replaces an existing profile photo and deletes the old object", async () => {
  const deletedKeys = [];
  let updatedFields;
  const setProfilePhoto = buildSetProfilePhoto({
    User: {
      async findById() {
        return {
          id: "user-1",
          profilePhotoKey: "profile-photos/user-1/old-avatar.jpg",
          profilePhotoUrl: "https://cdn.example.com/profile-photos/user-1/old-avatar.jpg",
          profilePhotoPromptDismissedAt: null,
        };
      },
      async update(id, fields) {
        updatedFields = fields;
        return { id, ...fields };
      },
    },
    profilePhotoStorage: createStorage({
      async deleteObject(key) {
        deletedKeys.push(key);
      },
    }),
  });

  const user = await setProfilePhoto({
    userId: "user-1",
    key: "profile-photos/user-1/new-avatar.jpg",
    url: "https://cdn.example.com/profile-photos/user-1/new-avatar.jpg",
  });

  assert.deepEqual(updatedFields, {
    profilePhotoKey: "profile-photos/user-1/new-avatar.jpg",
    profilePhotoUrl: "https://cdn.example.com/profile-photos/user-1/new-avatar.jpg",
    profilePhotoPromptDismissedAt: null,
  });
  assert.deepEqual(deletedKeys, ["profile-photos/user-1/old-avatar.jpg"]);
  assert.equal(
    user.profilePhotoUrl,
    "https://cdn.example.com/profile-photos/user-1/new-avatar.jpg"
  );
});

test("setProfilePhoto rejects uploads outside the user's managed path", async () => {
  const setProfilePhoto = buildSetProfilePhoto({
    User: {
      async findById() {
        return {
          id: "user-1",
          profilePhotoKey: null,
          profilePhotoUrl: null,
        };
      },
    },
    profilePhotoStorage: createStorage(),
  });

  await assert.rejects(
    () =>
      setProfilePhoto({
        userId: "user-1",
        key: "profile-photos/user-2/avatar.jpg",
        url: "https://cdn.example.com/profile-photos/user-2/avatar.jpg",
      }),
    (error) => {
      assert.ok(error instanceof InvalidProfilePhotoError);
      assert.equal(error.message, "Profile photo upload does not belong to this user");
      return true;
    }
  );
});

test("setProfilePhoto logs cleanup failures and still stores the new photo", async () => {
  const warnings = [];
  let updatedFields;
  const setProfilePhoto = buildSetProfilePhoto({
    User: {
      async findById() {
        return {
          id: "user-1",
          profilePhotoKey: "profile-photos/user-1/old-avatar.jpg",
          profilePhotoUrl: "https://cdn.example.com/profile-photos/user-1/old-avatar.jpg",
        };
      },
      async update(id, fields) {
        updatedFields = fields;
        return { id, ...fields };
      },
    },
    profilePhotoStorage: createStorage({
      async deleteObject() {
        throw new Error("delete failed");
      },
    }),
    logger: {
      warn(message) {
        warnings.push(message);
      },
    },
  });

  const user = await setProfilePhoto({
    userId: "user-1",
    key: "profile-photos/user-1/new-avatar.jpg",
    url: "https://cdn.example.com/profile-photos/user-1/new-avatar.jpg",
  });

  assert.deepEqual(updatedFields, {
    profilePhotoKey: "profile-photos/user-1/new-avatar.jpg",
    profilePhotoUrl: "https://cdn.example.com/profile-photos/user-1/new-avatar.jpg",
    profilePhotoPromptDismissedAt: null,
  });
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /Failed to delete old profile photo/);
  assert.equal(
    user.profilePhotoUrl,
    "https://cdn.example.com/profile-photos/user-1/new-avatar.jpg"
  );
});

test("removeProfilePhoto clears stored photo fields and deletes the object", async () => {
  const deletedKeys = [];
  let updatedFields;
  const removeProfilePhoto = buildRemoveProfilePhoto({
    User: {
      async findById() {
        return {
          id: "user-1",
          profilePhotoKey: "profile-photos/user-1/avatar.jpg",
          profilePhotoUrl: "https://cdn.example.com/profile-photos/user-1/avatar.jpg",
        };
      },
      async update(id, fields) {
        updatedFields = fields;
        return { id, ...fields };
      },
    },
    profilePhotoStorage: createStorage({
      async deleteObject(key) {
        deletedKeys.push(key);
      },
    }),
  });

  const user = await removeProfilePhoto({ userId: "user-1" });

  assert.deepEqual(updatedFields, {
    profilePhotoKey: null,
    profilePhotoUrl: null,
  });
  assert.deepEqual(deletedKeys, ["profile-photos/user-1/avatar.jpg"]);
  assert.equal(user.profilePhotoUrl, null);
});

test("removeProfilePhoto returns early when no profile photo exists", async () => {
  let updated = false;
  const removeProfilePhoto = buildRemoveProfilePhoto({
    User: {
      async findById() {
        return {
          id: "user-1",
          profilePhotoKey: null,
          profilePhotoUrl: null,
        };
      },
      async update() {
        updated = true;
      },
    },
    profilePhotoStorage: createStorage({
      async deleteObject() {
        throw new Error("should not be called");
      },
    }),
  });

  const user = await removeProfilePhoto({ userId: "user-1" });

  assert.equal(updated, false);
  assert.equal(user.profilePhotoUrl, null);
});

test("dismissProfilePhotoPrompt stores the dismissal timestamp", async () => {
  let updatedFields;
  const dismissProfilePhotoPrompt = buildDismissProfilePhotoPrompt({
    User: {
      async update(id, fields) {
        assert.equal(id, "user-1");
        updatedFields = fields;
        return { id, ...fields };
      },
    },
    now: () => new Date("2026-04-08T12:00:00.000Z"),
  });

  const user = await dismissProfilePhotoPrompt({ userId: "user-1" });

  assert.deepEqual(updatedFields, {
    profilePhotoPromptDismissedAt: new Date("2026-04-08T12:00:00.000Z"),
  });
  assert.equal(
    user.profilePhotoPromptDismissedAt.toISOString(),
    "2026-04-08T12:00:00.000Z"
  );
});
