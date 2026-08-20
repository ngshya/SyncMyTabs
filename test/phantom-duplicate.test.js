// Regression test for the "phantom duplicate placeholder" bug: a
// reconcile pass that isn't gated on any specific tab's load state
// (the alarm, a bookmark-change reaction) must never register a
// transient, mid-navigation URL as permanently open.

const { test } = require("node:test");
const assert = require("node:assert/strict");
const { SimWorld } = require("./sim-env.js");

test("a tab still loading is not registered as open by a concurrent alarm tick", async () => {
  const world = new SimWorld();
  const a = world.addDevice({ deviceName: "A" });
  const b = world.addDevice({ deviceName: "B" });

  // A starts navigating (e.g. mid-redirect) but hasn't completed yet.
  const tab = await a.openTabLoading("https://intermediate.example/hop");

  // Something unrelated triggers a reconcile pass on A while the tab
  // is still loading (the alarm doesn't wait for any tab in particular).
  await a.tick();

  // The intermediate/transient URL must NOT have been registered.
  const midEntries = (await world.allEntries("default")).filter(
    (e) => e.real === "https://intermediate.example/hop"
  );
  assert.deepEqual(midEntries, [], "mid-navigation URL must not be tracked");

  // Navigation completes at the real, final URL.
  await a.finishNavigation(tab.id, "https://final.example/");

  assert.deepEqual(a.openUrls(), ["https://final.example/"]);
  assert.deepEqual(b.openUrls(), ["https://final.example/"]); // B mirrors it in, as expected

  // One entry per device (A opened it, B mirrored it in) for the FINAL
  // url — and, critically, none at all for the intermediate hop (that
  // would be the phantom-duplicate bug).
  const entries = await world.allEntries("default");
  assert.deepEqual(
    entries.filter((e) => e.real === "https://intermediate.example/hop"),
    []
  );
  assert.equal(
    entries.filter((e) => e.real === "https://final.example/").length,
    2
  );
  const aOwn = await a.myEntries("default");
  assert.equal(aOwn.length, 1);
  assert.equal(aOwn[0].real, "https://final.example/");
});

test("a bookmark-event-triggered reconcile also ignores a loading tab", async () => {
  const world = new SimWorld();
  const a = world.addDevice({ deviceName: "A" });
  const b = world.addDevice({ deviceName: "B" });

  // A has a tab mid-navigation.
  const tab = await a.openTabLoading("https://intermediate.example/hop");

  // Meanwhile B opens something unrelated — this fires a bookmark
  // event that reaches A too (reconcile triggered by someone else's
  // change, not by A's own tab finishing).
  await b.openTab("https://unrelated.example/");
  await a.tick();

  const midEntries = (await world.allEntries("default")).filter(
    (e) => e.real === "https://intermediate.example/hop"
  );
  assert.deepEqual(midEntries, [], "still-loading URL must stay untracked");

  await a.finishNavigation(tab.id, "https://final.example/");
  assert.deepEqual(a.openUrls().sort(), [
    "https://final.example/",
    "https://unrelated.example/",
  ]);
});
