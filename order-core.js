// ============================================================
// SyncMyTabs - order-core.js
//
// Independent module: keeps each window's tab strip in a chosen
// layout — browser tab groups (Chrome/Brave) always first, sorted
// alphabetically by title, followed by every other (non-pinned,
// ungrouped) tab sorted most-recently-active first. Opt-in, off by
// default: reordering the tab strip is a more visibly disruptive
// action than anything else in this codebase, so it stays off until
// explicitly turned on, unlike groups-core.js's own (narrower)
// groupsPinToStart, which now defers to this module when it's active
// — see pinGroupsToStartEnabled's own comment in groups-core.js.
//
// Parameterized the same way as groups-core.js/archive-core.js: takes
// `env` PLUS the already-created sync engine instance (`syncEngine`)
// AND the archive engine instance (`archiveEngine`). Plain script, no
// import/export syntax — loaded via importScripts/background.scripts
// like the other modules; module.exports at the bottom is a Node-only
// no-op elsewhere.
//
// CONTRACT: reuses exactly syncEngine.isSyncEnabled() (the master
// pause switch) and archiveEngine.getActivityMap() (per-tab
// last-active timestamps, `{ [tabId]: timestamp }`) — a session
// editing only this file's own layout logic does not need to read
// sync-core.js or archive-core.js in full, only those two signatures.
//
// See docs/order-core.md for the full invariants (the idle-before-
// reordering trigger, the manual-move pause, the groups-pin-to-start
// hand-off, …) — this file's own comments carry the same detail near
// the relevant function; the doc is the compact index into it.
//
// Cross-browser note: tabGroups is a Chrome/Brave-only API (see
// CLAUDE.md's Cross-browser support section). On Firefox (or in any
// window with no open groups), the "groups first" phase is simply
// empty and every non-pinned tab is treated as an ungrouped
// recency-sort candidate — no special-casing needed anywhere below.
// ============================================================

const DEFAULT_ORDER_IDLE_MINUTES = 5;
const DEFAULT_ORDER_MANUAL_PAUSE_MINUTES = 30;
const ORDER_PAUSED_UNTIL_KEY = "tabOrderPausedUntil";

function createOrderEngine(env, syncEngine, archiveEngine) {
  const TAB_GROUP_ID_NONE = -1;

  function isGrouped(tab) {
    return typeof tab.groupId === "number" && tab.groupId !== TAB_GROUP_ID_NONE;
  }

  // ---- preferences (per-device local, not synced — same convention as
  // syncEnabled/ttlDays/groupsLeashEnabled/archiveEnabled) ----

  async function isOrderEnabled() {
    const { tabOrderEnabled } = await env.storage.local.get("tabOrderEnabled");
    return tabOrderEnabled === true; // default OFF — see the module header comment
  }

  async function orderIdleMinutes() {
    const { tabOrderIdleMinutes } = await env.storage.local.get("tabOrderIdleMinutes");
    return tabOrderIdleMinutes ?? DEFAULT_ORDER_IDLE_MINUTES;
  }

  async function orderManualPauseMinutes() {
    const { tabOrderManualPauseMinutes } = await env.storage.local.get(
      "tabOrderManualPauseMinutes"
    );
    return tabOrderManualPauseMinutes ?? DEFAULT_ORDER_MANUAL_PAUSE_MINUTES;
  }

  // ---- own-move guard, so a move THIS module issues is never mistaken
  // for a manual drag by handleTabMoved/handleGroupMoved below ----
  //
  // A heuristic time-window flag, not a real per-move acknowledgment —
  // the same class of trade-off as sync-core.js's
  // MIRROR_OPEN_DEBOUNCE_MS: neither tabs.onMoved nor tabGroups.onMoved
  // carries any "was this move programmatic" flag, so there's no exact
  // signal to key off. Set for the whole duration of one reconcile
  // pass (every tabGroups.move/tabs.move call it issues, across every
  // window) plus a short trailing grace period — an onMoved event can
  // still arrive a tick after the move() call's own promise resolves.
  // `env.reorderGuardGraceMs` overrides the grace period (absent on the
  // real `browser.*` object, so production always gets the real
  // default); test/sim-env.js's SimDevice defaults it to 0, since a
  // real wall-clock wait would only slow the suite down for no
  // correctness benefit there (SimTabsApi/SimTabGroupsApi fire onMoved
  // synchronously, not on a later tick).
  let reorderInProgress = false;

  async function withReorderGuard(fn) {
    reorderInProgress = true;
    try {
      await fn();
    } finally {
      const graceMs = env.reorderGuardGraceMs ?? 250;
      await new Promise((resolve) => setTimeout(resolve, graceMs));
      reorderInProgress = false;
    }
  }

  // ---- manual-move pause ----

  async function isPausedFromManualMove() {
    const { [ORDER_PAUSED_UNTIL_KEY]: until } = await env.storage.local.get(
      ORDER_PAUSED_UNTIL_KEY
    );
    return typeof until === "number" && Date.now() < until;
  }

  // Called from tabs.onMoved / tabGroups.onMoved (background.js) for any
  // move NOT issued by this module's own reconcile pass (guarded by
  // reorderInProgress above) — i.e. a real drag-and-drop by the user.
  // Suspends automatic reordering for orderManualPauseMinutes (default
  // 30, configurable) rather than fighting the user's own layout choice
  // on the very next check.
  async function handleForeignMove() {
    if (reorderInProgress) return;
    const minutes = await orderManualPauseMinutes();
    await env.storage.local.set({
      [ORDER_PAUSED_UNTIL_KEY]: Date.now() + minutes * 60 * 1000,
    });
  }

  // ---- the actual layout ----
  //
  // Groups first (alphabetical by title; an untitled group — no stable
  // identity for anything else in this codebase either, see
  // groups-core.js — sorts after every titled one), each as one
  // contiguous block in its OWN current internal tab order (this
  // function never reorders tabs WITHIN a group, only which block-index
  // the group starts at); then every remaining non-pinned, ungrouped
  // tab, most-recently-active first. Pinned tabs are never candidates
  // and never moved — same exclusion sync-core.js/archive-core.js apply
  // everywhere else, and the one the browser itself enforces anyway
  // (pinned tabs always occupy the window's first indices, outside any
  // extension's control).
  async function reorderWindow(windowId, activityMap) {
    const tabs = await env.tabs.query({ windowId });
    const pinnedCount = tabs.filter((t) => t.pinned).length;

    let groups = [];
    if (env.tabGroups) {
      try {
        groups = await env.tabGroups.query({ windowId });
      } catch (e) {
        groups = [];
      }
    }
    const sortedGroups = groups.slice().sort((a, b) => {
      const ta = a.title || "￿";
      const tb = b.title || "￿";
      return ta.localeCompare(tb);
    });

    const eligibleGrouped = new Set(
      tabs.filter((t) => !t.pinned && isGrouped(t)).map((t) => t.id)
    );
    const ungrouped = tabs.filter((t) => !t.pinned && !isGrouped(t));

    // A tab with no recorded activity yet (just opened, activity map
    // not written for it yet) sorts as if active RIGHT NOW — not to the
    // back, which would be a surprising place for a brand-new tab to
    // land the very next time this runs.
    const now = Date.now();
    ungrouped.sort((a, b) => (activityMap[b.id] ?? now) - (activityMap[a.id] ?? now));

    const desiredOrder = [];
    for (const g of sortedGroups) {
      for (const t of tabs) {
        if (t.groupId === g.id && eligibleGrouped.has(t.id)) desiredOrder.push(t.id);
      }
    }
    for (const t of ungrouped) desiredOrder.push(t.id);

    // Already exactly right? Skip entirely — avoids issuing no-op
    // move() calls (and toggling the reorder guard above) on every
    // single idle-triggered pass once a window has already settled.
    const currentOrder = tabs
      .filter((t) => !t.pinned)
      .slice()
      .sort((a, b) => a.index - b.index)
      .map((t) => t.id);
    if (desiredOrder.length === currentOrder.length && desiredOrder.every((id, i) => id === currentOrder[i])) {
      return;
    }

    let nextIndex = pinnedCount;
    for (const g of sortedGroups) {
      const memberCount = tabs.filter((t) => t.groupId === g.id && eligibleGrouped.has(t.id)).length;
      if (memberCount === 0) continue;
      try {
        await env.tabGroups.move(g.id, { index: nextIndex });
      } catch (e) {}
      nextIndex += memberCount;
    }
    for (const t of ungrouped) {
      try {
        await env.tabs.move(t.id, { index: nextIndex });
      } catch (e) {}
      nextIndex += 1;
    }
  }

  // ---- the reconcile pass ----
  //
  // Trigger: periodic (the same alarm as tab sync — see background.js),
  // and ONLY once no tab anywhere has been activated for at least
  // orderIdleMinutes (default 5) — a proxy for "reading something long,
  // or away from the computer", so the tab the user is actively working
  // in never jumps position under them. `{ force: true }` (the options
  // page's "Reorder now" button) bypasses both this idle gate and the
  // manual-move pause below — an explicit click is more authoritative
  // than either ambient heuristic — but still respects isOrderEnabled
  // and the master sync switch, same as every other module's "do it
  // now" action (GROUPS_RECONCILE_NOW/ARCHIVE_RECONCILE_NOW).
  async function reconcileOrder({ force = false } = {}) {
    if (!(await isOrderEnabled())) return;
    if (!(await syncEngine.isSyncEnabled())) return; // master pause covers this too

    const activity = await archiveEngine.getActivityMap();

    if (!force) {
      if (await isPausedFromManualMove()) return;
      const idleMinutes = await orderIdleMinutes();
      const values = Object.values(activity);
      const lastActivityAnywhere = values.length ? Math.max(...values) : 0;
      if (Date.now() - lastActivityAnywhere < idleMinutes * 60 * 1000) return;
    } else {
      // An explicit "reorder now" is a fresh instruction from the user
      // that supersedes any pending manual-move pause — clear it (set
      // firmly in the past, rather than removing the key outright, so
      // this doesn't need a storage.local.remove() the fake env in
      // test/sim-env.js would otherwise also have to implement) rather
      // than leaving a stale pause in effect for the NEXT automatic,
      // idle-gated pass too.
      await env.storage.local.set({ [ORDER_PAUSED_UNTIL_KEY]: 0 });
    }

    let windows = [];
    try {
      windows = await env.windows.getAll({ windowTypes: ["normal"] });
    } catch (e) {
      windows = [];
    }
    if (windows.length === 0) return;

    await withReorderGuard(async () => {
      for (const w of windows) {
        await reorderWindow(w.id, activity);
      }
    });
  }

  async function reorderNow() {
    await reconcileOrder({ force: true });
  }

  // ---- event-wiring handlers (see sync-core.js/groups-core.js's own
  // "why handle*() functions exist" comment) ----

  function handleTabMoved() {
    return handleForeignMove();
  }

  function handleGroupMoved() {
    return handleForeignMove();
  }

  async function handleOrderAlarm() {
    await reconcileOrder();
  }

  return {
    isOrderEnabled,
    orderIdleMinutes,
    orderManualPauseMinutes,
    isPausedFromManualMove,
    reconcileOrder,
    reorderNow,
    handleTabMoved,
    handleGroupMoved,
    handleOrderAlarm,
  };
}

if (typeof module !== "undefined" && module.exports) {
  module.exports = {
    DEFAULT_ORDER_IDLE_MINUTES,
    DEFAULT_ORDER_MANUAL_PAUSE_MINUTES,
    ORDER_PAUSED_UNTIL_KEY,
    createOrderEngine,
  };
}
