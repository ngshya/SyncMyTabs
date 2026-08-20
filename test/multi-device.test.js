// 3-4 device scenarios: fan-out, and contagious close. Closing is
// CONTAGIOUS (see mirror.test.js's header comment): the moment ANY
// device's own entry in a folder reads "closed", every other device
// that still shows "open" follows suit — closing its own matching
// tab(s) and flipping its own entry closed too — until every device
// agrees closed, at which point the folder is deleted.

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

test("ANY single device closing forces every other device closed too, and deletes the folder", async () => {
  const world = new SimWorld();
  const a = world.addDevice({ deviceName: "A" });
  const b = world.addDevice({ deviceName: "B" });
  const c = world.addDevice({ deviceName: "C" });

  await a.openTab("https://example.com/");
  assert.deepEqual(b.openUrls(), ["https://example.com/"]);
  assert.deepEqual(c.openUrls(), ["https://example.com/"]);

  // A closes: B and C follow, even though neither of them acted
  // locally — a single close is enough to bring everyone down.
  await a.closeTab("https://example.com/");
  await b.tick();
  await c.tick();

  assert.deepEqual(b.openUrls(), []);
  assert.deepEqual(c.openUrls(), []);
  assert.deepEqual(await world.allEntries("default"), [], "the folder is gone once everyone agrees closed");
});

test("closing a mirrored copy on ONE device forces every other mirrored copy closed too", async () => {
  const world = new SimWorld();
  const a = world.addDevice({ deviceName: "A" });
  const b = world.addDevice({ deviceName: "B" });
  const c = world.addDevice({ deviceName: "C" });

  await a.openTab("https://example.com/");
  assert.deepEqual(b.openUrls(), ["https://example.com/"]);
  assert.deepEqual(c.openUrls(), ["https://example.com/"]);

  // B, which only ever mirrored it in, closes its own copy — this is
  // enough to bring down A's original and C's mirrored copy too.
  await b.closeTab("https://example.com/");
  await a.tick();
  await c.tick();

  assert.deepEqual(a.openUrls(), [], "even the original opener follows a remote close");
  assert.deepEqual(b.openUrls(), []);
  assert.deepEqual(c.openUrls(), [], "an untouched mirrored copy follows too");
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

test("four devices, mixed opens: closing just ONE of the shared URLs on one device closes it everywhere, others untouched", async () => {
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

  // Only A closes its copy of one.example — that alone is enough to
  // close it everywhere, without any other device acting.
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
