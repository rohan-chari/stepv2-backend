const crypto = require("node:crypto");

const DEFAULT_PREFIX = "profile-photos";
const DEFAULT_EXPIRES_IN = 300;
const MAX_EXPIRES_IN = 60 * 60 * 24 * 7;

const ALLOWED_PROFILE_PHOTO_CONTENT_TYPES = [
  "image/jpeg",
  "image/png",
  "image/heic",
  "image/heif",
];

class ProfilePhotoStorageError extends Error {
  constructor(message) {
    super(message);
    this.name = "ProfilePhotoStorageError";
  }
}

class ProfilePhotoStorageConfigError extends ProfilePhotoStorageError {
  constructor(message) {
    super(message);
    this.name = "ProfilePhotoStorageConfigError";
  }
}

function trimSlashes(value) {
  return String(value || "").replace(/^\/+|\/+$/g, "");
}

function trimTrailingSlashes(value) {
  return String(value || "").replace(/\/+$/g, "");
}

function encodeRfc3986(value) {
  return encodeURIComponent(value).replace(
    /[!'()*]/g,
    (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`
  );
}

function encodeS3Key(key) {
  return String(key)
    .split("/")
    .map((part) => encodeRfc3986(part))
    .join("/");
}

function hashHex(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function hmac(key, value, encoding) {
  return crypto.createHmac("sha256", key).update(value).digest(encoding);
}

function resolveExtension(contentType) {
  switch (contentType) {
    case "image/jpeg":
      return "jpg";
    case "image/png":
      return "png";
    case "image/heic":
      return "heic";
    case "image/heif":
      return "heif";
    default:
      throw new ProfilePhotoStorageError(
        `Unsupported profile photo content type: ${contentType}`
      );
  }
}

function parseExpiresIn(value) {
  const parsed = Number(value);

  if (!Number.isFinite(parsed) || parsed <= 0) {
    return DEFAULT_EXPIRES_IN;
  }

  return Math.min(Math.floor(parsed), MAX_EXPIRES_IN);
}

function getTimestampParts(now = new Date()) {
  const iso = now.toISOString().replace(/[:-]|\.\d{3}/g, "");

  return {
    amzDate: iso,
    dateStamp: iso.slice(0, 8),
  };
}

function buildCredentialScope({ dateStamp, region }) {
  return `${dateStamp}/${region}/s3/aws4_request`;
}

function buildSigningKey({ secretAccessKey, dateStamp, region }) {
  const kDate = hmac(`AWS4${secretAccessKey}`, dateStamp);
  const kRegion = hmac(kDate, region);
  const kService = hmac(kRegion, "s3");
  return hmac(kService, "aws4_request");
}

function buildCanonicalQueryString(params) {
  return Object.entries(params)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, value]) => `${encodeRfc3986(key)}=${encodeRfc3986(String(value))}`)
    .join("&");
}

function getHost({ bucket, region }) {
  return `${bucket}.s3.${region}.amazonaws.com`;
}

function getPublicBaseUrl(config) {
  return config.publicBaseUrl || `https://${getHost(config)}`;
}

function publicUrlForKey(config, key) {
  return `${trimTrailingSlashes(getPublicBaseUrl(config))}/${encodeS3Key(key)}`;
}

function createPresignedPutUrl(config, { key, contentType, now = new Date() }) {
  const host = getHost(config);
  const canonicalUri = `/${encodeS3Key(key)}`;
  const { amzDate, dateStamp } = getTimestampParts(now);
  const credentialScope = buildCredentialScope({
    dateStamp,
    region: config.region,
  });

  const query = {
    "X-Amz-Algorithm": "AWS4-HMAC-SHA256",
    "X-Amz-Credential": `${config.accessKeyId}/${credentialScope}`,
    "X-Amz-Date": amzDate,
    "X-Amz-Expires": config.expiresIn,
    "X-Amz-SignedHeaders": "content-type;host",
  };

  if (config.sessionToken) {
    query["X-Amz-Security-Token"] = config.sessionToken;
  }

  const canonicalQueryString = buildCanonicalQueryString(query);
  const canonicalHeaders = `content-type:${contentType}\nhost:${host}\n`;
  const canonicalRequest = [
    "PUT",
    canonicalUri,
    canonicalQueryString,
    canonicalHeaders,
    "content-type;host",
    "UNSIGNED-PAYLOAD",
  ].join("\n");

  const stringToSign = [
    "AWS4-HMAC-SHA256",
    amzDate,
    credentialScope,
    hashHex(canonicalRequest),
  ].join("\n");

  const signature = hmac(
    buildSigningKey({
      secretAccessKey: config.secretAccessKey,
      dateStamp,
      region: config.region,
    }),
    stringToSign,
    "hex"
  );

  return `https://${host}${canonicalUri}?${canonicalQueryString}&X-Amz-Signature=${signature}`;
}

function buildDeleteRequestHeaders(config, { now = new Date() } = {}) {
  const host = getHost(config);
  const payloadHash = hashHex("");
  const { amzDate, dateStamp } = getTimestampParts(now);
  const credentialScope = buildCredentialScope({
    dateStamp,
    region: config.region,
  });

  const headers = {
    host,
    "x-amz-content-sha256": payloadHash,
    "x-amz-date": amzDate,
  };

  if (config.sessionToken) {
    headers["x-amz-security-token"] = config.sessionToken;
  }

  const signedHeaders = Object.keys(headers).sort().join(";");
  const canonicalHeaders = Object.keys(headers)
    .sort()
    .map((key) => `${key}:${headers[key]}`)
    .join("\n");

  return {
    host,
    headers,
    signedHeaders,
    credentialScope,
    payloadHash,
    amzDate,
    dateStamp,
    canonicalHeaders: `${canonicalHeaders}\n`,
  };
}

function resolveConfig(overrides = {}) {
  const bucket = overrides.bucket || process.env.S3_BUCKET;
  const region = overrides.region || process.env.S3_REGION;
  const accessKeyId = overrides.accessKeyId || process.env.S3_ACCESS_KEY_ID;
  const secretAccessKey =
    overrides.secretAccessKey || process.env.S3_SECRET_ACCESS_KEY;
  const sessionToken =
    overrides.sessionToken || process.env.S3_SESSION_TOKEN || null;
  const publicBaseUrl = trimTrailingSlashes(
    overrides.publicBaseUrl || process.env.S3_PUBLIC_BASE_URL || ""
  );
  const prefix = trimSlashes(
    overrides.prefix || process.env.S3_AVATAR_PREFIX || DEFAULT_PREFIX
  );
  const expiresIn = parseExpiresIn(
    overrides.expiresIn || process.env.S3_PRESIGNED_URL_EXPIRES_SECONDS
  );

  const missing = [];
  if (!bucket) missing.push("S3_BUCKET");
  if (!region) missing.push("S3_REGION");
  if (!accessKeyId) missing.push("S3_ACCESS_KEY_ID");
  if (!secretAccessKey) missing.push("S3_SECRET_ACCESS_KEY");

  if (missing.length > 0) {
    throw new ProfilePhotoStorageConfigError(
      `Missing S3 configuration: ${missing.join(", ")}`
    );
  }

  return {
    bucket,
    region,
    accessKeyId,
    secretAccessKey,
    sessionToken,
    publicBaseUrl: publicBaseUrl || null,
    prefix,
    expiresIn,
  };
}

function buildProfilePhotoStorage(overrides = {}) {
  return {
    async createUpload({ userId, contentType }) {
      const config = resolveConfig(overrides);
      const key = `${config.prefix}/${userId}/${Date.now()}-${crypto.randomUUID()}.${resolveExtension(
        contentType
      )}`;

      return {
        uploadUrl: createPresignedPutUrl(config, { key, contentType }),
        publicUrl: publicUrlForKey(config, key),
        key,
        contentType,
        expiresIn: config.expiresIn,
      };
    },

    async deleteObject(key) {
      const config = resolveConfig(overrides);
      const host = getHost(config);
      const canonicalUri = `/${encodeS3Key(key)}`;
      const {
        headers,
        signedHeaders,
        credentialScope,
        payloadHash,
        amzDate,
        canonicalHeaders,
      } = buildDeleteRequestHeaders(config);

      const canonicalRequest = [
        "DELETE",
        canonicalUri,
        "",
        canonicalHeaders,
        signedHeaders,
        payloadHash,
      ].join("\n");

      const stringToSign = [
        "AWS4-HMAC-SHA256",
        amzDate,
        credentialScope,
        hashHex(canonicalRequest),
      ].join("\n");

      const signature = hmac(
        buildSigningKey({
          secretAccessKey: config.secretAccessKey,
          dateStamp: credentialScope.slice(0, 8),
          region: config.region,
        }),
        stringToSign,
        "hex"
      );

      const authorization = [
        "AWS4-HMAC-SHA256",
        `Credential=${config.accessKeyId}/${credentialScope},`,
        `SignedHeaders=${signedHeaders},`,
        `Signature=${signature}`,
      ].join(" ");

      const response = await fetch(`https://${host}${canonicalUri}`, {
        method: "DELETE",
        headers: {
          Authorization: authorization,
          Host: headers.host,
          "x-amz-content-sha256": headers["x-amz-content-sha256"],
          "x-amz-date": headers["x-amz-date"],
          ...(config.sessionToken
            ? { "x-amz-security-token": config.sessionToken }
            : {}),
        },
      });

      if (!response.ok && response.status !== 404) {
        throw new ProfilePhotoStorageError(
          `S3 delete failed with status ${response.status}`
        );
      }
    },

    validateManagedUpload({ userId, key, url }) {
      if (!key || !url) {
        return false;
      }

      const config = resolveConfig(overrides);
      if (!key.startsWith(`${config.prefix}/${userId}/`)) {
        return false;
      }

      return publicUrlForKey(config, key) === url;
    },

    publicUrlForKey(key) {
      const config = resolveConfig(overrides);
      return publicUrlForKey(config, key);
    },
  };
}

const profilePhotoStorage = buildProfilePhotoStorage();

module.exports = {
  ALLOWED_PROFILE_PHOTO_CONTENT_TYPES,
  ProfilePhotoStorageError,
  ProfilePhotoStorageConfigError,
  buildProfilePhotoStorage,
  profilePhotoStorage,
};
