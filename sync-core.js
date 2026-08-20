// ============================================================
// SyncMyTabs - sync-core.js
//
// All the sync/reconcile logic, factored out of background.js and
// parameterized over an `env` object shaped like the WebExtension
// `browser.*` namespace (bookmarks/tabs/windows/storage/runtime) instead
// of calling `browser.*` directly. This lets the EXACT same logic run:
//   - for real, inside the extension: createSyncEngine(browser)
//   - inside a test simulator, in plain Node: createSyncEngine(fakeEnv)
// See test/sim-env.js for the simulated multi-device environment, and
// CLAUDE.md for how to run the test suite.
//
// Loaded into the extension the same way as the polyfill — via
// importScripts on Chrome, via manifest `background.scripts` on Firefox
// — so it must stay a plain script (no import/export syntax). The
// `module.exports` at the bottom only runs under Node (require()), and
// is a no-op — skipped, not an error — inside a browser/service worker.
//
// Required shape of `env` (only what's actually used):
//   env.bookmarks: { search, getChildren, getTree, create, update,
//                    remove, removeTree, move }
//   env.tabs:      { query, create, remove }
//   env.windows:   { getLastFocused, getAll, create, remove }
//   env.storage:   { local: { get(keys) -> Promise<obj>, set(obj) -> Promise } }
//   env.runtime:   { getURL(path) -> string }
// ============================================================

const ROOT_NAME = "SyncMyTabs";
// Previous names this extension has had. If the current-name root
// folder doesn't exist yet but one of these does, we rename it in
// place (instead of creating a fresh, disconnected folder) so
// existing synced data isn't orphaned by the rename.
const LEGACY_ROOT_NAMES = ["OpenTabSync", "Live Tabs Sync"];

const DEFAULT_PROFILE = "default";
const DEFAULT_TTL_DAYS = 21;
const DEFAULT_INTERVAL_MINUTES = 1;

// Every tab-entry bookmark's url starts with this and packs its
// metadata as query params: u=<real url>, d=<device>, s=open|closed,
// t=<last STATE-CHANGE time>, h=<last HEARTBEAT time>. `t` and `h` are
// deliberately separate: `t` only ever moves on a genuine open/close
// transition and drives open-vs-closed precedence when devices
// disagree; `h` is bumped by routine liveness heartbeats (so TTL
// cleanup doesn't sweep a tab that's simply been open a long time).
// Conflating the two was the root of the open-time race fixed in
// 2.6.2 — keeping them apart avoids reintroducing that class of bug.
const TAB_URL_BASE = "https://syncmytabs.local/tab";

// "Other Bookmarks" folder id: "2" on Chrome/Brave, "unfiled_____" on
// Firefox. Resolved at runtime from the bookmark tree, these are only
// the last-resort fallbacks.
const OTHER_BOOKMARKS_PARENT_ID = "2";
const FIREFOX_UNFILED_ID = "unfiled_____";

// ------------------------------------------------------------
// Pure helpers (no env needed) — exported standalone so they can be
// unit-tested directly, without spinning up an engine.
// ------------------------------------------------------------
function isHttpUrl(u) {
  return /^https?:\/\//.test(u || "");
}

function buildTabEntryUrl({ real, device, state, t, h }) {
  return (
    `${TAB_URL_BASE}?u=${encodeURIComponent(real)}` +
    `&d=${encodeURIComponent(device)}` +
    `&s=${state}&t=${t}&h=${h}`
  );
}

function parseTabEntryUrl(url) {
  if (!url || !url.startsWith(TAB_URL_BASE)) return null;
  try {
    const p = new URL(url).searchParams;
    const real = p.get("u");
    const device = p.get("d");
    const state = p.get("s");
    if (!real || !device || (state !== "open" && state !== "closed")) {
      return null;
    }
    const t = Number(p.get("t")) || 0;
    const h = Number(p.get("h")) || t;
    return { real, device, state, t, h };
  } catch (e) {
    return null;
  }
}

function isTabEntryBookmark(url) {
  return !!parseTabEntryUrl(url);
}

// ------------------------------------------------------------
// The engine: everything that needs to talk to bookmarks/tabs/storage.
// ------------------------------------------------------------
function createSyncEngine(env) {
  const LAZY_PAGE = env.runtime.getURL("lazy.html");

  function lazyUrlFor(entry) {
    return (
      `${LAZY_PAGE}?u=${encodeURIComponent(entry.url)}` +
      `&t=${encodeURIComponent(entry.title || "")}`
    );
  }

  // The real http(s) target of a tab. For a lazy-restore placeholder
  // tab (still unopened) this is the encoded `u` param; for any other
  // tab it's just its URL.
  function realUrlOfTab(tab) {
    const u = (tab && (tab.url || tab.pendingUrl)) || "";
    if (u.startsWith(LAZY_PAGE)) {
      try {
        const real = new URL(u).searchParams.get("u");
        if (real) return real;
      } catch (e) {}
    }
    return u;
  }

  let cachedRootParentId = null;
  async function getRootParentId() {
    if (cachedRootParentId) return cachedRootParentId;
    try {
      const tree = await env.bookmarks.getTree();
      const topLevel = (tree && tree[0] && tree[0].children) || [];
      const known = topLevel.find(
        (c) =>
          c.id === OTHER_BOOKMARKS_PARENT_ID || c.id === FIREFOX_UNFILED_ID
      );
      if (known) {
        cachedRootParentId = known.id;
        return cachedRootParentId;
      }
      const folders = topLevel.filter((c) => !c.url);
      if (folders.length > 0) {
        cachedRootParentId = folders[folders.length - 1].id;
        return cachedRootParentId;
      }
    } catch (e) {}
    cachedRootParentId = OTHER_BOOKMARKS_PARENT_ID;
    return cachedRootParentId;
  }

  // Root folder: find-or-create, consolidating duplicates and
  // migrating a legacy-named folder in place.
  async function getOrCreateRootFolder() {
    const results = await env.bookmarks.search({ title: ROOT_NAME });
    const folders = results.filter((b) => !b.url);

    if (folders.length > 0) {
      if (folders.length === 1) return folders[0];
      folders.sort((a, b) => (a.dateAdded || 0) - (b.dateAdded || 0));
      const [canonical, ...duplicates] = folders;
      for (const dup of duplicates) await mergeFolderInto(dup.id, canonical.id);
      return canonical;
    }

    for (const legacyName of LEGACY_ROOT_NAMES) {
      const legacyResults = await env.bookmarks.search({ title: legacyName });
      const legacyFolders = legacyResults.filter((b) => !b.url);
      if (legacyFolders.length === 0) continue;

      legacyFolders.sort((a, b) => (a.dateAdded || 0) - (b.dateAdded || 0));
      const [canonical, ...duplicates] = legacyFolders;
      for (const dup of duplicates) await mergeFolderInto(dup.id, canonical.id);
      await env.bookmarks.update(canonical.id, { title: ROOT_NAME });
      return canonical;
    }

    const parentId = await getRootParentId();
    return env.bookmarks.create({ parentId, title: ROOT_NAME });
  }

  // Moves all content of sourceFolderId into targetFolderId. Same-named
  // SUBFOLDERS are merged recursively; bookmark children (tab entries)
  // are just moved over unconditionally — any incidental (device,url)
  // duplicate left behind is cleaned up defensively by
  // reconcileMyOpenEntries the next time that device reconciles.
  async function mergeFolderInto(sourceFolderId, targetFolderId) {
    const children = await env.bookmarks.getChildren(sourceFolderId);
    const targetChildren = await env.bookmarks.getChildren(targetFolderId);

    for (const child of children) {
      const match = targetChildren.find(
        (t) => t.title === child.title && !t.url === !child.url
      );
      if (match && !match.url && !child.url) {
        await mergeFolderInto(child.id, match.id);
        try {
          await env.bookmarks.remove(child.id);
        } catch (e) {}
      } else {
        try {
          await env.bookmarks.move(child.id, { parentId: targetFolderId });
        } catch (e) {}
      }
    }

    try {
      await env.bookmarks.removeTree(sourceFolderId);
    } catch (e) {}
  }

  // Find-or-create the folder for a profile, directly under root.
  async function getOrCreateProfileFolder(profile) {
    const root = await getOrCreateRootFolder();
    const children = await env.bookmarks.getChildren(root.id);
    const matches = children.filter((c) => !c.url && c.title === profile);

    if (matches.length === 0) {
      return env.bookmarks.create({ parentId: root.id, title: profile });
    }
    if (matches.length === 1) return matches[0];

    matches.sort((a, b) => (a.dateAdded || 0) - (b.dateAdded || 0));
    const [canonical, ...dups] = matches;
    for (const d of dups) await mergeFolderInto(d.id, canonical.id);
    return canonical;
  }

  async function getActiveProfile() {
    const { activeProfile } = await env.storage.local.get("activeProfile");
    return activeProfile || DEFAULT_PROFILE;
  }

  // Snapshot of this device's own currently-open, real (non-placeholder-
  // pending, http/https) tabs. Tabs still mid-navigation
  // (status !== "complete") are excluded entirely — see CLAUDE.md for
  // why (the phantom-duplicate-entry bug this guards against).
  async function snapshotOwnTabs() {
    const urls = new Set();
    const titleByUrl = new Map();
    const tabIdsByUrl = new Map();
    for (const t of await env.tabs.query({})) {
      if (t.status && t.status !== "complete") continue;
      const real = realUrlOfTab(t);
      if (!isHttpUrl(real)) continue;
      urls.add(real);
      if (!titleByUrl.has(real)) titleByUrl.set(real, t.title || real);
      if (!tabIdsByUrl.has(real)) tabIdsByUrl.set(real, []);
      tabIdsByUrl.get(real).push(t.id);
    }
    return { urls, titleByUrl, tabIdsByUrl };
  }

  // Master on/off switch. When paused, this device neither pushes its
  // own tab state nor reacts to other devices' updates. Default ON.
  async function isSyncEnabled() {
    const { syncEnabled } = await env.storage.local.get("syncEnabled");
    return syncEnabled !== false;
  }

  // How often a still-open, still-tracked entry gets its heartbeat (`h`)
  // bumped — often enough to comfortably outrun the TTL, rarely enough
  // to not spam bookmark writes for tabs nobody touched.
  async function heartbeatIntervalMs() {
    const oneDay = 24 * 60 * 60 * 1000;
    const { ttlEnabled, ttlDays } = await env.storage.local.get([
      "ttlEnabled",
      "ttlDays",
    ]);
    if (ttlEnabled === false) return oneDay;
    const days = ttlDays || DEFAULT_TTL_DAYS;
    return Math.min(oneDay, (days * oneDay) / 3);
  }

  // ==========================================================
  // Reconcile pipeline. See CLAUDE.md's SAFETY RULE section: closes
  // are only ever detected from a live, specific-tab event
  // (handleTabRemoved / handleTabUpdated below), never from the alarm,
  // startup, or a bookmark-change reaction.
  // ==========================================================

  // Registers/refreshes THIS device's own "open" entries against its
  // live tabs. Safe to call from anywhere — it only ever creates/
  // refreshes "open" entries or revives a "closed" one a tab was
  // genuinely reopened at; it never closes anything.
  async function reconcileMyOpenEntries(profileFolderId, deviceName) {
    const children = await env.bookmarks.getChildren(profileFolderId);
    const mine = new Map(); // real url -> {id, ...parsed}
    const dupeIds = [];
    for (const c of children) {
      const info = parseTabEntryUrl(c.url);
      if (!info || info.device !== deviceName) continue;
      const existing = mine.get(info.real);
      if (!existing) {
        mine.set(info.real, { id: c.id, ...info });
      } else if (info.t >= existing.t) {
        dupeIds.push(existing.id);
        mine.set(info.real, { id: c.id, ...info });
      } else {
        dupeIds.push(c.id);
      }
    }
    for (const id of dupeIds) {
      try {
        await env.bookmarks.remove(id);
      } catch (e) {}
    }

    const { urls: current, titleByUrl } = await snapshotOwnTabs();
    const now = Date.now();
    const heartbeatMs = await heartbeatIntervalMs();

    for (const url of current) {
      const entry = mine.get(url);
      const title = titleByUrl.get(url) || url;
      if (!entry) {
        try {
          await env.bookmarks.create({
            parentId: profileFolderId,
            title,
            url: buildTabEntryUrl({
              real: url,
              device: deviceName,
              state: "open",
              t: now,
              h: now,
            }),
          });
        } catch (e) {}
      } else if (entry.state === "closed") {
        // Genuine reopen: always safe to record, regardless of when
        // it's detected.
        try {
          await env.bookmarks.update(entry.id, {
            title,
            url: buildTabEntryUrl({
              real: url,
              device: deviceName,
              state: "open",
              t: now,
              h: now,
            }),
          });
        } catch (e) {}
      } else if (now - entry.h > heartbeatMs) {
        // Still open: only bump the heartbeat, never `t` — otherwise a
        // routine liveness touch could outrace a genuine close recorded
        // elsewhere (the exact race fixed in 2.6.2).
        try {
          await env.bookmarks.update(entry.id, {
            url: buildTabEntryUrl({
              real: url,
              device: deviceName,
              state: "open",
              t: entry.t,
              h: now,
            }),
          });
        } catch (e) {}
      }
    }
  }

  // Flips THIS device's own entries to "closed" for URLs it had
  // tracked as open but no longer has live. ONLY ever called from
  // handleTabRemoved / handleTabUpdated.
  async function closeMyGoneTabs(profileFolderId, deviceName) {
    const children = await env.bookmarks.getChildren(profileFolderId);
    const { urls: current } = await snapshotOwnTabs();
    const now = Date.now();
    for (const c of children) {
      const info = parseTabEntryUrl(c.url);
      if (!info || info.device !== deviceName || info.state !== "open") {
        continue;
      }
      if (current.has(info.real)) continue;
      try {
        await env.bookmarks.update(c.id, {
          url: buildTabEntryUrl({ ...info, state: "closed", t: now, h: now }),
        });
      } catch (e) {}
    }
  }

  // Mirrors the group's aggregate state onto this device's live tabs.
  async function reconcileMirror(profileFolderId) {
    const children = await env.bookmarks.getChildren(profileFolderId);
    const groups = new Map(); // real url -> [{id, title, ...parsed}]
    for (const c of children) {
      const info = parseTabEntryUrl(c.url);
      if (!info) continue;
      if (!groups.has(info.real)) groups.set(info.real, []);
      groups.get(info.real).push({ id: c.id, title: c.title, ...info });
    }

    const { urls: current, tabIdsByUrl } = await snapshotOwnTabs();

    const idsToClose = [];
    const toOpen = [];
    for (const [url, entries] of groups) {
      const openEntries = entries.filter((e) => e.state === "open");
      const closedEntries = entries.filter((e) => e.state === "closed");
      const latestOpenT = openEntries.reduce(
        (m, e) => Math.max(m, e.t),
        -Infinity
      );
      const latestCloseT = closedEntries.reduce(
        (m, e) => Math.max(m, e.t),
        -Infinity
      );
      const present = latestOpenT > latestCloseT;

      if (present && !current.has(url)) {
        const best = openEntries.sort((a, b) => b.t - a.t)[0];
        toOpen.push({ url, title: (best && best.title) || url });
      } else if (!present && current.has(url)) {
        for (const id of tabIdsByUrl.get(url) || []) idsToClose.push(id);
      }
    }

    if (idsToClose.length) {
      try {
        await env.tabs.remove(idsToClose);
      } catch (e) {}
    }
    if (toOpen.length) {
      await performAdd(toOpen);
    }
    if (toOpen.length || idsToClose.length) {
      await env.storage.local.set({ lastActivityTimestamp: Date.now() });
    }
  }

  // TTL sweep + closed-group cleanup for a profile.
  async function cleanupProfileFolder(profile) {
    const { ttlEnabled, ttlDays } = await env.storage.local.get([
      "ttlEnabled",
      "ttlDays",
    ]);
    const enabled = ttlEnabled !== false; // default ON
    const days = ttlDays || DEFAULT_TTL_DAYS;
    const ttlMs = days * 24 * 60 * 60 * 1000;
    const now = Date.now();

    const profileFolder = await getOrCreateProfileFolder(profile);
    let children = await env.bookmarks.getChildren(profileFolder.id);

    if (enabled) {
      const stale = children.filter((c) => {
        const info = parseTabEntryUrl(c.url);
        if (!info) return false;
        return now - (info.h || info.t) > ttlMs;
      });
      for (const c of stale) {
        try {
          await env.bookmarks.remove(c.id);
        } catch (e) {}
      }
      if (stale.length) {
        children = await env.bookmarks.getChildren(profileFolder.id);
      }
    }

    const groups = new Map();
    for (const c of children) {
      const info = parseTabEntryUrl(c.url);
      if (!info) continue;
      if (!groups.has(info.real)) groups.set(info.real, []);
      groups.get(info.real).push({ id: c.id, state: info.state });
    }
    for (const entries of groups.values()) {
      if (entries.every((e) => e.state === "closed")) {
        for (const e of entries) {
          try {
            await env.bookmarks.remove(e.id);
          } catch (err) {}
        }
      }
    }
  }

  async function runReconcile({ checkClosed } = {}) {
    if (!(await isSyncEnabled())) return;
    const { deviceName } = await env.storage.local.get("deviceName");
    if (!deviceName) return;
    const profile = await getActiveProfile();
    const profileFolder = await getOrCreateProfileFolder(profile);

    if (checkClosed) await closeMyGoneTabs(profileFolder.id, deviceName);
    await reconcileMyOpenEntries(profileFolder.id, deviceName);
    await reconcileMirror(profileFolder.id);
    // Re-sync once more: the mirror pass may have opened/closed local
    // tabs, so make sure this device's own entries reflect that too.
    await reconcileMyOpenEntries(profileFolder.id, deviceName);
  }

  // Serializes all reconcile runs and coalesces bursts of triggers into
  // at most one extra run after the current one finishes.
  let reconcileRunning = false;
  let reconcilePendingOpts = null;
  let reconcileTail = Promise.resolve();

  function scheduleReconcile(opts = {}) {
    if (reconcileRunning) {
      reconcilePendingOpts = {
        checkClosed:
          (reconcilePendingOpts && reconcilePendingOpts.checkClosed) ||
          opts.checkClosed,
      };
      return reconcileTail;
    }
    reconcileRunning = true;
    reconcileTail = (async () => {
      let currentOpts = opts;
      while (currentOpts) {
        await runReconcile(currentOpts).catch(() => {});
        currentOpts = reconcilePendingOpts;
        reconcilePendingOpts = null;
      }
      reconcileRunning = false;
    })();
    return reconcileTail;
  }

  // Whether restored tabs should open lazily. Default ON.
  async function openRestoredLazily() {
    const { openRestoredLazy } = await env.storage.local.get(
      "openRestoredLazy"
    );
    return openRestoredLazy !== false;
  }

  // Opens `entries` ({url,title}) alongside the current tabs, skipping
  // any already open. Used by reconcileMirror to mirror in URLs that
  // are open elsewhere but not here yet.
  async function performAdd(entries) {
    const lazy = await openRestoredLazily();
    const { urls: alreadyOpen } = await snapshotOwnTabs();
    const toOpen = entries.filter((e) => !alreadyOpen.has(e.url));
    if (toOpen.length === 0) return;

    let targetWindow;
    try {
      targetWindow = await env.windows.getLastFocused({
        windowTypes: ["normal"],
      });
    } catch (e) {
      targetWindow = null;
    }

    if (targetWindow) {
      for (const entry of toOpen) {
        try {
          await env.tabs.create({
            windowId: targetWindow.id,
            url: lazy ? lazyUrlFor(entry) : entry.url,
            active: !lazy,
          });
        } catch (e) {}
      }
    } else {
      try {
        await env.windows.create({
          url: toOpen.map((e) => (lazy ? lazyUrlFor(e) : e.url)),
        });
      } catch (e) {}
    }
  }

  // ------------------------------------------------------------
  // Listing helper for the popup/options UI's profile pickers.
  // ------------------------------------------------------------
  async function listAllKnownProfiles() {
    const root = await getOrCreateRootFolder();
    const children = await env.bookmarks.getChildren(root.id);
    const found = new Set();
    for (const c of children) if (!c.url) found.add(c.title);
    const { profiles } = await env.storage.local.get("profiles");
    for (const p of profiles || []) found.add(p);
    found.add(DEFAULT_PROFILE);
    return Array.from(found).sort();
  }

  // ------------------------------------------------------------
  // Event-wiring handlers: the "when X happens, do Y" glue, factored
  // out here (not just the underlying reconcile primitives) so tests
  // exercise the SAME decisions background.js's real listeners make —
  // e.g. the isWindowClosing guard, or which status counts as
  // "navigation complete" — rather than re-implementing them.
  // ------------------------------------------------------------

  // One of the two places a close is ever detected.
  function handleTabRemoved(tabId, removeInfo) {
    if (removeInfo && removeInfo.isWindowClosing) return reconcileTail; // shutdown/window close
    return scheduleReconcile({ checkClosed: true });
  }

  // The other place a close is ever detected. A completed navigation
  // both registers the tab's new URL as open and checks for gone URLs,
  // so navigating an open tab to a different address is treated as
  // closing the old one and opening the new one.
  function handleTabUpdated(tabId, changeInfo) {
    if (changeInfo.status !== "complete") return reconcileTail;
    return scheduleReconcile({ checkClosed: true });
  }

  // Reaction to a remote (or our own) tab-entry bookmark change.
  // Never triggers a close — see the safety rule.
  function handleBookmarkEvent(url) {
    if (!isTabEntryBookmark(url)) return reconcileTail;
    return scheduleReconcile();
  }

  // Any bookmark removal is cheap to react to (the mutex/coalescing
  // bounds the cost) — no need to inspect what was removed.
  function handleBookmarkRemoved() {
    return scheduleReconcile();
  }

  async function handleAlarm() {
    await scheduleReconcile();
    const profile = await getActiveProfile();
    await cleanupProfileFolder(profile);
  }

  // No checkClosed here: session restore may still be repopulating
  // windows, so a live-tab snapshot right now can't be trusted for
  // deciding what's been closed. See the safety rule.
  async function handleStartup() {
    await scheduleReconcile();
    const profile = await getActiveProfile();
    await cleanupProfileFolder(profile);
  }

  // Explicit, in-session user actions — safe context for checkClosed.
  async function handleSyncNow() {
    await scheduleReconcile({ checkClosed: true });
    const profile = await getActiveProfile();
    await cleanupProfileFolder(profile);
  }

  async function handleSwitchProfileAndSave() {
    await scheduleReconcile({ checkClosed: true });
  }

  return {
    // constants, re-exported for convenience
    DEFAULT_PROFILE,
    DEFAULT_TTL_DAYS,
    // core
    getRootParentId,
    getOrCreateRootFolder,
    mergeFolderInto,
    getOrCreateProfileFolder,
    getActiveProfile,
    realUrlOfTab,
    lazyUrlFor,
    snapshotOwnTabs,
    isSyncEnabled,
    heartbeatIntervalMs,
    reconcileMyOpenEntries,
    closeMyGoneTabs,
    reconcileMirror,
    cleanupProfileFolder,
    runReconcile,
    scheduleReconcile,
    openRestoredLazily,
    performAdd,
    listAllKnownProfiles,
    // wiring handlers
    handleTabRemoved,
    handleTabUpdated,
    handleBookmarkEvent,
    handleBookmarkRemoved,
    handleAlarm,
    handleStartup,
    handleSyncNow,
    handleSwitchProfileAndSave,
  };
}

if (typeof module !== "undefined" && module.exports) {
  module.exports = {
    ROOT_NAME,
    LEGACY_ROOT_NAMES,
    DEFAULT_PROFILE,
    DEFAULT_TTL_DAYS,
    DEFAULT_INTERVAL_MINUTES,
    TAB_URL_BASE,
    OTHER_BOOKMARKS_PARENT_ID,
    FIREFOX_UNFILED_ID,
    isHttpUrl,
    buildTabEntryUrl,
    parseTabEntryUrl,
    isTabEntryBookmark,
    createSyncEngine,
  };
}
