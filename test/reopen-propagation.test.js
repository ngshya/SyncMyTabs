// Reopen propagation: the open-side mirror of reconcileMirror's close
// contagion. A device that opens/reopens a URL resets any OTHER
// device's STALE "closed" entry in that folder (deleting it so that
// device naturally re-mirrors the URL back in as open on its own next
// reconcile) — but never touches a device that's still genuinely open.
// See CLAUDE.md's resetClosedPeers section.

const { test } = require("node:test");
const assert = require("node:assert/strict");
const { SimWorld } = require("./sim-env.js");

test("reopening resets a peer that already caught the earlier close, without touching a peer that never did", async () => {
  const world = new SimWorld();
  const a = world.addDevice({ deviceName: "A" });
  const b = world.addDevice({ deviceName: "B" });
  const c = world.addDevice({ deviceName: "C" });

  await a.openTab("https://example.com/");
  assert.deepEqual(b.openUrls(), ["https://example.com/"]);
  assert.deepEqual(c.openUrls(), ["https://example.com/"]);

  // C "goes offline" right before the close — it never catches up to
  // it (simulates real bookmark-sync propagation lag: B's underlying
  // sync tool delivered A's close in time, C's didn't yet).
  world.disconnectDevice(c);

  await a.closeTab("https://example.com/");
  assert.deepEqual(b.openUrls(), [], "B, still connected, followed the close");
  assert.deepEqual(c.openUrls(), ["https://example.com/"], "C, disconnected, never saw it — untouched");

  const beforeReopen = await world.allEntries("default");
  const cEntryBefore = beforeReopen.find((e) => e.device === "C");
  assert.equal(cEntryBefore.state, "open");

  // A reopens. B (currently closed) should be reset and re-mirror in;
  // C (currently open, never closed) must be left completely alone.
  await a.openTab("https://example.com/");

  assert.deepEqual(a.openUrls(), ["https://example.com/"]);
  assert.deepEqual(b.openUrls(), ["https://example.com/"], "B re-mirrors in once its stale closed entry is reset");
  assert.deepEqual(c.openUrls(), ["https://example.com/"], "C's own tab was never touched at any point");

  const afterReopen = await world.allEntries("default");
  const cEntryAfter = afterReopen.find((e) => e.device === "C");
  assert.equal(cEntryAfter.id, cEntryBefore.id, "C's bookmark itself must never have been touched");
  assert.equal(cEntryAfter.t, cEntryBefore.t, "not even its timestamp");

  const bEntryAfter = afterReopen.find((e) => e.device === "B");
  assert.equal(bEntryAfter.state, "open");
});

test("a peer that's still open is never reset, and no forced reopen happens for it", async () => {
  const world = new SimWorld();
  const a = world.addDevice({ deviceName: "A" });
  const b = world.addDevice({ deviceName: "B" });

  await a.openTab("https://example.com/");
  assert.deepEqual(b.openUrls(), ["https://example.com/"]);

  // A closes and immediately reopens; B never closed at all, so
  // resetClosedPeers has nothing to do for B — it just stays open,
  // never receiving a delete+re-mirror round-trip.
  await a.closeTab("https://example.com/");
  await a.openTab("https://example.com/");

  const entries = await world.allEntries("default");
  const bEntry = entries.find((e) => e.device === "B");
  assert.equal(bEntry.state, "open");
  assert.deepEqual(b.openUrls(), ["https://example.com/"]);
});

test("a stale device catching up via a routine tick follows the close via contagion, without resetting the peer that closed it (no reset-and-recreate round-trip)", async () => {
  const world = new SimWorld();
  const a = world.addDevice({ deviceName: "A" });
  const b = world.addDevice({ deviceName: "B" });

  await a.openTab("https://example.com/");
  // A goes offline (stale) BEFORE B's close, so it doesn't catch it
  // via broadcast — only a later, explicit tick will.
  world.disconnectDevice(a);

  await b.closeTab("https://example.com/");
  const mid = (await world.allEntries("default")).find((e) => e.device === "B");
  assert.equal(mid.state, "closed");

  // A comes back and does a routine heartbeat/alarm check: it's still
  // "open" in its own bookmark (mine.state was never "closed", so the
  // `!mine` / genuine-reopen branches that call resetClosedPeers never
  // fire), and simply follows B's close via reconcileMirror's
  // contagion instead. If resetClosedPeers had incorrectly fired here,
  // B's bookmark would have been deleted-and-recreated (a fresh id,
  // reopening B's tab) instead of the folder just quietly finishing
  // its already-in-progress convergence to fully closed.
  await a.tick();

  assert.deepEqual(a.openUrls(), [], "A follows B's close via ordinary contagion");
  assert.deepEqual(b.openUrls(), [], "B's tab was never reopened");
  assert.deepEqual(await world.allEntries("default"), [], "folder fully closes — B's entry was never reset mid-way");
});
