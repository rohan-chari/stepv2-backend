const assert = require("node:assert/strict");
const test = require("node:test");

const {
  ADMIN_EXPOSED_FLAGS,
  KNOWN_FLAGS,
  PERMANENT_FLAGS,
  buildAppSettings,
} = require("../../src/shared/config/appSettings");

test("banner ads is a mutable admin setting with a true compatibility fallback", async () => {
  let storedValue;
  const writes = [];
  const settings = buildAppSettings({
    allowPermanentOverrides: false,
    cacheTtlMs: 0,
    prisma: {
      appSetting: {
        async findMany() {
          return storedValue === undefined
            ? []
            : [{ key: "bannerAdsEnabled", value: storedValue }];
        },
        async upsert(args) {
          writes.push(args);
          storedValue = args.create.value;
        },
      },
    },
  });

  assert.equal(KNOWN_FLAGS.bannerAdsEnabled, true);
  assert.equal(PERMANENT_FLAGS.bannerAdsEnabled, undefined);
  assert.equal(ADMIN_EXPOSED_FLAGS.includes("bannerAdsEnabled"), true);
  assert.equal(await settings.getFlag("bannerAdsEnabled"), true);
  assert.equal((await settings.getAllFlags()).bannerAdsEnabled, true);

  await settings.setFlag("bannerAdsEnabled", false);
  assert.equal(await settings.getFlag("bannerAdsEnabled"), false);
  assert.equal((await settings.getAllFlags()).bannerAdsEnabled, false);
  assert.equal(writes.length, 1);
  assert.deepEqual(writes[0], {
    where: { key: "bannerAdsEnabled" },
    update: { value: false },
    create: { key: "bannerAdsEnabled", value: false },
  });

  storedValue = "false";
  settings.bustCache();
  assert.equal(await settings.getFlag("bannerAdsEnabled"), true);
  assert.equal((await settings.getAllFlags()).bannerAdsEnabled, true);
});
