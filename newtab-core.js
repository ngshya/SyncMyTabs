// ============================================================
// SyncMyTabs - newtab-core.js
//
// Independent module: the data side of the custom new tab page
// (newtab.html/newtab.js, wired via manifest.json's
// chrome_url_overrides.newtab). Assembles what the page shows — this
// device's open tabs across every window, grouped by browser tab group
// (Chrome/Brave), plus the tabs open on the user's OTHER devices on the
// same active profile, read from the same synced bookmark tree
// sync-core.js maintains. The page itself stays a thin DOM layer that
// only renders this and calls tabs.update/windows.update on click.
//
// Routed through background.js messages (NEWTAB_LOCAL/NEWTAB_REMOTE/…)
// rather than the page building its own engine: the remote half goes
// through readProfileEntries, which self-heals duplicate folders with
// real bookmark writes — a second sync-core.js engine instance living
// in every open new tab page would mean concurrent, un-serialized
// writers on the same tree. One engine, in the background, is the only
// one that ever writes.
//
// Parameterized the same way as the other modules: takes `env` PLUS the
// already-created sync engine instance (`syncEngine`). Plain script, no
// import/export syntax — loaded via importScripts/background.scripts
// like the other modules; module.exports at the bottom is a Node-only
// no-op elsewhere.
//
// Self-contained on purpose: nothing in sync-core.js, groups-core.js,
// archive-core.js or order-core.js knows this module exists. It only
// READS through the existing syncEngine API below, background.js wires
// it with its own separate onMessage listener (handleMessage), and
// knowledge of what a new tab page even is (isNewTabPageUrl) lives here
// and nowhere else.
//
// Also reads the browser's own bookmarks bar (getBookmarksBar) for the
// page's optional copy of it, and the profile's auto-archive folder
// (getArchivedData) for its "recently archived" section — both read-only.
//
// CONTRACT with sync-core.js: this module reuses exactly
// syncEngine.realUrlOfTab() / .isSyncEnabled() / .getActiveProfile() /
// .getOrCreateProfileFolder() / .readProfileEntries() and nothing else.
//
// See docs/newtab-core.md for the full invariants (why remote data is
// skipped while sync is paused, favicon handling, …) — this file's own
// comments carry the same detail near the relevant function; the doc is
// the compact index into it.
//
// Cross-browser note: tabGroups is Chrome/Brave-only (see CLAUDE.md's
// Cross-browser support section). Without it, every tab simply lands in
// its window's ungrouped list — no special-casing needed below.
// ============================================================

// URLs a tab can report while it's sitting on a new tab page —
// including one this extension's own newtab.html override is rendering:
// depending on the browser, tabs.query() reports either the native
// new-tab URL (Chrome/Brave keep `chrome://newtab/` for an overridden new
// tab) or the extension page's own URL (`extensionNewtabUrl`, e.g.
// moz-extension://…/newtab.html on Firefox) — both are matched, so this
// doesn't depend on which one a given browser picks. Used to keep new
// tab pages (this one included) out of the page's own tab list.
const NATIVE_NEWTAB_URLS = [
  "chrome://newtab/",
  "chrome://new-tab-page/",
  "about:newtab",
  "about:home",
  "edge://newtab/",
];

function isNewTabPageUrl(url, extensionNewtabUrl) {
  if (!url) return false;
  if (NATIVE_NEWTAB_URLS.includes(url)) return true;
  return !!extensionNewtabUrl && url.startsWith(extensionNewtabUrl);
}

function createNewtabEngine(env, syncEngine) {
  const TAB_GROUP_ID_NONE = -1;
  const NEWTAB_PAGE = env.runtime.getURL("newtab.html");

  function isNewTabPage(tab) {
    return isNewTabPageUrl((tab && (tab.url || tab.pendingUrl)) || "", NEWTAB_PAGE);
  }

  function isGrouped(tab) {
    return typeof tab.groupId === "number" && tab.groupId !== TAB_GROUP_ID_NONE;
  }

  // Only a favicon the browser itself already loaded FOR THAT TAB (an
  // http(s) or inline data: image URL) — never a third-party favicon
  // service (google.com/s2/favicons and the like), which would leak every
  // open tab's domain off-device and break PRIVACY.md's "nothing leaves
  // your device" promise. Anything else (chrome://, an extension's own
  // icon, nothing at all) → null, and the page draws a plain letter
  // placeholder instead.
  function safeFaviconUrl(u) {
    if (!u) return null;
    if (/^https?:\/\//.test(u) || u.startsWith("data:image/")) return u;
    return null;
  }

  function tabView(tab) {
    const url = syncEngine.realUrlOfTab(tab);
    return {
      id: tab.id,
      windowId: tab.windowId,
      title: tab.title || url,
      url,
      favIconUrl: safeFaviconUrl(tab.favIconUrl),
      active: !!tab.active,
      pinned: !!tab.pinned,
    };
  }

  // This device's open tabs, every window, in EXACTLY the browser's own
  // tab-strip order: each window is one `entries` list where a browser tab
  // group appears as a single `{ kind: "group" }` entry at the position of
  // its first tab (holding its own tabs, in order), and every other tab as
  // a `{ kind: "tab" }` entry where it sits — so ungrouped tabs between two
  // groups stay between them, and pinned tabs come first because that's
  // where the strip keeps them. Each group carries the browser's own
  // `collapsed` state (false on Firefox, which has no tab groups), which
  // the page uses as its default fold state. New tab pages — this one and
  // any other — are left out; a new tab page listing itself would just be
  // noise. The focused window comes first, then the rest by window id.
  async function getLocalData() {
    const allTabs = (await env.tabs.query({}))
      .slice()
      .sort((a, b) => (a.index || 0) - (b.index || 0));

    const groupsById = new Map();
    if (env.tabGroups) {
      try {
        for (const g of await env.tabGroups.query({})) groupsById.set(g.id, g);
      } catch (e) {}
    }

    let focusedWindowId = null;
    try {
      const w = await env.windows.getLastFocused({ windowTypes: ["normal"] });
      focusedWindowId = w && w.id;
    } catch (e) {}

    const byWindow = new Map();
    for (const t of allTabs) {
      if (isNewTabPage(t)) continue;
      let win = byWindow.get(t.windowId);
      if (!win) {
        win = { id: t.windowId, focused: t.windowId === focusedWindowId, entries: [], groupIndex: new Map() };
        byWindow.set(t.windowId, win);
      }
      const view = tabView(t);
      if (isGrouped(t) && groupsById.has(t.groupId)) {
        let group = win.groupIndex.get(t.groupId);
        if (!group) {
          const info = groupsById.get(t.groupId);
          group = {
            id: info.id,
            title: info.title || "",
            color: info.color || "grey",
            collapsed: !!info.collapsed,
            tabs: [],
          };
          win.groupIndex.set(t.groupId, group);
          win.entries.push({ kind: "group", group });
        }
        group.tabs.push(view);
      } else {
        win.entries.push({ kind: "tab", tab: view });
      }
    }

    const windows = Array.from(byWindow.values()).map(({ groupIndex, ...w }) => w);
    windows.sort(
      (a, b) => Number(b.focused) - Number(a.focused) || String(a.id).localeCompare(String(b.id), undefined, { numeric: true })
    );
    return { windows };
  }

  // Tabs open on the user's OTHER devices, same active profile, read
  // from the synced bookmark tree — one list per device (alphabetical),
  // most recently opened first. Each entry carries `localTabId`/
  // `localWindowId` when the same URL is also open on THIS device, so a
  // click can switch to it rather than opening a duplicate — which, with
  // sync running normally, is most of them: sync-core.js mirrors every
  // remote open in here anyway, so this section is mainly a "what's open
  // on which device" view, and the not-yet-mirrored cases (still inside
  // MIRROR_OPEN_DEBOUNCE_MS, say) are the ones a click actually opens.
  //
  // Skipped entirely while the master sync switch is off: going through
  // readProfileEntries/getOrCreateProfileFolder can write to the
  // bookmark tree (self-healing a duplicate folder, creating a missing
  // profile folder), and "while paused, nothing touches bookmarks in
  // either direction" is the master switch's whole contract — see
  // runReconcile's own comment in sync-core.js.
  async function getRemoteData() {
    if (!(await syncEngine.isSyncEnabled())) return { paused: true, profile: null, devices: [] };

    const { deviceName } = await env.storage.local.get("deviceName");
    const profile = await syncEngine.getActiveProfile();
    const profileFolder = await syncEngine.getOrCreateProfileFolder(profile);
    const entries = await syncEngine.readProfileEntries(profileFolder.id);

    const localByUrl = new Map();
    for (const t of await env.tabs.query({})) {
      if (isNewTabPage(t)) continue;
      const u = syncEngine.realUrlOfTab(t);
      if (!localByUrl.has(u)) localByUrl.set(u, t);
    }

    const byDevice = new Map();
    for (const [url, folder] of entries) {
      for (const [name, list] of folder.devices) {
        if (name === deviceName) continue;
        const open = list.find((e) => e.state === "open");
        if (!open) continue;
        const local = localByUrl.get(url);
        if (!byDevice.has(name)) byDevice.set(name, []);
        byDevice.get(name).push({
          url,
          title: folder.folderTitle || url,
          t: open.t,
          localTabId: local ? local.id : null,
          localWindowId: local ? local.windowId : null,
          // Only when the same page is also open HERE: that tab's own,
          // already-loaded icon (same safeFaviconUrl rule). Never fetched
          // for a remote-only tab — the page shows a letter instead.
          favIconUrl: local ? safeFaviconUrl(local.favIconUrl) : null,
        });
      }
    }

    const devices = Array.from(byDevice.entries())
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([name, tabs]) => ({ name, tabs: tabs.sort((a, b) => b.t - a.t) }));
    return { paused: false, profile, devices };
  }

  // ---- recently auto-archived tabs ----

  // archive-core.js's ARCHIVE_ROOT_TITLE, repeated here rather than read
  // from it so this module keeps depending on syncEngine alone (scoped
  // inside this function, so no clash with archive-core.js's global in
  // the shared background scope); test/newtab-core.test.js checks the two
  // still agree.
  const ARCHIVE_FOLDER_TITLE = "_archive";
  const DEFAULT_ARCHIVED_DAYS = 7;
  const MAX_ARCHIVED_DAYS = 365;

  function pad2(n) {
    return String(n).padStart(2, "0");
  }

  async function subfolders(parentId) {
    return (await env.bookmarks.getChildren(parentId)).filter((c) => !c.url && c.type !== "separator");
  }

  // The tabs archive-core.js auto-archived over the last `days` calendar
  // days (today counts as one: 1 = today only), for the page's "recently
  // archived" section — read straight from the profile's
  // _archive/<year>/<month>/<day>/ folders (see archiveTab in
  // archive-core.js), so it covers what every device on this profile
  // archived, once bookmark sync has carried it here. Days come from the
  // folder names, not each bookmark's dateAdded, which a bookmark-sync
  // tool may reset to the time it synced; dateAdded (then position) only
  // orders the tabs within a day. Only the folders inside the window are
  // ever listed, so a years-long archive costs no more than a week of it.
  //
  // Read-only: no folder is created or merged — duplicate _archive/year/
  // month/day folders (two devices creating the same one before syncing)
  // are simply all read. A URL archived more than once appears once, on
  // its latest day; one that's open again on this device is left out (it
  // has been recovered already). Skipped while sync is paused, for the
  // same reason as getRemoteData (getOrCreateProfileFolder can write).
  async function getArchivedData(days) {
    if (!(await syncEngine.isSyncEnabled())) return { paused: true, days: [] };
    let n = Math.floor(Number(days));
    if (!(n >= 1)) n = DEFAULT_ARCHIVED_DAYS;
    n = Math.min(n, MAX_ARCHIVED_DAYS);

    const today = new Date(Date.now());
    const first = new Date(today.getFullYear(), today.getMonth(), today.getDate() - (n - 1));
    const firstKey = `${first.getFullYear()}-${pad2(first.getMonth() + 1)}-${pad2(first.getDate())}`;

    const profile = await syncEngine.getActiveProfile();
    const profileFolder = await syncEngine.getOrCreateProfileFolder(profile);
    const byDay = new Map(); // "YYYY-MM-DD" → [bookmark, …]
    for (const root of await subfolders(profileFolder.id)) {
      if (root.title !== ARCHIVE_FOLDER_TITLE) continue;
      for (const year of await subfolders(root.id)) {
        if (!/^\d{4}$/.test(year.title) || year.title < firstKey.slice(0, 4)) continue;
        for (const month of await subfolders(year.id)) {
          if (!/^\d{2}$/.test(month.title) || `${year.title}-${month.title}` < firstKey.slice(0, 7)) continue;
          for (const day of await subfolders(month.id)) {
            const key = `${year.title}-${month.title}-${day.title}`;
            if (!/^\d{2}$/.test(day.title) || key < firstKey) continue;
            const marks = (await env.bookmarks.getChildren(day.id)).filter((c) => c.url && /^https?:\/\//.test(c.url));
            if (!byDay.has(key)) byDay.set(key, []);
            byDay.get(key).push(...marks);
          }
        }
      }
    }

    const local = await localTabIndex();
    const seen = new Set();
    const out = [];
    for (const key of Array.from(byDay.keys()).sort().reverse()) {
      // Newest first: by dateAdded, ties (or no dateAdded at all) by
      // position — archive-core.js appends, so later is newer. sort() is
      // stable, so reversing first is enough for the ties.
      const marks = byDay
        .get(key)
        .slice()
        .reverse()
        .sort((a, b) => (b.dateAdded || 0) - (a.dateAdded || 0));
      const tabs = [];
      for (const m of marks) {
        if (seen.has(m.url)) continue;
        seen.add(m.url);
        if (local.byUrl.has(m.url)) continue;
        tabs.push({
          id: m.id,
          url: m.url,
          title: m.title || m.url,
          t: m.dateAdded || null,
          favIconUrl: local.byHost.get(hostOf(m.url)) || null,
        });
      }
      if (tabs.length) out.push({ date: key, tabs });
    }
    return { paused: false, days: out };
  }

  // This device's open tabs by real URL, plus the first loaded favicon per
  // URL and per site (same safeFaviconUrl rule) — for an archived or
  // bookmarked page, which has no tab of its own to take an icon from.
  async function localTabIndex() {
    const byUrl = new Map();
    const iconByUrl = new Map();
    const byHost = new Map();
    for (const t of await env.tabs.query({})) {
      if (isNewTabPage(t)) continue;
      const u = syncEngine.realUrlOfTab(t);
      if (!byUrl.has(u)) byUrl.set(u, t);
      const icon = safeFaviconUrl(t.favIconUrl);
      if (!icon) continue;
      if (!iconByUrl.has(u)) iconByUrl.set(u, icon);
      const host = hostOf(u);
      if (host && !byHost.has(host)) byHost.set(host, icon);
    }
    return { byUrl, iconByUrl, byHost };
  }

  // ---- bookmarks bar ----

  // The browser's own bookmarks-bar folder, never a hardcoded id alone
  // (same rule as sync-core.js's getRootParentId): Chrome/Brave 134+ mark
  // it with folderType "bookmarks-bar"; before that it's always the
  // top-level folder with id "1"; Firefox calls it "toolbar_____". Looked
  // up once, then cached — the root folders never move.
  const BOOKMARKS_BAR_IDS = ["toolbar_____", "1"];
  let cachedBarId = null;

  async function findBookmarksBarId() {
    if (cachedBarId) return cachedBarId;
    const tree = await env.bookmarks.getTree();
    const topLevel = (tree && tree[0] && tree[0].children) || [];
    const bar =
      topLevel.find((c) => c.folderType === "bookmarks-bar") ||
      topLevel.find((c) => BOOKMARKS_BAR_IDS.includes(c.id));
    cachedBarId = bar ? bar.id : null;
    return cachedBarId;
  }

  // The bookmarks bar's contents for the page's own copy of it
  // (newtab-bookmarks.js) — read-only, the bar is never written to.
  // Folders keep their nesting and order; Firefox's separators come
  // through as { kind: "separator" }. Bookmarklets (javascript: URLs) are
  // left out: an extension page can't run them. Icons follow the same
  // rule as everything else here: a bookmark gets a favicon only if a tab
  // on this device already has one for that exact page, or failing that
  // for the same site — never fetched from anywhere; a letter otherwise.
  async function getBookmarksBar() {
    const barId = await findBookmarksBarId();
    if (!barId) return { bar: null };
    const [bar] = await env.bookmarks.getSubTree(barId);
    if (!bar) return { bar: null };

    const { iconByUrl, byHost: iconByHost } = await localTabIndex();

    function view(node) {
      if (node.type === "separator") return { kind: "separator", id: node.id };
      if (node.url === undefined) {
        return {
          kind: "folder",
          id: node.id,
          title: node.title || "",
          children: (node.children || []).map(view).filter(Boolean),
        };
      }
      if (/^javascript:/i.test(node.url)) return null;
      return {
        kind: "bookmark",
        id: node.id,
        title: node.title || "",
        url: node.url,
        favIconUrl: iconByUrl.get(node.url) || iconByHost.get(hostOf(node.url)) || null,
      };
    }

    return { bar: { id: bar.id, children: (bar.children || []).map(view).filter(Boolean) } };
  }

  function hostOf(url) {
    try {
      return new URL(url).host;
    } catch (e) {
      return "";
    }
  }

  // The single entry point background.js wires, in an onMessage listener
  // of its own (not a branch inside the existing one): returns a promise
  // for a message this module owns, or null for anything else, so the
  // other modules' message handling never even sees these.
  //
  // Two messages rather than one on purpose: the local half is just one
  // tabs.query and renders instantly; the remote half walks the whole
  // profile's bookmark tree (readProfileEntries), so the page renders
  // local tabs first and fills the "other devices" section in when this
  // one answers, instead of the whole page waiting on the slower one.
  function handleMessage(message) {
    if (message && message.type === "NEWTAB_LOCAL") return getLocalData();
    if (message && message.type === "NEWTAB_REMOTE") return getRemoteData();
    if (message && message.type === "NEWTAB_BOOKMARKS") return getBookmarksBar();
    if (message && message.type === "NEWTAB_ARCHIVED") return getArchivedData(message.days);
    return null;
  }

  return {
    ARCHIVE_FOLDER_TITLE,
    isNewTabPage,
    getLocalData,
    getRemoteData,
    getArchivedData,
    getBookmarksBar,
    handleMessage,
  };
}

if (typeof module !== "undefined" && module.exports) {
  module.exports = { createNewtabEngine, isNewTabPageUrl, NATIVE_NEWTAB_URLS };
}
