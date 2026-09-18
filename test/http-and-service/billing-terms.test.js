const assert = require('node:assert/strict');
const { describe, it, before } = require('node:test');
const { getSharedServer } = require('./setup');

let server;
describe('billing legal pages', () => {
  before(async () => { server = await getSharedServer(); });
  for (const path of ['/billing-terms', '/billing-terms.html']) {
    it(`${path} serves readable purchase terms without JavaScript or authentication`, async () => {
      const response = await fetch(`${server.baseUrl}${path}`);
      assert.equal(response.status, 200);
      assert.match(response.headers.get('content-type'), /text\/html/);
      const html = await response.text();
      assert.match(html, /Bara Purchase Terms/);
      assert.match(html, /Permanent Bara\+/);
      assert.match(html, /one-time payment/);
      assert.match(html, /500 coins and 10 reroll credits every month/);
      assert.match(html, /monthly anniversary/);
      assert.match(html, /does not cancel an existing subscription/);
      assert.match(html, /Missed months remain owed/);
      assert.match(html, /Historical annual purchases/);
      assert.match(html, /seven-day free trial/);
      assert.match(html, /6,000 coins/);
      assert.match(html, /120 reroll/);
      assert.match(html, /automatically renew/);
      assert.match(html, /UTC calendar months/);
      assert.match(html, /13 calendar months/);
      assert.match(html, /original Bara account/);
      assert.match(html, /including earned coins/);
      assert.match(html, /do not create a debt/);
      assert.match(html, /next renewal/);
      assert.match(html, /href="\/privacy"/);
      assert.doesNotMatch(html, /<div id="app"><\/div>/);
    });
  }
  it('privacy explains RevenueCat billing data and retained purchase records', async () => {
    const response = await fetch(`${server.baseUrl}/privacy`);
    assert.equal(response.status, 200);
    const html = await response.text();
    assert.match(html, /RevenueCat/);
    assert.match(html, /billing records/);
    assert.match(html, /not send your health data or step counts to RevenueCat/);
  });
});
