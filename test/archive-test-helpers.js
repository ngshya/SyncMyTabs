// Shared setup for archive-core.js tests. Deliberately NOT part of
// sim-env.js: archive-core.js is a separate module from sync-core.js's
// own engine (same reasoning as test/groups-test-helpers.js) — sim-env.js
// stays decoupled from both. This file is the shared exception for tests
// that need archive-core.js wired to a device's real tab/window events.

const { createArchiveEngine } = require("../archive-core.js");

// Builds an archive engine for `device` and wires it to the SAME
// tabsApi/windowsApi event hooks the real background.js registers
// (tabs.onCreated, tabs.onActivated, tabs.onRemoved,
// windows.onFocusChanged) — WITHOUT clobbering device.tabsApi.onRemoved,
// which SimDevice's own constructor already uses for sync-core.js's
// handleTabRemoved. Every hook is queued onto world.pending, exactly
// like SimDevice's own onRemoved wiring, so world.flush() (which every
// SimDevice action already calls) waits for archive-core.js's reaction
// too before a test asserts anything.
function archiveEngineFor(device) {
  const archiveEngine = createArchiveEngine(device.env, device.engine);
  const world = device.world;

  const priorOnRemoved = device.tabsApi.onRemoved;
  device.tabsApi.onRemoved = (id, removeInfo) => {
    if (priorOnRemoved) priorOnRemoved(id, removeInfo);
    world.pending.push(Promise.resolve().then(() => archiveEngine.handleTabRemoved(id)));
  };
  device.tabsApi.onCreated = (tab) => {
    world.pending.push(Promise.resolve().then(() => archiveEngine.handleTabCreated(tab)));
  };
  device.tabsApi.onActivated = (activeInfo) => {
    world.pending.push(
      Promise.resolve().then(() => archiveEngine.handleTabActivated(activeInfo))
    );
  };
  device.windowsApi.onFocusChanged = (windowId) => {
    world.pending.push(
      Promise.resolve().then(() => archiveEngine.handleWindowFocusChanged(windowId))
    );
  };

  return archiveEngine;
}

// Simulates the user switching to an already-open tab (a click on its
// tab-strip entry, or Ctrl+Tab landing on it) — deactivates every other
// tab in the same window and fires tabs.onActivated, exactly like a
// real browser (see SimTabsApi._setActiveTab). Looked up by URL, same
// convention as SimDevice._findTabByUrl. Requires archiveEngineFor(device)
// (or nothing at all, if the test doesn't care about the event firing)
// to have been called first for the activation to actually reach
// archive-core.js.
async function activateTab(device, url) {
  const tab = device._findTabByUrl(url);
  if (!tab) throw new Error(`no tab open at ${url} on ${device.deviceName}`);
  device.tabsApi._setActiveTab(tab.id);
  await device.world.flush();
}

module.exports = { archiveEngineFor, activateTab };
