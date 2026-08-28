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
//
// groups-core.js is a SEPARATE, independent module (own bookmark
// sub-tree, own reconcile pipeline) for tab-group "leashing": a link
// clicked inside a titled browser tab group either navigates in place
// / opens alongside in the SAME group if it matches that tab's
// configured pattern, or always opens in a fresh UNGROUPED tab
// otherwise — plus a reconcile pass (at startup, and periodically at the
// same interval as tab sync) that reopens a group's missing "essential"
// tabs, closes duplicates, and optionally ungroups undeclared ones.
// Chrome/Brave only (Firefox has no tabGroups API — see groups-core.js).
// Group RULES sync via the SAME bookmark mechanism as everything else,
// scoped by the SAME active-profile concept.
//
// archive-core.js is a THIRD independent module: tracks the last time
// each of this device's own tabs was actually looked at, and — opt-in,
// off by default — saves a tab that's gone unlooked-at for longer than
// a configurable threshold (default 3 days) as a plain bookmark under a
// per-profile "_archive" folder, then closes it. Pinned/grouped tabs are
// never candidates. See archive-core.js's own header comment.
// ============================================================

// Cross-browser API access: use the promise-based `browser.*` namespace
// everywhere. On Firefox it's native; in the Chrome service worker we
// load Mozilla's WebExtension polyfill (which defines `browser` on top of
// `chrome`). On Firefox the polyfill (and sync-core.js) are loaded via
// manifest `background.scripts` instead, and `importScripts` doesn't
// exist on the event page — so guard the call.
if (typeof importScripts === "function") {
  importScripts(
    "browser-polyfill.min.js",
    "sync-core.js",
    "groups-core.js",
    "archive-core.js"
  );
}

const engine = createSyncEngine(browser);
const groupsEngine = createGroupsEngine(browser, engine);
const archiveEngine = createArchiveEngine(browser, engine);

// NOTE: sync-core.js, groups-core.js, AND archive-core.js are loaded
// into this SAME script via importScripts (Chrome) / sequential
// <script> tags (Firefox) — all four share ONE top-level `let`/`const`
// lexical scope, so declaring a top-level const/let here (or in
// groups-core.js/archive-core.js) with the SAME NAME as one of another
// file's own top-level bindings (e.g. sync-core.js's internal
// DEFAULT_PROFILE, DEFAULT_INTERVAL_MINUTES) throws a SyntaxError
// ("already been declared") that silently prevents this ENTIRE script
// from running — no listeners get registered at all. Always read such
// values off `engine.*`/`groupsEngine.*`/`archiveEngine.*` instead of
// re-declaring a same-named local, and give any background.js-only
// constant a name that can't collide (see test/no-name-collision.test.js).
const FALLBACK_INTERVAL_MINUTES = 1;
const GROUPS_RECONCILE_ALARM = "groupsReconcileAlarm";

async function ensureAlarm() {
  const { syncIntervalMinutes } = await browser.storage.local.get(
    "syncIntervalMinutes"
  );
  const period = syncIntervalMinutes || FALLBACK_INTERVAL_MINUTES;
  browser.alarms.create("saveTabsAlarm", { periodInMinutes: period });
}

// Re-arms the groups-reconcile alarm's recurring period to match the
// SAME check-interval setting as the main sync alarm above, without
// touching any startup-delay logic (that only applies right after a
// genuine browser launch — see onStartup below). Called whenever
// syncIntervalMinutes changes mid-session; the next fire is `period`
// minutes from now, same convention as ensureAlarm().
async function ensureGroupsAlarmPeriod() {
  const { syncIntervalMinutes } = await browser.storage.local.get(
    "syncIntervalMinutes"
  );
  const period = syncIntervalMinutes || FALLBACK_INTERVAL_MINUTES;
  browser.alarms.create(GROUPS_RECONCILE_ALARM, {
    delayInMinutes: period,
    periodInMinutes: period,
  });
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
    // Popups can't be opened programmatically — so open the full
    // options page as a regular tab instead, purely for this first-run
    // prompt (device name + profile setup live there).
    browser.tabs.create({ url: browser.runtime.getURL("options.html") });
  }
});

browser.runtime.onStartup.addListener(async () => {
  ensureAlarm();
  refreshActionIcon();
  await engine.handleStartup();
  await archiveEngine.handleStartupSeed();
  // First fire delayed (default 15s, configurable) so the browser's own
  // session restore has time to finish repopulating windows/tabs/groups
  // first — reconciling against a still-incomplete snapshot could
  // wrongly treat a not-yet-restored tab as "missing" or "duplicate".
  // Recurs after that at the SAME period as the main sync alarm
  // (syncIntervalMinutes) — see CLAUDE.md's "Tab-group leashing"
  // section for why running mid-session is safe.
  const [seconds, syncIntervalMinutes] = await Promise.all([
    groupsEngine.groupsStartupDelaySeconds(),
    browser.storage.local
      .get("syncIntervalMinutes")
      .then((r) => r.syncIntervalMinutes),
  ]);
  browser.alarms.create(GROUPS_RECONCILE_ALARM, {
    delayInMinutes: Math.max(Number(seconds) || 0, 1) / 60,
    periodInMinutes: syncIntervalMinutes || FALLBACK_INTERVAL_MINUTES,
  });
});

browser.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm.name !== "saveTabsAlarm") return;
  await engine.handleAlarm();
  // Reuses the SAME periodic alarm rather than registering a third one —
  // there's no separate "archive check interval" setting, it just piggy-
  // backs on the main sync cadence (syncIntervalMinutes).
  await archiveEngine.handleArchiveAlarm();
});

browser.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm.name !== GROUPS_RECONCILE_ALARM) return;
  await groupsEngine.handleGroupsAlarm();
});

browser.storage.onChanged.addListener((changes, area) => {
  if (area !== "local") return;
  if (changes.syncIntervalMinutes) {
    ensureAlarm();
    ensureGroupsAlarmPeriod();
  }
  // Reacting here (rather than only right after the popup's own toggle
  // write) makes storage.onChanged the single source of truth for the
  // toolbar icon's paused state — it updates correctly no matter what
  // changed syncEnabled.
  if (changes.syncEnabled) {
    updateActionIcon(changes.syncEnabled.newValue !== false);
  }
});

browser.tabs.onRemoved.addListener((tabId, removeInfo) => {
  engine.handleTabRemoved(tabId, removeInfo);
  archiveEngine.handleTabRemoved(tabId);
});

browser.tabs.onUpdated.addListener((tabId, changeInfo) => {
  engine.handleTabUpdated(tabId, changeInfo);
});

// archive-core.js's own activity tracking — see its header comment.
// Cheap and unconditional (regardless of archiveEnabled): a tab that's
// currently active in its window, or whose window just gained OS focus,
// counts as "looked at" right now.
browser.tabs.onActivated.addListener((activeInfo) => {
  archiveEngine.handleTabActivated(activeInfo);
});

browser.windows.onFocusChanged.addListener((windowId) => {
  archiveEngine.handleWindowFocusChanged(windowId);
});

browser.tabs.onCreated.addListener((tab) => {
  archiveEngine.handleTabCreated(tab);
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

  // ---- Tab-group leashing module (groups-core.js) ----

  if (message?.type === "LINK_CLICK" && sender.tab) {
    groupsEngine
      .handleLinkClick(message.href, sender.tab, message.modifiers || {})
      .then(() => sendResponse({ ok: true }))
      .catch((err) => sendResponse({ ok: false, error: String(err) }));
    return true;
  }

  // Answers link-leash-content.js's handshake — whether this tab is
  // grouped/leashed at all, and its currently-resolved pattern — so the
  // content script can decide SYNCHRONOUSLY, per click, whether to
  // intercept at all (a plain click on a link that already matches the
  // pattern must be left alone, not routed through a hard tabs.update,
  // or client-side-routed apps like Telegram Web get force-reloaded
  // instead of navigating in place — see CLAUDE.md). Re-sent by the
  // content script on every SPA-style URL change too, not just on load.
  if (message?.type === "GROUP_LEASH_INFO" && sender.tab) {
    groupsEngine.getLeashInfoFor(sender.tab).then((info) => sendResponse(info));
    return true;
  }

  if (message?.type === "GROUPS_LIST") {
    groupsEngine.listGroupsForActiveProfile().then((data) => sendResponse(data));
    return true;
  }

  if (message?.type === "GROUPS_GET") {
    groupsEngine.getGroupForEditing(message.title).then((data) => sendResponse(data));
    return true;
  }

  if (message?.type === "GROUPS_SET") {
    (async () => {
      await groupsEngine.setGroupSettingsForActiveProfile(message.title, message.rules);
      sendResponse({ ok: true });
    })();
    return true;
  }

  if (message?.type === "GROUPS_DELETE") {
    (async () => {
      await groupsEngine.deleteGroupSettingsForActiveProfile(message.title);
      sendResponse({ ok: true });
    })();
    return true;
  }

  if (message?.type === "GROUPS_GET_PREFS") {
    (async () => {
      const [leashEnabled, ungroupUndeclared, startupDelaySeconds, pinToStart] = await Promise.all([
        groupsEngine.isLeashEnabled(),
        groupsEngine.ungroupUndeclaredTabsEnabled(),
        groupsEngine.groupsStartupDelaySeconds(),
        groupsEngine.pinGroupsToStartEnabled(),
      ]);
      sendResponse({ leashEnabled, ungroupUndeclared, startupDelaySeconds, pinToStart });
    })();
    return true;
  }

  if (message?.type === "GROUPS_SET_PREFS") {
    (async () => {
      const updates = {};
      if (message.leashEnabled !== undefined) updates.groupsLeashEnabled = message.leashEnabled;
      if (message.ungroupUndeclared !== undefined) {
        updates.groupsUngroupUndeclaredTabs = message.ungroupUndeclared;
      }
      if (message.startupDelaySeconds !== undefined) {
        updates.groupsStartupDelaySeconds = message.startupDelaySeconds;
      }
      if (message.pinToStart !== undefined) updates.groupsPinToStart = message.pinToStart;
      await browser.storage.local.set(updates);
      sendResponse({ ok: true });
    })();
    return true;
  }

  if (message?.type === "GROUPS_RECONCILE_NOW") {
    (async () => {
      await groupsEngine.reconcileGroups();
      sendResponse({ ok: true });
    })();
    return true;
  }

  // ---- Auto-archive module (archive-core.js) ----

  if (message?.type === "ARCHIVE_GET_PREFS") {
    (async () => {
      const [archiveEnabled, idle] = await Promise.all([
        archiveEngine.isArchiveEnabled(),
        archiveEngine.archiveIdleThreshold(),
      ]);
      sendResponse({
        archiveEnabled,
        archiveIdleDays: idle.days,
        archiveIdleHours: idle.hours,
        archiveIdleMinutes: idle.minutes,
      });
    })();
    return true;
  }

  if (message?.type === "ARCHIVE_SET_PREFS") {
    (async () => {
      const updates = {};
      if (message.archiveEnabled !== undefined) updates.archiveEnabled = message.archiveEnabled;
      if (message.archiveIdleDays !== undefined) updates.archiveIdleDays = message.archiveIdleDays;
      if (message.archiveIdleHours !== undefined) updates.archiveIdleHours = message.archiveIdleHours;
      if (message.archiveIdleMinutes !== undefined) updates.archiveIdleMinutes = message.archiveIdleMinutes;
      await browser.storage.local.set(updates);
      sendResponse({ ok: true });
    })();
    return true;
  }

  if (message?.type === "ARCHIVE_RECONCILE_NOW") {
    (async () => {
      await archiveEngine.reconcileArchive();
      sendResponse({ ok: true });
    })();
    return true;
  }

  if (message?.type === "ARCHIVE_CLEAR") {
    (async () => {
      await archiveEngine.clearArchiveForActiveProfile();
      sendResponse({ ok: true });
    })();
    return true;
  }
});
