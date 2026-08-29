# Tab-group leashing module (`groups-core.js`)

> Split out of `CLAUDE.md` to keep the base file small — read this when
> you're actually working on `groups-core.js` or `link-leash-content.js`.
> Same 1-invariant-1-place documentation convention as `CLAUDE.md`'s
> Architecture section: summary + pointer here, full detail in the code.

A separate, independent module ported from the standalone TabGroupsLeash
extension: link "leashing" for a browser tab group (a clicked link either
navigates in place / opens alongside in the SAME group if it matches that
tab's configured pattern, or always opens in a fresh UNGROUPED tab
otherwise) plus a reconcile pass (reopen a group's missing "essential"
tabs, close duplicates, optionally detach undeclared ones from the group).
Chrome/Brave only — Firefox has no `tabGroups` API, so every function here
feature-detects `env.tabGroups` and no-ops without it (same cross-browser
rule as the rest of the codebase — see `CLAUDE.md`'s Cross-browser support
section).

- **Bookmark tree shape**:
  ```
  SyncMyTabs/<profile>/_groups/<group title>/<one bookmark per rule>
  ```
  SIBLING to the per-URL folders, invisible to `readProfileEntries`. A
  rule packs `pattern`/`openUrl` into its bookmark's `url`; the group
  TITLE is the only stable cross-device key (untitled groups are
  unsupported). Full encoding and the `pattern`-does-double-duty
  rationale: see the file header comment in `groups-core.js`.
- **Config, not tab state — different sync model on purpose.** A group's
  rules are replaced wholesale on every edit, last-write-wins on
  concurrent cross-device edits — accepted for infrequently-edited config
  data. See the comment above `setGroupSettings` in `groups-core.js`.
- **Only the RULES sync via bookmarks — local per-device preferences
  don't** (`groupsLeashEnabled`, `groupsUngroupUndeclaredTabs`,
  `groupsStartupDelaySeconds`, `groupsPinToStart` all live in
  `env.storage.local`).
- **Undeclared tabs are UNGROUPED, never closed** (`groupsUngroupUndeclaredTabs`,
  opt-in, default OFF) — non-destructive, unlike the exact-duplicate
  cleanup it runs alongside. Full history/rationale: see the comment
  above the `ungroupUndeclared` branch in `reconcileGroup` in
  `groups-core.js`.
- **Scoped by the SAME active-profile concept as the rest of the
  extension** — `activeProfileFolderId()` resolves through
  `syncEngine.getActiveProfile()`/`getOrCreateProfileFolder()`.
- **Link leashing is read-only-cheap for the common case** —
  `resolvePatternFor(tab)` bails out immediately unless the tab is
  ACTUALLY grouped; `readGroupSettings` never creates a folder just to
  read from it. See their own comments in `groups-core.js`.
- **The content script (`link-leash-content.js`) doesn't intercept every
  click on every page** — it only attaches listeners on a tab confirmed
  grouped at load time (trade-off: a tab grouped AFTER load won't get
  leashing until reloaded — see `CLAUDE.md`'s Known limitations). **A
  plain click on an already-matching link is left COMPLETELY alone** — a
  correctness fix, not an optimization, for client-side-routed pages
  (SPAs). Full mechanism (the cached, synchronously-rechecked
  `GROUP_LEASH_INFO` handshake, the `pushState`/`popstate` refresh
  hooks): see the header and `onClick` comments in
  `link-leash-content.js`. `handleLinkClick` in `groups-core.js` remains
  the authoritative decision-maker for every case that DOES reach it
  (non-matching link, or modifier-click on a matching one).
- **Groups can be pinned to the start of the tab strip**
  (`groupsPinToStart`, default off) — re-asserted on EVERY reconcile, not
  just when something reopened; multiple pinned groups stack in title
  order via consecutive indices. See the comment above the pin block in
  `reconcileGroup` in `groups-core.js`.
- **Runs once per browser launch AND periodically thereafter**, on the
  SAME interval as the main tab-sync check, only for groups with at least
  one saved rule; the first fire is delayed (`groupsStartupDelaySeconds`,
  default 15s) so session restore finishes first. Alarm registration
  lives in `background.js`; `groups-core.js` itself has no opinion on
  cadence. Full rationale for why periodic mid-session runs are safe: see
  the comment above `reconcileGroups` in `groups-core.js`.
- **`reconcileGroups()` also respects the master `syncEnabled` switch** —
  pausing sync pauses the whole extension, groups module included.
