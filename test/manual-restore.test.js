// Manual "restore from device" behavior: peeking at a NON-active
// profile's tabs must open them locally without ever registering them
// as this device's own contribution to that (or any) profile.

const { test } = require("node:test");
const assert = require("node:assert/strict");
const { SimWorld } = require("./sim-env.js");

test("restoring the active profile's tabs registers them normally", async () => {
  const world = new SimWorld();
  const a = world.addDevice({ deviceName: "A", activeProfile: "default" });
  const c = world.addDevice({ deviceName: "C", activeProfile: "default" });

  await a.openTab("https://example.com/");

  const entries = await a.engine.getOpenEntriesForDeviceProfile("A", "default");
  await a.engine.performAdd(entries.length ? entries : [{ url: "https://example.com/" }], {
    exemptFromTracking: false,
  });

  // C (a third device, still watching "default") should end up seeing
  // it from whichever device actually holds the live tab.
  await c.tick();
  assert.ok(c.openUrls().includes("https://example.com/"));
});

test("peeking at a non-active profile opens tabs without joining its mirror", async () => {
  const world = new SimWorld();
  const source = world.addDevice({ deviceName: "SOURCE", activeProfile: "work" });
  const viewer = world.addDevice({ deviceName: "VIEWER", activeProfile: "default" });
  const otherOnWork = world.addDevice({ deviceName: "OTHER", activeProfile: "work" });

  await source.openTab("https://work-page.example/");
  assert.deepEqual(otherOnWork.openUrls(), ["https://work-page.example/"]);
  assert.deepEqual(viewer.openUrls(), [], "viewer is on a different profile, shouldn't have it yet");

  // Viewer peeks at "work" via manual restore (MANUAL_RESTORE with a
  // non-active profile => exemptFromTracking).
  const entries = await viewer.engine.getOpenEntriesForDeviceProfile("SOURCE", "work");
  assert.equal(entries.length, 1);
  await viewer.engine.performAdd(entries, { exemptFromTracking: true });
  await viewer.world.flush();

  // The tab is genuinely open locally on viewer now...
  assert.deepEqual(viewer.openUrls(), ["https://work-page.example/"]);

  // ...but viewer must NOT have registered an entry for it (neither
  // under "default", its active profile, nor under "work").
  const viewerDefaultEntries = await viewer.myEntries("default");
  const viewerWorkEntries = await viewer.myEntries("work");
  assert.deepEqual(viewerDefaultEntries, []);
  assert.deepEqual(viewerWorkEntries, []);

  // And closing the peeked tab must not write anything either.
  await viewer.closeTab("https://work-page.example/");
  assert.deepEqual(await viewer.myEntries("work"), []);
  assert.deepEqual(await viewer.myEntries("default"), []);

  // The original "work" mirror is completely unaffected throughout.
  assert.deepEqual(otherOnWork.openUrls(), ["https://work-page.example/"]);
});
