// ============================================================
// SyncMyTabs - archive-core.js
//
// Independent module: auto-archive idle tabs. Tracks the last time each
// of this device's own tabs was actually looked at (became the active
// tab AND its window had focus), and — opt-in, off by default since
// it's destructive — once a tab has gone unlooked-at for longer than a
// configurable threshold (default 3 days), saves it as a plain bookmark
// under a per-profile archive folder and closes it. Pinned tabs and
// tabs inside a browser tab group are never candidates, same exclusion
// sync-core.js already applies everywhere else.
//
// Parameterized the same way as groups-core.js: takes `env` (the
// WebExtension-shaped bookmarks/tabs/windows/storage object) PLUS the
// already-created sync engine instance (`syncEngine`), reused here for
// getActiveProfile/getOrCreateProfileFolder/mergeFolderInto/
// isSyncEnabled/realUrlOfTab rather than re-implementing them. Plain
// script, no import/export syntax — loaded via importScripts/
// background.scripts like sync-core.js/groups-core.js; module.exports
// at the bottom is a Node-only no-op elsewhere.
//
// Bookmark tree shape, SIBLING to the per-URL folders and to _groups
// under each profile (and, like _groups, invisible to sync-core.js's
// readProfileEntries, which only ever recognizes a folder that has its
// own `_url` marker child):
//   SyncMyTabs/<profile>/_archive/<one plain bookmark per archived tab>
// Unlike the status/rule bookmarks elsewhere, an archived entry is a
// PLAIN bookmark (title = the tab's title, url = its real url) — there
// is nothing here the extension itself ever needs to parse back out;
// the whole point is a folder the user can browse/restore/delete
// through their ordinary bookmark manager, on any device once it syncs.
//
// Closing an archived tab goes through the ordinary env.tabs.remove(),
// which fires a real tabs.onRemoved event exactly like any other close
// (see test/sim-env.js's own comment on this) — so if the archived tab
// was ALSO one of sync-core.js's tracked open URLs, the EXISTING
// tabs.onRemoved wiring (background.js -> engine.handleTabRemoved)
// naturally flips this device's status bookmark to "closed" too,
// propagating everywhere via the existing contagious-close mechanism.
// No special-casing needed here for that — it falls out of the two
// modules sharing the same real browser event.
//
// Activity is tracked broadly (every tab, regardless of pinned/grouped
// state) but only ACTED on narrowly (pinned/grouped tabs are filtered
// out at reconcile time, never archived) — this is deliberate: a tab
// that was pinned/grouped while last focused and is later unpinned/
// ungrouped keeps its real, accurate last-active time instead of
// suddenly looking artificially stale the moment it becomes eligible.
// ============================================================

const ARCHIVE_ROOT_TITLE = "_archive";
const DEFAULT_ARCHIVE_IDLE_DAYS = 3;
const ARCHIVE_ACTIVITY_STORAGE_KEY = "archiveTabActivity";
const WINDOW_ID_NONE = -1; // matches browser.windows.WINDOW_ID_NONE

function createArchiveEngine(env, syncEngine) {
  function isGrouped(tab) {
    return typeof tab.groupId === "number" && tab.groupId !== -1;
  }

  // ---- preferences (per-device local, not synced — same convention as
  // syncEnabled/ttlDays/groupsLeashEnabled) ----

  async function isArchiveEnabled() {
    const { archiveEnabled } = await env.storage.local.get("archiveEnabled");
    return archiveEnabled === true; // default OFF (destructive)
  }

  async function archiveIdleDays() {
    const { archiveIdleDays: v } = await env.storage.local.get("archiveIdleDays");
    return v || DEFAULT_ARCHIVE_IDLE_DAYS;
  }

  // ---- activity tracking ----
  // Persisted in storage.local (not just an in-memory Map) because a
  // Manifest V3 service worker gets suspended and torn down after a
  // short idle period — an in-memory-only map would silently lose all
  // history every time that happens, which is often. Tab ids stay valid
  // as long as the browser PROCESS is alive (a suspended-then-woken
  // service worker is the same session, same ids); only a genuine
  // browser restart invalidates them — handled by seedStartupActivity
  // below. Tracking itself runs unconditionally (cheap: an occasional
  // timestamp write), regardless of archiveEnabled — so turning the
  // feature ON later doesn't start from a blank slate for tabs the user
  // has genuinely been using; only the destructive action (archive +
  // close) is gated on the toggle.

  async function readActivityMap() {
    const { [ARCHIVE_ACTIVITY_STORAGE_KEY]: map } = await env.storage.local.get(
      ARCHIVE_ACTIVITY_STORAGE_KEY
    );
    return map || {};
  }

  async function recordTabActivity(tabId) {
    if (tabId === undefined || tabId === null) return;
    const map = await readActivityMap();
    map[tabId] = Date.now();
    await env.storage.local.set({ [ARCHIVE_ACTIVITY_STORAGE_KEY]: map });
  }

  async function removeTabActivity(tabId) {
    const map = await readActivityMap();
    if (!(tabId in map)) return;
    delete map[tabId];
    await env.storage.local.set({ [ARCHIVE_ACTIVITY_STORAGE_KEY]: map });
  }

  // Seeds "now" for any currently-open tab id with no recorded activity
  // yet, and drops any recorded id that's no longer open — in one
  // read-modify-write pass. This is what makes both a fresh browser
  // launch (all ids are new) and first-ever enabling of the feature
  // (no history at all yet) safe: an unknown tab is never treated as
  // "has been idle forever", it's given a full fresh idle window
  // starting now. Also self-heals a missed onRemoved (e.g. the service
  // worker was dead when a tab closed).
  async function seedAndPruneActivity(openTabIds) {
    const map = await readActivityMap();
    const now = Date.now();
    let changed = false;
    const openIdSet = new Set(openTabIds.map(String));

    for (const id of Object.keys(map)) {
      if (!openIdSet.has(id)) {
        delete map[id];
        changed = true;
      }
    }
    for (const id of openTabIds) {
      if (!(id in map)) {
        map[id] = now;
        changed = true;
      }
    }
    if (changed) await env.storage.local.set({ [ARCHIVE_ACTIVITY_STORAGE_KEY]: map });
    return map;
  }

  // ---- bookmark-backed archive folder ----
  // Mirrors groups-core.js's own root-folder find-or-create + duplicate-
  // merge pattern (mergeFolderInto, reused from syncEngine), one level
  // scoped further down (profile -> "_archive").

  async function findArchiveFolder(profileFolderId) {
    const children = await env.bookmarks.getChildren(profileFolderId);
    const matches = children.filter((c) => !c.url && c.title === ARCHIVE_ROOT_TITLE);
    if (matches.length === 0) return null;
    if (matches.length === 1) return matches[0];
    matches.sort((a, b) => (a.dateAdded || 0) - (b.dateAdded || 0));
    const [canonical, ...dups] = matches;
    for (const d of dups) await syncEngine.mergeFolderInto(d.id, canonical.id);
    return canonical;
  }

  async function getOrCreateArchiveFolder(profileFolderId) {
    const found = await findArchiveFolder(profileFolderId);
    if (found) return found;
    return env.bookmarks.create({ parentId: profileFolderId, title: ARCHIVE_ROOT_TITLE });
  }

  // Saves `tab` as a plain bookmark in the profile's archive folder.
  // Returns true on success — the caller must not close the tab unless
  // this succeeds, so a tab is never lost without a saved trace of it.
  async function archiveTab(profileFolderId, tab) {
    const url = syncEngine.realUrlOfTab(tab);
    try {
      const folder = await getOrCreateArchiveFolder(profileFolderId);
      await env.bookmarks.create({
        parentId: folder.id,
        title: tab.title || url,
        url,
      });
      return true;
    } catch (e) {
      return false;
    }
  }

  // ---- the reconcile pass ----

  async function reconcileArchive() {
    if (!(await syncEngine.isSyncEnabled())) return; // master pause covers this too

    const allTabs = await env.tabs.query({});
    const eligible = allTabs.filter(
      (t) => !t.pinned && !isGrouped(t) && (!t.status || t.status === "complete")
    );

    // Tracking runs regardless of the toggle (see readActivityMap's own
    // comment) — every OPEN tab gets a baseline, not just eligible ones,
    // so a tab that's currently pinned/grouped still accrues real
    // history for whenever it stops being either.
    const activity = await seedAndPruneActivity(allTabs.map((t) => t.id));

    if (!(await isArchiveEnabled())) return;

    const idleMs = (await archiveIdleDays()) * 24 * 60 * 60 * 1000;
    const now = Date.now();
    const stale = eligible.filter((t) => now - (activity[t.id] || now) >= idleMs);
    if (stale.length === 0) return;

    const profile = await syncEngine.getActiveProfile();
    const profileFolder = await syncEngine.getOrCreateProfileFolder(profile);

    for (const tab of stale) {
      const saved = await archiveTab(profileFolder.id, tab);
      if (!saved) continue; // never close a tab we failed to save
      try {
        await env.tabs.remove(tab.id);
      } catch (e) {
        continue;
      }
      await removeTabActivity(tab.id);
    }
  }

  // ---- event-wiring handlers (see sync-core.js/groups-core.js's own
  // "why handle*() functions exist" comment: background.js's real
  // listeners are one-line calls into these, and the test simulator
  // drives the SAME functions, so a test exercises the real wiring) ----

  function handleTabActivated(activeInfo) {
    return recordTabActivity(activeInfo && activeInfo.tabId);
  }

  async function handleWindowFocusChanged(windowId) {
    if (windowId === undefined || windowId === WINDOW_ID_NONE) return;
    let active;
    try {
      [active] = await env.tabs.query({ windowId, active: true });
    } catch (e) {
      return;
    }
    if (active) await recordTabActivity(active.id);
  }

  function handleTabCreated(tab) {
    return recordTabActivity(tab && tab.id);
  }

  function handleTabRemoved(tabId) {
    return removeTabActivity(tabId);
  }

  // Called once at browser startup: every currently-open tab id is new
  // (ids aren't stable across a restart), so the persisted activity map
  // from the previous session is entirely stale — seedAndPruneActivity
  // drops it all and gives every currently-open tab a fresh "now"
  // baseline, rather than treating a just-restored session as having
  // been idle forever.
  async function handleStartupSeed() {
    const allTabs = await env.tabs.query({});
    await seedAndPruneActivity(allTabs.map((t) => t.id));
  }

  async function handleArchiveAlarm() {
    await reconcileArchive();
  }

  return {
    ARCHIVE_ROOT_TITLE,
    DEFAULT_ARCHIVE_IDLE_DAYS,
    isArchiveEnabled,
    archiveIdleDays,
    getOrCreateArchiveFolder,
    reconcileArchive,
    handleTabActivated,
    handleWindowFocusChanged,
    handleTabCreated,
    handleTabRemoved,
    handleStartupSeed,
    handleArchiveAlarm,
  };
}

if (typeof module !== "undefined" && module.exports) {
  module.exports = {
    ARCHIVE_ROOT_TITLE,
    DEFAULT_ARCHIVE_IDLE_DAYS,
    ARCHIVE_ACTIVITY_STORAGE_KEY,
    WINDOW_ID_NONE,
    createArchiveEngine,
  };
}
