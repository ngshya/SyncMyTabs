// ============================================================
// SyncMyTabs - background.js (service worker, Manifest V3)
// (previously named OpenTabSync / Live Tabs Sync)
//
// Architecture (as agreed during design):
// - Root bookmarks folder: "SyncMyTabs"
// - Under it: one subfolder per device, named by the user on first
//   run (e.g. "manjaro-vivobook")
// - Under each device: one subfolder per PROFILE (e.g. "default",
//   "work", "school"). A device can have several profiles; the user
//   picks which one is "active" at any time, and open tabs are
//   saved/restored per profile, not globally per device.
// - Every N minutes (configurable, default 1): saves the ACTIVE
//   profile's open tabs into <device>/<active profile>/, clearing
//   and repopulating that folder with title+URL of all open tabs
//   (all windows, flat list). Tabs with the same URL are deduped.
// - Each device/profile folder also holds a "_last_sync" bookmark
//   (fixed title, updated in place) with that profile's last save
//   timestamp. It's metadata only, never treated as a tab.
// - Each device folder holds a "_status" bookmark (fixed title,
//   updated in place) encoding that device's last save: device +
//   active profile + timestamp. One per device, so devices/profiles
//   never overwrite each other's signal. Other devices react via
//   bookmarks.onChanged / onCreated (event-driven, no polling),
//   tracking a per-source "last seen" timestamp so a newer update is
//   never skipped because another source has a faster clock, and show
//   a notification with two buttons: "Replace" / "Add". No automatic
//   opening. (Older versions kept a single root "_status"; it's read
//   for back-compat and each device removes its own on upgrade.)
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

const STATUS_TITLE = "_status"; // always fixed, never holds variable data
const STATUS_URL_BASE = "https://syncmytabs.local/status";
const LAST_SYNC_TITLE = "_last_sync"; // per-device-profile metadata, never a tab
const LAST_SYNC_URL_BASE = "https://syncmytabs.local/last-sync";
// Per-profile metadata bookmark holding pinned/tab-group info as a
// compact JSON payload (see updateTabMetaBookmark). Never a tab.
const TAB_META_TITLE = "_tab_meta";
const TAB_META_URL_BASE = "https://syncmytabs.local/tab-meta";
// Per-device-profile "session events" for full two-way mirror: per-URL
// open times (o) and close tombstones (c) as JSON in the URL. Used to
// decide, across devices, whether a URL is currently open or was closed.
// Never a tab. See reconcileFullMirror / updateEventsBookmark.
const EVENTS_TITLE = "_events";
const EVENTS_URL_BASE = "https://syncmytabs.local/events";

const DEFAULT_PROFILE = "default";
const NOTIF_PREFIX = "syncmytabs-";

// Lazy-restore placeholder page (see lazy.html / lazy.js). When lazy
// restore is enabled, tabs are opened pointing at this local page with
// the real target encoded as ?u=<url>&t=<title>; the page navigates to
// the real URL only when the tab first becomes visible, so nothing is
// fetched from the network until the user actually opens the tab.
const LAZY_PAGE = browser.runtime.getURL("lazy.html");

// Build the placeholder URL for an entry. `source` ({device, profile})
// tags where the tab came from (sd/sp) so we can later mirror closes:
// an unopened placeholder can be matched back to the remote session it
// was restored from.
function lazyUrlFor(entry, source) {
  let url =
    `${LAZY_PAGE}?u=${encodeURIComponent(entry.url)}` +
    `&t=${encodeURIComponent(entry.title || "")}`;
  if (source && source.device) {
    url +=
      `&sd=${encodeURIComponent(source.device)}` +
      `&sp=${encodeURIComponent(source.profile || DEFAULT_PROFILE)}`;
  }
  return url;
}

// The real http(s) target of a tab. For a lazy-restore placeholder tab
// (still unopened) this is the encoded `u` param; for any other tab
// it's just its URL. Lets saveOpenTabs and de-duplication treat a
// not-yet-loaded placeholder as if it already pointed at the real page.
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

// If `tab` is an unopened lazy placeholder, returns { real, sd, sp }
// (real target URL and the source device/profile it was restored from);
// otherwise null. Once the user opens a placeholder it navigates to the
// real URL and this returns null — so it never matches an opened tab.
function placeholderInfo(tab) {
  const u = (tab && tab.url) || "";
  if (!u.startsWith(LAZY_PAGE)) return null;
  try {
    const p = new URL(u).searchParams;
    const real = p.get("u");
    if (!real) return null;
    return { real, sd: p.get("sd") || null, sp: p.get("sp") || null };
  } catch (e) {
    return null;
  }
}

// "Other Bookmarks" folder id: "2" on Chrome/Brave, "unfiled_____" on
// Firefox. We resolve it at runtime from the bookmark tree rather than
// hardcoding, and only fall back to these known ids.
const OTHER_BOOKMARKS_PARENT_ID = "2";
const FIREFOX_UNFILED_ID = "unfiled_____";

// Resolved lazily and cached: the id of the top-level folder under
// which the root "SyncMyTabs" folder should live ("Other Bookmarks"
// on Chrome/Brave, its equivalent elsewhere). Falls back to the
// Chrome/Brave id if the tree can't be inspected.
let cachedRootParentId = null;
async function getRootParentId() {
  if (cachedRootParentId) return cachedRootParentId;
  try {
    const tree = await browser.bookmarks.getTree();
    const topLevel = (tree && tree[0] && tree[0].children) || [];

    // Known "Other/Unfiled Bookmarks" ids: "2" (Chrome/Brave),
    // "unfiled_____" (Firefox).
    const known = topLevel.find(
      (c) =>
        c.id === OTHER_BOOKMARKS_PARENT_ID || c.id === FIREFOX_UNFILED_ID
    );
    if (known) {
      cachedRootParentId = known.id;
      return cachedRootParentId;
    }

    // Last-ditch fallback: the last top-level folder is conventionally
    // the "unfiled/other" bookmarks container.
    const folders = topLevel.filter((c) => !c.url);
    if (folders.length > 0) {
      cachedRootParentId = folders[folders.length - 1].id;
      return cachedRootParentId;
    }
  } catch (e) {
    // Ignore and fall through to the hardcoded default.
  }

  cachedRootParentId = OTHER_BOOKMARKS_PARENT_ID;
  return cachedRootParentId;
}

function extractTimestampFromStatusUrl(url) {
  try {
    return Number(new URL(url).searchParams.get("t")) || 0;
  } catch (e) {
    return 0;
  }
}

// ------------------------------------------------------------
// Utility: find (or create) the root folder.
// - If a folder with the CURRENT name already exists (possibly more
//   than one, e.g. a first-run race condition across devices), those
//   are consolidated: the oldest becomes canonical, the others'
//   content is merged into it and they're removed.
// - Otherwise, if a folder with one of the LEGACY names exists (from
//   before the SyncMyTabs rename), it's renamed in place — this
//   preserves the same bookmark node, so the rename propagates via
//   sync instead of creating a disconnected duplicate.
// - Otherwise, a new folder is created.
// ------------------------------------------------------------
async function getOrCreateRootFolder() {
  const results = await browser.bookmarks.search({ title: ROOT_NAME });
  const folders = results.filter((b) => !b.url); // folders have no "url"

  if (folders.length > 0) {
    if (folders.length === 1) return folders[0];

    folders.sort((a, b) => (a.dateAdded || 0) - (b.dateAdded || 0));
    const [canonical, ...duplicates] = folders;
    for (const dup of duplicates) {
      await mergeFolderInto(dup.id, canonical.id);
    }
    return canonical;
  }

  // No folder with the current name yet: look for a legacy-named one
  // to migrate instead of starting fresh.
  for (const legacyName of LEGACY_ROOT_NAMES) {
    const legacyResults = await browser.bookmarks.search({
      title: legacyName,
    });
    const legacyFolders = legacyResults.filter((b) => !b.url);
    if (legacyFolders.length === 0) continue;

    legacyFolders.sort((a, b) => (a.dateAdded || 0) - (b.dateAdded || 0));
    const [canonical, ...duplicates] = legacyFolders;
    for (const dup of duplicates) {
      await mergeFolderInto(dup.id, canonical.id);
    }
    await browser.bookmarks.update(canonical.id, { title: ROOT_NAME });
    return canonical;
  }

  const parentId = await getRootParentId();
  return browser.bookmarks.create({
    parentId,
    title: ROOT_NAME,
  });
}

// ------------------------------------------------------------
// Moves all content of sourceFolderId into targetFolderId, merging
// same-named subfolders recursively (works for both the device level
// and the profile level, since it's purely title-based and doesn't
// care how deep it's nesting) instead of leaving duplicates around.
// ------------------------------------------------------------
async function mergeFolderInto(sourceFolderId, targetFolderId) {
  const children = await browser.bookmarks.getChildren(sourceFolderId);
  const targetChildren = await browser.bookmarks.getChildren(targetFolderId);

  for (const child of children) {
    const match = targetChildren.find((t) => t.title === child.title);
    const bothFolders = match && !match.url && !child.url;
    const bothBookmarks = match && match.url && child.url;

    if (bothFolders) {
      await mergeFolderInto(child.id, match.id);
      try {
        await browser.bookmarks.remove(child.id);
      } catch (e) {}
    } else if (bothBookmarks && !isMetaTitle(child.title)) {
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

// ------------------------------------------------------------
// Utility: find (or create) a named subfolder under a given parent.
// Used both for the device level (under root) and the profile level
// (under a device folder) — same logic, different parent.
// ------------------------------------------------------------
async function getOrCreateSubfolder(parentId, name) {
  const children = await browser.bookmarks.getChildren(parentId);
  const existing = children.find((c) => !c.url && c.title === name);
  if (existing) return existing;
  return browser.bookmarks.create({ parentId, title: name });
}

async function clearTabBookmarks(folderId) {
  const children = await browser.bookmarks.getChildren(folderId);
  for (const child of children) {
    if (isProfileMetaTitle(child.title)) continue;
    await browser.bookmarks.remove(child.id);
  }
}

// A metadata bookmark that lives next to a device root ("_status") or
// inside a profile folder ("_last_sync" / "_tab_meta"). These are never
// treated as tabs.
function isMetaTitle(title) {
  return (
    title === STATUS_TITLE ||
    title === LAST_SYNC_TITLE ||
    title === TAB_META_TITLE ||
    title === EVENTS_TITLE
  );
}

function isProfileMetaTitle(title) {
  return (
    title === LAST_SYNC_TITLE ||
    title === TAB_META_TITLE ||
    title === EVENTS_TITLE
  );
}

// ------------------------------------------------------------
// Pinned/tab-group metadata for a profile is stored in one "_tab_meta"
// bookmark as JSON in its URL:
//   { groups: [ {t: title, c: color}, ... ],
//     tabs:   { "<url>": { p: 1?, g: <group index>? }, ... } }
// Only pinned or grouped tabs appear in `tabs`, so it stays small and
// is absent entirely when nobody uses pins/groups.
// ------------------------------------------------------------
function parseTabMeta(bookmark) {
  const empty = { groups: [], tabs: {} };
  if (!bookmark || !bookmark.url) return empty;
  try {
    const d = new URL(bookmark.url).searchParams.get("d");
    if (!d) return empty;
    const obj = JSON.parse(d);
    return {
      groups: Array.isArray(obj.groups) ? obj.groups : [],
      tabs: obj.tabs && typeof obj.tabs === "object" ? obj.tabs : {},
    };
  } catch (e) {
    return empty;
  }
}

// Build a restore-ready entry ({url, title, pinned, group, groupTitle,
// groupColor}) from a tab bookmark plus the parsed profile metadata.
function entryFromMeta(url, title, meta) {
  const m = meta.tabs[url] || {};
  const g =
    typeof m.g === "number" && meta.groups[m.g] ? meta.groups[m.g] : null;
  return {
    url,
    title,
    pinned: !!m.p,
    group: g ? m.g : null,
    groupTitle: g ? g.t : null,
    groupColor: g ? g.c : null,
  };
}

// Order-independent signature of a tab set including pinned/group
// identity, used to skip needless rewrites (a bookmark write triggers
// the user's sync tool). Title is intentionally excluded, matching the
// pre-existing "URLs only" change detection.
function tabSignature(entries) {
  return entries
    .map((e) => {
      const groupKey = e.pinned
        ? ""
        : e.groupTitle != null
        ? `${e.groupTitle}\x1f${e.groupColor || ""}`
        : "";
      return `${e.url}\x1e${e.pinned ? 1 : 0}\x1e${groupKey}`;
    })
    .sort()
    .join("\n");
}

async function getActiveProfile() {
  const { activeProfile } = await browser.storage.local.get("activeProfile");
  return activeProfile || DEFAULT_PROFILE;
}

// ============================================================
// Full two-way session mirror (opt-out; default ON).
//
// For devices on the SAME profile, opening/closing a tab on one device
// is reflected on the others. Each device records, per profile, per-URL
// OPEN times and CLOSE tombstones in an "_events" bookmark. Across all
// devices, a URL is considered open iff its newest open time is newer
// than its newest close time:
//   open(url)  <=>  max(openTime) > max(closeTime)
// Reconciliation then closes local tabs no longer open, and opens ones
// that are. See reconcileFullMirror.
// ============================================================
async function fullMirrorEnabled() {
  const { fullSessionMirror } = await browser.storage.local.get(
    "fullSessionMirror"
  );
  return fullSessionMirror !== false; // default ON
}

function parseEvents(bookmark) {
  const empty = { o: {}, c: {} };
  if (!bookmark || !bookmark.url) return empty;
  try {
    const d = new URL(bookmark.url).searchParams.get("d");
    if (!d) return empty;
    const obj = JSON.parse(d);
    return {
      o: obj.o && typeof obj.o === "object" ? obj.o : {},
      c: obj.c && typeof obj.c === "object" ? obj.c : {},
    };
  } catch (e) {
    return empty;
  }
}

async function updateEventsBookmark(profileFolderId, eventsObj) {
  const existing = await dedupeNamedBookmark(profileFolderId, EVENTS_TITLE);
  const hasData =
    eventsObj &&
    (Object.keys(eventsObj.o || {}).length ||
      Object.keys(eventsObj.c || {}).length);
  if (!hasData) {
    if (existing) {
      try {
        await browser.bookmarks.remove(existing.id);
      } catch (e) {}
    }
    return;
  }
  const url = `${EVENTS_URL_BASE}?d=${encodeURIComponent(
    JSON.stringify(eventsObj)
  )}`;
  if (existing) {
    await browser.bookmarks.update(existing.id, { url });
  } else {
    await browser.bookmarks.create({
      parentId: profileFolderId,
      title: EVENTS_TITLE,
      url,
    });
  }
}

// Pure: given each device's {o,c} events, the set of URLs currently open
// (newest open strictly newer than newest close).
function computeEffectiveOpen(perDeviceEvents) {
  const openT = {};
  const closeT = {};
  for (const ev of perDeviceEvents) {
    for (const [u, t] of Object.entries(ev.o || {})) {
      openT[u] = Math.max(openT[u] || 0, t);
    }
    for (const [u, t] of Object.entries(ev.c || {})) {
      closeT[u] = Math.max(closeT[u] || 0, t);
    }
  }
  const present = new Set();
  const known = new Set([...Object.keys(openT), ...Object.keys(closeT)]);
  for (const u of Object.keys(openT)) {
    if (openT[u] > (closeT[u] || 0)) present.add(u);
  }
  return { present, known };
}

// Pending close tombstones recorded locally (by tab-close events),
// keyed by profile then URL, flushed into "_events" on the next save.
async function addLocalCloseTime(profile, url, t) {
  const { localCloseTimes } = await browser.storage.local.get(
    "localCloseTimes"
  );
  const map = localCloseTimes || {};
  map[profile] = map[profile] || {};
  map[profile][url] = t;
  await browser.storage.local.set({ localCloseTimes: map });
}
async function takeLocalCloseTimes(profile) {
  const { localCloseTimes } = await browser.storage.local.get(
    "localCloseTimes"
  );
  const map = localCloseTimes || {};
  const forProfile = map[profile] || {};
  if (map[profile]) {
    delete map[profile];
    await browser.storage.local.set({ localCloseTimes: map });
  }
  return forProfile;
}

// In-memory (persisted) tabId -> URL map, so a tab close can be resolved
// to its URL (onRemoved gives only the id). Rebuilt on startup.
const tabUrlById = new Map();
async function rememberTabUrl(tabId, url) {
  if (!/^https?:\/\//.test(url || "")) return;
  tabUrlById.set(tabId, url);
  const { tabUrlMap } = await browser.storage.local.get("tabUrlMap");
  const m = tabUrlMap || {};
  m[tabId] = url;
  await browser.storage.local.set({ tabUrlMap: m });
}
async function recallTabUrl(tabId) {
  if (tabUrlById.has(tabId)) return tabUrlById.get(tabId);
  const { tabUrlMap } = await browser.storage.local.get("tabUrlMap");
  return (tabUrlMap && tabUrlMap[tabId]) || null;
}
async function forgetTabUrl(tabId) {
  tabUrlById.delete(tabId);
  const { tabUrlMap } = await browser.storage.local.get("tabUrlMap");
  if (tabUrlMap && tabUrlMap[tabId] != null) {
    delete tabUrlMap[tabId];
    await browser.storage.local.set({ tabUrlMap });
  }
}

// Tab ids WE are about to close during reconciliation, so their
// onRemoved doesn't get mistaken for a user close (which would tombstone).
const selfClosingTabIds = new Set();

// Bring this device's open tabs in line with the shared session for the
// active profile: close tabs the session no longer has, open ones it
// gained. Only runs for the active profile and only when enabled.
async function reconcileFullMirror(profileArg) {
  if (!(await fullMirrorEnabled())) return;
  if (!(await isSyncEnabled())) return;
  const active = await getActiveProfile();
  const profile = profileArg || active;
  if (profile !== active) return; // only mirror the profile we're on

  // Flush our own current state first, so a tab we just opened counts as
  // "open" and isn't closed by a stale tombstone before we've saved it.
  await saveOpenTabs();

  // Gather every device's session events (and a title per URL) for this
  // profile.
  const root = await getOrCreateRootFolder();
  const deviceFolders = await browser.bookmarks.getChildren(root.id);
  const perDevice = [];
  const titleByUrl = {};
  for (const dev of deviceFolders) {
    if (dev.url) continue;
    const profFolders = await browser.bookmarks.getChildren(dev.id);
    const pf = profFolders.find((c) => !c.url && c.title === profile);
    if (!pf) continue;
    const children = await browser.bookmarks.getChildren(pf.id);
    perDevice.push(
      parseEvents(children.find((b) => b.url && b.title === EVENTS_TITLE))
    );
    for (const b of children) {
      if (b.url && !isProfileMetaTitle(b.title)) titleByUrl[b.url] = b.title;
    }
  }
  const { present, known } = computeEffectiveOpen(perDevice);

  // Index local tabs by their real URL.
  const localByUrl = new Map();
  for (const t of await browser.tabs.query({})) {
    const u = realUrlOfTab(t);
    if (!/^https?:\/\//.test(u)) continue;
    if (!localByUrl.has(u)) localByUrl.set(u, []);
    localByUrl.get(u).push(t);
  }

  // Close local tabs whose URL is session-known but no longer open.
  // Brand-new local tabs (not yet known to the session) are left alone.
  const toClose = [];
  for (const [u, list] of localByUrl) {
    if (known.has(u) && !present.has(u)) {
      for (const t of list) toClose.push(t.id);
    }
  }
  if (toClose.length) {
    for (const id of toClose) selfClosingTabIds.add(id);
    try {
      await browser.tabs.remove(toClose);
    } catch (e) {
      for (const id of toClose) selfClosingTabIds.delete(id);
    }
  }

  // Open URLs that should be present but aren't open here.
  const toOpen = [];
  for (const u of present) {
    if (!localByUrl.has(u)) toOpen.push({ url: u, title: titleByUrl[u] || u });
  }
  if (toOpen.length) {
    await performAdd(toOpen, { profile });
  }
}

// ------------------------------------------------------------
// Save: reads the open tabs and repopulates the ACTIVE profile's
// folder for this device (<device>/<active profile>/).
// ------------------------------------------------------------
async function saveOpenTabs() {
  const { deviceName, syncEnabled } = await browser.storage.local.get([
    "deviceName",
    "syncEnabled",
  ]);
  if (syncEnabled === false) return; // sync paused: don't push (outbound)
  if (!deviceName) return; // extension not configured yet

  const profile = await getActiveProfile();

  const root = await getOrCreateRootFolder();
  const deviceFolder = await getOrCreateSubfolder(root.id, deviceName);
  const profileFolder = await getOrCreateSubfolder(deviceFolder.id, profile);

  await dedupeNamedBookmark(deviceFolder.id, STATUS_TITLE);
  await dedupeNamedBookmark(profileFolder.id, LAST_SYNC_TITLE);
  await dedupeNamedBookmark(profileFolder.id, TAB_META_TITLE);

  const tabs = await browser.tabs.query({});

  // Tab-group definitions (title/color) keyed by group id, if the
  // tabGroups API is available. Missing API -> no group metadata.
  const groupById = new Map();
  if (browser.tabGroups) {
    try {
      const allGroups = await browser.tabGroups.query({});
      for (const g of allGroups) {
        groupById.set(g.id, { t: g.title || "", c: g.color });
      }
    } catch (e) {}
  }

  // Skip unopened lazy placeholders. A placeholder restored from another
  // device that the user hasn't actually opened is NOT part of this
  // device's own session — saving it would echo the other device's tabs
  // back as ours, and (with auto-Add on the other side) resurrect tabs
  // it just closed. Once the user opens a placeholder it navigates to
  // its real URL and stops being a placeholder, so it's saved normally.
  // The first occurrence of a URL wins (including its pinned/group state).
  const seenUrls = new Set();
  const dedupedTabs = [];
  for (const tab of tabs) {
    if (placeholderInfo(tab)) continue;
    const url = tab.url;
    if (!url || !/^https?:\/\//.test(url)) continue;
    if (seenUrls.has(url)) continue;
    seenUrls.add(url);
    dedupedTabs.push({
      url,
      title: tab.title,
      pinned: !!tab.pinned,
      groupId: typeof tab.groupId === "number" ? tab.groupId : -1,
    });
  }

  // Assign each referenced group a compact index and build the entries.
  const groups = [];
  const groupIndexById = new Map();
  const newEntries = dedupedTabs.map((t) => {
    let group = null;
    if (t.groupId >= 0 && groupById.has(t.groupId)) {
      if (!groupIndexById.has(t.groupId)) {
        groupIndexById.set(t.groupId, groups.length);
        groups.push(groupById.get(t.groupId));
      }
      group = groupIndexById.get(t.groupId);
    }
    const def = group != null ? groups[group] : null;
    return {
      url: t.url,
      title: t.title,
      pinned: t.pinned,
      group,
      groupTitle: def ? def.t : null,
      groupColor: def ? def.c : null,
    };
  });

  // Skip the write if nothing meaningful changed (URLs + pinned/group).
  const existingBookmarks = await browser.bookmarks.getChildren(
    profileFolder.id
  );
  const existingMeta = parseTabMeta(
    existingBookmarks.find((b) => b.url && b.title === TAB_META_TITLE)
  );
  const existingEntries = existingBookmarks
    .filter((b) => b.url && !isProfileMetaTitle(b.title))
    .map((b) => entryFromMeta(b.url, b.title, existingMeta));

  if (tabSignature(newEntries) === tabSignature(existingEntries)) return;

  await clearTabBookmarks(profileFolder.id);

  for (const entry of newEntries) {
    await browser.bookmarks.create({
      parentId: profileFolder.id,
      title: entry.title && entry.title.trim() ? entry.title : entry.url,
      url: entry.url,
    });
  }

  // Build and persist the pinned/group metadata.
  const metaObj = { groups, tabs: {} };
  for (const entry of newEntries) {
    if (entry.pinned || entry.group != null) {
      const m = {};
      if (entry.pinned) m.p = 1;
      if (entry.group != null) m.g = entry.group;
      metaObj.tabs[entry.url] = m;
    }
  }
  await updateTabMetaBookmark(profileFolder.id, metaObj);

  // Full-mirror session events: preserve each open URL's original open
  // time, fold in any pending local close tombstones, and GC tombstones
  // for URLs we've since reopened.
  if (await fullMirrorEnabled()) {
    const existingEvents = parseEvents(
      existingBookmarks.find((b) => b.url && b.title === EVENTS_TITLE)
    );
    const now = Date.now();
    const o = {};
    for (const entry of newEntries) {
      o[entry.url] = existingEvents.o[entry.url] || now;
    }
    const pendingCloses = await takeLocalCloseTimes(profile);
    const c = { ...existingEvents.c, ...pendingCloses };
    for (const url of Object.keys(c)) {
      if (o[url] && o[url] >= c[url]) delete c[url]; // reopened -> drop tombstone
    }
    await updateEventsBookmark(profileFolder.id, { o, c });
  }

  await updateLastSyncBookmark(profileFolder.id, deviceName, profile);
  // Each device signals through its OWN status bookmark inside its
  // folder, so devices/profiles never overwrite each other's signal.
  await updateStatusBookmark(deviceFolder.id, deviceName, profile);
  // Migrate away from the old single root "_status": drop the legacy one
  // that belongs to this device (other devices clean up their own).
  await removeLegacyRootStatus(root.id, deviceName);
}

async function dedupeNamedBookmark(folderId, title) {
  const children = await browser.bookmarks.getChildren(folderId);
  const matches = children.filter((c) => c.url && c.title === title);

  if (matches.length === 0) return null;

  if (matches.length > 1) {
    matches.sort(
      (a, b) =>
        extractTimestampFromStatusUrl(b.url) -
        extractTimestampFromStatusUrl(a.url)
    );
    const [keep, ...duplicates] = matches;
    for (const dup of duplicates) {
      try {
        await browser.bookmarks.remove(dup.id);
      } catch (e) {}
    }
    return keep;
  }

  return matches[0];
}

// Writes/updates this device's "_status" signal bookmark (kept inside
// the device folder, one per device) with the last save's profile and
// timestamp. Updated in place — never recreated — to avoid sync churn.
async function updateStatusBookmark(deviceFolderId, deviceName, profile) {
  const timestamp = Date.now();
  const statusUrl = `${STATUS_URL_BASE}?device=${encodeURIComponent(
    deviceName
  )}&profile=${encodeURIComponent(profile)}&t=${timestamp}`;

  const existing = await dedupeNamedBookmark(deviceFolderId, STATUS_TITLE);

  if (existing) {
    await browser.bookmarks.update(existing.id, { url: statusUrl });
  } else {
    await browser.bookmarks.create({
      parentId: deviceFolderId,
      title: STATUS_TITLE,
      url: statusUrl,
    });
  }
}

// Legacy migration: older versions kept a single "_status" at the root.
// Remove the one that belongs to THIS device once we've written our
// per-device status. Other devices' legacy statuses are left alone (and
// still read during catch-up) until those devices upgrade.
async function removeLegacyRootStatus(rootId, deviceName) {
  const children = await browser.bookmarks.getChildren(rootId);
  for (const c of children) {
    if (!c.url || c.title !== STATUS_TITLE) continue;
    try {
      if (new URL(c.url).searchParams.get("device") === deviceName) {
        await browser.bookmarks.remove(c.id);
      }
    } catch (e) {}
  }
}

async function updateLastSyncBookmark(profileFolderId, deviceName, profile) {
  const timestamp = Date.now();
  const lastSyncUrl = `${LAST_SYNC_URL_BASE}?device=${encodeURIComponent(
    deviceName
  )}&profile=${encodeURIComponent(profile)}&t=${timestamp}`;

  const existing = await dedupeNamedBookmark(profileFolderId, LAST_SYNC_TITLE);

  if (existing) {
    await browser.bookmarks.update(existing.id, { url: lastSyncUrl });
  } else {
    await browser.bookmarks.create({
      parentId: profileFolderId,
      title: LAST_SYNC_TITLE,
      url: lastSyncUrl,
    });
  }
}

// Persist the pinned/group metadata for a profile. When there's nothing
// to store (no pinned or grouped tabs) any existing metadata bookmark is
// removed so profiles that don't use the feature stay clean.
async function updateTabMetaBookmark(profileFolderId, metaObj) {
  const existing = await dedupeNamedBookmark(profileFolderId, TAB_META_TITLE);
  const hasData =
    metaObj && metaObj.tabs && Object.keys(metaObj.tabs).length > 0;

  if (!hasData) {
    if (existing) {
      try {
        await browser.bookmarks.remove(existing.id);
      } catch (e) {}
    }
    return;
  }

  const url = `${TAB_META_URL_BASE}?d=${encodeURIComponent(
    JSON.stringify(metaObj)
  )}`;

  if (existing) {
    await browser.bookmarks.update(existing.id, { url });
  } else {
    await browser.bookmarks.create({
      parentId: profileFolderId,
      title: TAB_META_TITLE,
      url,
    });
  }
}

const DEFAULT_INTERVAL_MINUTES = 1;

async function ensureAlarm() {
  const { syncIntervalMinutes } = await browser.storage.local.get(
    "syncIntervalMinutes"
  );
  const period = syncIntervalMinutes || DEFAULT_INTERVAL_MINUTES;
  browser.alarms.create("saveTabsAlarm", { periodInMinutes: period });
}

// Master on/off switch. When paused, this device neither saves its tabs
// (outbound) nor reacts to other devices' updates (inbound). Default ON.
async function isSyncEnabled() {
  const { syncEnabled } = await browser.storage.local.get("syncEnabled");
  return syncEnabled !== false;
}

// Reflect the on/off state in the toolbar: a distinct "paused" icon plus
// an OFF badge, so it's obvious at a glance that sync is off.
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

browser.runtime.onInstalled.addListener(async () => {
  ensureAlarm();
  refreshActionIcon();
  await rebuildTabUrlMap();
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
  sweepExpiredNotifications();
  await rebuildTabUrlMap();
  await reconcileFullMirror();
});

// Rebuild the tabId -> URL map from the currently open tabs (their ids
// don't survive a browser restart, and the in-memory map is lost when
// the worker suspends).
async function rebuildTabUrlMap() {
  const m = {};
  try {
    for (const t of await browser.tabs.query({})) {
      const u = realUrlOfTab(t);
      if (/^https?:\/\//.test(u)) {
        tabUrlById.set(t.id, u);
        m[t.id] = u;
      }
    }
    await browser.storage.local.set({ tabUrlMap: m });
  } catch (e) {}
}

browser.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm.name === "saveTabsAlarm") {
    // Backstop first: apply any notification timeout that elapsed
    // while the service worker was suspended.
    await sweepExpiredNotifications();
    await saveOpenTabs();
    // Catch-up reconcile in case an event was missed while suspended.
    await reconcileFullMirror();
  }
});

browser.storage.onChanged.addListener((changes, area) => {
  if (area !== "local") return;
  if (changes.syncIntervalMinutes) {
    ensureAlarm();
  }
  if (changes.syncEnabled) {
    updateActionIcon(changes.syncEnabled.newValue !== false);
  }
});

// --- Full-mirror tab tracking ---------------------------------------
// Keep a tabId -> real-URL map so a close can be resolved to its URL.
browser.tabs.onCreated.addListener((tab) => {
  const u = realUrlOfTab(tab);
  if (/^https?:\/\//.test(u)) rememberTabUrl(tab.id, u);
});

browser.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (!changeInfo.url) return; // only on actual navigations
  const u = realUrlOfTab(tab);
  if (/^https?:\/\//.test(u)) rememberTabUrl(tabId, u);
});

// A user-initiated tab close: record a close tombstone so the URL closes
// on the other devices too. Never on window/browser close (that would
// wipe the session everywhere), never for our own reconcile-driven
// closes, and never if the URL is still open in another tab.
browser.tabs.onRemoved.addListener(async (tabId, removeInfo) => {
  const url = await recallTabUrl(tabId);
  await forgetTabUrl(tabId);

  if (removeInfo && removeInfo.isWindowClosing) return;
  if (selfClosingTabIds.has(tabId)) {
    selfClosingTabIds.delete(tabId);
    return;
  }
  if (!url) return; // unknown (e.g. worker was cold) -> best-effort skip
  if (!(await fullMirrorEnabled())) return;
  if (!(await isSyncEnabled())) return;

  const stillOpen = (await browser.tabs.query({})).some(
    (t) => realUrlOfTab(t) === url
  );
  if (stillOpen) return;

  const profile = await getActiveProfile();
  await addLocalCloseTime(profile, url, Date.now());
  await saveOpenTabs(); // flush the tombstone + bump status so peers reconcile
});

browser.bookmarks.onCreated.addListener(async (id, node) => {
  if (!node || !node.url) return;
  if (node.title !== STATUS_TITLE && node.title !== LAST_SYNC_TITLE) return;

  const kept = await dedupeNamedBookmark(node.parentId, node.title);
  if (node.title === STATUS_TITLE && kept) {
    await evaluateStatusAndNotify(kept.url);
  }
});

// ------------------------------------------------------------
// Pending-notification bookkeeping.
//
// A notification's timeout must survive the MV3 service worker being
// torn down (which can happen well before a long timeout elapses), so
// we can't rely on setTimeout alone. Each open notification is
// recorded in storage together with the device/profile it refers to,
// the action to apply on timeout, and when it expires. A setTimeout
// gives an immediate response while the worker is alive; a periodic
// "sweep" (run on every alarm and on startup) is the durable backstop
// that applies the default action even if the worker was restarted.
//
// Whatever resolves a notification first — a button, a body click, the
// setTimeout, or the sweep — uses browser.notifications.clear() as the
// single mutex: user interactions close the notification themselves,
// so a later resolver sees clear() return false and stands down. That
// removes the double-apply race the old single-slot design had.
// ------------------------------------------------------------
const PENDING_NOTIFS_KEY = "pendingNotifs";

async function getPendingNotifs() {
  const stored = await browser.storage.local.get(PENDING_NOTIFS_KEY);
  return stored[PENDING_NOTIFS_KEY] || {};
}

async function savePendingNotif(notifId, data) {
  const map = await getPendingNotifs();
  map[notifId] = data;
  await browser.storage.local.set({ [PENDING_NOTIFS_KEY]: map });
}

async function removePendingNotif(notifId) {
  const map = await getPendingNotifs();
  const data = map[notifId];
  if (data) {
    delete map[notifId];
    await browser.storage.local.set({ [PENDING_NOTIFS_KEY]: map });
  }
  return data || null;
}

async function applyNotificationAction(action, device, profile) {
  if (!action || action === "none") return;
  const entries = await getTabEntriesForDeviceProfile(device, profile);
  if (entries.length === 0) return;
  const source = { device, profile };
  if (action === "replace") {
    await performReplace(entries, source);
  } else {
    await performAdd(entries, source);
  }
}

async function createUpdateNotification(remoteDevice, remoteProfile, timestamp) {
  const { notificationTimeoutSeconds, defaultTimeoutAction } =
    await browser.storage.local.get([
      "notificationTimeoutSeconds",
      "defaultTimeoutAction",
    ]);
  const timeoutMs = (notificationTimeoutSeconds || 15) * 1000;
  const defaultAction = defaultTimeoutAction || "add";

  const notifId = `${NOTIF_PREFIX}${timestamp}`;

  await savePendingNotif(notifId, {
    device: remoteDevice,
    profile: remoteProfile,
    defaultAction,
    expiresAt: Date.now() + timeoutMs,
  });

  browser.notifications.create(notifId, {
    type: "basic",
    iconUrl: "icons/icon128.png",
    title: "SyncMyTabs",
    message: `${remoteDevice} (${remoteProfile}) has updated tabs (${new Date(
      timestamp
    ).toLocaleTimeString()}). Click a button to open them, or click here to ignore.`,
    buttons: [{ title: "Replace" }, { title: "Add" }],
    requireInteraction: true,
  });

  // Fast path while the worker is alive. The sweep is the backstop if
  // the worker was already gone by the time this would have fired.
  setTimeout(async () => {
    const wasPresent = await browser.notifications.clear(notifId);
    if (!wasPresent) return; // already resolved by a click or the sweep
    const data = await removePendingNotif(notifId);
    if (!data) return;
    await applyNotificationAction(data.defaultAction, data.device, data.profile);
  }, timeoutMs);
}

// Durable backstop for notification timeouts: applies the default
// action to any pending notification whose deadline has passed. Safe
// to call repeatedly; clear() ensures only one resolver ever acts.
async function sweepExpiredNotifications() {
  const now = Date.now();
  const map = await getPendingNotifs();

  for (const [notifId, data] of Object.entries(map)) {
    if (!data || (data.expiresAt || 0) > now) continue;

    const wasPresent = await browser.notifications.clear(notifId);
    await removePendingNotif(notifId);
    if (wasPresent) {
      await applyNotificationAction(
        data.defaultAction,
        data.device,
        data.profile
      );
    }
  }
}

// Per-source "last seen" high-water marks, keyed by device+profile, so a
// legitimately newer update from one source is never skipped just because
// a DIFFERENT source (with a faster clock) advanced a single global mark.
function sourceKey(device, profile) {
  return `${device}${profile}`;
}
async function getLastSeenMap() {
  const { lastSeenBySource } = await browser.storage.local.get(
    "lastSeenBySource"
  );
  return lastSeenBySource || {};
}

async function evaluateStatusAndNotify(statusUrl) {
  const { deviceName, syncEnabled } = await browser.storage.local.get([
    "deviceName",
    "syncEnabled",
  ]);
  if (syncEnabled === false) return false; // sync paused: ignore (inbound)

  let remoteDevice, remoteProfile, timestamp;
  try {
    const url = new URL(statusUrl);
    remoteDevice = url.searchParams.get("device");
    remoteProfile = url.searchParams.get("profile") || DEFAULT_PROFILE;
    timestamp = Number(url.searchParams.get("t"));
  } catch (e) {
    return false;
  }

  if (!remoteDevice || !timestamp) return false;
  if (remoteDevice === deviceName) return false;

  // Profiles are independent: only sync when the remote update is for the
  // SAME profile this device is currently using. A device on "home"
  // ignores another device's "work" saves, and vice versa. (Manual
  // "Restore from device" is unaffected — it's an explicit user choice.)
  const activeProfile = await getActiveProfile();
  if (remoteProfile !== activeProfile) return false;

  const key = sourceKey(remoteDevice, remoteProfile);
  const map = await getLastSeenMap();
  if (map[key] && timestamp <= map[key]) return false;

  map[key] = timestamp;
  await browser.storage.local.set({
    lastSeenBySource: map,
    // Keep a global "most recent signal" for the popup/options display.
    lastSeenTimestamp: Math.max(...Object.values(map)),
  });

  // Full two-way mirror handles opening AND closing automatically for
  // the shared profile, so it replaces the notify+Add/Replace flow.
  if (await fullMirrorEnabled()) {
    await reconcileFullMirror(remoteProfile);
    return true;
  }

  // Otherwise (mirror off): close our unopened placeholders that this
  // device has since closed, and prompt with the notification.
  await mirrorRemoteCloses(remoteDevice, remoteProfile);
  await createUpdateNotification(remoteDevice, remoteProfile, timestamp);
  return true;
}

// Catch-up scan for updates missed while suspended/offline (runs on
// "Sync now"). Reads every device's "_status" plus any leftover legacy
// root "_status", and lets the per-source high-water marks decide what's
// actually new. A few devices to iterate — cheap, and only on demand.
async function checkForRemoteUpdateNow() {
  const root = await getOrCreateRootFolder();
  const children = await browser.bookmarks.getChildren(root.id);
  let found = false;

  for (const child of children) {
    if (child.url) {
      // Legacy root-level "_status" (pre per-device migration).
      if (child.title === STATUS_TITLE) {
        if (await evaluateStatusAndNotify(child.url)) found = true;
      }
      continue;
    }
    // A device folder: read its own "_status".
    const status = await dedupeNamedBookmark(child.id, STATUS_TITLE);
    if (status && (await evaluateStatusAndNotify(status.url))) found = true;
  }

  return found;
}

browser.bookmarks.onChanged.addListener(async (id, changeInfo) => {
  if (!changeInfo.url) return;

  let node;
  try {
    const results = await browser.bookmarks.get(id);
    node = results[0];
  } catch (e) {
    return;
  }
  if (!node || node.title !== STATUS_TITLE) return;

  await evaluateStatusAndNotify(changeInfo.url);
});

// Returns the saved tabs for a device/profile as restore-ready entries
// ({url, title, pinned, group, groupTitle, groupColor}).
async function getTabEntriesForDeviceProfile(deviceName, profile) {
  const root = await getOrCreateRootFolder();
  const deviceChildren = await browser.bookmarks.getChildren(root.id);
  const deviceFolder = deviceChildren.find(
    (c) => !c.url && c.title === deviceName
  );
  if (!deviceFolder) return [];

  const profileChildren = await browser.bookmarks.getChildren(deviceFolder.id);
  const profileFolder = profileChildren.find(
    (c) => !c.url && c.title === profile
  );
  if (!profileFolder) return [];

  const bookmarks = await browser.bookmarks.getChildren(profileFolder.id);
  const meta = parseTabMeta(
    bookmarks.find((b) => b.url && b.title === TAB_META_TITLE)
  );
  return bookmarks
    .filter((b) => b.url && !isProfileMetaTitle(b.title))
    .map((b) => entryFromMeta(b.url, b.title, meta));
}

// Whether restored tabs should open lazily (as a placeholder that
// doesn't hit the network until the tab is first viewed). Default ON.
async function openRestoredLazily() {
  const { openRestoredLazy } = await browser.storage.local.get(
    "openRestoredLazy"
  );
  return openRestoredLazy !== false;
}

// Whether to mirror tab closes from the source device: when a remote
// update arrives, close our own still-unopened placeholder tabs that
// were restored from that device but are no longer in its saved set.
// Default ON.
async function mirrorClosesEnabled() {
  const { mirrorRemoteCloses } = await browser.storage.local.get(
    "mirrorRemoteCloses"
  );
  return mirrorRemoteCloses !== false;
}

// When device D/profile P publishes an update, close any of our tabs
// that are (a) still unopened lazy placeholders, (b) tagged as restored
// from exactly D/P, and (c) no longer present in D/P's saved set — i.e.
// tabs we received from D but never looked at, which D has since closed.
// Opened tabs, our own tabs, and tabs from other sources are untouched.
async function mirrorRemoteCloses(device, profile) {
  if (!(await mirrorClosesEnabled())) return;

  const entries = await getTabEntriesForDeviceProfile(device, profile);
  const remoteUrls = new Set(entries.map((e) => e.url));

  const tabs = await browser.tabs.query({});
  const toClose = [];
  for (const tab of tabs) {
    const info = placeholderInfo(tab);
    if (!info) continue; // opened tab or not a placeholder
    if (info.sd !== device || info.sp !== profile) continue; // other source
    if (remoteUrls.has(info.real)) continue; // still open on the source
    toClose.push(tab.id);
  }

  if (toClose.length) {
    try {
      await browser.tabs.remove(toClose);
    } catch (e) {}
  }
}

// The URL to actually open a restored tab at: the lazy placeholder when
// lazy restore is on, otherwise the real URL.
function openUrlForEntry(entry, lazy, source) {
  return lazy ? lazyUrlFor(entry, source) : entry.url;
}

// Re-apply pinned state and tab-group membership to freshly created
// tabs. `pairs` is [{tabId, entry}] in the same window. Best-effort:
// any failure (e.g. tabGroups API missing) is swallowed so the restore
// itself never breaks. Pinned tabs are never grouped (Chrome forbids
// it), so pinning takes precedence.
async function applyPinnedAndGroups(pairs, windowId) {
  for (const { tabId, entry } of pairs) {
    if (entry.pinned) {
      try {
        await browser.tabs.update(tabId, { pinned: true });
      } catch (e) {}
    }
  }

  if (!browser.tabGroups || !browser.tabs.group) return;

  // Bucket tabs by their original group index so distinct groups stay
  // distinct even if they share a title/color.
  const buckets = new Map();
  for (const { tabId, entry } of pairs) {
    if (entry.pinned || entry.group == null) continue;
    if (!buckets.has(entry.group)) {
      buckets.set(entry.group, {
        title: entry.groupTitle,
        color: entry.groupColor,
        ids: [],
      });
    }
    buckets.get(entry.group).ids.push(tabId);
  }

  for (const { title, color, ids } of buckets.values()) {
    if (!ids.length) continue;
    try {
      const groupId = await browser.tabs.group({
        tabIds: ids,
        createProperties: { windowId },
      });
      const props = {};
      if (title) props.title = title;
      if (color) props.color = color;
      if (Object.keys(props).length) {
        await browser.tabGroups.update(groupId, props);
      }
    } catch (e) {}
  }
}

async function performReplace(entries, source) {
  const lazy = await openRestoredLazily();
  const openUrls = entries.map((e) => openUrlForEntry(e, lazy, source));

  const oldWindows = await browser.windows.getAll({ populate: false });
  const oldWindowIds = oldWindows.map((w) => w.id);

  // Open the replacement window FIRST and only close the old ones if
  // that succeeded — otherwise a failed create would leave the user
  // with no windows at all. With lazy restore on, the window's active
  // tab becomes visible and loads its real URL immediately; the rest
  // stay as placeholders until the user views them.
  let created;
  try {
    created = await browser.windows.create({ url: openUrls });
  } catch (e) {
    created = null;
  }
  if (!created) return;

  const createdTabs = created.tabs || [];
  const pairs = [];
  for (let i = 0; i < createdTabs.length && i < entries.length; i++) {
    pairs.push({ tabId: createdTabs[i].id, entry: entries[i] });
  }
  await applyPinnedAndGroups(pairs, created.id);

  for (const winId of oldWindowIds) {
    try {
      await browser.windows.remove(winId);
    } catch (e) {}
  }
}

async function performAdd(entries, source) {
  const lazy = await openRestoredLazily();

  // Resolve open tabs to their real targets (unwrapping any existing
  // placeholder tabs) so we don't re-open pages that are already there.
  const currentTabs = await browser.tabs.query({});
  const alreadyOpenUrls = new Set(currentTabs.map((t) => realUrlOfTab(t)));
  const toOpen = entries.filter((e) => !alreadyOpenUrls.has(e.url));

  if (toOpen.length === 0) return;

  let targetWindow;
  try {
    targetWindow = await browser.windows.getLastFocused({
      windowTypes: ["normal"],
    });
  } catch (e) {
    targetWindow = null;
  }

  const pairs = [];
  let windowId = null;

  if (targetWindow) {
    windowId = targetWindow.id;
    for (const entry of toOpen) {
      // active:false keeps the placeholder tab hidden, so it never
      // becomes visible and never navigates until the user opens it.
      try {
        const tab = await browser.tabs.create({
          windowId,
          url: openUrlForEntry(entry, lazy, source),
          active: !lazy,
          pinned: !!entry.pinned,
        });
        pairs.push({ tabId: tab.id, entry });
      } catch (e) {}
    }
  } else {
    const win = await browser.windows.create({
      url: toOpen.map((e) => openUrlForEntry(e, lazy, source)),
    });
    windowId = win && win.id;
    const createdTabs = (win && win.tabs) || [];
    for (let i = 0; i < createdTabs.length && i < toOpen.length; i++) {
      pairs.push({ tabId: createdTabs[i].id, entry: toOpen[i] });
    }
  }

  if (windowId != null) await applyPinnedAndGroups(pairs, windowId);
}

browser.notifications.onButtonClicked.addListener(
  async (notifId, buttonIndex) => {
    if (!notifId.startsWith(NOTIF_PREFIX)) return;

    // The user acted explicitly; drop the pending record so the sweep
    // won't also fire the default action later. (Clicking a button
    // already closes the notification, so the setTimeout/sweep paths
    // will see clear() return false and stand down.)
    const data = await removePendingNotif(notifId);
    browser.notifications.clear(notifId);
    if (!data) return; // already resolved by a timeout/sweep

    const entries = await getTabEntriesForDeviceProfile(
      data.device,
      data.profile
    );
    if (entries.length === 0) return;

    const source = { device: data.device, profile: data.profile };
    if (buttonIndex === 0) {
      await performReplace(entries, source);
    } else if (buttonIndex === 1) {
      await performAdd(entries, source);
    }
  }
);

// ------------------------------------------------------------
// browser.notifications only supports 2 buttons, so there's no room
// for a literal third "Ignore" button alongside "Replace"/"Add".
// Clicking the notification body itself (not a button) is the
// closest equivalent: it just dismisses the notification, applying
// no action at all — same outcome as letting it time out with
// defaultTimeoutAction set to "none", but immediate.
// ------------------------------------------------------------
browser.notifications.onClicked.addListener(async (notifId) => {
  if (!notifId.startsWith(NOTIF_PREFIX)) return;
  // "Ignore": discard the pending record so the default action never
  // gets applied, then dismiss the notification.
  await removePendingNotif(notifId);
  browser.notifications.clear(notifId);
});

async function listAvailableDevices() {
  const root = await getOrCreateRootFolder();
  const children = await browser.bookmarks.getChildren(root.id);
  return children.filter((c) => !c.url).map((c) => c.title);
}

async function listProfilesForDevice(deviceName) {
  const root = await getOrCreateRootFolder();
  const deviceChildren = await browser.bookmarks.getChildren(root.id);
  const deviceFolder = deviceChildren.find(
    (c) => !c.url && c.title === deviceName
  );
  if (!deviceFolder) return [];
  const children = await browser.bookmarks.getChildren(deviceFolder.id);
  return children.filter((c) => !c.url).map((c) => c.title);
}

// ------------------------------------------------------------
// Scans the ENTIRE bookmark tree (all devices) and returns the
// union of every profile name found anywhere, merged with this
// device's own locally-defined "profiles" list. This is what powers
// the "active profile" picker: profile names created on ANY device
// become selectable here too, without needing to be manually
// re-typed (only "profiles" — the local list of names you can pick
// as active — was previously per-device/unsynced; the actual
// per-device saved data was always synced via bookmarks).
// ------------------------------------------------------------
async function listAllKnownProfiles() {
  const root = await getOrCreateRootFolder();
  const deviceFolders = await browser.bookmarks.getChildren(root.id);

  const found = new Set();
  for (const deviceFolder of deviceFolders) {
    if (deviceFolder.url) continue; // skip "_status"
    const profileFolders = await browser.bookmarks.getChildren(
      deviceFolder.id
    );
    for (const pf of profileFolders) {
      if (!pf.url) found.add(pf.title);
    }
  }

  const { profiles } = await browser.storage.local.get("profiles");
  for (const p of profiles || []) found.add(p);
  found.add(DEFAULT_PROFILE);

  return Array.from(found).sort();
}

browser.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.type === "SYNC_NOW") {
    (async () => {
      await saveOpenTabs();
      const updateFound = await checkForRemoteUpdateNow();
      sendResponse({ ok: true, updateFound });
    })();
    return true;
  }

  if (message?.type === "GET_DEVICES") {
    listAvailableDevices().then((devices) => sendResponse({ devices }));
    return true;
  }

  if (message?.type === "GET_PROFILES_FOR_DEVICE") {
    listProfilesForDevice(message.device).then((profiles) =>
      sendResponse({ profiles })
    );
    return true;
  }

  if (message?.type === "GET_ALL_KNOWN_PROFILES") {
    listAllKnownProfiles().then((profiles) => sendResponse({ profiles }));
    return true;
  }

  if (message?.type === "MANUAL_RESTORE") {
    (async () => {
      const { device, profile, mode } = message;
      const resolvedProfile = profile || DEFAULT_PROFILE;
      const entries = await getTabEntriesForDeviceProfile(
        device,
        resolvedProfile
      );
      if (entries.length === 0) {
        sendResponse({ ok: false, reason: "no-tabs" });
        return;
      }
      const source = { device, profile: resolvedProfile };
      if (mode === "replace") {
        await performReplace(entries, source);
      } else {
        await performAdd(entries, source);
      }
      sendResponse({ ok: true });
    })();
    return true;
  }

  if (message?.type === "SWITCH_PROFILE_AND_SAVE") {
    (async () => {
      await saveOpenTabs();
      // Now that we're on a new profile, pick up other devices' updates
      // for THIS profile (the automatic detection only matches the
      // active profile, so a switch is when we re-check).
      await checkForRemoteUpdateNow();
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
