const assert = require("node:assert/strict");
const { after, before, beforeEach, describe, it } = require("node:test");

const {
  cleanDatabase,
  createTestUser,
  disconnectDatabase,
  prisma,
  request,
  startServer,
} = require("./setup");

describe("profile photo flow", () => {
  let server;
  let deletedKeys;
  let uploadCount;

  before(async () => {
    deletedKeys = [];
    uploadCount = 0;
    server = await startServer({
      profilePhotoStorage: {
        async createUpload({ userId, contentType }) {
          uploadCount += 1;
          const suffix = uploadCount === 1 ? "first" : `v${uploadCount}`;
          const key = `profile-photos/${userId}/${suffix}.jpg`;
          return {
            uploadUrl: `https://uploads.example.com/${key}`,
            publicUrl: `https://cdn.example.com/${key}`,
            key,
            contentType,
            expiresIn: 300,
          };
        },
        async deleteObject(key) {
          deletedKeys.push(key);
        },
        validateManagedUpload({ userId, key, url }) {
          return (
            key.startsWith(`profile-photos/${userId}/`) &&
            url === `https://cdn.example.com/${key}`
          );
        },
      },
    });
  });

  after(async () => {
    await server.close();
    await disconnectDatabase();
  });

  beforeEach(async () => {
    deletedKeys = [];
    uploadCount = 0;
    await cleanDatabase();
  });

  it("POST /auth/me/profile-photo/prompt-dismiss persists the dismissal timestamp", async () => {
    const { user, token } = await createTestUser({ displayName: "Trail Walker" });

    const response = await request(
      server.baseUrl,
      "POST",
      "/auth/me/profile-photo/prompt-dismiss",
      { token }
    );

    assert.equal(response.status, 200);
    const body = await response.json();
    assert.ok(body.user.profilePhotoPromptDismissedAt);

    const storedUser = await prisma.user.findUnique({
      where: { id: user.id },
    });
    assert.ok(storedUser.profilePhotoPromptDismissedAt instanceof Date);
  });

  it("PUT /auth/me/profile-photo saves the photo and clears the dismissal timestamp", async () => {
    const { user, token } = await createTestUser({ displayName: "Trail Walker" });

    await request(
      server.baseUrl,
      "POST",
      "/auth/me/profile-photo/prompt-dismiss",
      { token }
    );

    const uploadResponse = await request(
      server.baseUrl,
      "POST",
      "/auth/me/profile-photo/upload-url",
      {
        token,
        body: { contentType: "image/jpeg" },
      }
    );
    assert.equal(uploadResponse.status, 200);
    const uploadBody = await uploadResponse.json();

    const saveResponse = await request(
      server.baseUrl,
      "PUT",
      "/auth/me/profile-photo",
      {
        token,
        body: {
          key: uploadBody.upload.key,
          url: uploadBody.upload.publicUrl,
        },
      }
    );

    assert.equal(saveResponse.status, 200);
    const saveBody = await saveResponse.json();
    assert.equal(saveBody.user.profilePhotoUrl, uploadBody.upload.publicUrl);
    assert.equal(saveBody.user.profilePhotoPromptDismissedAt, null);

    const storedUser = await prisma.user.findUnique({
      where: { id: user.id },
    });
    assert.equal(storedUser.profilePhotoKey, uploadBody.upload.key);
    assert.equal(storedUser.profilePhotoUrl, uploadBody.upload.publicUrl);
    assert.equal(storedUser.profilePhotoPromptDismissedAt, null);
  });

  it("PUT /auth/me/profile-photo replaces the old photo and deletes the previous object", async () => {
    const { user, token } = await createTestUser({ displayName: "Trail Walker" });

    const firstUploadResponse = await request(
      server.baseUrl,
      "POST",
      "/auth/me/profile-photo/upload-url",
      {
        token,
        body: { contentType: "image/jpeg" },
      }
    );
    const firstUpload = await firstUploadResponse.json();

    await request(server.baseUrl, "PUT", "/auth/me/profile-photo", {
      token,
      body: {
        key: firstUpload.upload.key,
        url: firstUpload.upload.publicUrl,
      },
    });

    const secondUploadResponse = await request(
      server.baseUrl,
      "POST",
      "/auth/me/profile-photo/upload-url",
      {
        token,
        body: { contentType: "image/jpeg" },
      }
    );
    const secondUpload = await secondUploadResponse.json();

    const replaceResponse = await request(
      server.baseUrl,
      "PUT",
      "/auth/me/profile-photo",
      {
        token,
        body: {
          key: secondUpload.upload.key,
          url: secondUpload.upload.publicUrl,
        },
      }
    );

    assert.equal(replaceResponse.status, 200);
    const storedUser = await prisma.user.findUnique({
      where: { id: user.id },
    });
    assert.equal(storedUser.profilePhotoKey, secondUpload.upload.key);
    assert.equal(storedUser.profilePhotoUrl, secondUpload.upload.publicUrl);
    assert.deepEqual(deletedKeys, [firstUpload.upload.key]);
  });

  it("DELETE /auth/me/profile-photo clears the active photo and deletes the object", async () => {
    const { user, token } = await createTestUser({ displayName: "Trail Walker" });

    const uploadResponse = await request(
      server.baseUrl,
      "POST",
      "/auth/me/profile-photo/upload-url",
      {
        token,
        body: { contentType: "image/jpeg" },
      }
    );
    const uploadBody = await uploadResponse.json();

    await request(server.baseUrl, "PUT", "/auth/me/profile-photo", {
      token,
      body: {
        key: uploadBody.upload.key,
        url: uploadBody.upload.publicUrl,
      },
    });

    const response = await request(
      server.baseUrl,
      "DELETE",
      "/auth/me/profile-photo",
      { token }
    );

    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.user.profilePhotoUrl, null);

    const storedUser = await prisma.user.findUnique({
      where: { id: user.id },
    });
    assert.equal(storedUser.profilePhotoKey, null);
    assert.equal(storedUser.profilePhotoUrl, null);
    assert.deepEqual(deletedKeys, [uploadBody.upload.key]);
  });

  it("PUT /auth/me/profile-photo rejects a key for another user", async () => {
    const { token } = await createTestUser({ displayName: "Trail Walker" });

    const response = await request(
      server.baseUrl,
      "PUT",
      "/auth/me/profile-photo",
      {
        token,
        body: {
          key: "profile-photos/user-2/bad.jpg",
          url: "https://cdn.example.com/profile-photos/user-2/bad.jpg",
        },
      }
    );

    assert.equal(response.status, 400);
    assert.deepEqual(await response.json(), {
      error: "Profile photo upload does not belong to this user",
    });
  });
});
