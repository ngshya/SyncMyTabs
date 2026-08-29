// Tab & group order module: browser tab groups (Chrome/Brave) first,
// alphabetical by title, then every other non-pinned tab most-
// recently-active first. Opt-in, off by default. Only reorders once no
// tab anywhere has been activated for a while (idle gate, default 5
// minutes), and pauses itself for a while after a detected manual move
// (default 30 minutes). See order-core.js's own header comment.

const { test } = require("node:test");
const assert = require("node:assert/strict");
const { SimWorld } = require("./sim-env.js");
const { archiveEngineFor } = require("./archive-test-helpers.js");
const { orderEngineFor } = require("./order-test-helpers.js");

const MINUTE_MS = 60 * 1000;

// Same helper as archive-core.test.js / ttl-cleanup.test.js: runs
// `fn(advance)` with Date.now() frozen and advanceable, then always
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

async function windowUrls(device) {
  const tabs = await device.tabsApi.query({ windowId: device.windowsApi.defaultWindowId });
  return tabs.map((t) => t.url);
}

test("groups sort alphabetically at the start, then ungrouped tabs most-recently-active first", async () => {
  await withFakeClock(1_700_000_000_000, async (advance) => {
    const world = new SimWorld();
    const a = world.addDevice({ deviceName: "A", storage: { tabOrderEnabled: true } });
    const ae = archiveEngineFor(a);
    const oe = orderEngineFor(a, ae);

    // Opened in the OPPOSITE of the expected final order, so a correct
    // sort actually has to move something, not just leave things be.
    await a.openGroupedTab("https://zeta.example/", "Zeta tab", "Zeta");
    await a.openGroupedTab("https://alpha.example/", "Alpha tab", "Alpha");
    await a.openTab("https://old.example/");
    advance(MINUTE_MS);
    await a.openTab("https://mid.example/");
    advance(MINUTE_MS);
    await a.openTab("https://new.example/");

    advance(10 * MINUTE_MS); // past the default 5-minute idle gate
    await oe.reconcileOrder();

    assert.deepEqual(await windowUrls(a), [
      "https://alpha.example/",
      "https://zeta.example/",
      "https://new.example/",
      "https://mid.example/",
      "https://old.example/",
    ]);
  });
});

test("pinned tabs are never moved and stay before everything else", async () => {
  await withFakeClock(1_700_000_000_000, async (advance) => {
    const world = new SimWorld();
    const a = world.addDevice({ deviceName: "A", storage: { tabOrderEnabled: true } });
    const ae = archiveEngineFor(a);
    const oe = orderEngineFor(a, ae);

    const pinned = await a.openTab("https://pinned.example/", "Pinned", { pinned: true });
    await a.openGroupedTab("https://zeta.example/", "Zeta tab", "Zeta");
    await a.openTab("https://new.example/");

    advance(10 * MINUTE_MS);
    await oe.reconcileOrder();

    const tabs = await a.tabsApi.query({ windowId: a.windowsApi.defaultWindowId });
    assert.equal(tabs[0].id, pinned.id, "pinned tab stays first");
    assert.equal(tabs[0].index, 0);
    assert.equal(tabs[0].pinned, true, "never unpinned by this module");
  });
});

test("reconcileOrder no-ops while some tab has been activated too recently (idle gate)", async () => {
  await withFakeClock(1_700_000_000_000, async (advance) => {
    const world = new SimWorld();
    const a = world.addDevice({ deviceName: "A", storage: { tabOrderEnabled: true } });
    const ae = archiveEngineFor(a);
    const oe = orderEngineFor(a, ae);

    await a.openGroupedTab("https://zeta.example/", "Zeta tab", "Zeta");
    await a.openTab("https://new.example/"); // activates just now

    advance(2 * MINUTE_MS); // under the default 5-minute idle gate
    await oe.reconcileOrder();

    assert.deepEqual(
      await windowUrls(a),
      ["https://zeta.example/", "https://new.example/"],
      "creation order untouched — still too recently active"
    );
  });
});

test("reconcileOrder reorders once every tab has been idle past the threshold", async () => {
  await withFakeClock(1_700_000_000_000, async (advance) => {
    const world = new SimWorld();
    const a = world.addDevice({
      deviceName: "A",
      storage: { tabOrderEnabled: true, tabOrderIdleMinutes: 3 },
    });
    const ae = archiveEngineFor(a);
    const oe = orderEngineFor(a, ae);

    await a.openGroupedTab("https://zeta.example/", "Zeta tab", "Zeta");
    await a.openTab("https://new.example/");

    advance(3 * MINUTE_MS + 1);
    await oe.reconcileOrder();

    assert.deepEqual(await windowUrls(a), ["https://zeta.example/", "https://new.example/"]);
  });
});

test("reorderNow() bypasses the idle gate", async () => {
  await withFakeClock(1_700_000_000_000, async () => {
    const world = new SimWorld();
    const a = world.addDevice({ deviceName: "A", storage: { tabOrderEnabled: true } });
    const ae = archiveEngineFor(a);
    const oe = orderEngineFor(a, ae);

    await a.openGroupedTab("https://zeta.example/", "Zeta tab", "Zeta");
    await a.openGroupedTab("https://alpha.example/", "Alpha tab", "Alpha");

    // No advance() at all — activity is as fresh as it gets.
    await oe.reorderNow();

    assert.deepEqual(await windowUrls(a), ["https://alpha.example/", "https://zeta.example/"]);
  });
});

test("a detected manual move pauses automatic reordering for the configured minutes", async () => {
  await withFakeClock(1_700_000_000_000, async (advance) => {
    const world = new SimWorld();
    const a = world.addDevice({
      deviceName: "A",
      storage: { tabOrderEnabled: true, tabOrderManualPauseMinutes: 10 },
    });
    const ae = archiveEngineFor(a);
    const oe = orderEngineFor(a, ae);

    // Opened in reverse-alphabetical order, so a real reconcile pass
    // would visibly swap them — makes the "still paused, nothing moved"
    // assertion below meaningful, not just coincidentally already right.
    await a.openGroupedTab("https://zeta.example/", "Zeta tab", "Zeta");
    await a.openGroupedTab("https://alpha.example/", "Alpha tab", "Alpha");

    // Simulate the user dragging the first tab directly — a real move
    // NOT issued by order-core.js's own reconcile pass.
    const zetaTab = (await a.tabsApi.query({ windowId: a.windowsApi.defaultWindowId }))[0];
    await a.tabsApi.move(zetaTab.id, { index: 1 });
    assert.equal(await oe.isPausedFromManualMove(), true, "paused right after the manual move");

    advance(10 * MINUTE_MS - 1); // idle gate satisfied, but still (just) within the 10-minute pause window
    await oe.reconcileOrder();
    assert.equal(
      await oe.isPausedFromManualMove(),
      true,
      "still paused — reconcileOrder must not have touched anything"
    );

    advance(2); // now past the 10-minute pause too
    await oe.reconcileOrder();
    assert.deepEqual(await windowUrls(a), ["https://alpha.example/", "https://zeta.example/"]);
    assert.equal(await oe.isPausedFromManualMove(), false);
  });
});

test("reorderNow() bypasses the manual-move pause too", async () => {
  await withFakeClock(1_700_000_000_000, async () => {
    const world = new SimWorld();
    const a = world.addDevice({ deviceName: "A", storage: { tabOrderEnabled: true } });
    const ae = archiveEngineFor(a);
    const oe = orderEngineFor(a, ae);

    await a.openGroupedTab("https://zeta.example/", "Zeta tab", "Zeta");
    await a.openGroupedTab("https://alpha.example/", "Alpha tab", "Alpha");

    const zetaTab = (await a.tabsApi.query({ windowId: a.windowsApi.defaultWindowId }))[0];
    await a.tabsApi.move(zetaTab.id, { index: 1 });
    assert.equal(await oe.isPausedFromManualMove(), true);

    await oe.reorderNow();
    assert.deepEqual(await windowUrls(a), ["https://alpha.example/", "https://zeta.example/"]);
    assert.equal(
      await oe.isPausedFromManualMove(),
      false,
      "an explicit reorder-now also clears the pause for the NEXT automatic pass"
    );
  });
});

test("order-core.js's own moves never trigger its own manual-move pause", async () => {
  await withFakeClock(1_700_000_000_000, async (advance) => {
    const world = new SimWorld();
    const a = world.addDevice({ deviceName: "A", storage: { tabOrderEnabled: true } });
    const ae = archiveEngineFor(a);
    const oe = orderEngineFor(a, ae);

    await a.openGroupedTab("https://zeta.example/", "Zeta tab", "Zeta");
    await a.openGroupedTab("https://alpha.example/", "Alpha tab", "Alpha");
    await a.openTab("https://new.example/");

    advance(10 * MINUTE_MS);
    await oe.reconcileOrder(); // issues real tabGroups.move()/tabs.move() calls

    assert.equal(await oe.isPausedFromManualMove(), false, "own moves must not self-pause");
  });
});

test("master syncEnabled=false pauses order-core.js too", async () => {
  await withFakeClock(1_700_000_000_000, async (advance) => {
    const world = new SimWorld();
    const a = world.addDevice({
      deviceName: "A",
      storage: { tabOrderEnabled: true, syncEnabled: false },
    });
    const ae = archiveEngineFor(a);
    const oe = orderEngineFor(a, ae);

    await a.openGroupedTab("https://zeta.example/", "Zeta tab", "Zeta");
    await a.openGroupedTab("https://alpha.example/", "Alpha tab", "Alpha");

    advance(10 * MINUTE_MS);
    await oe.reconcileOrder();

    assert.deepEqual(await windowUrls(a), ["https://zeta.example/", "https://alpha.example/"]);
  });
});

test("tabOrderEnabled=false (default) never reorders", async () => {
  await withFakeClock(1_700_000_000_000, async (advance) => {
    const world = new SimWorld();
    const a = world.addDevice({ deviceName: "A" }); // no override — exercises the default
    const ae = archiveEngineFor(a);
    const oe = orderEngineFor(a, ae);

    await a.openGroupedTab("https://zeta.example/", "Zeta tab", "Zeta");
    await a.openGroupedTab("https://alpha.example/", "Alpha tab", "Alpha");

    advance(10 * MINUTE_MS);
    await oe.reconcileOrder();

    assert.deepEqual(await windowUrls(a), ["https://zeta.example/", "https://alpha.example/"]);
  });
});

test("with no tabGroups API at all (Firefox), every non-pinned tab is sorted by recency", async () => {
  await withFakeClock(1_700_000_000_000, async (advance) => {
    const world = new SimWorld();
    const a = world.addDevice({ deviceName: "A", storage: { tabOrderEnabled: true } });
    const ae = archiveEngineFor(a);
    const oe = orderEngineFor(a, ae);
    delete a.env.tabGroups; // simulate Firefox: no tabGroups API exposed at all

    await a.openTab("https://old.example/");
    advance(MINUTE_MS);
    await a.openTab("https://new.example/");

    advance(10 * MINUTE_MS);
    await oe.reconcileOrder();

    assert.deepEqual(await windowUrls(a), ["https://new.example/", "https://old.example/"]);
  });
});

test("each window is reordered independently", async () => {
  await withFakeClock(1_700_000_000_000, async (advance) => {
    const world = new SimWorld();
    const a = world.addDevice({ deviceName: "A", storage: { tabOrderEnabled: true } });
    const ae = archiveEngineFor(a);
    const oe = orderEngineFor(a, ae);

    const firstWindowId = a.windowsApi.defaultWindowId;
    await a.openGroupedTab("https://zeta.example/", "Zeta tab", "Zeta");
    await a.openGroupedTab("https://alpha.example/", "Alpha tab", "Alpha");

    // windowsApi.create() simulates a new window taking OS focus (like a
    // real browser), which is why firstWindowId was captured up front —
    // a.windowsApi.defaultWindowId now points at this second window.
    const secondWindow = await a.windowsApi.create({ url: "https://second-window.example/" });
    await a.tabsApi.create({
      url: "https://second-window-b.example/",
      windowId: secondWindow.id,
      active: false,
      status: "complete",
    });
    // A raw tabsApi.create() call, unlike SimDevice.openTab(), doesn't
    // flush world.pending itself — without this, archive-core.js's own
    // (fire-and-forget-queued) activity recording for this tab can
    // still be mid-flight when advance() below runs, recording Date.now()
    // AFTER the advance instead of before, which would make the idle
    // gate think activity is still fresh.
    await a.world.flush();

    advance(10 * MINUTE_MS);
    await oe.reconcileOrder();

    const firstWindowTabs = await a.tabsApi.query({ windowId: firstWindowId });
    assert.deepEqual(
      firstWindowTabs.map((t) => t.url),
      ["https://alpha.example/", "https://zeta.example/"]
    );
    const secondWindowTabs = await a.tabsApi.query({ windowId: secondWindow.id });
    assert.equal(secondWindowTabs.length, 2, "second window untouched in tab count");
  });
});
