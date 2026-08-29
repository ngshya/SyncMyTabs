# Tab & group order module (`order-core.js`)

> Split out of `CLAUDE.md` to keep the base file small — read this when
> you're actually working on `order-core.js`. Same 1-invariant-1-place
> documentation convention as `CLAUDE.md`'s Architecture section: summary
> + pointer here, full detail in the code.

A fourth independent module, **off by default**: lays out each window with
browser tab groups first (Chrome/Brave, alphabetical by title) then every
other non-pinned tab most-recently-active first. Reordering the tab strip
is a more visibly disruptive action than anything else in this codebase,
which is why — unlike every other module here — it defaults OFF rather
than on.

- **Reuses `archive-core.js`'s activity tracking, doesn't duplicate it.**
  `archive-core.js` already records every tab's last-active timestamp
  unconditionally (regardless of `archiveEnabled`); `order-core.js` takes
  the already-created archive engine instance as a constructor param
  (`createOrderEngine(env, syncEngine, archiveEngine)`) and reads it via
  `archiveEngine.getActivityMap()` — a `{ [tabId]: timestamp }` map,
  exposed specifically for this reuse. See the CONTRACT comment at the
  top of `order-core.js` and `getActivityMap`'s own comment in
  `archive-core.js`.
- **The layout**: groups first (alphabetical by title — an untitled
  group, no stable identity for anything else in this codebase either,
  see `groups-core.js`, sorts after every titled one), each as ONE
  contiguous block in its own current internal tab order (this module
  never reorders tabs WITHIN a group, only which index the group's block
  starts at); then every remaining non-pinned, ungrouped tab,
  most-recently-active first. A tab with no recorded activity yet sorts
  as if active RIGHT NOW, not to the back — a brand-new tab shouldn't
  land somewhere surprising the very next time this runs. See the
  comment above `reorderWindow` in `order-core.js`.
- **Pinned tabs are never candidates and never moved** — same exclusion
  `sync-core.js`/`archive-core.js` apply everywhere else, and one the
  browser itself enforces anyway (pinned tabs always occupy a window's
  first indices, outside any extension's control).
- **Trigger: periodic, and only once idle.** Piggybacks on the SAME
  alarm as tab sync (no separate "tab order check interval" setting,
  same convention as `archive-core.js`) — see the `saveTabsAlarm`
  handler in `background.js`. `reconcileOrder()` itself only actually
  reorders once NO tab anywhere has been activated for at least
  `orderIdleMinutes` (default 5, configurable) — a proxy for "reading
  something long, or away from the computer" — so the tab the user is
  actively using never jumps position under them. See the comment above
  `reconcileOrder` in `order-core.js`.
- **A detected manual move pauses automatic reordering.** Real
  drag-and-drop fires `tabs.onMoved`/`tabGroups.onMoved` — wired in
  `background.js` to `handleTabMoved`/`handleGroupMoved`, which suspend
  `reconcileOrder()` for `orderManualPauseMinutes` (default 30,
  configurable) rather than immediately fighting the user's own layout
  choice on the very next check. See `handleForeignMove`'s comment in
  `order-core.js`.
- **The own-move guard (`reorderInProgress`) is a heuristic, not a real
  acknowledgment** — same class of trade-off as `sync-core.js`'s
  `MIRROR_OPEN_DEBOUNCE_MS`: neither `tabs.onMoved` nor
  `tabGroups.onMoved` carries a "was this move programmatic" flag, so
  there's no exact signal to key off. Set for the whole duration of one
  reconcile pass (every `tabGroups.move`/`tabs.move` call it issues,
  across every window) plus a short trailing grace period
  (`env.reorderGuardGraceMs`, overridable — `test/sim-env.js`'s
  `SimDevice` defaults it to 0 since its fakes fire `onMoved`
  synchronously, no real event-loop delay to guard against there). See
  `withReorderGuard`'s comment in `order-core.js`.
- **`groupsPinToStart` (`groups-core.js`) defers to this module when
  it's active.** That toggle only ever repositions groups with a saved
  leash rule in `groups-core.js`'s own config, leaving every other open
  group's position untouched, and runs on every check interval rather
  than this module's idle-gated cadence — running both at once wouldn't
  just be redundant, it would actively break this module's own
  manual-move detector (it can't tell `groupsPinToStart`'s own
  `tabGroups.move()` calls apart from a real user drag). `groups-core.js`
  reads `tabOrderEnabled` directly (a well-known shared storage key, not
  a function-level dependency on this module) to detect this and skip
  its own pin-to-start move entirely. See `pinGroupsToStartEnabled`'s
  own comment in `groups-core.js`.
- **`reorderNow()`** (the options page's "Reorder now" button, and the
  `ORDER_REORDER_NOW` message) bypasses BOTH the idle gate and the
  manual-move pause — an explicit click is more authoritative than
  either ambient heuristic — and also clears any pending manual-move
  pause outright, rather than leaving it in effect for the next
  automatic pass too. Still respects `isOrderEnabled()` and the master
  `syncEnabled` switch, same as every other module's "do it now" action.
  See `reconcileOrder`'s own comment in `order-core.js`.
- **Cross-browser**: the "groups first" phase is Chrome/Brave only
  (`env.tabGroups` feature-detected, see `CLAUDE.md`'s Cross-browser
  support section) — on Firefox, or in any window with no open groups,
  every non-pinned tab is simply treated as an ungrouped recency-sort
  candidate, no special-casing needed anywhere.
