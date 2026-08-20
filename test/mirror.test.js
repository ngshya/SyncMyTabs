// Core two-device mirror behavior: open propagates, close propagates,
// closing a whole window never propagates, navigating a tab counts as
// closing the old URL and opening the new one, and profiles stay
// independent.

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

test("closing a tab on A closes it on B too, and the group is deleted once both agree", async () => {
  const world = new SimWorld();
  const a = world.addDevice({ deviceName: "A" });
  const b = world.addDevice({ deviceName: "B" });

  await a.openTab("https://example.com/");
  assert.deepEqual(b.openUrls(), ["https://example.com/"]);

  await a.closeTab("https://example.com/");
  await b.tick(); // periodic double-check; also runs cleanup

  assert.deepEqual(a.openUrls(), []);
  assert.deepEqual(b.openUrls(), []);
  assert.deepEqual(await world.allEntries("default"), []);
});

test("closing it FROM the mirroring device (B) closes it on A too", async () => {
  const world = new SimWorld();
  const a = world.addDevice({ deviceName: "A" });
  const b = world.addDevice({ deviceName: "B" });

  await a.openTab("https://example.com/");
  assert.deepEqual(b.openUrls(), ["https://example.com/"]);

  await b.closeTab("https://example.com/");
  await a.tick();

  assert.deepEqual(a.openUrls(), []);
  assert.deepEqual(b.openUrls(), []);
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

test("navigating an open tab to a new URL closes the old one and opens the new one, on both devices", async () => {
  const world = new SimWorld();
  const a = world.addDevice({ deviceName: "A" });
  const b = world.addDevice({ deviceName: "B" });

  await a.openTab("https://old.example/");
  assert.deepEqual(b.openUrls(), ["https://old.example/"]);

  await a.navigateTab("https://old.example/", "https://new.example/");
  await b.tick();

  assert.deepEqual(a.openUrls(), ["https://new.example/"]);
  assert.deepEqual(b.openUrls(), ["https://new.example/"]);

  const entries = await world.allEntries("default");
  const old = entries.filter((e) => e.real === "https://old.example/");
  const fresh = entries.filter((e) => e.real === "https://new.example/");
  assert.ok(old.every((e) => e.state === "closed"), "old URL should be closed everywhere");
  assert.ok(fresh.every((e) => e.state === "open"), "new URL should be open everywhere");
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
  assert.deepEqual(b.openUrls(), ["https://two.example/"]);
});
