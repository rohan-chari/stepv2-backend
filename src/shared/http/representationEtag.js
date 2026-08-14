const { createHash } = require("node:crypto");

function serializeWithStrongEtag(value) {
  const body = JSON.stringify(value);
  const digest = createHash("sha256").update(body).digest("hex");
  return { body, etag: `"${digest}"` };
}

function weakTagValue(value) {
  const trimmed = value.trim();
  return trimmed.startsWith("W/") ? trimmed.slice(2).trim() : trimmed;
}

function ifNoneMatchMatches(header, etag) {
  if (typeof header !== "string" || header.trim() === "") return false;
  return header
    .split(",")
    .map((value) => value.trim())
    .some((candidate) => candidate === "*" || weakTagValue(candidate) === etag);
}

function sendConditionalJson(req, res, value, vary) {
  const { body, etag } = serializeWithStrongEtag(value);
  res.set("ETag", etag);
  if (vary) res.vary(vary);
  if (ifNoneMatchMatches(req.get("If-None-Match"), etag)) {
    return res.status(304).end();
  }
  return res.type("application/json").send(body);
}

module.exports = {
  ifNoneMatchMatches,
  sendConditionalJson,
  serializeWithStrongEtag,
};
