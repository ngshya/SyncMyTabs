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

// "Other Bookmarks" folder in Chrome/Brave. If Firefox support is
// ever needed, this id would have to be adapted (Firefox uses
// different strings, e.g. "unfiled_____").
const OTHER_BOOKMARKS_PARENT_ID = "2";

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

  return chrome.bookmarks.create({
    parentId: OTHER_BOOKMARKS_PARENT_ID,
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

async function clearFolder(folderId) {
  const children = await chrome.bookmarks.getChildren(folderId);
  for (const child of children) {
    await chrome.bookmarks.remove(child.id);
  }
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

chrome.runtime.onStartup.addListener(ensureAlarm);

chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm.name === "saveTabsAlarm") {
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

async function createUpdateNotification(remoteDevice, remoteProfile, timestamp) {
  const { notificationTimeoutSeconds } = await chrome.storage.local.get(
    "notificationTimeoutSeconds"
  );
  const timeoutMs = (notificationTimeoutSeconds || 15) * 1000;

  const notifId = `${NOTIF_PREFIX}${timestamp}`;
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

  setTimeout(async () => {
    const stillPending = await chrome.notifications.clear(notifId);
    if (!stillPending) return;

    const { defaultTimeoutAction } = await chrome.storage.local.get(
      "defaultTimeoutAction"
    );
    const action = defaultTimeoutAction || "add";
    if (action === "none") return;

    const urls = await getUrlsForDeviceProfile(remoteDevice, remoteProfile);
    if (urls.length === 0) return;

    if (action === "replace") {
      await performReplace(urls);
    } else {
      await performAdd(urls);
    }
  }, timeoutMs);
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

  await chrome.storage.local.set({
    lastSeenTimestamp: timestamp,
    pendingDevice: remoteDevice,
    pendingProfile: remoteProfile,
  });

  createUpdateNotification(remoteDevice, remoteProfile, timestamp);
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

  await chrome.windows.create({ url: urls });

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

    const { pendingDevice, pendingProfile } = await chrome.storage.local.get([
      "pendingDevice",
      "pendingProfile",
    ]);
    if (!pendingDevice) return;

    const urls = await getUrlsForDeviceProfile(
      pendingDevice,
      pendingProfile || DEFAULT_PROFILE
    );
    if (urls.length === 0) {
      chrome.notifications.clear(notifId);
      return;
    }

    if (buttonIndex === 0) {
      await performReplace(urls);
    } else if (buttonIndex === 1) {
      await performAdd(urls);
    }

    chrome.notifications.clear(notifId);
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
chrome.notifications.onClicked.addListener((notifId) => {
  if (!notifId.startsWith(NOTIF_PREFIX)) return;
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
