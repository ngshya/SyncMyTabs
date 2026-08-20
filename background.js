// ============================================================
// SyncMyTabs - background.js (service worker, Manifest V3)
//
// Architecture (v4 — per-URL folders, see CLAUDE.md):
// - Root bookmarks folder: "SyncMyTabs"
// - Under it: one subfolder per PROFILE (e.g. "default", "work"). A
//   device picks which profile is "active"; automatic sync only ever
//   happens for the active profile (profiles stay independent).
// - Under each profile: one subfolder per open URL (its title is just
//   the tab title/URL, cosmetic only). Inside it: an `_url` bookmark
//   holding the real URL (the actual matching key — never the folder
//   title), and one status bookmark per device, titled with that
//   device's name, encoding open/closed + two timestamps (see
//   parseDeviceStatusUrl/buildDeviceStatusUrl in sync-core.js).
// - Every device is the ONLY writer of its OWN status bookmark. Opening
//   a tab creates/updates that device's entry to "open"; closing it
//   flips the SAME entry to "closed" (never deleted immediately) so the
//   closure is an observable, explicit event other devices react to.
//   Once EVERY device's entry in a folder is "closed", any device that
//   notices deletes the whole folder. Once a device has weighed in
//   (open OR closed) on a URL, only ITS OWN future actions ever change
//   its own entry — it never gets overridden by another device's state.
//   A configurable TTL is a safety net that prunes a device's own stale
//   entry (untouched heartbeat) outright; a folder disappears once
//   every entry left in it (after pruning) is closed, or none remain.
// - Pinned tabs and tabs inside a browser tab group are excluded
//   entirely from this tracking.
// - No more notifications / manual Add-Replace flow: this is always a
//   live two-way mirror for the active profile.
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

// NOTE: sync-core.js is loaded into this SAME script via importScripts
// (Chrome) / sequential <script> tags (Firefox) — both share ONE
// top-level `let`/`const` lexical scope, so declaring a top-level
// const/let here with the SAME NAME as one of sync-core.js's own
// top-level bindings (e.g. its internal DEFAULT_PROFILE,
// DEFAULT_INTERVAL_MINUTES) throws a SyntaxError ("already been
// declared") that silently prevents this ENTIRE script from running —
// no listeners get registered at all. Always read such values off
// `engine.*` instead of re-declaring a same-named local, and give any
// background.js-only constant a name that can't collide.
const FALLBACK_INTERVAL_MINUTES = 1;

async function ensureAlarm() {
  const { syncIntervalMinutes } = await browser.storage.local.get(
    "syncIntervalMinutes"
  );
  const period = syncIntervalMinutes || FALLBACK_INTERVAL_MINUTES;
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
      profiles: [engine.DEFAULT_PROFILE],
      activeProfile: engine.DEFAULT_PROFILE,
    });
  }
  if (!deviceName) {
    // There's no separate options page anymore (settings live in the
    // popup) and popups can't be opened programmatically — so open the
    // SAME popup.html as a regular tab instead, purely for this
    // first-run prompt. It's the identical page either way.
    browser.tabs.create({ url: browser.runtime.getURL("popup.html") });
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
  engine.handleBookmarkEvent(node && node.title, node && node.url);
});

browser.bookmarks.onChanged.addListener((id, changeInfo) => {
  engine.handleBookmarkEvent(changeInfo && changeInfo.title, changeInfo && changeInfo.url);
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
      const list = profiles && profiles.length ? profiles : [engine.DEFAULT_PROFILE];
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
