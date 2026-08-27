// Auto-archive idle tabs: track the last time each tab was actually
// looked at, and — opt-in, off by default — save it as a plain bookmark
// under SyncMyTabs/<profile>/_archive/ then close it, once idle for
// longer than a configurable threshold. Pinned/grouped tabs are never
// candidates. See archive-core.js's own header comment.

const { test } = require("node:test");
const assert = require("node:assert/strict");
const { SimWorld } = require("./sim-env.js");
const { archiveEngineFor, activateTab } = require("./archive-test-helpers.js");

const DAY_MS = 24 * 60 * 60 * 1000;

// Same helper as ttl-cleanup.test.js / mirror-open-debounce.test.js:
// runs `fn(advance)` with Date.now() frozen and advanceable, then always
// restores the real clock.
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

// reconcileArchive() can itself queue a downstream reaction onto
// world.pending (e.g. closing a tab fires tabs.onRemoved, which
// sync-core.js's own handler reacts to by flipping this device's status
// bookmark, which in turn propagates to other devices) — every
// SimDevice action method already flushes this queue itself, but
// archiveEngine.reconcileArchive() is called directly here, not through
// a SimDevice method, so tests must flush explicitly afterward for that
// propagation to actually run before an assertion.
async function runReconcile(device, archiveEngine) {
  await archiveEngine.reconcileArchive();
  await device.world.flush();
}

async function archivedEntries(device, archiveEngine) {
  const profile = await device.engine.getActiveProfile();
  const profileFolder = await device.engine.getOrCreateProfileFolder(profile);
  const archiveFolder = await archiveEngine.getOrCreateArchiveFolder(profileFolder.id);
  const kids = await device.env.bookmarks.getChildren(archiveFolder.id);
  return kids.map((k) => ({ title: k.title, url: k.url }));
}

test("a tab idle longer than the threshold is archived (bookmarked, then closed)", async () => {
  await withFakeClock(1_700_000_000_000, async (advance) => {
    const world = new SimWorld();
    const a = world.addDevice({
      deviceName: "A",
      storage: { archiveEnabled: true, archiveIdleDays: 3 },
    });
    const ae = archiveEngineFor(a);

    await a.openTab("https://example.com/stale", "Stale Page");
    await activateTab(a, "https://example.com/stale"); // baseline activity

    advance(3 * DAY_MS + 1);
    await runReconcile(a, ae);

    assert.deepEqual(a.openUrls(), [], "the idle tab must have been closed");
    assert.deepEqual(await archivedEntries(a, ae), [
      { title: "Stale Page", url: "https://example.com/stale" },
    ]);
  });
});

test("a tab active more recently than the threshold is left alone", async () => {
  await withFakeClock(1_700_000_000_000, async (advance) => {
    const world = new SimWorld();
    const a = world.addDevice({
      deviceName: "A",
      storage: { archiveEnabled: true, archiveIdleDays: 3 },
    });
    const ae = archiveEngineFor(a);

    await a.openTab("https://example.com/fresh");
    await activateTab(a, "https://example.com/fresh");

    advance(2 * DAY_MS); // short of the 3-day threshold
    await runReconcile(a, ae);

    assert.deepEqual(a.openUrls(), ["https://example.com/fresh"]);
    assert.deepEqual(await archivedEntries(a, ae), []);
  });
});

test("re-activating a tab resets its idle timer", async () => {
  await withFakeClock(1_700_000_000_000, async (advance) => {
    const world = new SimWorld();
    const a = world.addDevice({
      deviceName: "A",
      storage: { archiveEnabled: true, archiveIdleDays: 3 },
    });
    const ae = archiveEngineFor(a);

    await a.openTab("https://example.com/revisited");
    await activateTab(a, "https://example.com/revisited");

    advance(2 * DAY_MS);
    await activateTab(a, "https://example.com/revisited"); // looked at again

    advance(2 * DAY_MS); // 2 days since the SECOND activation, not 4
    await runReconcile(a, ae);

    assert.deepEqual(
      a.openUrls(),
      ["https://example.com/revisited"],
      "the re-activation must have reset the clock"
    );
  });
});

test("pinned and grouped tabs are never archived, however idle", async () => {
  await withFakeClock(1_700_000_000_000, async (advance) => {
    const world = new SimWorld();
    const a = world.addDevice({
      deviceName: "A",
      storage: { archiveEnabled: true, archiveIdleDays: 3 },
    });
    const ae = archiveEngineFor(a);

    const pinned = await a.tabsApi.create({
      url: "https://example.com/pinned",
      active: false,
      pinned: true,
    });
    const grouped = await a.openGroupedTab("https://example.com/grouped", "G", "Work");

    await runReconcile(a, ae); // seeds a genuine baseline for both, at day 0
    advance(30 * DAY_MS);
    await runReconcile(a, ae);

    const tabs = await a.tabsApi.query({});
    assert.ok(tabs.some((t) => t.id === pinned.id), "pinned tab must survive");
    assert.ok(tabs.some((t) => t.id === grouped.id), "grouped tab must survive");
    assert.deepEqual(await archivedEntries(a, ae), []);
  });
});

test("archiveEnabled=false (default) never archives, however idle", async () => {
  await withFakeClock(1_700_000_000_000, async (advance) => {
    const world = new SimWorld();
    const a = world.addDevice({ deviceName: "A" }); // archiveEnabled defaults OFF
    const ae = archiveEngineFor(a);

    await a.openTab("https://example.com/never-touched");
    await activateTab(a, "https://example.com/never-touched");

    advance(30 * DAY_MS);
    await runReconcile(a, ae);

    assert.deepEqual(a.openUrls(), ["https://example.com/never-touched"]);
    assert.deepEqual(await archivedEntries(a, ae), []);
  });
});

test("a tab with no recorded activity yet is seeded fresh, not immediately archived (safe first-enable behavior)", async () => {
  await withFakeClock(1_700_000_000_000, async (advance) => {
    const world = new SimWorld();
    // archiveEnabled is turned on only AFTER the tab is already open —
    // simulates a user enabling the feature on a browser that's had
    // tabs open for a while, with no activity history for them yet.
    const a = world.addDevice({ deviceName: "A" });
    const ae = archiveEngineFor(a);
    await a.openTab("https://example.com/pre-existing");
    await a.storage.set({ archiveEnabled: true, archiveIdleDays: 3 });

    await runReconcile(a, ae); // first pass: seeds activity, must not archive
    assert.deepEqual(a.openUrls(), ["https://example.com/pre-existing"]);

    advance(3 * DAY_MS + 1);
    await runReconcile(a, ae); // now genuinely idle since the seed
    assert.deepEqual(a.openUrls(), []);
  });
});

test("windows.onFocusChanged also counts as activity for that window's active tab", async () => {
  await withFakeClock(1_700_000_000_000, async (advance) => {
    const world = new SimWorld();
    const a = world.addDevice({
      deviceName: "A",
      storage: { archiveEnabled: true, archiveIdleDays: 3 },
    });
    const ae = archiveEngineFor(a);

    await a.openTab("https://example.com/refocused");
    await activateTab(a, "https://example.com/refocused");

    advance(2 * DAY_MS);
    a.windowsApi.focus(a.windowsApi.defaultWindowId); // e.g. Alt-Tab back to it
    await a.world.flush();

    advance(2 * DAY_MS); // 2 days since the focus event, not 4
    await runReconcile(a, ae);

    assert.deepEqual(a.openUrls(), ["https://example.com/refocused"]);
  });
});

test("archiving a tab that's also sync-tracked propagates the close to other devices via the normal mechanism", async () => {
  await withFakeClock(1_700_000_000_000, async (advance) => {
    const world = new SimWorld();
    const a = world.addDevice({
      deviceName: "A",
      storage: { archiveEnabled: true, archiveIdleDays: 3 },
    });
    const b = world.addDevice({ deviceName: "B" });
    const ae = archiveEngineFor(a);

    await a.openTab("https://example.com/shared");
    await activateTab(a, "https://example.com/shared");
    assert.deepEqual(b.openUrls(), ["https://example.com/shared"], "B mirrors it in first");

    advance(3 * DAY_MS + 1);
    await runReconcile(a, ae);

    assert.deepEqual(a.openUrls(), [], "archived on A");
    assert.deepEqual(b.openUrls(), [], "the archive-driven close propagates to B too");
  });
});

test("master syncEnabled=false pauses archiving too", async () => {
  await withFakeClock(1_700_000_000_000, async (advance) => {
    const world = new SimWorld();
    const a = world.addDevice({
      deviceName: "A",
      storage: { archiveEnabled: true, archiveIdleDays: 3, syncEnabled: false },
    });
    const ae = archiveEngineFor(a);

    await a.openTab("https://example.com/paused");
    await activateTab(a, "https://example.com/paused");

    advance(30 * DAY_MS);
    await runReconcile(a, ae);

    assert.deepEqual(a.openUrls(), ["https://example.com/paused"], "paused: nothing archived");
  });
});

test("closing a tab cleans up its recorded activity (no leak)", async () => {
  await withFakeClock(1_700_000_000_000, async (advance) => {
    const world = new SimWorld();
    const a = world.addDevice({
      deviceName: "A",
      storage: { archiveEnabled: true, archiveIdleDays: 3 },
    });
    const ae = archiveEngineFor(a);

    await a.openTab("https://example.com/closed-manually");
    await activateTab(a, "https://example.com/closed-manually");
    await a.closeTab("https://example.com/closed-manually");

    const { archiveTabActivity } = await a.storage.get("archiveTabActivity");
    assert.deepEqual(archiveTabActivity, {}, "no stale activity entry should remain");
  });
});
