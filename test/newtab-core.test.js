// Custom new tab page, data side (newtab-core.js): this device's tabs
// across every window grouped by tab group, the bookmarks bar, and the
// recently auto-archived tabs. See newtab-core.js's own
// header comment.

const { test } = require("node:test");
const assert = require("node:assert/strict");
const { SimWorld } = require("./sim-env.js");
const { createNewtabEngine } = require("../newtab-core.js");

const MINUTE_MS = 60 * 1000;

function newtabEngineFor(device) {
  return createNewtabEngine(device.env, device.engine);
}

// A window's entries as a compact, readable shape: "url" for a plain tab,
// { group: title, collapsed, urls: [...] } for a tab group.
function layout(win) {
  return win.entries.map((e) =>
    e.kind === "tab"
      ? e.tab.url
      : { group: e.group.title, collapsed: e.group.collapsed, urls: e.group.tabs.map((t) => t.url) }
  );
}

// Every tab view in a window, grouped or not, in order.
function allTabs(win) {
  return win.entries.flatMap((e) => (e.kind === "tab" ? [e.tab] : e.group.tabs));
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

test("lists every window's tabs, focused window first, new tab pages left out", async () => {
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
  assert.deepEqual(layout(windows[0]), ["https://second.example/"]);

  const first = windows[1];
  assert.equal(first.id, firstWindowId);
  assert.deepEqual(
    layout(first),
    [{ group: "Work", collapsed: false, urls: ["https://work.example/"] }, "https://plain.example/"],
    "both kinds of new tab page are left out of the list"
  );
});

test("entries follow the browser's tab strip exactly: a group sits where its tabs are, between ungrouped ones", async () => {
  const world = new SimWorld();
  const a = world.addDevice({ deviceName: "A" });
  const nt = newtabEngineFor(a);

  await a.openTab("https://before.example/");
  await a.openGroupedTab("https://g1.example/", "G1", "Work");
  await a.openTab("https://between.example/");
  await a.openGroupedTab("https://h1.example/", "H1", "Play");
  // A second tab opened INTO "Work" lands right after its last member,
  // like the real strip — before "between", not at the end.
  await a.openGroupedTab("https://g2.example/", "G2", "Work");
  await a.openTab("https://after.example/");

  const { windows } = await nt.getLocalData();
  assert.deepEqual(layout(windows[0]), [
    "https://before.example/",
    { group: "Work", collapsed: false, urls: ["https://g1.example/", "https://g2.example/"] },
    "https://between.example/",
    { group: "Play", collapsed: false, urls: ["https://h1.example/"] },
    "https://after.example/",
  ]);
});

test("a group collapsed in the browser comes through as collapsed", async () => {
  const world = new SimWorld();
  const a = world.addDevice({ deviceName: "A" });
  const nt = newtabEngineFor(a);

  await a.openGroupedTab("https://open.example/", "Open", "Open group");
  await a.openGroupedTab("https://folded.example/", "Folded", "Folded group");
  const foldedId = a.ensureOpenGroup("Folded group");
  await a.tabGroupsApi.update(foldedId, { collapsed: true });

  const { windows } = await nt.getLocalData();
  assert.deepEqual(
    layout(windows[0]).map((e) => [e.group, e.collapsed]),
    [
      ["Open group", false],
      ["Folded group", true],
    ]
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
  assert.deepEqual(allTabs(windows[0]).map((t) => t.url), ["https://real.example/page"]);
  assert.equal(allTabs(windows[0])[0].title, "Real page");
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
  const byUrl = new Map(allTabs(windows[0]).map((t) => [t.url, t]));
  assert.equal(byUrl.get("https://icon.example/").favIconUrl, "https://icon.example/favicon.ico");
  assert.equal(byUrl.get("https://internal-icon.example/").favIconUrl, null);
  assert.equal(byUrl.get("https://no-icon.example/").favIconUrl, null);
});

// ---- bookmarks bar ----

// Adds a top-level bookmarks-bar folder the way each browser has one.
function addBar(world, { id = "1", folderType } = {}) {
  const bar = { id, parentId: "0", title: "Bookmarks bar", children: [] };
  if (folderType) bar.folderType = folderType;
  world.root.children.unshift(bar);
  return bar;
}

test("bookmarks bar: contents in order, folders nested, bookmarklets left out", async () => {
  const world = new SimWorld();
  const a = world.addDevice({ deviceName: "A" });
  const nt = newtabEngineFor(a);
  const bar = addBar(world);

  await a.env.bookmarks.create({ parentId: bar.id, title: "Mail", url: "https://mail.example/" });
  const folder = await a.env.bookmarks.create({ parentId: bar.id, title: "Work" });
  await a.env.bookmarks.create({ parentId: folder.id, title: "Docs", url: "https://docs.example/" });
  const inner = await a.env.bookmarks.create({ parentId: folder.id, title: "Deep" });
  await a.env.bookmarks.create({ parentId: inner.id, title: "Wiki", url: "https://wiki.example/" });
  await a.env.bookmarks.create({ parentId: bar.id, title: "Bookmarklet", url: "javascript:alert(1)" });
  await a.env.bookmarks.create({ parentId: bar.id, title: "News", url: "https://news.example/" });

  const shape = (n) => (n.kind === "folder" ? { [n.title]: n.children.map(shape) } : n.title);
  const { bar: data } = await nt.getBookmarksBar();
  assert.deepEqual(data.children.map(shape), ["Mail", { Work: ["Docs", { Deep: ["Wiki"] }] }, "News"]);
});

test("bookmarks bar is found by folderType, or by Firefox's id — and is null when there's none", async () => {
  const chrome = new SimWorld();
  const c = chrome.addDevice({ deviceName: "C" });
  addBar(chrome, { id: "42", folderType: "bookmarks-bar" });
  await c.env.bookmarks.create({ parentId: "42", title: "X", url: "https://x.example/" });
  assert.deepEqual((await newtabEngineFor(c).getBookmarksBar()).bar.children.map((n) => n.title), ["X"]);

  const firefox = new SimWorld();
  const f = firefox.addDevice({ deviceName: "F" });
  const toolbar = addBar(firefox, { id: "toolbar_____" });
  toolbar.children.push({ id: "sep1", parentId: "toolbar_____", type: "separator", title: "" });
  await f.env.bookmarks.create({ parentId: "toolbar_____", title: "Y", url: "https://y.example/" });
  assert.deepEqual(
    (await newtabEngineFor(f).getBookmarksBar()).bar.children.map((n) => n.kind),
    ["separator", "bookmark"]
  );

  const none = new SimWorld();
  const n = none.addDevice({ deviceName: "N" });
  assert.equal((await newtabEngineFor(n).getBookmarksBar()).bar, null);
});

test("bookmarks bar icons: an open tab's own favicon for that page or site, nothing otherwise", async () => {
  const world = new SimWorld();
  const a = world.addDevice({ deviceName: "A" });
  const nt = newtabEngineFor(a);
  const bar = addBar(world);

  const exact = await a.openTab("https://site.example/page");
  await a.tabsApi.update(exact.id, { favIconUrl: "https://site.example/favicon.ico" });
  await a.env.bookmarks.create({ parentId: bar.id, title: "Same page", url: "https://site.example/page" });
  await a.env.bookmarks.create({ parentId: bar.id, title: "Same site", url: "https://site.example/other" });
  await a.env.bookmarks.create({ parentId: bar.id, title: "Elsewhere", url: "https://elsewhere.example/" });

  const icons = (await nt.getBookmarksBar()).bar.children.map((b) => [b.title, b.favIconUrl]);
  assert.deepEqual(icons, [
    ["Same page", "https://site.example/favicon.ico"],
    ["Same site", "https://site.example/favicon.ico"],
    ["Elsewhere", null],
  ]);
});

test("NEWTAB_BOOKMARKS is answered; the bar is never written to", async () => {
  const world = new SimWorld();
  const a = world.addDevice({ deviceName: "A" });
  const nt = newtabEngineFor(a);
  addBar(world);
  const before = JSON.stringify(world.root.children[0]);
  const reply = await nt.handleMessage({ type: "NEWTAB_BOOKMARKS" });
  assert.deepEqual(reply.bar.children, []);
  assert.equal(JSON.stringify(world.root.children[0]), before);
});

// ---- recently auto-archived tabs ----

const { createArchiveEngine, ARCHIVE_ROOT_TITLE } = require("../archive-core.js");

// Archives `url` the way archive-core.js does (its own archiveTab, via a
// tab that has gone idle), `daysAgo` days before `now`.
async function archiveAt(device, now, daysAgo, url, title) {
  const realNow = Date.now;
  Date.now = () => now - daysAgo * 24 * 60 * MINUTE_MS;
  try {
    const tab = await device.openTab(url, title);
    const archive = createArchiveEngine(device.env, device.engine);
    await device.env.storage.local.set({ archiveIdleDays: 0, archiveIdleHours: 0, archiveIdleMinutes: 1 });
    await archive.handleStartupSeed();
    Date.now = () => now - daysAgo * 24 * 60 * MINUTE_MS + 2 * MINUTE_MS;
    await archive.reconcileArchive();
    await device.world.flush();
    assert.ok(!(await device.tabsApi.query({})).some((t) => t.id === tab.id), `${url} archived and closed`);
  } finally {
    Date.now = realNow;
  }
}

test("archived: the folder title is archive-core.js's own", () => {
  const world = new SimWorld();
  const a = world.addDevice({ deviceName: "A" });
  assert.equal(newtabEngineFor(a).ARCHIVE_FOLDER_TITLE, ARCHIVE_ROOT_TITLE);
});

test("archived: last n calendar days, newest day first, newest first within a day", async () => {
  const now = new Date(2026, 9, 17, 12, 0).getTime();
  const world = new SimWorld();
  const a = world.addDevice({ deviceName: "A" });
  const nt = newtabEngineFor(a);

  await archiveAt(a, now, 0, "https://today-1.example/", "Today 1");
  await archiveAt(a, now, 0, "https://today-2.example/", "Today 2");
  await archiveAt(a, now, 1, "https://yesterday.example/", "Yesterday");
  await archiveAt(a, now, 6, "https://six-days.example/", "Six days ago");
  await archiveAt(a, now, 7, "https://seven-days.example/", "Seven days ago");
  await archiveAt(a, now, 40, "https://last-month.example/", "Last month");

  await withFakeClock(now, async () => {
    const shape = (data) => data.days.map((d) => [d.date, d.tabs.map((t) => t.title)]);
    assert.deepEqual(shape(await nt.getArchivedData(7)), [
      ["2026-10-17", ["Today 2", "Today 1"]],
      ["2026-10-16", ["Yesterday"]],
      ["2026-10-11", ["Six days ago"]],
    ]);
    assert.deepEqual(shape(await nt.getArchivedData(1)), [["2026-10-17", ["Today 2", "Today 1"]]]);
    assert.equal((await nt.getArchivedData(60)).days.length, 5, "a longer window reaches last month");
    assert.equal((await nt.getArchivedData("junk")).days.length, 3, "an invalid value falls back to 7 days");
    const reply = await nt.handleMessage({ type: "NEWTAB_ARCHIVED", days: 2 });
    assert.deepEqual(shape(reply).map(([d]) => d), ["2026-10-17", "2026-10-16"]);
  });
});

test("archived: a URL archived twice shows once, on its latest day; one open again here is left out", async () => {
  const now = new Date(2026, 9, 17, 12, 0).getTime();
  const world = new SimWorld();
  const a = world.addDevice({ deviceName: "A" });
  const nt = newtabEngineFor(a);

  await archiveAt(a, now, 3, "https://twice.example/", "Twice");
  await archiveAt(a, now, 1, "https://twice.example/", "Twice");
  await archiveAt(a, now, 1, "https://reopened.example/", "Reopened");

  await withFakeClock(now, async () => {
    const before = await nt.getArchivedData(7);
    assert.deepEqual(
      before.days.map((d) => [d.date, d.tabs.map((t) => t.url)]),
      [["2026-10-16", ["https://reopened.example/", "https://twice.example/"]]]
    );
    await a.openTab("https://reopened.example/", "Reopened");
    const after = await nt.getArchivedData(7);
    assert.deepEqual(after.days[0].tabs.map((t) => t.url), ["https://twice.example/"]);
  });
});

test("archived: covers what other devices archived on the same profile, and never writes", async () => {
  const now = new Date(2026, 9, 17, 12, 0).getTime();
  const world = new SimWorld();
  const a = world.addDevice({ deviceName: "A" });
  const b = world.addDevice({ deviceName: "B" });
  await archiveAt(b, now, 0, "https://from-b.example/", "From B");

  await withFakeClock(now, async () => {
    const before = JSON.stringify(world.root);
    const data = await newtabEngineFor(a).getArchivedData(7);
    assert.deepEqual(data.days[0].tabs.map((t) => t.title), ["From B"]);
    assert.equal(JSON.stringify(world.root), before, "read-only");
  });
});

test("archived: skipped while sync is paused, bookmark tree untouched", async () => {
  const world = new SimWorld();
  const a = world.addDevice({ deviceName: "A", storage: { syncEnabled: false } });
  const before = JSON.stringify(world.root);
  assert.deepEqual(await newtabEngineFor(a).getArchivedData(7), { paused: true, days: [] });
  assert.equal(JSON.stringify(world.root), before);
});
