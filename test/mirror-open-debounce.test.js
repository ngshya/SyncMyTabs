// The mirror-open debounce: reconcileMirror never opens a brand-new
// mirror candidate on its very first sighting — it waits for the URL to
// still qualify on a LATER reconcile pass, at least MIRROR_OPEN_DEBOUNCE_MS
// after the first one. See sync-core.js's own comment on
// MIRROR_OPEN_DEBOUNCE_MS for why: bookmark sync is neither atomic nor
// ordered, so a device can see a stale "still open elsewhere" snapshot
// just after that URL was actually closed AND its folder fully deleted
// everywhere else — opening on that first sighting would resurrect an
// otherwise-fully-closed URL with no peer "closed" entry left for the
// contagious-close mechanism to ever catch onto again (a permanent
// orphan tab). See CLAUDE.md.
//
// SimWorld's shared, instantaneous bookmark tree deliberately doesn't
// model sync propagation delay (see its own comment), so every OTHER
// test in this suite runs devices with the default mirrorOpenDebounceMs:
// 0 override, which collapses this mechanism back to "open on first
// sighting" and leaves the rest of the suite's assumptions untouched.
// These tests instead construct a device with a non-zero window and
// drive a fake clock across separate reconcile passes to exercise the
// mechanism itself directly.

const { test } = require("node:test");
const assert = require("node:assert/strict");
const { SimWorld } = require("./sim-env.js");
const { MIRROR_OPEN_DEBOUNCE_MS } = require("../sync-core.js");

// Same helper as ttl-cleanup.test.js: runs `fn(advance)` with Date.now()
// frozen and advanceable, then always restores the real clock.
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

test("a mirror candidate is not opened on first sighting, only once the debounce window has elapsed and it's re-confirmed", async () => {
  await withFakeClock(1_700_000_000_000, async (advance) => {
    const world = new SimWorld();
    const a = world.addDevice({ deviceName: "A" });
    const b = world.addDevice({
      deviceName: "B",
      mirrorOpenDebounceMs: MIRROR_OPEN_DEBOUNCE_MS,
    });

    await a.openTab("https://example.com/");
    assert.deepEqual(
      b.openUrls(),
      [],
      "must not mirror in on the very first sighting"
    );

    // Not enough time has passed yet — still must not open.
    advance(MIRROR_OPEN_DEBOUNCE_MS - 1);
    await b.tick();
    assert.deepEqual(
      b.openUrls(),
      [],
      "must still not open just short of the debounce window"
    );

    // Now the window has fully elapsed since the first sighting.
    advance(1);
    await b.tick();
    assert.deepEqual(
      b.openUrls(),
      ["https://example.com/"],
      "must mirror in once re-confirmed after the debounce window"
    );
  });
});

test("a mirror candidate that's closed and fully deleted before the debounce window elapses is never opened (the orphan-tab race)", async () => {
  await withFakeClock(1_700_000_000_000, async (advance) => {
    const world = new SimWorld();
    const a = world.addDevice({ deviceName: "A" });
    const b = world.addDevice({
      deviceName: "B",
      mirrorOpenDebounceMs: MIRROR_OPEN_DEBOUNCE_MS,
    });

    await a.openTab("https://example.com/");
    assert.deepEqual(b.openUrls(), []);

    // A closes it before B's debounce window elapses. A is the only
    // device with an entry, so the whole folder is deleted immediately —
    // exactly the scenario that used to leave a resurrected, orphaned
    // tab behind on B once its stale "still open" sighting matured.
    await a.closeTab("https://example.com/");
    assert.deepEqual(
      b.openUrls(),
      [],
      "must not have opened while A's close was propagating"
    );

    advance(MIRROR_OPEN_DEBOUNCE_MS + 1);
    await b.tick();

    assert.deepEqual(
      b.openUrls(),
      [],
      "must never open a candidate that resolved to closed+deleted before confirmation"
    );
    const entries = await world.allEntries("default");
    assert.deepEqual(
      entries,
      [],
      "no orphan folder/entry must be left behind on either device"
    );
  });
});
