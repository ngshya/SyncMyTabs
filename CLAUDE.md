# CLAUDE.md

Guidance for Claude (and any AI agent) working in this repository.

## What this repository is

**SyncMyTabs** is a browser extension (Manifest V3) that syncs a user's open
tabs across devices, organized by profile, using **bookmarks as the transport**.
It has no server, no account, and no cloud service of its own — it reads/writes a
structured bookmark tree and reacts to changes, relying on the user's existing
bookmark sync (native browser sync, Floccus, xBrowserSync, …) to actually move
data between devices.

See `README.md` for the full user-facing description. This file is about
*working on the code*.

## Cross-browser support (IMPORTANT)

**The extension must work on both Chromium browsers (Chrome/Brave) and
Firefox.** Keep this in mind in every change:

- Prefer APIs available on both — this codebase currently uses no Chrome-only
  API (pinned tabs and tab groups, the previous Chrome-only feature, were
  dropped in the v3 redesign). If a future change needs one, it must be
  **feature-detected and degrade gracefully**, never assumed to exist.
- Bookmark-root ids differ (Chrome `"2"` vs Firefox `"unfiled_____"` etc.):
  always resolve through `getRootParentId`, never hardcode.
- Firefox uses `browser.*` (promise-based) and event-page backgrounds, not a
  service worker. Cross-browser API access goes through the vendored
  `webextension-polyfill` (or an equivalent shim) — don't reintroduce raw
  `chrome.*` promise calls that only work on Chrome.
- The manifest carries both backgrounds (`service_worker` for Chrome, `scripts`
  for Firefox); `browser_specific_settings.gecko` pins the Firefox id / min
  version. When you touch the manifest, keep both browsers loadable.
- There is no automated cross-browser test here — verify manually in **both**
  Chrome (`chrome://extensions` → Load unpacked) and Firefox
  (`about:debugging` → Load Temporary Add-on).

## Branch & push workflow (IMPORTANT)

- **All development happens on the `claude/svil` branch.**
- If you are **not** currently on `claude/svil`, switch to it before making any
  change:
  ```bash
  git checkout claude/svil 2>/dev/null || git checkout -b claude/svil
  ```
- **Always push to `claude/svil`** (`git push -u origin claude/svil`). Never
  push to `main`/`master` or to any other branch without the user's explicit
  permission.
- Open pull requests **from `claude/svil`** into the default branch.

## Project layout

| File | Role |
|---|---|
| `manifest.json` | Manifest V3, permissions, entry points, **version**; dual background (Chrome `service_worker` + Firefox `scripts`), `browser_specific_settings.gecko`, the tab-group leashing module's `<all_urls>` content script |
| `sync-core.js` | **All the open-tab sync/reconcile logic**, factored out of `background.js` and parameterized over an `env` (bookmarks/tabs/windows/storage/runtime) instead of calling `browser.*` directly — see "Testing" below. Plain script, no import/export syntax (loaded via `importScripts`/`background.scripts` like the polyfill); `module.exports` at the bottom is a Node-only no-op elsewhere. |
| `groups-core.js` | **The independent tab-group leashing module** (see its own "Tab-group leashing" section below, and [`docs/groups-core.md`](docs/groups-core.md) for the full invariants) — same `env`-parameterized style as `sync-core.js`, plus takes the already-created sync engine instance (`createGroupsEngine(env, syncEngine)`) to reuse `getActiveProfile`/`getOrCreateProfileFolder`/`mergeFolderInto`/`isSyncEnabled` rather than re-implementing them. Chrome/Brave only (feature-detects `env.tabGroups`, a silent no-op on Firefox). |
| `archive-core.js` | **The independent auto-archive module** (see its own "Auto-archive idle tabs" section below, and [`docs/archive-core.md`](docs/archive-core.md) for the full invariants) — same `env`-parameterized style, takes the sync engine instance (`createArchiveEngine(env, syncEngine)`) for the same reuse reasons as `groups-core.js`. Tracks each tab's last-focused time and, on by default, saves+closes one that's been idle past a threshold. |
| `background.js` | Thin wiring: registers real `browser.*` event listeners and forwards them to `sync-core.js`'s / `groups-core.js`'s / `archive-core.js`'s `engine.handle*()` functions, plus browser-chrome-only bits (toolbar icon, alarm registration) that aren't sync logic |
| `link-leash-content.js` | Content script for the leashing module — see its section below |
| `popup.html` / `popup.js` | The **compact** toolbar popup — status, an on/off switch per feature module (open-tab sync, tab groups, auto-archive), a "Sync now" quick action, and a button to open `options.html`. Deliberately minimal; see "Popup vs. options page" below for why. |
| `options.html` / `options.js` | The **full settings page**, opened as a plain tab (from the popup's "Open full settings" button, or by `browser.runtime.onInstalled` for first-run setup, since popups can't be opened programmatically) — device name, profiles, the shared check interval, and every module's detail settings (grouped into three cards: Open tabs sync, Tab groups, Auto-archive), plus the theme selector. Mostly the same DOM-building code the old all-in-one popup used to have. |
| `theme.css` / `theme.js` | Shared dark/light/system theme system, loaded by both `popup.html` and `options.html` — see "Popup vs. options page" below |
| `lazy.html` / `lazy.js` | Lazy-restore placeholder page — by default loads the real URL only on an explicit click (not just on becoming visible), so autoplay media (YouTube, etc.) never starts just from switching tabs; `lazyRequireClick: false` in storage restores the old load-on-visible behavior |
| `browser-polyfill.min.js` | Vendored Mozilla WebExtension polyfill so `browser.*` is promise-based on Chrome too |
| `icons/` | Extension icons (16 / 48 / 128 px, plus `*-off` for the paused state) |
| `test/` | The test suite for `sync-core.js`, `groups-core.js`, and `archive-core.js` — see "Testing" below |

There is **no build step** — the repository *is* the unpacked extension (the
polyfill is vendored, not built; `package.json` exists only for `npm test`, no
runtime dependencies). The only CI is a **release workflow**
(`.github/workflows/release.yml`), which **fires automatically on every push
to `main`** — i.e. every PR merge — and checks whether `manifest.json`'s
`version` is already released; if it's new, it syntax-checks the JS, **runs
the test suite**, builds **two** store-ready zips from the dual dev manifest —
a Chrome one (`service_worker` only) and a Firefox one (`scripts` only) — runs
`web-ext lint` on the Firefox build, and publishes both as a GitHub Release.
A merge that doesn't bump the version is a no-op for this workflow (skipped,
not failed). It can also be triggered by pushing a matching `v*` tag, or
manually from the Actions tab — both fail loudly instead of skipping if that
version was already released. Store-listing docs live in `PRIVACY.md`,
`PERMISSIONS.md`, and `STORE_LISTING.md` (the store's summary/description
copy); listing screenshots live in `store-assets/`.

**When you add a new top-level file** — a new module loaded via
`importScripts`/`background.scripts` (like `archive-core.js`), or a new file
an HTML page loads via its own `<script src>`/`<link href>` (like
`options.js`/`theme.css`) — **add it to `release.yml`'s `COMMON` file list
too** (and the syntax-check step, if it's JS). This isn't automatic: the
dev tree (what `git clone` + "Load unpacked" gives you) and the store zips
are built from two different file lists that only the workflow keeps in
sync, and nothing here checks that they match. Missing this once already
shipped a real regression: `archive-core.js` missing broke the WHOLE
background service worker (a failed `importScripts` call throws, so
**no** listener ever registers — sync and groups included, not just
archive), `options.html` missing made "Open full settings" fail with
`ERR_FILE_NOT_FOUND`, and `theme.css` missing left every CSS custom
property undefined, rendering buttons with no background at all ("the
theme looks all white, I can't see the buttons"). All invisible from
`test/` (Node tests) and from testing via "Load unpacked" on the raw repo
folder (always complete) — only a build from the actual `release.yml`
file list would have caught it. Verify by actually building the zip
locally (mirror the workflow's `COMMON` + packaging steps) and loading
*that* folder via "Load unpacked" when you're unsure, not just the repo
root.

## Testing

`sync-core.js` holds all the sync logic as a factory, `createSyncEngine(env)`,
that never touches `browser.*` directly — every bookmark/tab/window/storage/
runtime call goes through the `env` object passed in. In the real extension
`background.js` calls `createSyncEngine(browser)`; the test suite instead
builds a **simulated multi-device environment** (`test/sim-env.js`) and calls
`createSyncEngine(fakeEnv)` for each simulated device — so the exact same
reconcile code runs in both places, not a re-implementation of it.

`sync-core.js` also exports the **event-wiring decisions** as
`engine.handle*()` functions (`handleTabRemoved`, `handleTabUpdated`,
`handleBookmarkEvent`, `handleAlarm`, `handleStartup`, `handleSyncNow`,
`handleSwitchProfileAndSave`) — e.g. "an `isWindowClosing` removal is
ignored", "only `status === 'complete'` counts as a finished navigation".
`background.js`'s real listeners are one-line calls into these; `sim-env.js`'s
`SimDevice` methods (`openTab`, `closeTab`, `navigateTab`, `tick`, `startup`,
`switchProfile`, `updateTabs`, …) call the **same** functions when simulating
a browser event. This means a test exercises the real wiring, not just the
reconcile internals — e.g. the simulator's `tabs.remove()` fires `onRemoved`
even for a removal `reconcileMirror` itself triggered, exactly like a real
browser, which is what makes a mirror-driven close correctly flip the closing
device's own bookmark entry too.

`test/sim-env.js`'s `SimWorld` holds one **shared, in-memory bookmark tree**
that every simulated device's `env.bookmarks` reads/writes — i.e. bookmark
sync is simulated as instantaneous. That's the right simplification for
testing whether the reconcile logic itself converges to the correct
open/closed state (which is most of what there is to test); it does NOT model
sync propagation delay, so it can't catch a timing-dependent race on its own
— those stay a documented, accepted architectural trade-off (see Known
limitations). `world.disconnectDevice(device)` simulates a device going
permanently offline (uninstalled, or just never coming back) for TTL tests,
since otherwise every registered device reacts to every change. TTL tests
also monkey-patch `Date.now()` (see `withFakeClock` in
`test/ttl-cleanup.test.js`) rather than waiting in real time — always restore
it in a `finally`.

`test/sim-env.js` also fakes `env.tabGroups` per device (`SimTabGroupsApi`:
`query`/`get`/`update`) plus `env.tabs.group()`/`.ungroup()`/`.update()`, for
`groups-core.js` tests. Tab groups are per-device local state (a `Map`, not
routed through `SimWorld`'s shared tree) — exactly like the real
`chrome.tabGroups` API, only the group's RULES sync via the shared bookmark
tree. Group ids from these fakes are deliberately kept **numeric**
(`nextGroupId()`, distinct from every other id in the simulator, which are
opaque strings) because `isInTabGroup`/`groups-core.js`'s `isGrouped` both
type-check `typeof tab.groupId === "number"` to match the real API — use
`SimDevice.ensureOpenGroup(title)` / `openGroupedTab(url, title, groupTitle)`
in a test, never a raw `nextId()`-derived id, or the "grouped" check will
silently read as false. `groups-core.js` tests build their own engine
directly — `createGroupsEngine(device.env, device.engine)` — rather than
going through a `SimDevice` helper, since it's a separate module from
`sync-core.js`'s own engine; `test/groups-test-helpers.js`'s
`groupsEngineFor(device)` is the shared one-liner for that, used by every
`groups-*.test.js` file instead of each redeclaring it.

`archive-core.js` tests follow the same "separate module, own helper"
pattern as `groups-core.js` — `test/archive-test-helpers.js`'s
`archiveEngineFor(device)` builds `createArchiveEngine(device.env,
device.engine)` and wires it to the SAME `tabsApi`/`windowsApi` event
hooks the real `background.js` registers (`onCreated`, `onActivated`,
`onRemoved` — chained onto SimDevice's own existing `onRemoved` handler
rather than replacing it, `onFocusChanged`), each queued onto
`world.pending` exactly like `sim-env.js`'s own `onRemoved` wiring, so
`world.flush()` waits for archive-core.js's reaction too. Calling
`archiveEngine.reconcileArchive()` directly (there's no `SimDevice`
helper for it — same reasoning as `groups-core.js`'s own engine) does
**not** auto-flush afterward the way every `SimDevice` action method
does; a test must `await device.world.flush()` itself if the reconcile
closed a tab whose downstream reaction (e.g. propagating that close to
another device) matters to the assertion —
`test/archive-core.test.js`'s own `runReconcile()` helper wraps both
calls together for this reason. `test/archive-test-helpers.js`'s
`activateTab(device, url)` simulates the user switching to an
already-open tab (deactivates every other tab in the same window, fires
`tabs.onActivated` — see `SimTabsApi._setActiveTab`).
`SimTabsApi.query(queryInfo)` filters for real (by `windowId`/`active`/
`groupId`/`pinned`) — an earlier version silently ignored `queryInfo`
entirely and always returned every tab, undetected until archive-core.js
needed a real `windowId`+`active` lookup to mean something. A tab's
`windowId` also now defaults to `windowsApi.defaultWindowId` (not a
hardcoded `"1"`) for the same reason.

Run the suite:
```bash
npm test                    # same as: node --test test/*.test.js
```
(`node --test test/` — a bare directory path, no glob — misbehaves on at
least some Node versions; always pass the explicit glob.)

When you change reconcile behavior in `sync-core.js`, `groups-core.js`, or
`archive-core.js`, add/update a test in `test/` alongside it — this is the
actual regression net for the safety rules documented below (the
phantom-duplicate-entry guard, the "closes are only detected from a live tab
event" rule, and the mirror-open debounce all have regression tests; a
change that violates any of them should make one fail).

`popup.js`/`options.js`/`theme.js` (and `lazy.js`, `link-leash-content.js`)
are DOM/browser-API-only and stay outside the Node suite's scope, same as
before — verify those live in a real (or headless, via Playwright) browser.

## How to work on it

1. **Switch to `claude/svil`** (see above) before editing.
2. Edit the plain JS/HTML files directly. Sync/reconcile logic changes go in
   `sync-core.js`, not `background.js` — see "Testing" above.
3. **Syntax-check** any JS you touched:
   ```bash
   node --check background.js && node --check sync-core.js && node --check groups-core.js && node --check archive-core.js && node --check popup.js && node --check options.js
   ```
4. **Run the test suite** (`npm test`) — see "Testing" above. Add/update
   tests for any reconcile-logic change.
5. **Manually verify** in the browser when behavior changes: load the folder via
   `chrome://extensions` → *Load unpacked*, then hit **Reload** on the extension
   after each change. The test suite covers the reconcile logic; it can't
   exercise the real `browser.*` APIs, the popup UI, or the manifest.
6. If behavior or the public surface changed, **bump `version` in
   `manifest.json`** (semver) and update `README.md`.
7. Commit with a clear message, then **push to `claude/svil`**.

## Architecture notes & conventions (v4 — per-URL folders)

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

## Tab-group leashing module (`groups-core.js`)

A separate, independent module ported from the standalone TabGroupsLeash
extension: link "leashing" for a browser tab group (a clicked link either
navigates in place / opens alongside in the SAME group if it matches that
tab's configured pattern, or always opens in a fresh UNGROUPED tab
otherwise) plus a reconcile pass (reopen a group's missing "essential"
tabs, close duplicates, optionally detach undeclared ones from the group).
Chrome/Brave only — Firefox has no `tabGroups` API, so every function here
feature-detects `env.tabGroups` and no-ops without it (same cross-browser
rule as the rest of the codebase — see Cross-browser support above).

**Full invariants (bookmark tree shape, the config-vs-tab-state sync
model, link-leashing mechanics, reconcile cadence, …) are in
[`docs/groups-core.md`](docs/groups-core.md) — read it before touching
`groups-core.js` or `link-leash-content.js`.** Kept out of this file to
keep every session's base context small; not needed unless you're
actually working on this module.

## Auto-archive idle tabs (`archive-core.js`)

A third independent module: tracks the last time each of this device's own
tabs was actually looked at, and — on by default, despite being
destructive — once a tab has gone unlooked-at for longer than a
configurable threshold (default 4 days), saves it as a plain bookmark and
closes it. Pinned tabs and tabs inside a browser tab group are never
candidates, same exclusion `sync-core.js` applies everywhere else.

**Full invariants (the day/hour/minute threshold fields, bookmark tree
shape, activity-tracking persistence, the never-close-without-saving
rule, …) are in [`docs/archive-core.md`](docs/archive-core.md) — read it
before touching `archive-core.js`.** Kept out of this file for the same
reason as the groups-core.js doc above.

## Popup vs. options page

Split in the same change auto-archive was added, once the popup had grown
enough settings that keeping everything in one place stopped being the
better trade-off. `popup.html`/`popup.js` is now deliberately minimal:
status, one on/off switch per feature module (open-tab sync — also the
master `syncEnabled` switch — tab groups, auto-archive), a "Sync now"
quick action, and a button that opens `options.html` as a plain tab (same
`browser.tabs.create({url: browser.runtime.getURL(...)})` mechanism the
first-run prompt already used). `options.html`/`options.js` holds
everything else: device name, profiles, the shared check interval (right
after profiles), and every module's detail settings grouped into three
cards in that same order (Open tabs sync / Tab groups / Auto-archive),
plus the theme selector. `browser.runtime.onInstalled` now opens
`options.html` (not `popup.html`) for first-run setup, since that's where
device name + profile setup live now.

`theme.css`/`theme.js` are shared between the two pages: `theme.css`
defines CSS custom-property tokens on bare `:root` (light, the default),
redefines them under `@media (prefers-color-scheme: dark)` guarded by
`:root:not([data-theme="light"])`, then redefines them again under
`:root[data-theme="dark"]` so an explicit choice always wins over the OS
setting in both directions. `theme.js` reads `themePreference` from
`storage.local` (`"system"` default / `"light"` / `"dark"`), stamps it as
a `data-theme` attribute on `<html>`, and listens for `storage.onChanged`
so a change made in one page is reflected live in the other if both happen
to be open at once. Applied asynchronously (a brief flash of the OS-default
theme before an explicit override applies is accepted — not worth a
synchronous-localStorage-cache workaround for a page this short-lived).

## Known limitations (don't "fix" without discussion)

- Chrome/Brave and Firefox are both supported targets (see **Cross-browser
  support** above).
- **Closing (and reopening) is contagious, not per-device-final** (see the
  Architecture section above) — there is no shared clock and no cross-device
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
  resurrection" race** (see the Architecture section above,
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
