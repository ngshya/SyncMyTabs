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
const DEFAULT_TTL_DAYS = 14;
const DEFAULT_INTERVAL_MINUTES = 1;

// Bookmark tree shape (see CLAUDE.md):
//   SyncMyTabs/<profile>/<one folder per URL>/{_url, <device1>, <device2>, …}
// The per-URL folder's title is purely cosmetic (tab title, or the URL
// itself, truncated) — matching a URL to its folder is ALWAYS done by
// reading the `_url` child, never by folder title, so title length/
// collisions/encoding are never a correctness concern.
const URL_MARKER_TITLE = "_url";
const FOLDER_TITLE_MAX_LEN = 80;

function folderTitleFor(title, url) {
  const base = (title && title.trim()) || url;
  return base.length > FOLDER_TITLE_MAX_LEN
    ? base.slice(0, FOLDER_TITLE_MAX_LEN - 1) + "…"
    : base;
}

// Each device's own status bookmark inside a URL folder is titled with
// the device's name (exact, unencoded) and its url packs open|closed
// plus two timestamps: t=<last STATE-CHANGE time>, h=<last HEARTBEAT
// time>. Deliberately separate: `t` only ever moves on a genuine local
// open/close transition; `h` is bumped by routine liveness heartbeats
// (so TTL cleanup doesn't sweep a tab that's simply been open a long
// time). Conflating the two was the root of the open-time race fixed
// in 2.6.2 — keeping them apart avoids reintroducing that class of bug,
// and `h` (not `t`) is what folder-level TTL staleness checks.
const STATUS_URL_BASE = "https://syncmytabs.local/status";

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

// True iff `t` is inside a browser tab group. Feature-detected via
// `groupId` (Chrome/Brave tabGroups: -1 means ungrouped) rather than
// assumed present — Firefox tabs don't carry a `groupId` at all, so this
// is always false there and grouped-tab handling silently no-ops, per
// CLAUDE.md's cross-browser rule (never assume a Chrome-only field).
function isInTabGroup(t) {
  return typeof t.groupId === "number" && t.groupId !== -1;
}

function buildDeviceStatusUrl({ state, t, h }) {
  return `${STATUS_URL_BASE}?s=${state}&t=${t}&h=${h}`;
}

function parseDeviceStatusUrl(url) {
  if (!url || !url.startsWith(STATUS_URL_BASE)) return null;
  try {
    const p = new URL(url).searchParams;
    const state = p.get("s");
    if (state !== "open" && state !== "closed") return null;
    const t = Number(p.get("t")) || 0;
    const h = Number(p.get("h")) || t;
    return { state, t, h };
  } catch (e) {
    return null;
  }
}

// Whether a bookmark-tree change is one we care about: either the `_url`
// marker of a newly-created URL folder, or a device status bookmark
// (created or updated). Anything else (the user's own unrelated
// bookmarks, a plain folder by itself) is ignored.
function isRelevantBookmarkChange(title, url) {
  return title === URL_MARKER_TITLE || !!parseDeviceStatusUrl(url);
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
  //
  // Pinned tabs and tabs inside a browser tab group are deliberately
  // left out of `urls`/`titleByUrl`/`tabIdsByUrl` too: neither ever gets
  // its own bookmark entry, and mirror-driven open/close never touches
  // one (reconcileMirror only ever closes ids drawn from `tabIdsByUrl`).
  // They ARE still counted in `allUrls`, which exists purely so callers
  // that just want to know "is this URL already open here at all"
  // (avoiding a duplicate open) don't ignore a tab merely because it's
  // pinned or grouped.
  async function snapshotOwnTabs() {
    const urls = new Set();
    const allUrls = new Set();
    const titleByUrl = new Map();
    const tabIdsByUrl = new Map();
    for (const t of await env.tabs.query({})) {
      if (t.status && t.status !== "complete") continue;
      const real = realUrlOfTab(t);
      if (!isHttpUrl(real)) continue;
      allUrls.add(real);
      if (t.pinned || isInTabGroup(t)) continue;
      urls.add(real);
      if (!titleByUrl.has(real)) titleByUrl.set(real, t.title || real);
      if (!tabIdsByUrl.has(real)) tabIdsByUrl.set(real, []);
      tabIdsByUrl.get(real).push(t.id);
    }
    return { urls, allUrls, titleByUrl, tabIdsByUrl };
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

  // Reads a whole profile folder's tree in one pass: every per-URL
  // subfolder's real url (its `_url` child) and every device's status
  // bookmark inside it. Self-healing: if a sync-tool race left two
  // folders for the SAME url (two devices creating it at once), the
  // second one's device bookmarks are moved into the first (canonical)
  // folder and the duplicate folder is removed — the same spirit as
  // mergeFolderInto, just keyed by url match instead of title match.
  //
  // Returns Map<realUrl, { folderId, urlBookmarkId,
  //   devices: Map<deviceName, {id,state,t,h}[]> }>. `devices` values
  // are arrays (not a single entry) because a duplicate device
  // bookmark within one folder (same race) is possible too; callers
  // that only care about their OWN device dedupe it defensively (see
  // reconcileMyOpenEntries), callers that aggregate across devices
  // (reconcileMirror/cleanupProfileFolder) just flatten every entry.
  async function readProfileEntries(profileFolderId) {
    const byUrl = new Map();
    const children = await env.bookmarks.getChildren(profileFolderId);
    for (const folder of children) {
      if (folder.url) continue; // a stray bookmark directly in the profile folder; ignore
      const kids = await env.bookmarks.getChildren(folder.id);
      const urlBm = kids.find((k) => k.title === URL_MARKER_TITLE && k.url);
      if (!urlBm) continue; // malformed/incomplete folder; ignore

      const devices = new Map();
      for (const k of kids) {
        if (k.id === urlBm.id) continue;
        const info = parseDeviceStatusUrl(k.url);
        if (!info) continue;
        if (!devices.has(k.title)) devices.set(k.title, []);
        devices.get(k.title).push({ id: k.id, ...info });
      }

      const existing = byUrl.get(urlBm.url);
      if (existing) {
        for (const [devName, list] of devices) {
          for (const entry of list) {
            try {
              await env.bookmarks.move(entry.id, { parentId: existing.folderId });
            } catch (e) {}
            if (!existing.devices.has(devName)) existing.devices.set(devName, []);
            existing.devices.get(devName).push(entry);
          }
        }
        try {
          await env.bookmarks.removeTree(folder.id);
        } catch (e) {}
      } else {
        byUrl.set(urlBm.url, {
          folderId: folder.id,
          folderTitle: folder.title,
          urlBookmarkId: urlBm.id,
          devices,
        });
      }
    }
    return byUrl;
  }

  // Registers/refreshes THIS device's own "open" entries against its
  // live tabs. Safe to call from anywhere — it only ever creates a new
  // URL folder, creates/refreshes an "open" entry, or revives a
  // "closed" one a tab was genuinely reopened at; it never closes
  // anything.
  async function reconcileMyOpenEntries(profileFolderId, deviceName) {
    const entries = await readProfileEntries(profileFolderId);

    // Defensive: collapse any duplicate status bookmarks for MY OWN
    // device within a folder (a sync-tool race) down to the most
    // recently changed one.
    for (const folderEntry of entries.values()) {
      const mineList = folderEntry.devices.get(deviceName);
      if (mineList && mineList.length > 1) {
        mineList.sort((a, b) => b.t - a.t);
        const [keep, ...dupes] = mineList;
        for (const d of dupes) {
          try {
            await env.bookmarks.remove(d.id);
          } catch (e) {}
        }
        folderEntry.devices.set(deviceName, [keep]);
      }
    }

    const { urls: current, titleByUrl } = await snapshotOwnTabs();
    const now = Date.now();
    const heartbeatMs = await heartbeatIntervalMs();

    for (const url of current) {
      const folderEntry = entries.get(url);
      const mine = folderEntry && folderEntry.devices.get(deviceName)?.[0];
      const title = titleByUrl.get(url) || url;

      if (!folderEntry) {
        try {
          const folder = await env.bookmarks.create({
            parentId: profileFolderId,
            title: folderTitleFor(title, url),
          });
          await env.bookmarks.create({
            parentId: folder.id,
            title: URL_MARKER_TITLE,
            url,
          });
          await env.bookmarks.create({
            parentId: folder.id,
            title: deviceName,
            url: buildDeviceStatusUrl({ state: "open", t: now, h: now }),
          });
        } catch (e) {}
      } else if (!mine) {
        try {
          await env.bookmarks.create({
            parentId: folderEntry.folderId,
            title: deviceName,
            url: buildDeviceStatusUrl({ state: "open", t: now, h: now }),
          });
        } catch (e) {}
      } else if (mine.state === "closed") {
        // Genuine reopen: always safe to record, regardless of when
        // it's detected.
        try {
          await env.bookmarks.update(mine.id, {
            url: buildDeviceStatusUrl({ state: "open", t: now, h: now }),
          });
        } catch (e) {}
      } else if (now - mine.h > heartbeatMs) {
        // Still open: only bump the heartbeat, never `t` — otherwise a
        // routine liveness touch could outrace a genuine close recorded
        // elsewhere (the exact race fixed in 2.6.2).
        try {
          await env.bookmarks.update(mine.id, {
            url: buildDeviceStatusUrl({ state: "open", t: mine.t, h: now }),
          });
        } catch (e) {}
      }
    }
  }

  // Flips THIS device's own entry to "closed" for URLs it had tracked
  // as open but no longer has live. ONLY ever called from
  // handleTabRemoved / handleTabUpdated.
  async function closeMyGoneTabs(profileFolderId, deviceName) {
    const entries = await readProfileEntries(profileFolderId);
    const { urls: current } = await snapshotOwnTabs();
    const now = Date.now();
    for (const [url, folderEntry] of entries) {
      const mine = folderEntry.devices.get(deviceName)?.[0];
      if (!mine || mine.state !== "open") continue;
      if (current.has(url)) continue;
      try {
        await env.bookmarks.update(mine.id, {
          url: buildDeviceStatusUrl({ state: "closed", t: now, h: now }),
        });
      } catch (e) {}
    }
  }

  // Mirrors the shared state onto this device's live tabs, and deletes
  // any URL folder every device has now closed. Per-device state is
  // NOT re-derived from a cross-device timestamp vote (the old model):
  // once THIS device's own entry says "closed", it stays closed here
  // regardless of what other devices still show — only this device's
  // own genuine open/close actions (reconcileMyOpenEntries /
  // closeMyGoneTabs) ever change it. A device that hasn't weighed in
  // yet (no entry of its own) mirrors in whatever's open elsewhere.
  async function reconcileMirror(profileFolderId, deviceName) {
    const entries = await readProfileEntries(profileFolderId);
    const { allUrls } = await snapshotOwnTabs();

    const toOpen = [];
    const foldersToDelete = [];

    for (const [url, folderEntry] of entries) {
      const allEntries = [];
      for (const list of folderEntry.devices.values()) allEntries.push(...list);
      if (allEntries.length === 0) continue; // malformed folder, leave for cleanupProfileFolder

      const allClosed = allEntries.every((e) => e.state === "closed");
      if (allClosed) {
        foldersToDelete.push(folderEntry.folderId);
        continue;
      }

      const mine = folderEntry.devices.get(deviceName)?.[0];
      if (mine) continue; // I've already weighed in (open or closed) — never overridden by others

      const anyOpen = allEntries.some((e) => e.state === "open");
      // Duplicate-open check uses `allUrls` (pinned/grouped tabs
      // included): a URL the user already has open there is still
      // "already here" and must not get a second, untracked tab opened
      // next to it. There's no "close a local tab" branch here — under
      // this model only THIS device's own genuine close (via
      // closeMyGoneTabs) ever closes its own tab; see the function
      // comment above.
      if (anyOpen && !allUrls.has(url)) {
        toOpen.push({ url, title: folderEntry.folderTitle || url });
      }
    }

    for (const folderId of foldersToDelete) {
      try {
        await env.bookmarks.removeTree(folderId);
      } catch (e) {}
    }
    if (toOpen.length) {
      await performAdd(toOpen);
    }
    if (toOpen.length || foldersToDelete.length) {
      await env.storage.local.set({ lastActivityTimestamp: Date.now() });
    }
  }

  // TTL sweep for a profile: deletes an ENTIRE url folder once nothing
  // in it has been touched (any device's heartbeat) in `ttlDays` — the
  // safety net for a topic nobody's device is still actively
  // maintaining. Also deletes any folder where every device already
  // agrees "closed" (unconditional, not gated on TTL being enabled) —
  // this duplicates reconcileMirror's own immediate check, run here too
  // as a periodic backstop in case that event-driven pass was ever
  // missed.
  // TTL is evaluated PER DEVICE ENTRY, not per folder: pruning only the
  // stale entry (not the whole folder) is what keeps a device that's
  // gone for good from leaving a permanent "ghost open" marker that
  // other devices keep mirroring in, while a folder still genuinely
  // maintained by at least one other device is left alone. The folder
  // itself is only ever deleted as a CONSEQUENCE of that pruning (or of
  // reconcileMirror's own immediate check) — once every entry left in
  // it is closed, or none are left at all.
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
    const entries = await readProfileEntries(profileFolder.id);

    if (enabled) {
      for (const folderEntry of entries.values()) {
        for (const list of folderEntry.devices.values()) {
          for (const entry of list) {
            if (now - (entry.h || entry.t || 0) > ttlMs) {
              try {
                await env.bookmarks.remove(entry.id);
              } catch (e) {}
              entry.removedByTtl = true;
            }
          }
        }
      }
    }

    for (const folderEntry of entries.values()) {
      const remaining = [];
      for (const list of folderEntry.devices.values()) {
        for (const entry of list) if (!entry.removedByTtl) remaining.push(entry);
      }
      const allClosed =
        remaining.length > 0 && remaining.every((e) => e.state === "closed");
      if (allClosed || remaining.length === 0) {
        try {
          await env.bookmarks.removeTree(folderEntry.folderId);
        } catch (e) {}
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
    await reconcileMirror(profileFolder.id, deviceName);
    // Re-sync once more: the mirror pass may have opened tabs locally,
    // so make sure this device's own entries reflect that too.
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
  // are open elsewhere but not here yet. Dedup uses `allUrls` (grouped
  // tabs included) — same reasoning as reconcileMirror's own check.
  async function performAdd(entries) {
    const lazy = await openRestoredLazily();
    const { allUrls: alreadyOpen } = await snapshotOwnTabs();
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

  // Reaction to a remote (or our own) tab-entry bookmark change: an
  // `_url` marker's creation, or a device status bookmark's creation/
  // update. Never triggers a close — see the safety rule.
  function handleBookmarkEvent(title, url) {
    if (!isRelevantBookmarkChange(title, url)) return reconcileTail;
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
    readProfileEntries,
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
    URL_MARKER_TITLE,
    STATUS_URL_BASE,
    OTHER_BOOKMARKS_PARENT_ID,
    FIREFOX_UNFILED_ID,
    isHttpUrl,
    buildDeviceStatusUrl,
    parseDeviceStatusUrl,
    isRelevantBookmarkChange,
    createSyncEngine,
  };
}
