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
//   parseTabEntryUrl/buildTabEntryUrl in sync-core.js).
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
//
// This file is deliberately thin: all the actual sync/reconcile logic
// (and the "when X happens, do Y" decisions — e.g. which tab events
// count as a close) lives in sync-core.js, factored out so the exact
// same code can run against a simulated multi-device environment in
// the test suite (see test/ and CLAUDE.md). Keep new sync LOGIC in
// sync-core.js; keep this file to wiring real browser events to it and
// to things that are genuinely browser-chrome-only (the toolbar icon,
// the alarm registration).
// ============================================================

// Cross-browser API access: use the promise-based `browser.*` namespace
// everywhere. On Firefox it's native; in the Chrome service worker we
// load Mozilla's WebExtension polyfill (which defines `browser` on top of
// `chrome`). On Firefox the polyfill (and sync-core.js) are loaded via
// manifest `background.scripts` instead, and `importScripts` doesn't
// exist on the event page — so guard the call.
if (typeof importScripts === "function") {
  importScripts("browser-polyfill.min.js", "sync-core.js");
}

const engine = createSyncEngine(browser);
const DEFAULT_PROFILE = engine.DEFAULT_PROFILE;

const DEFAULT_INTERVAL_MINUTES = 1;

async function ensureAlarm() {
  const { syncIntervalMinutes } = await browser.storage.local.get(
    "syncIntervalMinutes"
  );
  const period = syncIntervalMinutes || DEFAULT_INTERVAL_MINUTES;
  browser.alarms.create("saveTabsAlarm", { periodInMinutes: period });
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
  updateActionIcon(await engine.isSyncEnabled());
}

// ------------------------------------------------------------
// Lifecycle & event wiring — thin wrappers over engine.handle*.
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
  await engine.handleStartup();
});

browser.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm.name !== "saveTabsAlarm") return;
  await engine.handleAlarm();
});

browser.storage.onChanged.addListener((changes, area) => {
  if (area !== "local") return;
  if (changes.syncIntervalMinutes) ensureAlarm();
  if (changes.syncEnabled) {
    updateActionIcon(changes.syncEnabled.newValue !== false);
  }
});

browser.tabs.onRemoved.addListener((tabId, removeInfo) => {
  engine.handleTabRemoved(tabId, removeInfo);
});

browser.tabs.onUpdated.addListener((tabId, changeInfo) => {
  engine.handleTabUpdated(tabId, changeInfo);
});

browser.bookmarks.onCreated.addListener((id, node) => {
  engine.handleBookmarkEvent(node && node.url);
});

browser.bookmarks.onChanged.addListener((id, changeInfo) => {
  engine.handleBookmarkEvent(changeInfo && changeInfo.url);
});

browser.bookmarks.onRemoved.addListener(() => {
  engine.handleBookmarkRemoved();
});

// ------------------------------------------------------------
// Messages from the popup/options UI.
// ------------------------------------------------------------
browser.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.type === "SYNC_NOW") {
    (async () => {
      await engine.handleSyncNow();
      sendResponse({ ok: true });
    })();
    return true;
  }

  if (message?.type === "GET_ALL_KNOWN_PROFILES") {
    engine.listAllKnownProfiles().then((profiles) => sendResponse({ profiles }));
    return true;
  }

  if (message?.type === "GET_DEVICES_FOR_PROFILE") {
    engine.listDevicesForProfile(message.profile).then((devices) =>
      sendResponse({ devices })
    );
    return true;
  }

  if (message?.type === "MANUAL_RESTORE") {
    (async () => {
      const { device, profile, mode } = message;
      const resolvedProfile = profile || DEFAULT_PROFILE;
      const entries = await engine.getOpenEntriesForDeviceProfile(
        device,
        resolvedProfile
      );
      if (entries.length === 0) {
        sendResponse({ ok: false, reason: "no-tabs" });
        return;
      }
      const activeProfile = await engine.getActiveProfile();
      const opts = { exemptFromTracking: resolvedProfile !== activeProfile };
      if (mode === "replace") {
        await engine.performReplace(entries, opts);
      } else {
        await engine.performAdd(entries, opts);
      }
      sendResponse({ ok: true });
    })();
    return true;
  }

  if (message?.type === "SWITCH_PROFILE_AND_SAVE") {
    (async () => {
      await engine.handleSwitchProfileAndSave();
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
