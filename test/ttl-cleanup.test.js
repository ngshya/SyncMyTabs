// TTL safety-net behavior: a device that's genuinely gone for good
// (uninstalled, or just never comes back) must not block cleanup
// forever, while a device that's still alive and heartbeating never
// gets swept just for staying open a long time.

const { test } = require("node:test");
const assert = require("node:assert/strict");
const { SimWorld } = require("./sim-env.js");

const DAY_MS = 24 * 60 * 60 * 1000;

// Runs `fn(advance)` with Date.now() frozen and advanceable, then
// always restores the real clock — even if the test throws.
async function withFakeClock(startTime, fn) {
  const realNow = Date.now;
  let now = startTime;
  Date.now = () => now;
  try {
    await fn((ms) => {
      now += ms;
    });
  } finally {
    Date.now = realNow;
  }
}

test("a device that never comes back has its stale entry swept by TTL, without disturbing the still-open tab", async () => {
  await withFakeClock(1_700_000_000_000, async (advance) => {
    const world = new SimWorld();
    const a = world.addDevice({
      deviceName: "A",
      storage: { ttlEnabled: true, ttlDays: 21 },
    });
    const b = world.addDevice({
      deviceName: "B",
      storage: { ttlEnabled: true, ttlDays: 21 },
    });

    await a.openTab("https://example.com/");
    assert.deepEqual(b.openUrls(), ["https://example.com/"]);

    // B is uninstalled / gone for good.
    world.disconnectDevice(b);
    advance(22 * DAY_MS);

    // A keeps ticking normally — its own entry gets heartbeat-refreshed
    // each time, so it never goes stale itself.
    await a.tick();

    const entries = await world.allEntries("default");
    assert.deepEqual(
      entries.filter((e) => e.device === "B"),
      [],
      "B's abandoned entry should be swept by TTL"
    );
    const mine = entries.filter((e) => e.device === "A");
    assert.equal(mine.length, 1);
    assert.equal(mine[0].state, "open", "A's own still-open tab must survive");
    assert.deepEqual(a.openUrls(), ["https://example.com/"]);
  });
});

test("with TTL disabled, an abandoned entry is never swept", async () => {
  await withFakeClock(1_700_000_000_000, async (advance) => {
    const world = new SimWorld();
    const a = world.addDevice({
      deviceName: "A",
      storage: { ttlEnabled: false },
    });
    const b = world.addDevice({
      deviceName: "B",
      storage: { ttlEnabled: false },
    });

    await a.openTab("https://example.com/");
    world.disconnectDevice(b);
    advance(365 * DAY_MS);
    await a.tick();

    const entries = await world.allEntries("default");
    assert.equal(
      entries.filter((e) => e.device === "B").length,
      1,
      "with TTL off, the abandoned entry must survive indefinitely"
    );
  });
});

test("a closed group with one device that never confirms is eventually swept whole", async () => {
  await withFakeClock(1_700_000_000_000, async (advance) => {
    const world = new SimWorld();
    const a = world.addDevice({
      deviceName: "A",
      storage: { ttlEnabled: true, ttlDays: 21 },
    });
    const b = world.addDevice({
      deviceName: "B",
      storage: { ttlEnabled: true, ttlDays: 21 },
    });

    await a.openTab("https://example.com/");
    await a.closeTab("https://example.com/"); // A's own entry: closed
    world.disconnectDevice(b); // B never gets the memo, and never will

    advance(22 * DAY_MS);
    await a.tick();

    // The whole group should be gone: A's closed entry is stale (TTL),
    // and B's never-updated open entry is stale too — neither is ever
    // going to "agree closed" on its own, so TTL is the only way out.
    assert.deepEqual(await world.allEntries("default"), []);
  });
});

test("a tab kept open for far longer than the TTL is never swept (heartbeat keeps it fresh)", async () => {
  await withFakeClock(1_700_000_000_000, async (advance) => {
    const world = new SimWorld();
    const a = world.addDevice({
      deviceName: "A",
      storage: { ttlEnabled: true, ttlDays: 21 },
    });

    await a.openTab("https://example.com/");

    // Simulate 60 days of the tab just sitting open, ticking
    // periodically (as the real alarm would).
    for (let i = 0; i < 60; i++) {
      advance(DAY_MS);
      await a.tick();
    }

    assert.deepEqual(a.openUrls(), ["https://example.com/"]);
    const mine = await a.myEntries("default");
    assert.equal(mine.length, 1);
    assert.equal(mine[0].state, "open");
  });
});
