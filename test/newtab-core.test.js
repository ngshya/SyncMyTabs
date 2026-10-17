// Custom new tab page, data side (newtab-core.js): this device's tabs
// across every window grouped by tab group, plus the tabs open on the
// user's other devices on the same profile. See newtab-core.js's own
// header comment.

const { test } = require("node:test");
const assert = require("node:assert/strict");
const { SimWorld } = require("./sim-env.js");
const { createNewtabEngine } = require("../newtab-core.js");

const MINUTE_MS = 60 * 1000;

function newtabEngineFor(device) {
  return createNewtabEngine(device.env, device.engine);
}

// Same helper as archive-core.test.js / ttl-cleanup.test.js.
async function withFakeClock(startTime, fn) {
  const realNow = Date.now;
  let now = startTime;
  Date.now = () => now;
  try {
    await fn((ms) => {
      now += ms;
    });
  } finally {
    Date.now = realNow;
  }
}

test("lists every window's tabs, groups first, focused window first, new tab pages left out", async () => {
  const world = new SimWorld();
  const a = world.addDevice({ deviceName: "A" });
  const nt = newtabEngineFor(a);

  const firstWindowId = a.windowsApi.defaultWindowId;
  await a.openGroupedTab("https://work.example/", "Work tab", "Work");
  await a.openTab("https://plain.example/", "Plain");
  await a.openTab("chrome://newtab/"); // native new tab URL, as Chrome reports an overridden one
  await a.openTab(a.env.runtime.getURL("newtab.html")); // the extension page itself (Firefox)

  // windowsApi.create() makes the new window the focused one.
  const second = await a.windowsApi.create({ url: "https://second.example/" });
  await a.world.flush();

  const { windows } = await nt.getLocalData();
  assert.equal(windows.length, 2);
  assert.equal(windows[0].id, second.id, "focused window comes first");
  assert.equal(windows[0].focused, true);
  assert.deepEqual(windows[0].tabs.map((t) => t.url), ["https://second.example/"]);

  const first = windows[1];
  assert.equal(first.id, firstWindowId);
  assert.deepEqual(
    first.groups.map((g) => ({ title: g.title, urls: g.tabs.map((t) => t.url) })),
    [{ title: "Work", urls: ["https://work.example/"] }]
  );
  assert.deepEqual(
    first.tabs.map((t) => t.url),
    ["https://plain.example/"],
    "both kinds of new tab page are left out of the list"
  );
});

test("a lazy-restore placeholder shows the real page it stands for", async () => {
  const world = new SimWorld();
  const a = world.addDevice({ deviceName: "A" });
  const nt = newtabEngineFor(a);

  await a.tabsApi.create({
    url: a.engine.lazyUrlFor({ url: "https://real.example/page", title: "Real page" }),
    title: "Real page",
    status: "complete",
  });
  await a.world.flush();

  const { windows } = await nt.getLocalData();
  assert.deepEqual(windows[0].tabs.map((t) => t.url), ["https://real.example/page"]);
  assert.equal(windows[0].tabs[0].title, "Real page");
});

test("favicons: only the tab's own http(s)/data: icon, never anything else", async () => {
  const world = new SimWorld();
  const a = world.addDevice({ deviceName: "A" });
  const nt = newtabEngineFor(a);

  const withIcon = await a.openTab("https://icon.example/");
  const internalIcon = await a.openTab("https://internal-icon.example/");
  await a.openTab("https://no-icon.example/");
  await a.tabsApi.update(withIcon.id, { favIconUrl: "https://icon.example/favicon.ico" });
  await a.tabsApi.update(internalIcon.id, { favIconUrl: "chrome://theme/IDR_DEFAULT_FAVICON" });

  const { windows } = await nt.getLocalData();
  const byUrl = new Map(windows[0].tabs.map((t) => [t.url, t]));
  assert.equal(byUrl.get("https://icon.example/").favIconUrl, "https://icon.example/favicon.ico");
  assert.equal(byUrl.get("https://internal-icon.example/").favIconUrl, null);
  assert.equal(byUrl.get("https://no-icon.example/").favIconUrl, null);
});

test("remote: other devices' open tabs, own device and closed entries left out, local tab linked when open here", async () => {
  await withFakeClock(1_700_000_000_000, async (advance) => {
    const world = new SimWorld();
    const a = world.addDevice({ deviceName: "A" });
    const b = world.addDevice({ deviceName: "B" });
    const nt = newtabEngineFor(a);

    await b.openTab("https://mirrored.example/", "Mirrored");
    // A mirrors it in (debounce is 0 in the simulator) — so it's open here too.
    assert.ok(a.openUrls().includes("https://mirrored.example/"));

    // From here on A stops reacting to B's changes, so B's next open is
    // NOT mirrored in here, and B's close below isn't followed here either.
    world.disconnectDevice(a);
    advance(MINUTE_MS);
    await b.openTab("https://only-on-b.example/", "Only on B");
    advance(MINUTE_MS);
    await b.openTab("https://closed-on-b.example/", "Closed on B");
    await b.closeTab("https://closed-on-b.example/");

    const remote = await nt.getRemoteData();
    assert.equal(remote.paused, false);
    assert.deepEqual(
      remote.devices.map((d) => d.name),
      ["B"],
      "this device's own entries are never listed as remote"
    );
    const tabs = remote.devices[0].tabs;
    assert.deepEqual(
      tabs.map((t) => t.url),
      ["https://only-on-b.example/", "https://mirrored.example/"],
      "most recently opened first; B's closed entry left out"
    );

    // Mirrored in as a lazy-restore placeholder (on by default), so its
    // own url is lazy.html?u=… — resolve it the same way newtab-core.js does.
    const localMirrored = (await a.tabsApi.query({})).find(
      (t) => a.engine.realUrlOfTab(t) === "https://mirrored.example/"
    );
    assert.equal(tabs[1].localTabId, localMirrored.id, "linked to the local copy");
    assert.equal(tabs[1].localWindowId, localMirrored.windowId);
    assert.equal(tabs[0].localTabId, null, "not open here — a click would open it");
  });
});

test("remote is skipped while the master sync switch is off, leaving the bookmark tree untouched", async () => {
  const world = new SimWorld();
  const a = world.addDevice({ deviceName: "A", storage: { syncEnabled: false } });
  const nt = newtabEngineFor(a);

  const before = JSON.stringify(world.root);
  const remote = await nt.getRemoteData();
  assert.equal(remote.paused, true);
  assert.deepEqual(remote.devices, []);
  assert.equal(JSON.stringify(world.root), before, "no profile folder created, nothing self-healed");
});
