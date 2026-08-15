const assert = require("node:assert/strict");
const { describe, it } = require("node:test");

const {
  clampOffsetLimit,
} = require("../../src/shared/pagination/clampOffsetLimit");

// Pure offset/limit arithmetic with many boundary cases — the CLAUDE.md carve-out
// for a unit test over an integration test. Every route that WIRES this helper up
// still gets its own integration assertion (see
// test/integration/race-details-participants-paging.test.js).
describe("clampOffsetLimit", () => {
  it("defaults an absent limit to defaultLimit and an absent offset to 0", () => {
    assert.deepEqual(clampOffsetLimit({ total: 100 }), {
      start: 0,
      safeLimit: 10,
      hasMore: true,
      nextOffset: 10,
    });
  });

  it("floors a fractional offset and limit", () => {
    assert.deepEqual(clampOffsetLimit({ offset: 4.9, limit: 7.9, total: 100 }), {
      start: 4,
      safeLimit: 7,
      hasMore: true,
      nextOffset: 11,
    });
  });

  it("clamps limit into [1, maxLimit]", () => {
    assert.equal(clampOffsetLimit({ limit: 0, total: 100 }).safeLimit, 1);
    assert.equal(clampOffsetLimit({ limit: -5, total: 100 }).safeLimit, 1);
    assert.equal(clampOffsetLimit({ limit: 1, total: 100 }).safeLimit, 1);
    assert.equal(clampOffsetLimit({ limit: 50, total: 100 }).safeLimit, 50);
    assert.equal(clampOffsetLimit({ limit: 51, total: 100 }).safeLimit, 50);
    assert.equal(clampOffsetLimit({ limit: 9999, total: 100 }).safeLimit, 50);
  });

  it("honours custom defaultLimit / maxLimit", () => {
    assert.equal(
      clampOffsetLimit({ total: 100, defaultLimit: 25 }).safeLimit,
      25
    );
    assert.equal(
      clampOffsetLimit({ limit: 999, total: 100, maxLimit: 15 }).safeLimit,
      15
    );
  });

  it("treats a non-numeric limit as defaultLimit, not as 1", () => {
    // Inherited from the inline getRaceProgress code: `Number.isFinite` decides,
    // so "abc"/undefined/Infinity fall back rather than clamping to the floor.
    assert.equal(clampOffsetLimit({ limit: "abc", total: 100 }).safeLimit, 10);
    assert.equal(
      clampOffsetLimit({ limit: undefined, total: 100 }).safeLimit,
      10
    );
    assert.equal(
      clampOffsetLimit({ limit: Infinity, total: 100 }).safeLimit,
      10
    );
    assert.equal(clampOffsetLimit({ limit: NaN, total: 100 }).safeLimit, 10);
  });

  it("accepts a numeric string limit (query params arrive as strings)", () => {
    assert.equal(clampOffsetLimit({ limit: "5", total: 100 }).safeLimit, 5);
    assert.equal(clampOffsetLimit({ offset: "20", total: 100 }).start, 20);
  });

  it("clamps a negative / non-numeric offset to 0", () => {
    assert.equal(clampOffsetLimit({ offset: -1, total: 100 }).start, 0);
    assert.equal(clampOffsetLimit({ offset: "abc", total: 100 }).start, 0);
    assert.equal(clampOffsetLimit({ offset: null, total: 100 }).start, 0);
    assert.equal(clampOffsetLimit({ offset: NaN, total: 100 }).start, 0);
  });

  it("clamps start to total when the offset runs past the end", () => {
    assert.deepEqual(clampOffsetLimit({ offset: 500, limit: 10, total: 12 }), {
      start: 12,
      safeLimit: 10,
      hasMore: false,
      nextOffset: 22,
    });
  });

  it("reports the last page as hasMore:false with nextOffset past the end", () => {
    // Pins getRaceProgress's convention exactly: nextOffset is always
    // start + limit, never the clamped end of the array.
    assert.deepEqual(clampOffsetLimit({ offset: 470, limit: 10, total: 477 }), {
      start: 470,
      safeLimit: 10,
      hasMore: false,
      nextOffset: 480,
    });
    assert.deepEqual(clampOffsetLimit({ offset: 10, limit: 5, total: 12 }), {
      start: 10,
      safeLimit: 5,
      hasMore: false,
      nextOffset: 15,
    });
  });

  it("reports hasMore:false when the page exactly covers the tail", () => {
    assert.deepEqual(clampOffsetLimit({ offset: 5, limit: 5, total: 10 }), {
      start: 5,
      safeLimit: 5,
      hasMore: false,
      nextOffset: 10,
    });
  });

  it("handles an empty / zero / garbage total", () => {
    assert.deepEqual(clampOffsetLimit({ offset: 3, limit: 5, total: 0 }), {
      start: 0,
      safeLimit: 5,
      hasMore: false,
      nextOffset: 5,
    });
    assert.equal(clampOffsetLimit({ total: -4 }).hasMore, false);
    assert.equal(clampOffsetLimit({ total: "abc" }).hasMore, false);
    assert.equal(clampOffsetLimit().start, 0);
  });

  it("reproduces the inline getRaceProgress arithmetic across a sweep", () => {
    // The original inline block, copied verbatim from getRaceProgress.js before
    // the extraction. Any divergence here is a behaviour change to a shipped
    // pager, not a refactor.
    const inline = (participantsOffset, participantsLimit, totalParticipants) => {
      const safeOffset =
        Number(participantsOffset) > 0 ? Math.floor(participantsOffset) : 0;
      const parsedLimit = Number(participantsLimit);
      const safeLimit = Math.min(
        Math.max(Number.isFinite(parsedLimit) ? Math.floor(parsedLimit) : 10, 1),
        50
      );
      const start = Math.min(safeOffset, totalParticipants);
      return {
        start,
        safeLimit,
        hasMore: start + safeLimit < totalParticipants,
        nextOffset: start + safeLimit,
      };
    };

    const offsets = [0, 1, 5, 9, 10, 11, 24, 50, 476, 477, 1000, -3, "abc", 2.7];
    const limits = [undefined, 0, 1, 5, 10, 49, 50, 51, 500, -2, "abc", 3.9];
    const totals = [0, 1, 10, 12, 24, 477];
    for (const offset of offsets) {
      for (const limit of limits) {
        for (const total of totals) {
          assert.deepEqual(
            clampOffsetLimit({ offset, limit, total }),
            inline(offset, limit, total),
            `offset=${offset} limit=${limit} total=${total}`
          );
        }
      }
    }
  });
});
