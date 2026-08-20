// 3-4 device scenarios: fan-out, and "everyone must agree closed"
// before a folder is actually deleted. Closing is per-device and
// sticky (see mirror.test.js's header comment) — one device closing
// its own copy never forces another device's already-mirrored-in copy
// closed; the folder only disappears once EVERY device that ever
// weighed in shows closed.

const { test } = require("node:test");
const assert = require("node:assert/strict");
const { SimWorld } = require("./sim-env.js");

test("a tab opened on one device mirrors onto three others", async () => {
  const world = new SimWorld();
  const devices = ["A", "B", "C", "D"].map((name) =>
    world.addDevice({ deviceName: name })
  );
  const [a, b, c, d] = devices;

  await a.openTab("https://example.com/");

  for (const dev of [b, c, d]) {
    assert.deepEqual(dev.openUrls(), ["https://example.com/"], `${dev.deviceName} should mirror it`);
  }
});

test("a folder is only deleted once EVERY device that had it open closes its own copy", async () => {
  const world = new SimWorld();
  const a = world.addDevice({ deviceName: "A" });
  const b = world.addDevice({ deviceName: "B" });
  const c = world.addDevice({ deviceName: "C" });

  await a.openTab("https://example.com/");
  assert.deepEqual(b.openUrls(), ["https://example.com/"]);
  assert.deepEqual(c.openUrls(), ["https://example.com/"]);

  // A closes: B and C haven't, so their entries (and the folder)
  // survive untouched.
  await a.closeTab("https://example.com/");
  await b.tick();
  await c.tick();
  assert.notDeepEqual(await world.allEntries("default"), []);
  assert.deepEqual(b.openUrls(), ["https://example.com/"]);
  assert.deepEqual(c.openUrls(), ["https://example.com/"]);

  // B closes too: still not everyone.
  await b.closeTab("https://example.com/");
  await c.tick();
  assert.notDeepEqual(await world.allEntries("default"), []);

  // C, the last holdout, closes: now every device that ever weighed in
  // agrees closed, and the folder is deleted.
  await c.closeTab("https://example.com/");
  await a.tick();
  await b.tick();
  assert.deepEqual(await world.allEntries("default"), []);
});

test("closing a mirrored copy on ONE device leaves the other mirrored copies untouched", async () => {
  const world = new SimWorld();
  const a = world.addDevice({ deviceName: "A" });
  const b = world.addDevice({ deviceName: "B" });
  const c = world.addDevice({ deviceName: "C" });

  await a.openTab("https://example.com/");
  assert.deepEqual(b.openUrls(), ["https://example.com/"]);
  assert.deepEqual(c.openUrls(), ["https://example.com/"]);

  // B, which only ever mirrored it in, closes its own copy.
  await b.closeTab("https://example.com/");
  await a.tick();
  await c.tick();

  assert.deepEqual(
    a.openUrls(),
    ["https://example.com/"],
    "the original opener keeps its own copy"
  );
  assert.deepEqual(b.openUrls(), []);
  assert.deepEqual(
    c.openUrls(),
    ["https://example.com/"],
    "an untouched mirrored copy stays open too"
  );
});

test("a fourth device joining later mirrors in whatever's currently open", async () => {
  const world = new SimWorld();
  const a = world.addDevice({ deviceName: "A" });
  const b = world.addDevice({ deviceName: "B" });

  await a.openTab("https://example.com/");
  await a.openTab("https://another.example/");

  // C "joins" later — its first reconcile (tick) should pick up
  // everything currently open on the shared profile.
  const c = world.addDevice({ deviceName: "C" });
  await c.tick();

  assert.deepEqual(c.openUrls(), [
    "https://another.example/",
    "https://example.com/",
  ]);
});

test("four devices, mixed opens and closes, converge once everyone closes their own copy", async () => {
  const world = new SimWorld();
  const a = world.addDevice({ deviceName: "A" });
  const b = world.addDevice({ deviceName: "B" });
  const c = world.addDevice({ deviceName: "C" });
  const d = world.addDevice({ deviceName: "D" });

  await a.openTab("https://one.example/");
  await b.openTab("https://two.example/");
  await c.openTab("https://three.example/");

  for (const dev of [a, b, c, d]) {
    assert.deepEqual(
      dev.openUrls(),
      ["https://one.example/", "https://three.example/", "https://two.example/"],
      `${dev.deviceName} should see all three`
    );
  }

  // Every device mirrored "one.example" in on its own, so every device
  // needs to close its own copy before the folder goes away.
  await a.closeTab("https://one.example/");
  await b.closeTab("https://one.example/");
  await c.closeTab("https://one.example/");
  await d.closeTab("https://one.example/");
  await a.tick();

  for (const dev of [a, b, c, d]) {
    assert.deepEqual(
      dev.openUrls(),
      ["https://three.example/", "https://two.example/"],
      `${dev.deviceName} should no longer have URL one`
    );
  }
});
