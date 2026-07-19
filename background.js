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
// - A single "_status" bookmark at the root (fixed title, updated in
//   place) encodes device + profile + timestamp of the last save
//   anywhere. Other devices react to it via bookmarks.onChanged /
//   onCreated (event-driven, no polling) and show a notification
//   with two buttons: "Replace" / "Add". No automatic opening.
// ============================================================

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

const DEFAULT_PROFILE = "default";
const NOTIF_PREFIX = "syncmytabs-";

// "Other Bookmarks" folder in Chrome/Brave. Firefox uses different
// ids (e.g. "unfiled_____"), so instead of hardcoding "2" everywhere
// we resolve it at runtime from the bookmark tree and only fall back
// to this value.
const OTHER_BOOKMARKS_PARENT_ID = "2";

// Resolved lazily and cached: the id of the top-level folder under
// which the root "SyncMyTabs" folder should live ("Other Bookmarks"
// on Chrome/Brave, its equivalent elsewhere). Falls back to the
// Chrome/Brave id if the tree can't be inspected.
let cachedRootParentId = null;
async function getRootParentId() {
  if (cachedRootParentId) return cachedRootParentId;
  try {
    const tree = await chrome.bookmarks.getTree();
    const topLevel = (tree && tree[0] && tree[0].children) || [];

    // Chrome/Brave: "Other Bookmarks" has the well-known id "2".
    const known = topLevel.find((c) => c.id === OTHER_BOOKMARKS_PARENT_ID);
    if (known) {
      cachedRootParentId = known.id;
      return cachedRootParentId;
    }

    // Fallback (e.g. Firefox): the last top-level folder is
    // conventionally the "unfiled/other" bookmarks container.
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
  const results = await chrome.bookmarks.search({ title: ROOT_NAME });
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
    const legacyResults = await chrome.bookmarks.search({
      title: legacyName,
    });
    const legacyFolders = legacyResults.filter((b) => !b.url);
    if (legacyFolders.length === 0) continue;

    legacyFolders.sort((a, b) => (a.dateAdded || 0) - (b.dateAdded || 0));
    const [canonical, ...duplicates] = legacyFolders;
    for (const dup of duplicates) {
      await mergeFolderInto(dup.id, canonical.id);
    }
    await chrome.bookmarks.update(canonical.id, { title: ROOT_NAME });
    return canonical;
  }

  const parentId = await getRootParentId();
  return chrome.bookmarks.create({
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
  const children = await chrome.bookmarks.getChildren(sourceFolderId);
  const targetChildren = await chrome.bookmarks.getChildren(targetFolderId);

  for (const child of children) {
    const match = targetChildren.find((t) => t.title === child.title);
    const bothFolders = match && !match.url && !child.url;
    const bothBookmarks = match && match.url && child.url;

    if (bothFolders) {
      await mergeFolderInto(child.id, match.id);
      try {
        await chrome.bookmarks.remove(child.id);
      } catch (e) {}
    } else if (
      bothBookmarks &&
      child.title !== STATUS_TITLE &&
      child.title !== LAST_SYNC_TITLE
    ) {
      try {
        await chrome.bookmarks.remove(child.id);
      } catch (e) {}
    } else {
      try {
        await chrome.bookmarks.move(child.id, { parentId: targetFolderId });
      } catch (e) {}
    }
  }

  try {
    await chrome.bookmarks.removeTree(sourceFolderId);
  } catch (e) {}
}

// ------------------------------------------------------------
// Utility: find (or create) a named subfolder under a given parent.
// Used both for the device level (under root) and the profile level
// (under a device folder) — same logic, different parent.
// ------------------------------------------------------------
async function getOrCreateSubfolder(parentId, name) {
  const children = await chrome.bookmarks.getChildren(parentId);
  const existing = children.find((c) => !c.url && c.title === name);
  if (existing) return existing;
  return chrome.bookmarks.create({ parentId, title: name });
}

async function clearTabBookmarks(folderId) {
  const children = await chrome.bookmarks.getChildren(folderId);
  for (const child of children) {
    if (child.title === LAST_SYNC_TITLE) continue;
    await chrome.bookmarks.remove(child.id);
  }
}

function sameUrlSet(listA, listB) {
  const a = new Set(listA);
  const b = new Set(listB);
  if (a.size !== b.size) return false;
  for (const url of a) {
    if (!b.has(url)) return false;
  }
  return true;
}

async function getActiveProfile() {
  const { activeProfile } = await chrome.storage.local.get("activeProfile");
  return activeProfile || DEFAULT_PROFILE;
}

// ------------------------------------------------------------
// Save: reads the open tabs and repopulates the ACTIVE profile's
// folder for this device (<device>/<active profile>/).
// ------------------------------------------------------------
async function saveOpenTabs() {
  const { deviceName } = await chrome.storage.local.get("deviceName");
  if (!deviceName) return; // extension not configured yet

  const profile = await getActiveProfile();

  const root = await getOrCreateRootFolder();
  const deviceFolder = await getOrCreateSubfolder(root.id, deviceName);
  const profileFolder = await getOrCreateSubfolder(deviceFolder.id, profile);

  await dedupeNamedBookmark(root.id, STATUS_TITLE);
  await dedupeNamedBookmark(profileFolder.id, LAST_SYNC_TITLE);

  const tabs = await chrome.tabs.query({});
  const validTabs = tabs.filter((t) => t.url && /^https?:\/\//.test(t.url));

  const seenUrls = new Set();
  const dedupedTabs = [];
  for (const tab of validTabs) {
    if (seenUrls.has(tab.url)) continue;
    seenUrls.add(tab.url);
    dedupedTabs.push(tab);
  }

  const newUrls = dedupedTabs.map((t) => t.url);

  const existingBookmarks = await chrome.bookmarks.getChildren(
    profileFolder.id
  );
  const existingUrls = existingBookmarks
    .filter((b) => b.url && b.title !== LAST_SYNC_TITLE)
    .map((b) => b.url);

  if (sameUrlSet(newUrls, existingUrls)) return;

  await clearTabBookmarks(profileFolder.id);

  for (const tab of dedupedTabs) {
    await chrome.bookmarks.create({
      parentId: profileFolder.id,
      title: tab.title && tab.title.trim() ? tab.title : tab.url,
      url: tab.url,
    });
  }

  await updateLastSyncBookmark(profileFolder.id, deviceName, profile);
  await updateStatusBookmark(root.id, deviceName, profile);
}

async function dedupeNamedBookmark(folderId, title) {
  const children = await chrome.bookmarks.getChildren(folderId);
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
        await chrome.bookmarks.remove(dup.id);
      } catch (e) {}
    }
    return keep;
  }

  return matches[0];
}

async function updateStatusBookmark(rootId, deviceName, profile) {
  const timestamp = Date.now();
  const statusUrl = `${STATUS_URL_BASE}?device=${encodeURIComponent(
    deviceName
  )}&profile=${encodeURIComponent(profile)}&t=${timestamp}`;

  const existing = await dedupeNamedBookmark(rootId, STATUS_TITLE);

  if (existing) {
    await chrome.bookmarks.update(existing.id, { url: statusUrl });
  } else {
    await chrome.bookmarks.create({
      parentId: rootId,
      title: STATUS_TITLE,
      url: statusUrl,
    });
  }
}

async function updateLastSyncBookmark(profileFolderId, deviceName, profile) {
  const timestamp = Date.now();
  const lastSyncUrl = `${LAST_SYNC_URL_BASE}?device=${encodeURIComponent(
    deviceName
  )}&profile=${encodeURIComponent(profile)}&t=${timestamp}`;

  const existing = await dedupeNamedBookmark(profileFolderId, LAST_SYNC_TITLE);

  if (existing) {
    await chrome.bookmarks.update(existing.id, { url: lastSyncUrl });
  } else {
    await chrome.bookmarks.create({
      parentId: profileFolderId,
      title: LAST_SYNC_TITLE,
      url: lastSyncUrl,
    });
  }
}

const DEFAULT_INTERVAL_MINUTES = 1;

async function ensureAlarm() {
  const { syncIntervalMinutes } = await chrome.storage.local.get(
    "syncIntervalMinutes"
  );
  const period = syncIntervalMinutes || DEFAULT_INTERVAL_MINUTES;
  chrome.alarms.create("saveTabsAlarm", { periodInMinutes: period });
}

chrome.runtime.onInstalled.addListener(() => {
  ensureAlarm();
  chrome.storage.local.get(
    ["deviceName", "profiles"],
    ({ deviceName, profiles }) => {
      if (!profiles || profiles.length === 0) {
        chrome.storage.local.set({
          profiles: [DEFAULT_PROFILE],
          activeProfile: DEFAULT_PROFILE,
        });
      }
      if (!deviceName) {
        chrome.runtime.openOptionsPage();
      }
    }
  );
});

chrome.runtime.onStartup.addListener(() => {
  ensureAlarm();
  sweepExpiredNotifications();
});

chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm.name === "saveTabsAlarm") {
    // Backstop first: apply any notification timeout that elapsed
    // while the service worker was suspended.
    await sweepExpiredNotifications();
    await saveOpenTabs();
  }
});

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === "local" && changes.syncIntervalMinutes) {
    ensureAlarm();
  }
});

chrome.bookmarks.onCreated.addListener(async (id, node) => {
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
// setTimeout, or the sweep — uses chrome.notifications.clear() as the
// single mutex: user interactions close the notification themselves,
// so a later resolver sees clear() return false and stands down. That
// removes the double-apply race the old single-slot design had.
// ------------------------------------------------------------
const PENDING_NOTIFS_KEY = "pendingNotifs";

async function getPendingNotifs() {
  const stored = await chrome.storage.local.get(PENDING_NOTIFS_KEY);
  return stored[PENDING_NOTIFS_KEY] || {};
}

async function savePendingNotif(notifId, data) {
  const map = await getPendingNotifs();
  map[notifId] = data;
  await chrome.storage.local.set({ [PENDING_NOTIFS_KEY]: map });
}

async function removePendingNotif(notifId) {
  const map = await getPendingNotifs();
  const data = map[notifId];
  if (data) {
    delete map[notifId];
    await chrome.storage.local.set({ [PENDING_NOTIFS_KEY]: map });
  }
  return data || null;
}

async function applyNotificationAction(action, device, profile) {
  if (!action || action === "none") return;
  const urls = await getUrlsForDeviceProfile(device, profile);
  if (urls.length === 0) return;
  if (action === "replace") {
    await performReplace(urls);
  } else {
    await performAdd(urls);
  }
}

async function createUpdateNotification(remoteDevice, remoteProfile, timestamp) {
  const { notificationTimeoutSeconds, defaultTimeoutAction } =
    await chrome.storage.local.get([
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

  chrome.notifications.create(notifId, {
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
    const wasPresent = await chrome.notifications.clear(notifId);
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

    const wasPresent = await chrome.notifications.clear(notifId);
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

async function evaluateStatusAndNotify(statusUrl) {
  const { deviceName, lastSeenTimestamp } = await chrome.storage.local.get([
    "deviceName",
    "lastSeenTimestamp",
  ]);

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
  if (lastSeenTimestamp && timestamp <= lastSeenTimestamp) return false;

  await chrome.storage.local.set({ lastSeenTimestamp: timestamp });

  await createUpdateNotification(remoteDevice, remoteProfile, timestamp);
  return true;
}

async function checkForRemoteUpdateNow() {
  const root = await getOrCreateRootFolder();
  const status = await dedupeNamedBookmark(root.id, STATUS_TITLE);
  if (!status) return false;
  return evaluateStatusAndNotify(status.url);
}

chrome.bookmarks.onChanged.addListener(async (id, changeInfo) => {
  if (!changeInfo.url) return;

  let node;
  try {
    const results = await chrome.bookmarks.get(id);
    node = results[0];
  } catch (e) {
    return;
  }
  if (!node || node.title !== STATUS_TITLE) return;

  await evaluateStatusAndNotify(changeInfo.url);
});

async function getUrlsForDeviceProfile(deviceName, profile) {
  const root = await getOrCreateRootFolder();
  const deviceChildren = await chrome.bookmarks.getChildren(root.id);
  const deviceFolder = deviceChildren.find(
    (c) => !c.url && c.title === deviceName
  );
  if (!deviceFolder) return [];

  const profileChildren = await chrome.bookmarks.getChildren(deviceFolder.id);
  const profileFolder = profileChildren.find(
    (c) => !c.url && c.title === profile
  );
  if (!profileFolder) return [];

  const bookmarks = await chrome.bookmarks.getChildren(profileFolder.id);
  return bookmarks
    .filter((b) => b.url && b.title !== LAST_SYNC_TITLE)
    .map((b) => b.url);
}

async function performReplace(urls) {
  const oldWindows = await chrome.windows.getAll({ populate: false });
  const oldWindowIds = oldWindows.map((w) => w.id);

  // Open the replacement window FIRST and only close the old ones if
  // that succeeded — otherwise a failed create would leave the user
  // with no windows at all.
  let created;
  try {
    created = await chrome.windows.create({ url: urls });
  } catch (e) {
    created = null;
  }
  if (!created) return;

  for (const winId of oldWindowIds) {
    try {
      await chrome.windows.remove(winId);
    } catch (e) {}
  }
}

async function performAdd(urls) {
  const currentTabs = await chrome.tabs.query({});
  const alreadyOpenUrls = new Set(currentTabs.map((t) => t.url));
  const urlsToOpen = urls.filter((url) => !alreadyOpenUrls.has(url));

  if (urlsToOpen.length === 0) return;

  let targetWindow;
  try {
    targetWindow = await chrome.windows.getLastFocused({
      windowTypes: ["normal"],
    });
  } catch (e) {
    targetWindow = null;
  }

  if (targetWindow) {
    for (const url of urlsToOpen) {
      await chrome.tabs.create({ windowId: targetWindow.id, url });
    }
  } else {
    await chrome.windows.create({ url: urlsToOpen });
  }
}

chrome.notifications.onButtonClicked.addListener(
  async (notifId, buttonIndex) => {
    if (!notifId.startsWith(NOTIF_PREFIX)) return;

    // The user acted explicitly; drop the pending record so the sweep
    // won't also fire the default action later. (Clicking a button
    // already closes the notification, so the setTimeout/sweep paths
    // will see clear() return false and stand down.)
    const data = await removePendingNotif(notifId);
    chrome.notifications.clear(notifId);
    if (!data) return; // already resolved by a timeout/sweep

    const urls = await getUrlsForDeviceProfile(data.device, data.profile);
    if (urls.length === 0) return;

    if (buttonIndex === 0) {
      await performReplace(urls);
    } else if (buttonIndex === 1) {
      await performAdd(urls);
    }
  }
);

// ------------------------------------------------------------
// chrome.notifications only supports 2 buttons, so there's no room
// for a literal third "Ignore" button alongside "Replace"/"Add".
// Clicking the notification body itself (not a button) is the
// closest equivalent: it just dismisses the notification, applying
// no action at all — same outcome as letting it time out with
// defaultTimeoutAction set to "none", but immediate.
// ------------------------------------------------------------
chrome.notifications.onClicked.addListener(async (notifId) => {
  if (!notifId.startsWith(NOTIF_PREFIX)) return;
  // "Ignore": discard the pending record so the default action never
  // gets applied, then dismiss the notification.
  await removePendingNotif(notifId);
  chrome.notifications.clear(notifId);
});

async function listAvailableDevices() {
  const root = await getOrCreateRootFolder();
  const children = await chrome.bookmarks.getChildren(root.id);
  return children.filter((c) => !c.url).map((c) => c.title);
}

async function listProfilesForDevice(deviceName) {
  const root = await getOrCreateRootFolder();
  const deviceChildren = await chrome.bookmarks.getChildren(root.id);
  const deviceFolder = deviceChildren.find(
    (c) => !c.url && c.title === deviceName
  );
  if (!deviceFolder) return [];
  const children = await chrome.bookmarks.getChildren(deviceFolder.id);
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
  const deviceFolders = await chrome.bookmarks.getChildren(root.id);

  const found = new Set();
  for (const deviceFolder of deviceFolders) {
    if (deviceFolder.url) continue; // skip "_status"
    const profileFolders = await chrome.bookmarks.getChildren(
      deviceFolder.id
    );
    for (const pf of profileFolders) {
      if (!pf.url) found.add(pf.title);
    }
  }

  const { profiles } = await chrome.storage.local.get("profiles");
  for (const p of profiles || []) found.add(p);
  found.add(DEFAULT_PROFILE);

  return Array.from(found).sort();
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
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
      const urls = await getUrlsForDeviceProfile(
        device,
        profile || DEFAULT_PROFILE
      );
      if (urls.length === 0) {
        sendResponse({ ok: false, reason: "no-tabs" });
        return;
      }
      if (mode === "replace") {
        await performReplace(urls);
      } else {
        await performAdd(urls);
      }
      sendResponse({ ok: true });
    })();
    return true;
  }

  if (message?.type === "SWITCH_PROFILE_AND_SAVE") {
    saveOpenTabs().then(() => sendResponse({ ok: true }));
    return true;
  }

  if (message?.type === "ADD_PROFILE") {
    (async () => {
      const { profiles } = await chrome.storage.local.get("profiles");
      const list = profiles && profiles.length ? profiles : [DEFAULT_PROFILE];
      const name = message.name.trim();
      const exists = list.some((p) => p.toLowerCase() === name.toLowerCase());
      if (!exists) {
        await chrome.storage.local.set({ profiles: [...list, name] });
      }
      sendResponse({ ok: true });
    })();
    return true;
  }
});
