# Known limitations (don't "fix" without discussion)

> Moved out of `CLAUDE.md` to keep every session's base context small.
> Read it when you're working on what it covers.


- Chrome/Brave and Firefox are both supported targets (see **Cross-browser
  support** above).
- **Closing (and reopening) is contagious, not per-device-final** (see
  `docs/sync-core.md`) — there is no shared clock and no cross-device
  "who's newer" comparison; a close anywhere closes everywhere, and a reopen
  anywhere resets any peer that's currently closed so it re-mirrors back in
  too. This is architectural and deliberate, confirmed explicitly with the
  user after an earlier "sticky" iteration (a device's own close was final,
  never overridden by another's state) was found to not match what was
  actually wanted. Known, accepted trade-off: `resetClosedPeers` can't tell
  a peer's STALE closed entry (left over from an earlier close that's since
  been undone) apart from that same peer's own CURRENT, independent close —
  so a reopen anywhere forces a reopen on every currently-closed peer,
  regardless of why each one is closed. Don't "fix" this into a
  per-device-final model without discussion.
- **Mirror-open debounce shrinks, but doesn't eliminate, the "orphan
  resurrection" race** (see `docs/sync-core.md`,
  `MIRROR_OPEN_DEBOUNCE_MS`). It's a fixed heuristic delay, not a real
  happens-before guarantee against an out-of-order/partial bookmark sync
  batch — a device that's offline, asleep, or simply behind by longer
  than the debounce window when it finally catches up can still open a
  tab for a URL that, in reality, was fully closed and deleted elsewhere
  moments before. This is the same class of trade-off as the two bullets
  above (no shared clock, no central authority) — increasing the window
  narrows the risk further at the cost of extra latency on every
  legitimate remote open; don't "fix" this into a stronger guarantee (a
  real ack/confirmation protocol between devices) without discussion —
  there is no channel for that beyond the bookmarks themselves.
- No migration from pre-4.0 versions. An upgrading user's old
  `SyncMyTabs/<profile>/…` (v3, flat per-(device,url) bookmarks) or
  `SyncMyTabs/<device>/…` (pre-3.0) tree is left in place, unused. Don't add
  migration code for it without the user asking — this was a deliberate
  decision.
- The tab-group leashing module (`groups-core.js`) is Chrome/Brave only
  (Firefox has no `tabGroups` API) and doesn't support untitled groups (no
  stable cross-device key) — see its own section above. Group RULES are
  last-write-wins on concurrent cross-device edits (config data, not tab
  state — see that section for why this is a different, and accepted,
  trade-off from the tab-close model). A tab dragged into a group
  after its page already loaded doesn't get leashing until reloaded, by
  design (see that section's content-script note) — don't "fix" this by
  reverting to intercepting every click on every page.
- **The browser's own tab-group sync (where the browser account itself,
  not this extension, syncs tab-group membership across devices) should be
  turned off for any profile this module manages.** Both mechanisms
  reconciling group membership independently — this module's rule-based
  reconcile pass and the browser's own — can fight each other. This is
  surfaced as a warning in `options.html`'s Tab groups card and in
  `README.md`, not something the extension can detect or disable on the
  user's behalf (it's a browser-level setting, outside any WebExtension
  API this codebase has access to).
- **Archived tabs are a one-way export, not a restore feature.**
  `archive-core.js` only ever writes to the `_archive` bookmark folder; it
  never reads it back. Restoring an archived tab is just opening its
  bookmark like any other, through the browser's own bookmark manager —
  there's no in-extension "browse/restore archived tabs" UI. Don't add one
  without the user asking; it wasn't requested and duplicates what the
  browser's bookmark manager already does.
- **`order-core.js`'s own-move guard (`reorderInProgress`) is a
  heuristic time window, not a real acknowledgment** — same class of
  trade-off as `MIRROR_OPEN_DEBOUNCE_MS` above: neither `tabs.onMoved`
  nor `tabGroups.onMoved` tells an extension whether a move was
  programmatic, so there's no exact signal available. A move that
  somehow lands outside the guarded window (a very slow/suspended
  service worker mid-reconcile, say) could be misread as manual and
  trigger an unnecessary pause — self-correcting on its own once the
  pause expires, never a correctness problem, just an extra delay. Don't
  "fix" this into a stronger guarantee without discussion; there's no
  channel to do so beyond this heuristic.
- **`order-core.js` is opt-in and off by default, unlike every other
  module here.** Deliberate: reordering the tab strip is more visibly
  disruptive than anything else in this codebase (closing/archiving a
  tab happens to ONE tab a user hasn't touched in a while; this can
  rearrange an entire window at once). Don't flip its default without
  the user asking.
- **The custom new tab page can't be switched off from inside the
  extension.** `chrome_url_overrides.newtab` is all-or-nothing per
  installation, and an extension page can't redirect back to the native
  new tab page. The only ways back are disabling the extension — which
  is also exactly what Chrome's own post-install prompt does if the user
  picks "Change it back", taking tab sync down with it (surfaced as a
  warning in README.md and STORE_LISTING.md). Don't
  "fix" this with an in-page "disabled" mode that renders a blank page —
  that's worse than either, and still not the native page.
- **`theme.js`'s brief flash of the OS-default theme** (see Popup vs.
  options page) is more noticeable on the new tab page, which opens far
  more often than popup/options. Accepted for now, same reasoning; a
  synchronous localStorage cache in `theme.js` is the fix if it ever
  bothers the user.
