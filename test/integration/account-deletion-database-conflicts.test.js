const assert = require('node:assert/strict');
const { before, beforeEach, it } = require('node:test');
const target = new URL(process.env.DATABASE_URL);
assert.ok(['localhost','127.0.0.1'].includes(target.hostname));
assert.match(target.pathname, /_test$/);
const { prisma, cleanDatabase, createTestUser, getSharedServer, request } = require('./setup');
let baseUrl;
before(async () => { baseUrl = (await getSharedServer()).baseUrl; });
beforeEach(cleanDatabase);

for (const failureCount of [1, 10]) {
  it(`account deletion rolls back and retries database conflicts with a bounded budget (${failureCount})`, async () => {
    const account = await createTestUser();
    await prisma.$executeRawUnsafe('CREATE SEQUENCE test_event_version_delete_retry');
    await prisma.$executeRawUnsafe(`CREATE FUNCTION test_event_version_delete_retry() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN IF nextval('test_event_version_delete_retry') <= ${failureCount} THEN
        RAISE EXCEPTION 'test database conflict' USING ERRCODE='40P01'; END IF; RETURN OLD; END $$`);
    await prisma.$executeRawUnsafe('CREATE TRIGGER test_event_version_delete_retry BEFORE DELETE ON users FOR EACH ROW EXECUTE FUNCTION test_event_version_delete_retry()');
    try {
      const result = await request(baseUrl, 'DELETE', '/auth/account', { token:account.token });
      const [attempts] = await prisma.$queryRawUnsafe('SELECT last_value::int AS count FROM test_event_version_delete_retry');
      assert.equal(attempts.count, failureCount === 1 ? 2 : 3);
      if (failureCount === 1) {
        assert.equal(result.status, 204);
        assert.equal(await prisma.user.findUnique({ where:{id:account.user.id} }), null);
      } else {
        assert.ok(result.status >= 500);
        assert.ok(await prisma.user.findUnique({ where:{id:account.user.id} }));
        const me = await request(baseUrl, 'GET', '/auth/me', { token:account.token });
        assert.equal(me.status, 200);
      }
    } finally {
      await prisma.$executeRawUnsafe('DROP TRIGGER test_event_version_delete_retry ON users');
      await prisma.$executeRawUnsafe('DROP FUNCTION test_event_version_delete_retry()');
      await prisma.$executeRawUnsafe('DROP SEQUENCE test_event_version_delete_retry');
    }
  });
}
