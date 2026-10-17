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
// Routed through background.js messages (NEWTAB_LOCAL/NEWTAB_REMOTE)
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

  // This device's open tabs, every window. Each window: its browser tab
  // groups (in tab-strip order — position of each group's first tab),
  // each with its own tabs, then every ungrouped tab, pinned ones
  // included (they're simply first in strip order). New tab pages — this
  // one and any other — are left out; a new tab page listing itself
  // would just be noise. The focused window comes first.
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
        win = {
          id: t.windowId,
          focused: t.windowId === focusedWindowId,
          groups: [],
          tabs: [],
          groupIndex: new Map(),
        };
        byWindow.set(t.windowId, win);
      }
      const view = tabView(t);
      if (isGrouped(t) && groupsById.has(t.groupId)) {
        let group = win.groupIndex.get(t.groupId);
        if (!group) {
          const info = groupsById.get(t.groupId);
          group = { id: info.id, title: info.title || "", color: info.color || "grey", tabs: [] };
          win.groupIndex.set(t.groupId, group);
          win.groups.push(group);
        }
        group.tabs.push(view);
      } else {
        win.tabs.push(view);
      }
    }

    const windows = Array.from(byWindow.values()).map(({ groupIndex, ...w }) => w);
    windows.sort((a, b) => Number(b.focused) - Number(a.focused));
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
    return null;
  }

  return {
    isNewTabPage,
    getLocalData,
    getRemoteData,
    handleMessage,
  };
}

if (typeof module !== "undefined" && module.exports) {
  module.exports = { createNewtabEngine, isNewTabPageUrl, NATIVE_NEWTAB_URLS };
}
