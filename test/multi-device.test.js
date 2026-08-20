// 3-4 device scenarios: fan-out, and "everyone must agree closed"
// before a group is actually deleted.

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

test("a group is only deleted once EVERY device that had it open agrees it's closed", async () => {
  const world = new SimWorld();
  const a = world.addDevice({ deviceName: "A" });
  const b = world.addDevice({ deviceName: "B" });
  const c = world.addDevice({ deviceName: "C" });

  await a.openTab("https://example.com/");
  assert.deepEqual(b.openUrls(), ["https://example.com/"]);
  assert.deepEqual(c.openUrls(), ["https://example.com/"]);

  // A and B close, C hasn't reacted yet in this simulation step... but
  // since propagation is instantaneous here, C mirrors A's close right
  // away too. Verify it ends up closed everywhere, and the group is
  // only removed once ALL THREE entries (A, B, C) show closed.
  await a.closeTab("https://example.com/");
  await b.tick();
  await c.tick();

  assert.deepEqual(a.openUrls(), []);
  assert.deepEqual(b.openUrls(), []);
  assert.deepEqual(c.openUrls(), []);
  assert.deepEqual(await world.allEntries("default"), []);
});

test("closing a MIRRORED copy closes it everywhere, including at the original opener", async () => {
  // This is the symmetric "true mirror" property the whole design is
  // for: it's not "only the original opener's close counts" — ANY
  // device's close (even one that only ever mirrored the tab in) wins
  // and propagates to everyone, including back to whoever opened it
  // first.
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

  assert.deepEqual(a.openUrls(), [], "the original opener must close too");
  assert.deepEqual(b.openUrls(), []);
  assert.deepEqual(c.openUrls(), []);
  assert.deepEqual(await world.allEntries("default"), []);
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

test("four devices, mixed opens and closes, converge to the same state", async () => {
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

  await a.closeTab("https://one.example/");
  await b.tick();
  await c.tick();
  await d.tick();

  for (const dev of [a, b, c, d]) {
    assert.deepEqual(
      dev.openUrls(),
      ["https://three.example/", "https://two.example/"],
      `${dev.deviceName} should no longer have URL one`
    );
  }
});
