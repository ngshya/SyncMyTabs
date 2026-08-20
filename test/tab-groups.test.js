// Tabs inside a browser tab group (Chrome/Brave tabGroups; feature-detected
// via `groupId`, always absent/-1 on Firefox) are intentionally invisible to
// sync in both directions: a grouped tab never gets its own bookmark entry,
// a remote open never duplicates a tab the user already has open in a group,
// and a remote close never reaches into a group to tear a tab out of it. See
// CLAUDE.md / isInTabGroup in sync-core.js.

const { test } = require("node:test");
const assert = require("node:assert/strict");
const { SimWorld } = require("./sim-env.js");

test("a tab opened directly inside a group is never synced", async () => {
  const world = new SimWorld();
  const a = world.addDevice({ deviceName: "A" });
  const b = world.addDevice({ deviceName: "B" });

  await a.openTab("https://example.com/", "Example", { groupId: 5 });

  const mine = await a.myEntries("default");
  assert.equal(
    mine.some((e) => e.real === "https://example.com/"),
    false,
    "a grouped tab must not get its own bookmark entry"
  );
  assert.deepEqual(b.openUrls(), [], "a grouped tab must never mirror to another device");
});

test("dragging an already-synced tab into a group stops tracking it (closes the entry, leaves the tab open)", async () => {
  const world = new SimWorld();
  const a = world.addDevice({ deviceName: "A" });
  const b = world.addDevice({ deviceName: "B" });

  await a.openTab("https://example.com/");
  assert.deepEqual(b.openUrls(), ["https://example.com/"]);

  // Dragging into a group fires no engine event by itself (mirrors a real
  // browser: groupId changes don't carry status "complete"). Only some
  // other live tab event triggers the checkClosed scan that notices it.
  a.setTabGroup("https://example.com/", 7);
  await a.openTab("https://dummy.example/");

  assert.ok(
    a.openUrls().includes("https://example.com/"),
    "the grouped tab itself must stay open locally"
  );
  const mine = await a.myEntries("default");
  const entry = mine.find((e) => e.real === "https://example.com/");
  assert.equal(entry.state, "closed", "no-longer-tracked entry should read as closed");

  // A's own entry now reads closed, but per the sticky close model that
  // never forces B's already-mirrored-in copy closed too — B's own status
  // bookmark is final once it exists, unaffected by A's later state.
  await b.tick();
  assert.ok(
    b.openUrls().includes("https://example.com/"),
    "B's own mirrored copy is sticky and stays open regardless of A's entry"
  );
});

test("a remote open never duplicates a tab already open locally in a group", async () => {
  const world = new SimWorld();
  const a = world.addDevice({ deviceName: "A" });
  const b = world.addDevice({ deviceName: "B" });

  await a.openTab("https://example.com/", "Example", { groupId: 3 });
  await b.openTab("https://example.com/", "Example"); // ungrouped, propagates

  const matches = a.openUrls().filter((u) => u === "https://example.com/");
  assert.equal(matches.length, 1, "must not open a second, ungrouped tab next to the grouped one");
});

test("a remote close never reaches into a local tab group", async () => {
  const world = new SimWorld();
  const a = world.addDevice({ deviceName: "A" });
  const b = world.addDevice({ deviceName: "B" });

  await a.openTab("https://example.com/", "Example", { groupId: 4 });
  await b.openTab("https://example.com/", "Example");

  await b.closeTab("https://example.com/");

  assert.ok(
    a.openUrls().includes("https://example.com/"),
    "the grouped tab must survive a remote close of the same URL"
  );
});
