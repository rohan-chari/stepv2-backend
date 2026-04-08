const assert = require("node:assert/strict");
const http = require("node:http");
const test = require("node:test");

const { createApp } = require("../../src/app");

async function startServer(dependencies = {}) {
  const app = createApp(dependencies);
  const server = http.createServer(app);

  await new Promise((resolve) => {
    server.listen(0, "127.0.0.1", resolve);
  });

  const address = server.address();

  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    async close() {
      await new Promise((resolve, reject) => {
        server.close((error) => {
          if (error) {
            reject(error);
            return;
          }

          resolve();
        });
      });
    },
  };
}

function authMocks(overrides = {}) {
  return {
    async verifyAppleIdentityToken(token) {
      assert.equal(token, "apple-token");
      return { sub: "apple-user-123" };
    },
    async ensureAppleUser() {
      return {
        id: "user-1",
        appleId: "apple-user-123",
        email: "walker@example.com",
      };
    },
    ...overrides,
  };
}

test("GET /auth/me includes profile photo fields in user", async () => {
  const server = await startServer({
    async verifyAppleIdentityToken(token) {
      assert.equal(token, "apple-token");
      return { sub: "apple-user-123" };
    },
    async ensureAppleUser() {
      return {
        id: "user-1",
        appleId: "apple-user-123",
        email: "walker@example.com",
        profilePhotoUrl: "https://cdn.example.com/profile-photos/user-1/avatar.jpg",
        profilePhotoPromptDismissedAt: "2026-04-08T12:00:00.000Z",
      };
    },
  });

  try {
    const response = await fetch(`${server.baseUrl}/auth/me`, {
      headers: {
        authorization: "Bearer apple-token",
      },
    });

    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(
      body.user.profilePhotoUrl,
      "https://cdn.example.com/profile-photos/user-1/avatar.jpg"
    );
    assert.equal(
      body.user.profilePhotoPromptDismissedAt,
      "2026-04-08T12:00:00.000Z"
    );
  } finally {
    await server.close();
  }
});

test("GET /auth/session includes profile photo fields in user", async () => {
  const server = await startServer({
    User: {
      async findById(id) {
        assert.equal(id, "user-1");
        return {
          id: "user-1",
          appleId: "apple-user-123",
          email: "walker@example.com",
          profilePhotoUrl: "https://cdn.example.com/profile-photos/user-1/avatar.jpg",
          profilePhotoPromptDismissedAt: "2026-04-08T12:00:00.000Z",
        };
      },
    },
    verifySessionToken() {
      return { sub: "user-1", appleId: "apple-user-123" };
    },
  });

  try {
    const response = await fetch(`${server.baseUrl}/auth/session`, {
      headers: {
        authorization: "Bearer session-token",
      },
    });

    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(
      body.user.profilePhotoUrl,
      "https://cdn.example.com/profile-photos/user-1/avatar.jpg"
    );
    assert.equal(
      body.user.profilePhotoPromptDismissedAt,
      "2026-04-08T12:00:00.000Z"
    );
  } finally {
    await server.close();
  }
});

test("POST /auth/me/profile-photo/upload-url returns 401 without auth token", async () => {
  const server = await startServer();

  try {
    const response = await fetch(`${server.baseUrl}/auth/me/profile-photo/upload-url`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
      },
      body: JSON.stringify({ contentType: "image/jpeg" }),
    });

    assert.equal(response.status, 401);
    assert.deepEqual(await response.json(), {
      error: "Authorization bearer token is required",
    });
  } finally {
    await server.close();
  }
});

test("POST /auth/me/profile-photo/upload-url returns 400 when contentType is missing", async () => {
  const server = await startServer(authMocks());

  try {
    const response = await fetch(`${server.baseUrl}/auth/me/profile-photo/upload-url`, {
      method: "POST",
      headers: {
        authorization: "Bearer apple-token",
        "content-type": "application/json",
      },
      body: JSON.stringify({}),
    });

    assert.equal(response.status, 400);
    assert.deepEqual(await response.json(), {
      error: "contentType is required",
    });
  } finally {
    await server.close();
  }
});

test("POST /auth/me/profile-photo/upload-url returns 400 for unsupported contentType", async () => {
  const server = await startServer(authMocks());

  try {
    const response = await fetch(`${server.baseUrl}/auth/me/profile-photo/upload-url`, {
      method: "POST",
      headers: {
        authorization: "Bearer apple-token",
        "content-type": "application/json",
      },
      body: JSON.stringify({ contentType: "image/gif" }),
    });

    assert.equal(response.status, 400);
    assert.deepEqual(await response.json(), {
      error: "contentType must be one of image/jpeg, image/png, image/heic, image/heif",
    });
  } finally {
    await server.close();
  }
});

test("POST /auth/me/profile-photo/upload-url creates an upload target", async () => {
  let receivedPayload;

  const server = await startServer(
    authMocks({
      async createProfilePhotoUpload(payload) {
        receivedPayload = payload;
        return {
          uploadUrl: "https://uploads.example.com/presigned",
          publicUrl: "https://cdn.example.com/profile-photos/user-1/avatar.jpg",
          key: "profile-photos/user-1/avatar.jpg",
          contentType: payload.contentType,
          expiresIn: 300,
        };
      },
    })
  );

  try {
    const response = await fetch(`${server.baseUrl}/auth/me/profile-photo/upload-url`, {
      method: "POST",
      headers: {
        authorization: "Bearer apple-token",
        "content-type": "application/json",
      },
      body: JSON.stringify({ contentType: "image/jpeg" }),
    });

    assert.equal(response.status, 200);
    const body = await response.json();
    assert.deepEqual(body.upload, {
      uploadUrl: "https://uploads.example.com/presigned",
      publicUrl: "https://cdn.example.com/profile-photos/user-1/avatar.jpg",
      key: "profile-photos/user-1/avatar.jpg",
      contentType: "image/jpeg",
      expiresIn: 300,
    });
    assert.deepEqual(receivedPayload, {
      userId: "user-1",
      contentType: "image/jpeg",
    });
  } finally {
    await server.close();
  }
});

test("PUT /auth/me/profile-photo returns 400 when key is missing", async () => {
  const server = await startServer(authMocks());

  try {
    const response = await fetch(`${server.baseUrl}/auth/me/profile-photo`, {
      method: "PUT",
      headers: {
        authorization: "Bearer apple-token",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        url: "https://cdn.example.com/profile-photos/user-1/avatar.jpg",
      }),
    });

    assert.equal(response.status, 400);
    assert.deepEqual(await response.json(), {
      error: "key is required",
    });
  } finally {
    await server.close();
  }
});

test("PUT /auth/me/profile-photo returns 400 when url is missing", async () => {
  const server = await startServer(authMocks());

  try {
    const response = await fetch(`${server.baseUrl}/auth/me/profile-photo`, {
      method: "PUT",
      headers: {
        authorization: "Bearer apple-token",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        key: "profile-photos/user-1/avatar.jpg",
      }),
    });

    assert.equal(response.status, 400);
    assert.deepEqual(await response.json(), {
      error: "url is required",
    });
  } finally {
    await server.close();
  }
});

test("PUT /auth/me/profile-photo saves the uploaded profile photo", async () => {
  let receivedPayload;

  const server = await startServer(
    authMocks({
      async setProfilePhoto(payload) {
        receivedPayload = payload;
        return {
          id: "user-1",
          profilePhotoUrl: payload.url,
          profilePhotoPromptDismissedAt: null,
        };
      },
    })
  );

  try {
    const response = await fetch(`${server.baseUrl}/auth/me/profile-photo`, {
      method: "PUT",
      headers: {
        authorization: "Bearer apple-token",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        key: "profile-photos/user-1/avatar.jpg",
        url: "https://cdn.example.com/profile-photos/user-1/avatar.jpg",
      }),
    });

    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(
      body.user.profilePhotoUrl,
      "https://cdn.example.com/profile-photos/user-1/avatar.jpg"
    );
    assert.deepEqual(receivedPayload, {
      userId: "user-1",
      key: "profile-photos/user-1/avatar.jpg",
      url: "https://cdn.example.com/profile-photos/user-1/avatar.jpg",
    });
  } finally {
    await server.close();
  }
});

test("DELETE /auth/me/profile-photo removes the active profile photo", async () => {
  let receivedPayload;

  const server = await startServer(
    authMocks({
      async removeProfilePhoto(payload) {
        receivedPayload = payload;
        return {
          id: "user-1",
          profilePhotoUrl: null,
          profilePhotoPromptDismissedAt: null,
        };
      },
    })
  );

  try {
    const response = await fetch(`${server.baseUrl}/auth/me/profile-photo`, {
      method: "DELETE",
      headers: {
        authorization: "Bearer apple-token",
      },
    });

    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.user.profilePhotoUrl, null);
    assert.deepEqual(receivedPayload, {
      userId: "user-1",
    });
  } finally {
    await server.close();
  }
});

test("POST /auth/me/profile-photo/prompt-dismiss stores the dismissal choice", async () => {
  let receivedPayload;

  const server = await startServer(
    authMocks({
      async dismissProfilePhotoPrompt(payload) {
        receivedPayload = payload;
        return {
          id: "user-1",
          profilePhotoPromptDismissedAt: "2026-04-08T12:00:00.000Z",
        };
      },
    })
  );

  try {
    const response = await fetch(`${server.baseUrl}/auth/me/profile-photo/prompt-dismiss`, {
      method: "POST",
      headers: {
        authorization: "Bearer apple-token",
      },
    });

    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(
      body.user.profilePhotoPromptDismissedAt,
      "2026-04-08T12:00:00.000Z"
    );
    assert.deepEqual(receivedPayload, {
      userId: "user-1",
    });
  } finally {
    await server.close();
  }
});
