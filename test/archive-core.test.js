// Auto-archive idle tabs: track the last time each tab was actually
// looked at, and — opt-in, off by default — save it as a plain bookmark
// under SyncMyTabs/<profile>/_archive/<year>/<month>/<day>/ then close
// it, once idle for longer than a configurable threshold. Pinned/grouped
// tabs are never candidates. See archive-core.js's own header comment.

const { test } = require("node:test");
const assert = require("node:assert/strict");
const { SimWorld } = require("./sim-env.js");
const { archiveEngineFor, activateTab } = require("./archive-test-helpers.js");
const { MIN_ARCHIVE_IDLE_MS } = require("../archive-core.js");

const DAY_MS = 24 * 60 * 60 * 1000;
const HOUR_MS = 60 * 60 * 1000;
const MINUTE_MS = 60 * 1000;

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

// Collects every archived bookmark REGARDLESS of which year/month/day
// subfolder it landed in — most tests here only care about what got
// archived, not the exact date-folder structure (a dedicated test below
// covers that specifically).
async function archivedEntries(device, archiveEngine) {
  const profile = await device.engine.getActiveProfile();
  const profileFolder = await device.engine.getOrCreateProfileFolder(profile);
  const archiveFolder = await archiveEngine.getOrCreateArchiveFolder(profileFolder.id);
  const out = [];
  async function walk(folderId) {
    const kids = await device.env.bookmarks.getChildren(folderId);
    for (const k of kids) {
      if (k.url) out.push({ title: k.title, url: k.url });
      else await walk(k.id);
    }
  }
  await walk(archiveFolder.id);
  return out;
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

test("archived tabs are organized by year/month/day (local date at archive time)", async () => {
  const start = new Date(2024, 0, 15, 10, 0, 0).getTime(); // Jan 15, 2024, local
  await withFakeClock(start, async (advance) => {
    const world = new SimWorld();
    const a = world.addDevice({
      deviceName: "A",
      storage: { archiveEnabled: true, archiveIdleDays: 3 },
    });
    const ae = archiveEngineFor(a);

    await a.openTab("https://example.com/dated");
    await activateTab(a, "https://example.com/dated");

    advance(3 * DAY_MS + 1); // now Jan 18, 2024 — the archiving moment
    await runReconcile(a, ae);

    const profile = await a.engine.getActiveProfile();
    const profileFolder = await a.engine.getOrCreateProfileFolder(profile);
    const archiveFolder = await ae.getOrCreateArchiveFolder(profileFolder.id);

    const years = await a.env.bookmarks.getChildren(archiveFolder.id);
    assert.deepEqual(years.map((y) => y.title), ["2024"], "one year folder, named plainly");

    const months = await a.env.bookmarks.getChildren(years[0].id);
    assert.deepEqual(months.map((m) => m.title), ["01"], "month is zero-padded two digits");

    const days = await a.env.bookmarks.getChildren(months[0].id);
    assert.deepEqual(days.map((d) => d.title), ["18"], "day is zero-padded two digits");

    const bookmarks = await a.env.bookmarks.getChildren(days[0].id);
    assert.deepEqual(
      bookmarks.map((b) => b.url),
      ["https://example.com/dated"],
      "the archived bookmark lands in the day folder matching the archiving date"
    );
  });
});

test("clearArchiveForActiveProfile empties the whole archive, and a later archive still works", async () => {
  await withFakeClock(1_700_000_000_000, async (advance) => {
    const world = new SimWorld();
    const a = world.addDevice({
      deviceName: "A",
      storage: { archiveEnabled: true, archiveIdleDays: 3 },
    });
    const ae = archiveEngineFor(a);

    await a.openTab("https://example.com/first");
    await activateTab(a, "https://example.com/first");
    advance(3 * DAY_MS + 1);
    await runReconcile(a, ae);
    assert.equal((await archivedEntries(a, ae)).length, 1, "one entry archived so far");

    await ae.clearArchiveForActiveProfile();
    assert.deepEqual(await archivedEntries(a, ae), [], "the whole archive must be empty now");

    // A later archive action must still work correctly — the root
    // "_archive" folder (and its year/month/day chain) is recreated
    // fresh via getOrCreateArchiveFolder, not left broken by the clear.
    await a.openTab("https://example.com/second");
    await activateTab(a, "https://example.com/second");
    advance(3 * DAY_MS + 1);
    await runReconcile(a, ae);
    assert.deepEqual(await archivedEntries(a, ae), [
      { title: "https://example.com/second", url: "https://example.com/second" },
    ]);
  });
});

test("clearArchiveForActiveProfile with nothing archived yet is a safe no-op", async () => {
  const world = new SimWorld();
  const a = world.addDevice({ deviceName: "A" });
  const ae = archiveEngineFor(a);

  await ae.clearArchiveForActiveProfile(); // must not throw
  assert.deepEqual(await archivedEntries(a, ae), []);
});

test("the idle threshold can be set purely in hours/minutes, with 0 days", async () => {
  await withFakeClock(1_700_000_000_000, async (advance) => {
    const world = new SimWorld();
    // 0 days — a threshold under a day is otherwise impossible to
    // express with days alone.
    const a = world.addDevice({
      deviceName: "A",
      storage: { archiveEnabled: true, archiveIdleDays: 0, archiveIdleHours: 2, archiveIdleMinutes: 30 },
    });
    const ae = archiveEngineFor(a);

    await a.openTab("https://example.com/short-fuse");
    await activateTab(a, "https://example.com/short-fuse");

    advance(2 * HOUR_MS + 29 * MINUTE_MS); // just short of 2h30m
    await runReconcile(a, ae);
    assert.deepEqual(a.openUrls(), ["https://example.com/short-fuse"], "not idle long enough yet");

    advance(2 * MINUTE_MS); // now past 2h30m
    await runReconcile(a, ae);
    assert.deepEqual(a.openUrls(), [], "archived once past the hours/minutes threshold");
  });
});

test("days, hours, and minutes combine into a single threshold", async () => {
  await withFakeClock(1_700_000_000_000, async (advance) => {
    const world = new SimWorld();
    // 1 day + 2 hours + 0 minutes = 26 hours total.
    const a = world.addDevice({
      deviceName: "A",
      storage: { archiveEnabled: true, archiveIdleDays: 1, archiveIdleHours: 2, archiveIdleMinutes: 0 },
    });
    const ae = archiveEngineFor(a);

    await a.openTab("https://example.com/combined");
    await activateTab(a, "https://example.com/combined");

    advance(26 * HOUR_MS - MINUTE_MS);
    await runReconcile(a, ae);
    assert.deepEqual(a.openUrls(), ["https://example.com/combined"], "just short of 26h");

    advance(2 * MINUTE_MS);
    await runReconcile(a, ae);
    assert.deepEqual(a.openUrls(), [], "past the combined 26h threshold");
  });
});

test("an all-zero stored threshold falls back to the 1-minute safety floor, never 0", async () => {
  await withFakeClock(1_700_000_000_000, async (advance) => {
    const world = new SimWorld();
    // Bypasses the UI's own "must be more than zero" validation —
    // simulates storage edited some other way.
    const a = world.addDevice({
      deviceName: "A",
      storage: { archiveEnabled: true, archiveIdleDays: 0, archiveIdleHours: 0, archiveIdleMinutes: 0 },
    });
    const ae = archiveEngineFor(a);

    assert.equal(await ae.archiveIdleThresholdMs(), MIN_ARCHIVE_IDLE_MS);

    await a.openTab("https://example.com/zeroed");
    await activateTab(a, "https://example.com/zeroed");
    await runReconcile(a, ae);
    assert.deepEqual(
      a.openUrls(),
      ["https://example.com/zeroed"],
      "a just-activated tab must not be archived instantly"
    );

    advance(MIN_ARCHIVE_IDLE_MS + 1);
    await runReconcile(a, ae);
    assert.deepEqual(a.openUrls(), [], "archived once past the 1-minute floor");
  });
});
