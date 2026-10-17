# Open-tab sync (`sync-core.js`): architecture notes & conventions (v4 — per-URL folders)

> Moved out of `CLAUDE.md` to keep every session's base context small.
> Read it when you're working on what it covers.


Understanding these will keep changes safe. This is a from-scratch redesign of
the bookmark schema (v3.x used one flat bookmark per `(device, url)` pair
directly under the profile folder, with cross-device timestamp-precedence
voting deciding open-vs-closed; that's gone — no migration, see Known
limitations).

> **Documentation convention:** each invariant below is documented ONCE, in
> full, in the code comment nearest the function that implements it. Here you
> get a 1-2 line summary plus a pointer — read the pointed-to comment for the
> why/trade-offs/edge-cases before changing that code. Don't re-expand the
> summary back into a duplicate essay here; enrich the code comment instead.

- **Bookmark tree shape** (created under "Other Bookmarks"):
  ```
  SyncMyTabs/<profile>/<one folder per open URL>/{_url, <device1>, <device2>, …}
  ```
  Every open URL gets its own folder; matching is always by the folder's
  `_url` child (`URL_MARKER_TITLE`), never by folder title. Each device that
  has weighed in gets **one status bookmark of its own** (`s`/`t`/`h` packed
  into its `url`) and **only ever writes its own** — never another device's,
  except the three sanctioned exceptions. Full encoding, the "own bookmark
  only" invariant, and the three exceptions: see the comment above
  `STATUS_URL_BASE` in `sync-core.js`.
- **Closing is CONTAGIOUS, not per-device-final** — one device's status
  reading `closed` makes `reconcileMirror` close it on every other device
  too, cascading until the folder is deleted. This is a REMOTE-DRIVEN close
  (an explicit bookmark signal), unlike `closeMyGoneTabs` below — see the
  comment above `reconcileMirror` in `sync-core.js`.
- **Reopening propagates too — `resetClosedPeers`** — a fresh/genuine local
  open deletes every OTHER device's stale `closed` entry in that folder, so
  it naturally re-mirrors back in. Known, accepted trade-off: can't tell a
  peer's stale closed entry from its current independent close. See the
  comment above `resetClosedPeers` in `sync-core.js` and
  `test/reopen-propagation.test.js`.
- **A brand-new mirror-open is debounced — `MIRROR_OPEN_DEBOUNCE_MS`** (20s)
  — guards against resurrecting a URL that was actually already closed and
  deleted elsewhere but hasn't finished syncing that away yet. A fixed
  heuristic delay, not a real happens-before guarantee (see Known
  limitations). Full mechanism: see the comment above the
  `MIRROR_OPEN_DEBOUNCE_MS` constant in `sync-core.js`.
- **`t` vs `h` — do not conflate them.** `t` moves only on a genuine local
  open/close transition; `h` is a liveness heartbeat used purely for
  per-device TTL staleness. Conflating them reintroduces the race fixed in
  2.6.2. See the comment above `STATUS_URL_BASE` in `sync-core.js`.
- **SAFETY RULE: closes are only ever detected from a live, specific-tab
  event.** `closeMyGoneTabs` is called only from `tabs.onRemoved`/
  `tabs.onUpdated`(navigation complete) — never from the alarm, `onStartup`,
  or a bookmark-change reaction, none of which are tied to one tab's event or
  guaranteed to see a complete `tabs.query()` snapshot. Does NOT apply to
  `reconcileMirror`'s contagious close (an explicit remote signal, not an
  inference) — safe from every trigger. Full rule: see the comment above
  `closeMyGoneTabs` in `sync-core.js`.
- **`snapshotOwnTabs` skips tabs still loading** (`status !== "complete"`) to
  avoid registering a transient mid-navigation URL as a permanent phantom
  entry. See the comment above `snapshotOwnTabs` in `sync-core.js`.
- **`readProfileEntries`** is the single place that reads a whole profile
  folder's tree, and self-heals duplicate URL-folders from sync-tool races.
  Every reconcile function goes through it — don't re-implement folder
  traversal elsewhere. See its own comment in `sync-core.js`.
- **The extension checks the SyncMyTabs folder on every change to it, never
  on a timer** — bookmark events trigger a reconcile immediately; the alarm
  is only a backstop plus the TTL sweep. See the comment above `runReconcile`
  in `sync-core.js`.
- **The reconcile pipeline** (`runReconcile`, always via `scheduleReconcile`
  — never call `runReconcile` directly): `closeMyGoneTabs` (if `checkClosed`)
  → `reconcileMyOpenEntries` → `reconcileMirror` → `reconcileMyOpenEntries`
  again. Full trigger list and ordering rationale: see the comment above
  `runReconcile` in `sync-core.js`.
- **A close always propagates, but folder deletion still needs everyone
  actually closed first** — safe for any device to delete once nobody's
  writing to those bookmarks anymore. See the comment above `reconcileMirror`
  in `sync-core.js`.
- **TTL cleanup** (`ttlEnabled`/`ttlDays` in storage, default on/**14 days**)
  is evaluated **per device entry, not per folder** — a folder-level check
  would let one abandoned device's stale entry hide behind another's fresh
  heartbeat. See `cleanupProfileFolder` in `sync-core.js`.
- **`closeMyDuplicateTabs`** (`closeDuplicateTabs` in storage, default
  **OFF**) is a periodic backstop closing this device's own extra local tabs
  sharing a URL, keeping the leftmost. Wired into the alarm and
  `handleSyncNow`, deliberately not `handleStartup`. See its own comment in
  `sync-core.js`.
- **Parent folder id** is resolved at runtime (`getRootParentId`), cached,
  with a fallback to Chrome/Brave's `"2"`. Never hardcode `"2"` — go through
  the resolver so Firefox stays reachable.
- **Unopened placeholders still count as "open".** `snapshotOwnTabs` resolves
  a lazy placeholder to its real URL (`realUrlOfTab`) and treats it like any
  other open tab. See the comment above `realUrlOfTab` in `sync-core.js`.
- **Master on/off switch.** `syncEnabled` (storage, default true) is checked
  at the top of `runReconcile`/`cleanupProfileFolder`; the toolbar icon
  reacts via `chrome.storage.onChanged` so the popup toggle is the single
  source of truth. See the comment above `runReconcile` in `sync-core.js` and
  the `storage.onChanged` listener in `background.js`.
- **Pinned tabs and tabs inside a browser tab group are both excluded from
  sync entirely.** `snapshotOwnTabs` splits its result into `urls`
  (pinned/grouped excluded — feeds the folder-entry logic) and `allUrls`
  (pinned/grouped included — feeds dedup checks, so a remote open never
  duplicates a pinned/grouped tab). See the comment above `snapshotOwnTabs`
  in `sync-core.js` and `test/grouped-tabs-excluded.test.js`. Don't
  reintroduce pin or tab-group syncing without discussion.
- **Self-healing.** `mergeFolderInto` merges same-named duplicate root/
  profile folders (sync-tool races); `readProfileEntries` does the
  URL-folder-level equivalent, keyed by `_url` instead of title. See their
  own comments in `sync-core.js`.
- **Legacy root names.** The extension was formerly `OpenTabSync` / `Live
  Tabs Sync` and migrates such a root folder in place (`LEGACY_ROOT_NAMES`).
  Add to that list rather than breaking migration if the name ever changes
  again. This is unrelated to (and unaffected by) the v3→v4 schema change.
