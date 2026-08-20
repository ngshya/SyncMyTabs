// ============================================================
// SyncMyTabs - background.js (service worker, Manifest V3)
//
// Architecture (v3 — per-tab shared metadata, see CLAUDE.md):
// - Root bookmarks folder: "SyncMyTabs"
// - Under it: one subfolder per PROFILE (e.g. "default", "work").
//   Profiles are now the top-level unit — there is no more per-device
//   folder. A device picks which profile is "active"; automatic sync
//   only ever happens for the active profile (profiles stay independent).
// - Inside each profile folder: one bookmark per (device, url) pair —
//   the tab's real title, and its metadata packed into the bookmark's
//   URL: which device, open/closed state, and two timestamps (see
//   parseTabEntryUrl/buildTabEntryUrl below).
// - Every device is the ONLY writer of its OWN (device, url) entries.
//   Opening a tab creates/updates that device's entry to "open"; closing
//   it flips the SAME entry to "closed" (never deleted immediately) so
//   the closure is an observable, explicit event other devices react
//   to. Once EVERY entry for a URL is "closed", any device that notices
//   deletes the whole group. A configurable TTL is a safety net that
//   deletes stale entries outright (e.g. a device that was uninstalled
//   and will never come back to agree "closed").
// - No more notifications / manual Add-Replace flow: this is always a
//   live two-way mirror for the active profile. A manual "restore from
//   device" action still exists in the popup for peeking at another
//   profile's currently-open tabs on demand.
// ============================================================

// Cross-browser API access: use the promise-based `browser.*` namespace
// everywhere. On Firefox it's native; in the Chrome service worker we
// load Mozilla's WebExtension polyfill (which defines `browser` on top of
// `chrome`). On Firefox the polyfill is loaded via manifest
// `background.scripts` instead, and `importScripts` doesn't exist on the
// event page — so guard the call.
if (typeof importScripts === "function") {
  importScripts("browser-polyfill.min.js");
}

const ROOT_NAME = "SyncMyTabs";
// Previous names this extension has had. If the current-name root
// folder doesn't exist yet but one of these does, we rename it in
// place (instead of creating a fresh, disconnected folder) so
// existing synced data isn't orphaned by the rename.
const LEGACY_ROOT_NAMES = ["OpenTabSync", "Live Tabs Sync"];

const DEFAULT_PROFILE = "default";
const DEFAULT_TTL_DAYS = 21;

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

// Lazy-restore placeholder page (see lazy.html / lazy.js). When lazy
// restore is enabled, mirrored-in tabs point at this local page with
// the real target encoded as ?u=<url>&t=<title>; the page navigates to
// the real URL only when the tab first becomes visible, so nothing is
// fetched from the network until the user actually opens the tab.
const LAZY_PAGE = browser.runtime.getURL("lazy.html");

function lazyUrlFor(entry) {
  return (
    `${LAZY_PAGE}?u=${encodeURIComponent(entry.url)}` +
    `&t=${encodeURIComponent(entry.title || "")}`
  );
}

// The real http(s) target of a tab. For a lazy-restore placeholder tab
// (still unopened) this is the encoded `u` param; for any other tab
// it's just its URL.
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

function isHttpUrl(u) {
  return /^https?:\/\//.test(u || "");
}

// "Other Bookmarks" folder id: "2" on Chrome/Brave, "unfiled_____" on
// Firefox. We resolve it at runtime from the bookmark tree rather than
// hardcoding, and only fall back to these known ids.
const OTHER_BOOKMARKS_PARENT_ID = "2";
const FIREFOX_UNFILED_ID = "unfiled_____";

let cachedRootParentId = null;
async function getRootParentId() {
  if (cachedRootParentId) return cachedRootParentId;
  try {
    const tree = await browser.bookmarks.getTree();
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

// ------------------------------------------------------------
// Root folder: find-or-create, consolidating duplicates and
// migrating a legacy-named folder in place (same node, so the rename
// propagates via sync instead of creating a disconnected duplicate).
// ------------------------------------------------------------
async function getOrCreateRootFolder() {
  const results = await browser.bookmarks.search({ title: ROOT_NAME });
  const folders = results.filter((b) => !b.url);

  if (folders.length > 0) {
    if (folders.length === 1) return folders[0];
    folders.sort((a, b) => (a.dateAdded || 0) - (b.dateAdded || 0));
    const [canonical, ...duplicates] = folders;
    for (const dup of duplicates) await mergeFolderInto(dup.id, canonical.id);
    return canonical;
  }

  for (const legacyName of LEGACY_ROOT_NAMES) {
    const legacyResults = await browser.bookmarks.search({ title: legacyName });
    const legacyFolders = legacyResults.filter((b) => !b.url);
    if (legacyFolders.length === 0) continue;

    legacyFolders.sort((a, b) => (a.dateAdded || 0) - (b.dateAdded || 0));
    const [canonical, ...duplicates] = legacyFolders;
    for (const dup of duplicates) await mergeFolderInto(dup.id, canonical.id);
    await browser.bookmarks.update(canonical.id, { title: ROOT_NAME });
    return canonical;
  }

  const parentId = await getRootParentId();
  return browser.bookmarks.create({ parentId, title: ROOT_NAME });
}

// Moves all content of sourceFolderId into targetFolderId. Same-named
// SUBFOLDERS are merged recursively (this is what consolidates two
// duplicate root folders, each holding profile subfolders). Bookmark
// children (tab entries) are just moved over unconditionally — unlike
// the old fixed-title metadata bookmarks, there's no single "the"
// entry to dedupe by title here; any incidental (device,url) duplicate
// left behind is cleaned up defensively by reconcileMyOpenEntries the
// next time that device runs its own reconcile.
async function mergeFolderInto(sourceFolderId, targetFolderId) {
  const children = await browser.bookmarks.getChildren(sourceFolderId);
  const targetChildren = await browser.bookmarks.getChildren(targetFolderId);

  for (const child of children) {
    const match = targetChildren.find(
      (t) => t.title === child.title && !t.url === !child.url
    );
    if (match && !match.url && !child.url) {
      await mergeFolderInto(child.id, match.id);
      try {
        await browser.bookmarks.remove(child.id);
      } catch (e) {}
    } else {
      try {
        await browser.bookmarks.move(child.id, { parentId: targetFolderId });
      } catch (e) {}
    }
  }

  try {
    await browser.bookmarks.removeTree(sourceFolderId);
  } catch (e) {}
}

// Find-or-create the folder for a profile, directly under root.
async function getOrCreateProfileFolder(profile) {
  const root = await getOrCreateRootFolder();
  const children = await browser.bookmarks.getChildren(root.id);
  const matches = children.filter((c) => !c.url && c.title === profile);

  if (matches.length === 0) {
    return browser.bookmarks.create({ parentId: root.id, title: profile });
  }
  if (matches.length === 1) return matches[0];

  matches.sort((a, b) => (a.dateAdded || 0) - (b.dateAdded || 0));
  const [canonical, ...dups] = matches;
  for (const d of dups) await mergeFolderInto(d.id, canonical.id);
  return canonical;
}

async function getActiveProfile() {
  const { activeProfile } = await browser.storage.local.get("activeProfile");
  return activeProfile || DEFAULT_PROFILE;
}

// ------------------------------------------------------------
// Tab-entry bookmark encoding: see the header comment for the schema
// and why `t` (state-change time) and `h` (heartbeat time) are kept
// separate.
// ------------------------------------------------------------
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

// Tabs opened for an explicit, one-off "peek" at a NON-active profile
// (see MANUAL_RESTORE) are deliberately excluded from tracking — they
// must never register themselves under the wrong (active) profile.
// In-memory only: if the service worker restarts before such a tab is
// closed, it could start being tracked on the next reconcile. Low-harm,
// rare edge case for a manual, occasional action — not worth the extra
// durability machinery the real close-tracking needs.
const manualPeekTabIds = new Set();

// Snapshot of this device's own currently-open, real (non-placeholder-
// pending, http/https) tabs: which URLs, their titles, and which tab
// ids show each URL (placeholders resolve to their real target via
// realUrlOfTab, and still count as "open" — a placeholder is still a
// tab this device has, even before the user has looked at it).
//
// Tabs still mid-navigation (status !== "complete") are excluded
// entirely. A tab's url/pendingUrl can pass through one or more
// transient values while loading (a redirect chain, for instance) —
// registering one of those as "open" would create a permanent phantom
// entry for a URL nothing actually displays once the navigation
// settles (nothing would ever close it, since the tab itself never
// goes away, it just finishes loading). Waiting for "complete" is the
// same guard tabs.onUpdated's own listener already applies; this
// extends it to the other reconcile triggers (alarm, bookmark events)
// that aren't gated on any one tab's load state.
async function snapshotOwnTabs() {
  const urls = new Set();
  const titleByUrl = new Map();
  const tabIdsByUrl = new Map();
  for (const t of await browser.tabs.query({})) {
    if (manualPeekTabIds.has(t.id)) continue;
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

const DEFAULT_INTERVAL_MINUTES = 1;

async function ensureAlarm() {
  const { syncIntervalMinutes } = await browser.storage.local.get(
    "syncIntervalMinutes"
  );
  const period = syncIntervalMinutes || DEFAULT_INTERVAL_MINUTES;
  browser.alarms.create("saveTabsAlarm", { periodInMinutes: period });
}

// Master on/off switch. When paused, this device neither pushes its own
// tab state nor reacts to other devices' updates. Default ON.
async function isSyncEnabled() {
  const { syncEnabled } = await browser.storage.local.get("syncEnabled");
  return syncEnabled !== false;
}

function updateActionIcon(enabled) {
  const suffix = enabled ? "" : "-off";
  browser.action.setIcon({
    path: {
      16: `icons/icon16${suffix}.png`,
      48: `icons/icon48${suffix}.png`,
      128: `icons/icon128${suffix}.png`,
    },
  });
  browser.action.setBadgeText({ text: enabled ? "" : "OFF" });
  browser.action.setBadgeBackgroundColor({ color: "#64748b" });
}

async function refreshActionIcon() {
  updateActionIcon(await isSyncEnabled());
}

// How often a still-open, still-tracked entry gets its heartbeat (`h`)
// bumped — often enough to comfortably outrun the TTL, rarely enough to
// not spam bookmark writes for tabs nobody touched. Capped at 1 day;
// scaled down for a short custom TTL so it always refreshes at least
// 3x within the window.
async function heartbeatIntervalMs() {
  const oneDay = 24 * 60 * 60 * 1000;
  const { ttlEnabled, ttlDays } = await browser.storage.local.get([
    "ttlEnabled",
    "ttlDays",
  ]);
  if (ttlEnabled === false) return oneDay;
  const days = ttlDays || DEFAULT_TTL_DAYS;
  return Math.min(oneDay, (days * oneDay) / 3);
}

// ============================================================
// Reconcile pipeline.
//
// SAFETY RULE (do not weaken this without a lot of thought): a device
// only ever flips one of ITS OWN entries from open -> closed inside
// closeMyGoneTabs, and closeMyGoneTabs is only ever called in reaction
// to a real, specific, live tab event for THIS device — tabs.onRemoved
// (guarded against isWindowClosing) or tabs.onUpdated once a navigation
// completes (so navigating a tab to a new URL, without closing the tab,
// is treated as closing the old URL and opening the new one — both are
// genuine local state changes reported by the browser while it's
// definitely running normally). It is deliberately NEVER called from
// the alarm, startup, or a bookmark-change reaction, because those
// aren't tied to any one tab's event — they just compare "what's
// tracked as open" against a live browser.tabs.query() snapshot that
// ISN'T guaranteed to be complete at those moments — most notably right
// after startup, before session restore has finished repopulating
// windows. Treating that gap as "the user closed everything" would
// tombstone (and propagate-close) a device's entire session just
// because it started up slowly. Opening/mirroring, by contrast, is
// always safe to run broadly: at worst a not-yet-visible tab is
// registered a little late, which self-heals on the next trigger —
// never destructive.
// ============================================================

// Registers/refreshes THIS device's own "open" entries against its
// live tabs. Safe to call from anywhere (alarm, startup, bookmark
// events, tab updates) — it only ever creates/refreshes "open" entries
// or revives a "closed" one a tab was genuinely reopened at; it never
// closes anything.
async function reconcileMyOpenEntries(profileFolderId, deviceName) {
  const children = await browser.bookmarks.getChildren(profileFolderId);
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
      await browser.bookmarks.remove(id);
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
        await browser.bookmarks.create({
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
      // Genuine reopen: always safe to record, regardless of when it's
      // detected.
      try {
        await browser.bookmarks.update(entry.id, {
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
      // elsewhere (the exact race fixed in 2.6.2, now structurally
      // impossible since heartbeats can't touch `t`).
      try {
        await browser.bookmarks.update(entry.id, {
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

// Flips THIS device's own entries to "closed" for URLs it had tracked
// as open but no longer has live. ONLY ever called from tabs.onRemoved
// or tabs.onUpdated(complete) — see the safety rule above.
async function closeMyGoneTabs(profileFolderId, deviceName) {
  const children = await browser.bookmarks.getChildren(profileFolderId);
  const { urls: current } = await snapshotOwnTabs();
  const now = Date.now();
  for (const c of children) {
    const info = parseTabEntryUrl(c.url);
    if (!info || info.device !== deviceName || info.state !== "open") continue;
    if (current.has(info.real)) continue;
    try {
      await browser.bookmarks.update(c.id, {
        url: buildTabEntryUrl({ ...info, state: "closed", t: now, h: now }),
      });
    } catch (e) {}
  }
}

// Mirrors the group's aggregate state onto this device's live tabs:
// opens URLs that are present (open) elsewhere and missing here, closes
// local tabs whose URL's group has gone fully quiet (no entry newer
// than the newest close). Reading straight from bookmark data — not a
// live-tab snapshot comparison — so unlike closeMyGoneTabs this is safe
// to run broadly, including at startup: it only ever acts on a URL it
// can currently see as genuinely live, so a tab that hasn't finished
// being restored yet is simply left alone until a later pass sees it.
async function reconcileMirror(profileFolderId) {
  const children = await browser.bookmarks.getChildren(profileFolderId);
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
    const latestOpenT = openEntries.reduce((m, e) => Math.max(m, e.t), -Infinity);
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
      await browser.tabs.remove(idsToClose);
    } catch (e) {}
  }
  if (toOpen.length) {
    await performAdd(toOpen);
    await browser.storage.local.set({ lastActivityTimestamp: Date.now() });
  } else if (idsToClose.length) {
    await browser.storage.local.set({ lastActivityTimestamp: Date.now() });
  }
}

// TTL sweep + closed-group cleanup for a profile. Any device can run
// this for any URL group — by the time every entry agrees "closed", or
// an entry has gone stale past the TTL, nobody is going to write to it
// again, so deleting it is not a race, just tidying up inert data.
async function cleanupProfileFolder(profile) {
  const { ttlEnabled, ttlDays } = await browser.storage.local.get([
    "ttlEnabled",
    "ttlDays",
  ]);
  const enabled = ttlEnabled !== false; // default ON
  const days = ttlDays || DEFAULT_TTL_DAYS;
  const ttlMs = days * 24 * 60 * 60 * 1000;
  const now = Date.now();

  const profileFolder = await getOrCreateProfileFolder(profile);
  let children = await browser.bookmarks.getChildren(profileFolder.id);

  if (enabled) {
    const stale = children.filter((c) => {
      const info = parseTabEntryUrl(c.url);
      if (!info) return false;
      return now - (info.h || info.t) > ttlMs;
    });
    for (const c of stale) {
      try {
        await browser.bookmarks.remove(c.id);
      } catch (e) {}
    }
    if (stale.length) children = await browser.bookmarks.getChildren(profileFolder.id);
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
          await browser.bookmarks.remove(e.id);
        } catch (err) {}
      }
    }
  }
}

async function runReconcile({ checkClosed } = {}) {
  if (!(await isSyncEnabled())) return;
  const { deviceName } = await browser.storage.local.get("deviceName");
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

// Serializes all reconcile runs (never overlap two in flight — avoids
// interleaved reads/writes racing each other) and coalesces bursts of
// triggers into at most one extra run after the current one finishes.
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

// Whether restored tabs should open lazily (as a placeholder that
// doesn't hit the network until the tab is first viewed). Default ON.
async function openRestoredLazily() {
  const { openRestoredLazy } = await browser.storage.local.get(
    "openRestoredLazy"
  );
  return openRestoredLazy !== false;
}

// Opens `entries` ({url,title}) alongside the current tabs (skipping
// any already open). `opts.exemptFromTracking` marks the newly created
// tabs so they never register themselves under the active profile —
// used for MANUAL_RESTORE of a profile other than the active one (a
// one-off peek, not a join).
async function performAdd(entries, opts = {}) {
  const lazy = await openRestoredLazily();
  const { urls: alreadyOpen } = await snapshotOwnTabs();
  const toOpen = entries.filter((e) => !alreadyOpen.has(e.url));
  if (toOpen.length === 0) return;

  let targetWindow;
  try {
    targetWindow = await browser.windows.getLastFocused({
      windowTypes: ["normal"],
    });
  } catch (e) {
    targetWindow = null;
  }

  const createdIds = [];
  if (targetWindow) {
    for (const entry of toOpen) {
      try {
        const tab = await browser.tabs.create({
          windowId: targetWindow.id,
          url: lazy ? lazyUrlFor(entry) : entry.url,
          active: !lazy,
        });
        createdIds.push(tab.id);
      } catch (e) {}
    }
  } else {
    let win;
    try {
      win = await browser.windows.create({
        url: toOpen.map((e) => (lazy ? lazyUrlFor(e) : e.url)),
      });
    } catch (e) {
      win = null;
    }
    for (const t of (win && win.tabs) || []) createdIds.push(t.id);
  }

  if (opts.exemptFromTracking) {
    for (const id of createdIds) manualPeekTabIds.add(id);
  }
}

async function performReplace(entries, opts = {}) {
  const lazy = await openRestoredLazily();
  const openUrls = entries.map((e) => (lazy ? lazyUrlFor(e) : e.url));

  const oldWindows = await browser.windows.getAll({ populate: false });
  const oldWindowIds = oldWindows.map((w) => w.id);

  let created;
  try {
    created = await browser.windows.create({ url: openUrls });
  } catch (e) {
    created = null;
  }
  if (!created) return;

  if (opts.exemptFromTracking) {
    for (const t of created.tabs || []) manualPeekTabIds.add(t.id);
  }

  for (const winId of oldWindowIds) {
    try {
      await browser.windows.remove(winId);
    } catch (e) {}
  }
}

// ------------------------------------------------------------
// Listing helpers for the popup/options UI.
// ------------------------------------------------------------
async function listAllKnownProfiles() {
  const root = await getOrCreateRootFolder();
  const children = await browser.bookmarks.getChildren(root.id);
  const found = new Set();
  for (const c of children) if (!c.url) found.add(c.title);
  const { profiles } = await browser.storage.local.get("profiles");
  for (const p of profiles || []) found.add(p);
  found.add(DEFAULT_PROFILE);
  return Array.from(found).sort();
}

async function listDevicesForProfile(profile) {
  const profileFolder = await getOrCreateProfileFolder(profile);
  const children = await browser.bookmarks.getChildren(profileFolder.id);
  const found = new Set();
  for (const c of children) {
    const info = parseTabEntryUrl(c.url);
    if (info && info.state === "open") found.add(info.device);
  }
  return Array.from(found).sort();
}

async function getOpenEntriesForDeviceProfile(device, profile) {
  const profileFolder = await getOrCreateProfileFolder(profile);
  const children = await browser.bookmarks.getChildren(profileFolder.id);
  const out = [];
  for (const c of children) {
    const info = parseTabEntryUrl(c.url);
    if (info && info.device === device && info.state === "open") {
      out.push({ url: info.real, title: c.title });
    }
  }
  return out;
}

// ------------------------------------------------------------
// Lifecycle & event wiring.
// ------------------------------------------------------------
browser.runtime.onInstalled.addListener(async () => {
  ensureAlarm();
  refreshActionIcon();
  const { deviceName, profiles } = await browser.storage.local.get([
    "deviceName",
    "profiles",
  ]);
  if (!profiles || profiles.length === 0) {
    await browser.storage.local.set({
      profiles: [DEFAULT_PROFILE],
      activeProfile: DEFAULT_PROFILE,
    });
  }
  if (!deviceName) {
    browser.runtime.openOptionsPage();
  }
});

browser.runtime.onStartup.addListener(async () => {
  ensureAlarm();
  refreshActionIcon();
  // No checkClosed here: session restore may still be repopulating
  // windows, so a live-tab snapshot right now can't be trusted for
  // deciding what's been closed. See the safety rule above
  // reconcileMyOpenEntries.
  await scheduleReconcile();
  const profile = await getActiveProfile();
  await cleanupProfileFolder(profile);
});

browser.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm.name !== "saveTabsAlarm") return;
  await scheduleReconcile();
  const profile = await getActiveProfile();
  await cleanupProfileFolder(profile);
});

browser.storage.onChanged.addListener((changes, area) => {
  if (area !== "local") return;
  if (changes.syncIntervalMinutes) ensureAlarm();
  if (changes.syncEnabled) {
    updateActionIcon(changes.syncEnabled.newValue !== false);
  }
});

// One of the two places a close is ever detected — see the safety rule
// above.
browser.tabs.onRemoved.addListener((tabId, removeInfo) => {
  manualPeekTabIds.delete(tabId);
  if (removeInfo && removeInfo.isWindowClosing) return; // shutdown/window close
  scheduleReconcile({ checkClosed: true });
});

// The other place a close is ever detected — see the safety rule above.
// A completed navigation both registers the tab's new URL as open and
// checks for gone URLs, so navigating an open tab to a different
// address is treated as closing the old one and opening the new one —
// not just a silent in-place update. Safe to run on every completed
// navigation: this fires per specific tab while the browser is
// definitely running normally, never during a startup/restore race.
browser.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (changeInfo.status !== "complete") return;
  scheduleReconcile({ checkClosed: true });
});

function isTabEntryBookmark(url) {
  return !!parseTabEntryUrl(url);
}

browser.bookmarks.onCreated.addListener((id, node) => {
  if (!node || !isTabEntryBookmark(node.url)) return;
  scheduleReconcile();
});

browser.bookmarks.onChanged.addListener((id, changeInfo) => {
  if (!changeInfo || !isTabEntryBookmark(changeInfo.url)) return;
  scheduleReconcile();
});

browser.bookmarks.onRemoved.addListener(() => {
  // Cheap either way (the mutex/coalescing bounds the cost); a removal
  // elsewhere in the bookmark tree just results in a reconcile pass
  // that finds nothing to do.
  scheduleReconcile();
});

// ------------------------------------------------------------
// Messages from the popup/options UI.
// ------------------------------------------------------------
browser.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.type === "SYNC_NOW") {
    (async () => {
      // Explicit, in-session user action — safe context for checkClosed.
      await scheduleReconcile({ checkClosed: true });
      const profile = await getActiveProfile();
      await cleanupProfileFolder(profile);
      sendResponse({ ok: true });
    })();
    return true;
  }

  if (message?.type === "GET_ALL_KNOWN_PROFILES") {
    listAllKnownProfiles().then((profiles) => sendResponse({ profiles }));
    return true;
  }

  if (message?.type === "GET_DEVICES_FOR_PROFILE") {
    listDevicesForProfile(message.profile).then((devices) =>
      sendResponse({ devices })
    );
    return true;
  }

  if (message?.type === "MANUAL_RESTORE") {
    (async () => {
      const { device, profile, mode } = message;
      const resolvedProfile = profile || DEFAULT_PROFILE;
      const entries = await getOpenEntriesForDeviceProfile(
        device,
        resolvedProfile
      );
      if (entries.length === 0) {
        sendResponse({ ok: false, reason: "no-tabs" });
        return;
      }
      const activeProfile = await getActiveProfile();
      const opts = { exemptFromTracking: resolvedProfile !== activeProfile };
      if (mode === "replace") {
        await performReplace(entries, opts);
      } else {
        await performAdd(entries, opts);
      }
      sendResponse({ ok: true });
    })();
    return true;
  }

  if (message?.type === "SWITCH_PROFILE_AND_SAVE") {
    (async () => {
      // Explicit, in-session user action — safe context for checkClosed.
      await scheduleReconcile({ checkClosed: true });
      sendResponse({ ok: true });
    })();
    return true;
  }

  if (message?.type === "ADD_PROFILE") {
    (async () => {
      const { profiles } = await browser.storage.local.get("profiles");
      const list = profiles && profiles.length ? profiles : [DEFAULT_PROFILE];
      const name = message.name.trim();
      const exists = list.some((p) => p.toLowerCase() === name.toLowerCase());
      if (!exists) {
        await browser.storage.local.set({ profiles: [...list, name] });
      }
      sendResponse({ ok: true });
    })();
    return true;
  }
});
