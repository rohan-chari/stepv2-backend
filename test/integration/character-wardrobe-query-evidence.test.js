const assert = require("node:assert/strict");
const { it } = require("node:test");
const fs = require("node:fs");
const path = require("node:path");
const { prisma, cleanDatabase, request, getSharedServer } = require("./setup");
it("measures whole HTTP wardrobe statements and records sanitized exact response fixtures", async () => {
  await cleanDatabase();
  const server = await getSharedServer();
  let r = await request(server.baseUrl, "POST", "/auth/apple", {
    body: { identityToken: "apple-wardrobe-evidence" },
  });
  const b = await r.json();
  const token = b.sessionToken,
    userId = b.user.id;
  const character = await prisma.shopItem.create({
    data: {
      id: "wardrobe-evidence-character",
      sku: "evidence_character",
      name: "Character",
      slot: "CHARACTER",
      assetKey: "corgi_puppy",
      priceCoins: 10,
    },
  });
  const hat = await prisma.shopItem.create({
    data: {
      id: "wardrobe-evidence-hat",
      sku: "evidence_hat",
      name: "Hat",
      slot: "HEAD",
      assetKey: "birthday_hat",
      priceCoins: 10,
    },
  });
  await prisma.userShopItem.createMany({
    data: [character, hat].map((i) => ({ userId, shopItemId: i.id })),
  });
  await prisma.shopItemCharacterFit.createMany({
    data: [
      { accessoryShopItemId: hat.id, characterKey: "default" },
      {
        accessoryShopItemId: hat.id,
        characterKey: character.id,
        characterShopItemId: character.id,
      },
    ],
  });
  let queries = [];
  const queryPlans = [];
  let capture = false;
  prisma.$on("query", (e) => {
    if (capture) queries.push({ query: e.query, params: e.params });
  });
  const samples = [],
    fixtures = {};
  async function measure(name, method, url, body) {
    queries = [];
    capture = true;
    const response = await request(server.baseUrl, method, url, {
      token,
      body,
      headers: { "X-Client-Features": "characters,remote_assets" },
    });
    const json = await response.json();
    capture = false;
    assert.equal(response.status, 200, JSON.stringify(json));
    fixtures[name] = json;
    const counts = {
      total: queries.length,
      selects: 0,
      inserts: 0,
      updates: 0,
      deletes: 0,
      locks: 0,
      transactionControl: 0,
    };
    for (const q of queries) {
      const norm = q.query.trim();
      if (/FOR (UPDATE|SHARE)/i.test(norm)) counts.locks++;
      else if (/^SELECT/i.test(norm)) counts.selects++;
      else if (/^INSERT/i.test(norm)) counts.inserts++;
      else if (/^UPDATE/i.test(norm)) counts.updates++;
      else if (/^DELETE/i.test(norm)) counts.deletes++;
      else counts.transactionControl++;
    }
    if (process.env.PRISMA_QUERY_EVENTS_ENABLED === "true") {
      const { Client } = require("pg");
      const db = new Client({ connectionString: process.env.DATABASE_URL });
      await db.connect();
      try {
        for (const entry of queries.filter((e) =>
          /^SELECT (i\.\*|u\.coins)/.test(e.query.trim()),
        )) {
          const result = await db.query(
            "EXPLAIN (ANALYZE,BUFFERS,FORMAT JSON) " + entry.query,
            JSON.parse(entry.params),
          );
          queryPlans.push({
            request: name,
            query: entry.query,
            plan: result.rows[0]["QUERY PLAN"],
          });
        }
      } finally {
        await db.end();
      }
    }
    samples.push({ name, ...counts });
    return json;
  }
  const empty = { HEAD: null, FACE: null, NECK: null, BACK: null, FEET: null };
  await measure("collection", "GET", "/shop/characters");
  await measure("wardrobe", "GET", "/shop/characters/default/wardrobe");
  await measure(
    "inactiveSave",
    "PUT",
    `/shop/characters/${character.id}/outfit`,
    { expectedOutfitRevision: 0, slots: { ...empty, HEAD: hat.id } },
  );
  await measure("activate", "PUT", "/shop/active-character", {
    characterKey: character.id,
    expectedAppearanceRevision: 0,
    expectedOutfitRevision: 1,
  });
  await measure("noOp", "PUT", "/shop/active-character", {
    characterKey: character.id,
    expectedAppearanceRevision: 1,
    expectedOutfitRevision: 1,
  });
  assert.equal(fixtures.collection.contract, "character-wardrobes-v1");
  assert.equal(fixtures.inactiveSave.appearanceChanged, false);
  assert.equal(fixtures.activate.equipped.HEAD.id, hat.id);
  if (process.env.PRISMA_QUERY_EVENTS_ENABLED === "true") {
    assert.ok(samples.every((s) => s.total > 0));
    assert.ok(
      samples
        .slice(0, 2)
        .every((s) => s.inserts === 0 && s.updates === 0 && s.deletes === 0),
    );
    const directory = path.join(__dirname, "../../docs/evidence");
    fs.mkdirSync(directory, { recursive: true });
    fs.writeFileSync(
      path.join(directory, "character-wardrobe-query-counts.json"),
      JSON.stringify(
        {
          source:
            "real HTTP, local dedicated test database; includes authentication, membership/ad policy and cache DB reads; no production timing/CPU claim",
          samples,
        },
        null,
        2,
      ) + "\n",
    );
    fs.writeFileSync(
      path.join(directory, "character-wardrobe-query-plans.json"),
      JSON.stringify(
        {
          source:
            "EXPLAIN ANALYZE of actual local HTTP query shapes; tiny fixture demonstrates plans, not production CPU or population scaling",
          plans: queryPlans,
        },
        null,
        2,
      ) + "\n",
    );
    fs.writeFileSync(
      path.join(directory, "character-wardrobe-contract-fixtures.json"),
      JSON.stringify(fixtures, null, 2) + "\n",
    );
  }
});
