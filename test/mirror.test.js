// Core two-device mirror behavior: open propagates, closing a whole
// window never propagates, navigating a tab counts as closing the old
// URL and opening the new one, and profiles stay independent.
//
// Close semantics: once a device has weighed in on a URL (its own
// status bookmark exists, open OR closed), only THAT device's own
// future open/close actions ever change it again — it's never
// overridden just because another device's state changed. A folder
// only disappears once EVERY device that ever weighed in shows closed.

const { test } = require("node:test");
const assert = require("node:assert/strict");
const { SimWorld } = require("./sim-env.js");

test("opening a tab on A mirrors it onto B (same profile)", async () => {
  const world = new SimWorld();
  const a = world.addDevice({ deviceName: "A" });
  const b = world.addDevice({ deviceName: "B" });

  await a.openTab("https://example.com/", "Example");

  assert.deepEqual(a.openUrls(), ["https://example.com/"]);
  assert.deepEqual(b.openUrls(), ["https://example.com/"]);
});

test("closing a tab on A does not force it closed on B once B has mirrored its own copy in", async () => {
  const world = new SimWorld();
  const a = world.addDevice({ deviceName: "A" });
  const b = world.addDevice({ deviceName: "B" });

  await a.openTab("https://example.com/");
  assert.deepEqual(b.openUrls(), ["https://example.com/"]);

  await a.closeTab("https://example.com/");
  await b.tick();

  assert.deepEqual(a.openUrls(), []);
  // B already registered its own "open" entry when it mirrored the tab
  // in — that's sticky, unaffected by A's close.
  assert.deepEqual(b.openUrls(), ["https://example.com/"]);

  // Only once B ALSO closes its own copy does every device agree
  // closed, and the whole folder disappears.
  await b.closeTab("https://example.com/");
  await a.tick();
  assert.deepEqual(await world.allEntries("default"), []);
});

test("closing the mirrored copy on B does not force A's original closed either", async () => {
  const world = new SimWorld();
  const a = world.addDevice({ deviceName: "A" });
  const b = world.addDevice({ deviceName: "B" });

  await a.openTab("https://example.com/");
  assert.deepEqual(b.openUrls(), ["https://example.com/"]);

  await b.closeTab("https://example.com/");
  await a.tick();

  assert.deepEqual(b.openUrls(), []);
  assert.deepEqual(a.openUrls(), ["https://example.com/"]);
});

test("closing a whole window (isWindowClosing) never propagates", async () => {
  const world = new SimWorld();
  const a = world.addDevice({ deviceName: "A" });
  const b = world.addDevice({ deviceName: "B" });

  await a.openTab("https://example.com/");
  assert.deepEqual(b.openUrls(), ["https://example.com/"]);

  // A's whole browser/window quits — this must NOT close the tab
  // anywhere, including on A's own next reconcile.
  await a.closeAllTabsAsWindowClosing();
  await a.tick();
  await b.tick();

  assert.deepEqual(b.openUrls(), ["https://example.com/"]);
  const mine = await a.myEntries("default");
  assert.equal(mine[0].state, "open");
});

test("navigating an open tab closes the old URL and opens the new one on that device; other devices' own tabs are unaffected", async () => {
  const world = new SimWorld();
  const a = world.addDevice({ deviceName: "A" });
  const b = world.addDevice({ deviceName: "B" });

  await a.openTab("https://old.example/");
  assert.deepEqual(b.openUrls(), ["https://old.example/"]);

  await a.navigateTab("https://old.example/", "https://new.example/");
  await b.tick();

  // A itself: old closed (gone locally), new open.
  assert.deepEqual(a.openUrls(), ["https://new.example/"]);
  const mineA = await a.myEntries("default");
  assert.equal(mineA.find((e) => e.real === "https://old.example/").state, "closed");
  assert.equal(mineA.find((e) => e.real === "https://new.example/").state, "open");

  // B's own tab never moved — A's navigation has no bearing on it. B
  // mirrors in the new URL too, but keeps its own still-genuinely-open
  // old tab (nobody told B to close it).
  assert.deepEqual(b.openUrls().sort(), [
    "https://new.example/",
    "https://old.example/",
  ]);
});

test("profiles are independent: a device on a different profile ignores the update", async () => {
  const world = new SimWorld();
  const a = world.addDevice({ deviceName: "A", activeProfile: "default" });
  const b = world.addDevice({ deviceName: "B", activeProfile: "work" });

  await a.openTab("https://example.com/");
  await b.tick();

  assert.deepEqual(a.openUrls(), ["https://example.com/"]);
  assert.deepEqual(b.openUrls(), [], "device on a different profile must not mirror");
});

test("a device that switches into the shared profile catches up immediately", async () => {
  const world = new SimWorld();
  const a = world.addDevice({ deviceName: "A", activeProfile: "default" });
  const b = world.addDevice({ deviceName: "B", activeProfile: "work" });

  await a.openTab("https://example.com/");
  assert.deepEqual(b.openUrls(), []);

  await b.switchProfile("default");
  assert.deepEqual(b.openUrls(), ["https://example.com/"]);
});

test("the update-tabs batch helper opens and closes in one call", async () => {
  const world = new SimWorld();
  const a = world.addDevice({ deviceName: "A" });
  const b = world.addDevice({ deviceName: "B" });

  await a.updateTabs({
    open: ["https://one.example/", { url: "https://two.example/", title: "Two" }],
  });
  assert.deepEqual(b.openUrls(), ["https://one.example/", "https://two.example/"]);

  await a.updateTabs({ close: ["https://one.example/"] });
  await b.tick();

  // A closed its own copy of one.example; B's own mirrored copy is
  // sticky and stays open until B closes it itself.
  assert.deepEqual(a.openUrls(), ["https://two.example/"]);
  assert.deepEqual(b.openUrls().sort(), [
    "https://one.example/",
    "https://two.example/",
  ]);
});
