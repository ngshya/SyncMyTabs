// Shared setup for order-core.js tests. Deliberately NOT part of
// sim-env.js: order-core.js is a separate module from sync-core.js's
// own engine (same reasoning as test/groups-test-helpers.js) —
// sim-env.js stays decoupled from all of these. order-core.js itself
// requires an archiveEngine instance (see its own CONTRACT comment) —
// a test needs archive-core.js's activity tracking wired to the SAME
// device's real events too for the recency sort to mean anything, so
// call archiveEngineFor(device) FIRST and pass its result in here,
// rather than this file building its own separate, unwired instance.

const { createOrderEngine } = require("../order-core.js");

// Wires order-core.js to the SAME tabsApi/tabGroupsApi event hooks the
// real background.js registers (tabs.onMoved, tabGroups.onMoved).
//
// Deliberately NOT queued onto world.pending, unlike every other
// wiring helper in this suite (archive-test-helpers.js's onRemoved/
// onCreated/onActivated, SimDevice's own onRemoved) — those model
// genuine async cross-device/cross-reconcile propagation, where
// deferring to a flush() point is the right simplification. This one
// backs order-core.js's own SYNCHRONOUS "was this move mine"
// reorderInProgress guard (see its module comment): the check only
// means anything if it runs and completes at the moment the move
// happens, not on some later flush() — which is also why
// SimTabsApi.move()/SimTabGroupsApi.move() `await` this hook directly
// before their own promise resolves, instead of firing it
// fire-and-forget the way onCreated/onActivated do.
function orderEngineFor(device, archiveEngine) {
  const orderEngine = createOrderEngine(device.env, device.engine, archiveEngine);

  const priorOnMoved = device.tabsApi.onMoved;
  device.tabsApi.onMoved = async (tabId, moveInfo) => {
    if (priorOnMoved) await priorOnMoved(tabId, moveInfo);
    await orderEngine.handleTabMoved();
  };
  device.tabGroupsApi.onMoved = async (groupId, moveInfo) => {
    await orderEngine.handleGroupMoved();
  };

  return orderEngine;
}

module.exports = { orderEngineFor };
