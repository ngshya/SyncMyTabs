// Core two-device mirror behavior: open propagates, closing a whole
// window never propagates, navigating a tab counts as closing the old
// URL and opening the new one, and profiles stay independent.
//
// Close semantics: CONTAGIOUS. The moment any device's own status
// bookmark in a folder reads "closed", every other device that still
// shows "open" follows — closing its own matching tab(s) and flipping
// its own entry closed too — until every device agrees closed, at
// which point the folder is deleted.

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

test("closing a tab on A also closes B's mirrored copy, and deletes the folder", async () => {
  const world = new SimWorld();
  const a = world.addDevice({ deviceName: "A" });
  const b = world.addDevice({ deviceName: "B" });

  await a.openTab("https://example.com/");
  assert.deepEqual(b.openUrls(), ["https://example.com/"]);

  await a.closeTab("https://example.com/");
  await b.tick();

  assert.deepEqual(a.openUrls(), []);
  assert.deepEqual(b.openUrls(), [], "B must follow A's close");
  assert.deepEqual(await world.allEntries("default"), [], "the folder disappears once everyone agrees closed");
});

test("closing the mirrored copy on B forces A's original closed too", async () => {
  const world = new SimWorld();
  const a = world.addDevice({ deviceName: "A" });
  const b = world.addDevice({ deviceName: "B" });

  await a.openTab("https://example.com/");
  assert.deepEqual(b.openUrls(), ["https://example.com/"]);

  await b.closeTab("https://example.com/");
  await a.tick();

  assert.deepEqual(b.openUrls(), []);
  assert.deepEqual(a.openUrls(), [], "A must follow B's close, even though A opened it first");
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

test("navigating an open tab closes the old URL and opens the new one on that device; the other device follows the close and mirrors the new URL", async () => {
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
  assert.equal(mineA.find((e) => e.real === "https://new.example/").state, "open");

  // B follows A's close of the old URL (contagious) — since both A and
  // B end up closed, the old.example folder disappears entirely — and
  // mirrors in the new one A just opened.
  assert.deepEqual(b.openUrls(), ["https://new.example/"]);
  assert.equal(
    mineA.find((e) => e.real === "https://old.example/"),
    undefined,
    "the old URL's folder is gone once every device agrees closed"
  );
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

test("the update-tabs batch helper opens and closes in one call, and the close propagates", async () => {
  const world = new SimWorld();
  const a = world.addDevice({ deviceName: "A" });
  const b = world.addDevice({ deviceName: "B" });

  await a.updateTabs({
    open: ["https://one.example/", { url: "https://two.example/", title: "Two" }],
  });
  assert.deepEqual(b.openUrls(), ["https://one.example/", "https://two.example/"]);

  await a.updateTabs({ close: ["https://one.example/"] });
  await b.tick();

  // A closed its own copy of one.example; B's mirrored copy follows.
  assert.deepEqual(a.openUrls(), ["https://two.example/"]);
  assert.deepEqual(b.openUrls(), ["https://two.example/"]);
});
