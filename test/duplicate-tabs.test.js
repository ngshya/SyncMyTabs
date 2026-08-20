// closeMyDuplicateTabs: an opt-in cleanup (default OFF, since closing a
// tab is destructive) that closes this device's own EXTRA local tabs
// sharing the exact same real URL, keeping the leftmost. Wired into the
// periodic alarm and the explicit "Sync now" action — never startup, and
// never inferred from a tab's absence (see sync-core.js's own comment).

const { test } = require("node:test");
const assert = require("node:assert/strict");
const { SimWorld } = require("./sim-env.js");

test("closeDuplicateTabs=false (default) leaves duplicate tabs alone", async () => {
  const world = new SimWorld();
  const a = world.addDevice({ deviceName: "A" });

  await a.openTab("https://example.com/");
  await a.openTab("https://example.com/"); // a second, genuine duplicate tab
  assert.equal(a.tabsApi.tabs.size, 2);

  await a.tick();
  assert.equal(a.tabsApi.tabs.size, 2, "no tab should have been closed by default");
});

test("closeDuplicateTabs=true closes the extra tab(s), keeping the leftmost", async () => {
  const world = new SimWorld();
  const a = world.addDevice({
    deviceName: "A",
    storage: { closeDuplicateTabs: true },
  });

  const first = await a.openTab("https://example.com/");
  await a.openTab("https://example.com/");
  await a.openTab("https://example.com/");
  assert.equal(a.tabsApi.tabs.size, 3);

  await a.tick();

  const remaining = Array.from(a.tabsApi.tabs.values());
  assert.equal(remaining.length, 1, "only one copy should survive");
  assert.equal(remaining[0].id, first.id, "the leftmost (first-created) tab survives");
});

test("closeDuplicateTabs=true leaves DIFFERENT URLs alone", async () => {
  const world = new SimWorld();
  const a = world.addDevice({
    deviceName: "A",
    storage: { closeDuplicateTabs: true },
  });

  await a.openTab("https://one.example/");
  await a.openTab("https://two.example/");
  assert.equal(a.tabsApi.tabs.size, 2);

  await a.tick();
  assert.equal(a.tabsApi.tabs.size, 2, "distinct URLs are never touched");
});

test("closeDuplicateTabs=true never touches pinned or grouped duplicates", async () => {
  const world = new SimWorld();
  const a = world.addDevice({
    deviceName: "A",
    storage: { closeDuplicateTabs: true },
  });

  await a.tabsApi.create({ url: "https://example.com/", status: "complete", pinned: true });
  await a.tabsApi.create({ url: "https://example.com/", status: "complete", pinned: true });
  await a.openGroupedTab("https://grouped.example/", "G1", "Work");
  await a.openGroupedTab("https://grouped.example/", "G2", "Work");
  assert.equal(a.tabsApi.tabs.size, 4);

  await a.tick();
  assert.equal(a.tabsApi.tabs.size, 4, "pinned/grouped tabs are entirely outside this check");
});

test("closeDuplicateTabs=true survives a mid-navigation (loading) tab without miscounting it", async () => {
  const world = new SimWorld();
  const a = world.addDevice({
    deviceName: "A",
    storage: { closeDuplicateTabs: true },
  });

  await a.openTab("https://example.com/");
  await a.openTabLoading("https://example.com/"); // still "loading", not complete
  assert.equal(a.tabsApi.tabs.size, 2);

  await a.tick();
  assert.equal(a.tabsApi.tabs.size, 2, "a loading tab is never counted as a duplicate, complete or not");
});

test("closeDuplicateTabs=true also runs from Sync now (handleSyncNow)", async () => {
  const world = new SimWorld();
  const a = world.addDevice({
    deviceName: "A",
    storage: { closeDuplicateTabs: true },
  });

  await a.openTab("https://example.com/");
  await a.openTab("https://example.com/");
  assert.equal(a.tabsApi.tabs.size, 2);

  await a.syncNow();
  assert.equal(a.tabsApi.tabs.size, 1);
});
