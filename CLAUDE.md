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
| `groups-core.js` | **The independent tab-group leashing module** (see its own "Tab-group leashing" section below) — same `env`-parameterized style as `sync-core.js`, plus takes the already-created sync engine instance (`createGroupsEngine(env, syncEngine)`) to reuse `getActiveProfile`/`getOrCreateProfileFolder`/`mergeFolderInto`/`isSyncEnabled` rather than re-implementing them. Chrome/Brave only (feature-detects `env.tabGroups`, a silent no-op on Firefox). |
| `background.js` | Thin wiring: registers real `browser.*` event listeners and forwards them to `sync-core.js`'s / `groups-core.js`'s `engine.handle*()` functions, plus browser-chrome-only bits (toolbar icon, alarm registration) that aren't sync logic |
| `link-leash-content.js` | Content script for the leashing module — see its section below |
| `popup.html` / `popup.js` | The **only** UI — toolbar popup holding status, all settings (device name, profiles, interval, lazy restore, TTL), and tab-group rule editors. No separate options page; `browser.runtime.onInstalled` opens `popup.html` as a plain tab for first-run setup, since popups can't be opened programmatically. |
| `lazy.html` / `lazy.js` | Lazy-restore placeholder page — by default loads the real URL only on an explicit click (not just on becoming visible), so autoplay media (YouTube, etc.) never starts just from switching tabs; `lazyRequireClick: false` in storage restores the old load-on-visible behavior |
| `browser-polyfill.min.js` | Vendored Mozilla WebExtension polyfill so `browser.*` is promise-based on Chrome too |
| `icons/` | Extension icons (16 / 48 / 128 px, plus `*-off` for the paused state) |
| `test/` | The test suite for `sync-core.js` and `groups-core.js` — see "Testing" below |

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
version was already released. Store-listing docs live in `PRIVACY.md` and
`PERMISSIONS.md`.

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

Run the suite:
```bash
npm test                    # same as: node --test test/*.test.js
```
(`node --test test/` — a bare directory path, no glob — misbehaves on at
least some Node versions; always pass the explicit glob.)

When you change reconcile behavior in `sync-core.js` or `groups-core.js`,
add/update a test in `test/` alongside it — this is the actual regression net
for the safety rules documented below (the phantom-duplicate-entry guard and
the "closes are only detected from a live tab event" rule both have
regression tests; a change that violates either should make one fail).

## How to work on it

1. **Switch to `claude/svil`** (see above) before editing.
2. Edit the plain JS/HTML files directly. Sync/reconcile logic changes go in
   `sync-core.js`, not `background.js` — see "Testing" above.
3. **Syntax-check** any JS you touched:
   ```bash
   node --check background.js && node --check sync-core.js && node --check popup.js
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

- **Bookmark tree shape** (created under "Other Bookmarks"):
  ```
  SyncMyTabs/<profile>/<one folder per open URL>/{_url, <device1>, <device2>, …}
  ```
  Profiles are still the top-level unit. Under each profile, every open URL
  gets its **own folder**. That folder's `title` is purely cosmetic
  (`folderTitleFor` — the tab's title, or the URL itself, truncated to
  `FOLDER_TITLE_MAX_LEN`) — matching a URL to its folder is **always** done
  by reading the folder's `_url` child bookmark (`URL_MARKER_TITLE`), never
  by folder title, so title length/collisions/encoding are never a
  correctness concern. Inside the folder, each device that has ever weighed
  in on that URL gets **one bookmark of its own**, titled with the device's
  name (exact, unencoded), whose `url` packs its status
  (`buildDeviceStatusUrl`/`parseDeviceStatusUrl`): `s`=`open`|`closed`,
  `t`=state-change time, `h`=heartbeat time. **A device only ever writes its
  own status bookmark** — never another device's — so there is never a
  concurrent write to the same bookmark. This is the property that makes the
  whole design safe; don't introduce a NEW code path where one device edits
  another's status bookmark beyond the three sanctioned exceptions: TTL-
  driven removal of a stale entry, bulk deletion of a folder everyone
  already agrees is fully `closed` (see cleanup below), and
  `resetClosedPeers` deleting a peer's stale `closed` entry on a fresh
  open/reopen (see the CONTAGIOUS bullet right below).
- **Closing is CONTAGIOUS, not per-device-final.** The moment ANY device's
  own status bookmark in a folder reads `closed`, `reconcileMirror` makes
  every OTHER device that still shows `open` follow suit: it closes its own
  matching tab(s) (via `env.tabs.remove`) and flips its own status bookmark
  to `closed` too — see the `anyClosed` branch. This cascades until every
  device agrees closed, at which point the folder is deleted (see below). A
  device with no bookmark of its own yet still mirrors in whatever's open
  elsewhere, exactly as before — but once ANYONE has started closing a URL,
  no device mirrors it in anymore (`if (anyClosed) { ...; continue; }` skips
  the open-mirroring branch entirely for that URL). This is a REMOTE-DRIVEN
  close, driven by an unambiguous bookmark-state signal, not an inference
  from this device's own tab snapshot — see the SAFETY RULE below for why
  that distinction matters and why it's still fine for this to run from
  every trigger (alarm/startup/bookmark-event), unlike `closeMyGoneTabs`.
  (An earlier iteration of this design made a device's own close "sticky" —
  final for that device, never overridden by another's state. That was
  reverted: closing a tab anywhere now closes it everywhere.)
- **Reopening propagates too — `resetClosedPeers`.** Close-contagion alone
  left a real gap: a device that had already followed a peer's close stayed
  closed forever, even after that peer reopened — nothing told it to catch
  up. `reconcileMyOpenEntries` closes this gap: whenever THIS device
  freshly opens a URL (the `!mine` branch) or genuinely reopens one (the
  `mine.state === "closed"` branch), it calls `resetClosedPeers`, which
  deletes every OTHER device's entry in that folder that currently reads
  `closed` — never one that's still `open`. Once deleted, that peer has "no
  entry of its own" left, so its own next reconcile naturally re-mirrors
  the URL back in as open, via the ordinary `!mine` open-mirroring branch —
  no separate "force open remotely" mechanism needed. Deliberately NOT
  called from the heartbeat-refresh branch (`mine.state` already `open`,
  just bumping `h`) — only from a genuine, one-time local open/reopen
  action — otherwise one device's periodic heartbeat could repeatedly undo
  a peer's LATER, independent, intentional close, an infinite forced-reopen
  loop. Known trade-off, accepted as-is: this can't distinguish a peer's
  STALE closed entry (left over from following an earlier close that's now
  been undone) from that same peer's own CURRENT, independent close for
  unrelated reasons — both look identical in the bookmark tree, so a
  reopen anywhere will force a reopen on every currently-closed peer,
  regardless of why each one is closed. See `test/reopen-propagation.test.js`.
- **`t` vs `h` — do not conflate them.** `t` only ever moves on a genuine
  local open/close transition. `h` is bumped by routine liveness heartbeats
  so TTL cleanup doesn't sweep a tab that's simply been open a long time.
  Conflating them (letting a heartbeat touch `t`) reintroduces the exact race
  fixed in 2.6.2. Unlike v3, `t`/`h` no longer feed any cross-device
  precedence decision (see above) — `h` is now used purely for **per-device**
  TTL staleness (see cleanup below). Keep them separate if you touch this.
- **SAFETY RULE: closes are only ever detected from a live, specific-tab
  event.** `closeMyGoneTabs` (which flips this device's own status bookmark
  open→closed) is called **only** from `browser.tabs.onRemoved` (guarded
  against `isWindowClosing`) and from `browser.tabs.onUpdated` once a
  navigation completes — both are genuine, real-time signals about ONE
  particular tab, reported while the browser is definitely running
  normally. Calling it on `onUpdated(complete)` too is what makes
  navigating an open tab to a different URL equivalent to closing the old
  URL and opening the new one, instead of a silent in-place swap. It is
  deliberately never called from the alarm, `onStartup`, or a
  bookmark-change reaction, because those aren't tied to any one tab's
  event — they just compare tracked-open entries against a whole
  `browser.tabs.query()` snapshot that isn't guaranteed complete at those
  moments — most notably right after startup, before session restore has
  repopulated windows. Treating that gap as "the user closed everything"
  would propagate a close for the entire session just because the browser
  started up slowly. Opening/mirroring (`reconcileMyOpenEntries`,
  `reconcileMirror`), by contrast, is always safe to run broadly — worst
  case a tab is registered a little late, which self-heals on the next
  trigger, never destructive. Preserve this asymmetry if you touch the
  reconcile pipeline.
  **This rule is specifically about closeMyGoneTabs** (inferring a close
  from THIS device's own, possibly-incomplete tab snapshot) and is
  unaffected by — and doesn't apply to — `reconcileMirror`'s contagious
  close (above): that one acts on an explicit, unambiguous REMOTE signal
  (another device's bookmark already reads `closed`), not an inference, so
  it's safe to run from every trigger, including the alarm and `onStartup`.
  Don't conflate the two when reasoning about this code.
- **`snapshotOwnTabs` skips tabs still loading** (`status !== "complete"`).
  A tab's url/pendingUrl can pass through transient values while
  navigating (a redirect chain, for instance); registering one of those
  as "open" would create a permanent phantom entry nothing ever closes,
  since the tab itself never goes away — it just finishes loading. This
  is the same guard the `tabs.onUpdated` listener already applies to
  itself; `snapshotOwnTabs` extends it to the alarm and bookmark-event
  triggers too, which aren't gated on any one tab's load state.
- **`readProfileEntries`** is the single place that reads a whole profile
  folder's tree — every URL subfolder's real url (its `_url` child) and
  every device's status bookmark inside it — returning
  `Map<realUrl, {folderId, folderTitle, urlBookmarkId, devices}>`. It also
  self-heals: if a sync-tool race left two folders for the *same* URL, the
  second one's device bookmarks are merged into the first (canonical) folder
  and the duplicate removed, the same spirit as `mergeFolderInto` but keyed
  by URL match instead of title match. Every other reconcile function reads
  the profile folder through this helper — don't re-implement folder
  traversal elsewhere.
- **The extension checks the SyncMyTabs folder on every change to it, never
  on a timer.** `bookmarks.onCreated`/`onChanged` on the `_url` marker or any
  device status bookmark (`isRelevantBookmarkChange`) triggers a reconcile
  immediately; the alarm (default every `DEFAULT_INTERVAL_MINUTES`) is only a
  backstop double-check plus the TTL sweep, never the primary signal.
- **The reconcile pipeline** (`runReconcile`, invoked through
  `scheduleReconcile` which serializes/coalesces concurrent triggers — never
  call `runReconcile` directly): `closeMyGoneTabs` (only if `checkClosed`) →
  `reconcileMyOpenEntries` → `reconcileMirror` → `reconcileMyOpenEntries`
  again (so this device's own entries reflect whatever the mirror pass just
  opened/closed locally). Triggered with `checkClosed: true` from
  `tabs.onRemoved` and `tabs.onUpdated` on navigation complete (see the
  safety rule above), and without it from the alarm, `onStartup`, and
  reactions to bookmark create/change events under the active profile
  folder.
- **A close always propagates, but folder deletion still needs everyone
  actually closed first.** A close never deletes anything immediately — it
  flips the device's own bookmark to `closed`, which (per the contagious
  rule above) makes every other device close in turn. Only once **every**
  device that ever weighed in on a URL shows closed does `reconcileMirror`
  (immediately, on whichever device's own write happens to be the one that
  notices everyone's now closed) or `cleanupProfileFolder` (as a periodic
  backstop) delete the whole folder — safe for any device to do, since by
  then nobody is writing to those bookmarks anymore.
- **TTL cleanup** (`ttlEnabled`/`ttlDays` in storage, default on/**14 days**)
  is the escape hatch for a device that's gone for good and will never come
  back to agree "closed". It is evaluated **per device entry, not per
  folder**: each device's own status bookmark is checked independently
  against `now - h > ttlMs` and removed if stale, regardless of state. A
  folder is only deleted as a *consequence* of that pruning — once every
  entry left in it (after pruning) is closed, or none remain at all. This is
  deliberate: evaluating staleness at the folder level (e.g. the max
  heartbeat across all devices in it) would let one abandoned device's stale
  "open" entry hide forever behind any other device's still-fresh heartbeat
  in the same folder, producing a permanent ghost-open marker that new
  devices keep mirroring in. Don't regress to a folder-level TTL check.
- **`closeMyDuplicateTabs`** (`closeDuplicateTabs` in storage, default
  **OFF** — closing a tab is destructive) closes this device's own EXTRA
  local tabs sharing the exact same real URL, keeping the leftmost — same
  "keep the leftmost, close the rest" convention as `groups-core.js`'s own
  duplicate-tab handling. Exists because the two dedup checks that
  normally prevent a *mirrored* URL from ever duplicating a tab
  (`reconcileMirror`'s `!allUrls.has(url)` check and `performAdd`'s own
  second check right before opening) can't do anything about a genuinely
  separate duplicate the user (or a very narrow timing race around
  those two checks) created directly — this is a periodic backstop for
  that, not a replacement for them. Scoped to `urls` (pinned/grouped tabs
  excluded, same as everywhere else) and only ever counts tabs with
  `status === "complete"`, so it never misjudges a still-loading tab
  either way. Wired into the alarm and `handleSyncNow` only, deliberately
  NOT `handleStartup` — closing a live tab this device didn't ask this
  device's user to close stays that one notch more conservative right
  after a browser launch, even though nothing here actually infers
  anything from a tab's absence (see the SAFETY RULE above; this is a
  different, always-safe-to-observe kind of check, the caution is just
  about being trigger-happy with `tabs.remove` immediately on launch).
- **Parent folder id** is resolved at runtime from the bookmark tree
  (`getRootParentId`), cached, with a fallback to Chrome/Brave's `"2"`. Do not
  hardcode `"2"` in new code — go through the resolver so Firefox support stays
  reachable.
- **Unopened placeholders still count as "open".** `snapshotOwnTabs` resolves
  a lazy placeholder to its real URL (`realUrlOfTab`) and treats it the same
  as any other open tab — closing it (before or after the user ever looked at
  it) is handled identically either way.
- **Master on/off switch.** `syncEnabled` (storage, default true) is checked
  once, at the top of `runReconcile` and `cleanupProfileFolder` — while
  paused, nothing touches bookmarks in either direction. The toolbar icon
  swaps to the `icons/icon*-off.png` set plus an "OFF" badge via
  `updateActionIcon`, driven off `chrome.storage.onChanged` so the popup
  toggle is the single source of truth.
- **Pinned tabs and tabs inside a browser tab group are both excluded from
  sync entirely**, and stay outside this whole folder-per-URL logic. Pinned
  tabs (`t.pinned`) were dropped from sync in the v3 redesign; tab-group
  exclusion (`isInTabGroup`, feature-detected off `t.groupId`, a no-op on
  Firefox which doesn't expose one) predates this restructure too — both
  checks now live together in `snapshotOwnTabs`. `snapshotOwnTabs` splits
  its result into `urls` (pinned/grouped tabs excluded — feeds
  `reconcileMyOpenEntries`/`closeMyGoneTabs`, so neither ever gets a folder
  entry, and pinning/grouping a tracked tab reads as "no longer tracked" on
  the next live-event reconcile, flipping its own entry to closed without
  touching the actual tab) and `allUrls` (pinned/grouped tabs included —
  feeds the "is this URL already open here at all" dedup checks in
  `reconcileMirror`/`performAdd`, so a remote open never duplicates a tab the
  user already has pinned or grouped). `tabIdsByUrl` is built from the
  excluded set, which is what keeps a mirror-driven close from ever reaching
  into a local pinned tab or group. See `test/grouped-tabs-excluded.test.js`. Don't
  reintroduce pin or tab-group syncing without discussion.
- **Self-healing.** Third-party sync tools sometimes recreate rather than
  update bookmarks, producing duplicate profile folders, duplicate root
  folders, or duplicate folders for the same URL. `mergeFolderInto` merges
  same-named subfolders recursively and just moves bookmark children over
  (root/profile folders, matched by title); `readProfileEntries` does the
  URL-folder-level equivalent, matched by the `_url` child instead of title.
  Any incidental duplicate device bookmark left within one folder (same
  race) is cleaned up defensively by `reconcileMyOpenEntries` the next time
  that device reconciles.
- **Legacy root names.** The extension was formerly `OpenTabSync` / `Live
  Tabs Sync` and migrates such a root folder in place (`LEGACY_ROOT_NAMES`).
  Add to that list rather than breaking migration if the name ever changes
  again. This is unrelated to (and unaffected by) the v3→v4 schema change.

## Tab-group leashing module (`groups-core.js`)

A separate, independent module ported from the standalone TabGroupsLeash
extension: link "leashing" for a browser tab group (a clicked link either
navigates in place / opens alongside in the SAME group if it matches that
tab's configured pattern, or always opens in a fresh UNGROUPED tab
otherwise) plus a startup reconcile (reopen a group's missing "essential"
tabs, close duplicates, optionally close undeclared ones). Chrome/Brave
only — Firefox has no `tabGroups` API, so every function here
feature-detects `env.tabGroups` and no-ops without it, never assumed to
exist (same cross-browser rule as the rest of the codebase).

- **Bookmark tree shape**, SIBLING to the per-URL folders under each
  profile (and invisible to `sync-core.js`'s `readProfileEntries`, which
  only ever recognizes a folder that has its own `_url` marker child — a
  `_groups` folder never does, so the two coexist with zero interference):
  ```
  SyncMyTabs/<profile>/_groups/<group title>/<one bookmark per rule>
  ```
  A rule bookmark's `title` is its own `pattern` (or, for an openUrl-only
  rule, its `openUrl` — human-readable in a plain bookmark manager); the
  rule data itself is packed into the bookmark's `url`
  (`buildGroupRuleUrl`/`parseGroupRuleUrl`, same `URLSearchParams`-based
  encoding style as `sync-core.js`'s device status bookmarks): `p`=leash
  pattern, `o`=reopen URL. A rule has only these two fields — `pattern`
  decides BOTH which rule covers a tab's current page AND what a clicked
  link must match to stay in-group (one field, one job, done twice); an
  earlier version had a third, separate `match` field for the "which page"
  half, which turned out to be a real footgun (a rule silently failing to
  resolve because `match` and `pattern` had drifted apart) for no strong
  enough use case, so it was dropped. An openUrl-only rule (no pattern at
  all) never resolves for any tab — see `findRuleForTabUrl` — and exists
  purely as a startup "make sure this exact URL is open somewhere"
  declaration; `tabSatisfiesRule` is what `reconcileGroup`'s
  missing/duplicate/undeclared checks use to test a tab against a rule
  (pattern if set, else an exact `openUrl` match). **The group's
  TITLE is the only stable, cross-device key** — a browser's own numeric
  tab-group id is local and meaningless on another device — so an untitled
  group is deliberately unsupported (mirrors the original TabGroupsLeash's
  own "no reliable sync key" reasoning for its local-only fallback, which
  this port doesn't carry over: "always use bookmarks to sync" ruled out a
  local-storage-only fallback that can't sync in the first place).
- **Config, not tab state — different sync model on purpose.** Unlike
  open/closed tab entries, a group's rules are just replaced wholesale on
  every edit (`setGroupSettings` deletes the old rule set, writes the new
  one) — there's no contagion/propagation semantics here, because unlike
  a tab's open/closed state, group rules aren't something each device
  independently observes; they're shared configuration a user edits from
  any device. Two devices editing the SAME group concurrently is
  last-write-wins (whichever bookmark write lands last), same trade-off the
  original TabGroupsLeash already had with `chrome.storage.sync.set` — an
  accepted limitation for infrequently-edited config data, not a bug.
- **Only the RULES sync via bookmarks — local per-device preferences don't.**
  Whether leashing is on at all (`groupsLeashEnabled`), whether the startup
  reconcile also closes undeclared tabs (`groupsCloseUndeclaredTabs`), and
  the startup delay (`groupsStartupDelaySeconds`) all live in
  `env.storage.local`, same convention as `syncEnabled`/`ttlDays`/
  `openRestoredLazy` — per-device operational toggles, not shared config.
- **Scoped by the SAME active-profile concept as the rest of the
  extension.** `activeProfileFolderId()` resolves through
  `syncEngine.getActiveProfile()`/`getOrCreateProfileFolder()` — a device on
  a different profile never sees, mirrors, or reconciles another profile's
  groups. Each profile has its own independent set of group definitions,
  exactly as requested.
- **Link leashing is read-only-cheap for the common case.**
  `resolvePatternFor(tab)` bails out immediately (no bookmark read at all)
  unless the tab is ACTUALLY grouped (`typeof tab.groupId === "number" &&
  tab.groupId !== -1`, same check as `sync-core.js`'s `isInTabGroup`) —
  every click on every ordinary, ungrouped tab costs nothing. `readGroupSettings`
  itself is also deliberately read-only (never creates a folder just to
  read from it), since it's called on every leashed click.
- **The content script (`link-leash-content.js`) doesn't intercept every
  click on every page**, unlike the original TabGroupsLeash — it first asks
  the background page `GROUP_LEASH_INFO` and only attaches its `click`/
  `auxclick` capture-phase listeners if the tab is actually grouped at load
  time. This is a deliberate improvement over a naive port: capturing +
  `preventDefault`-ing every click on every page (including sites whose own
  JS also listens for link clicks, e.g. SPA client-side routers) just to
  fall back to default behavior server-side for the overwhelming majority
  of (ungrouped) tabs would be a real regression risk. The trade-off: a tab
  grouped AFTER its page already loaded won't get leashing until reloaded
  (see Known limitations).
- **A plain click on an already-matching link is left COMPLETELY alone —
  no `preventDefault`, no message sent at all.** This is not an
  optimization, it's a correctness fix: routing that case through
  `handleLinkClick`'s `env.tabs.update()` (a hard, address-bar-equivalent
  navigation) breaks any client-side-routed page — Telegram Web and
  similar SPAs using pushState/hash routing for in-app navigation expect a
  lightweight same-document transition from their OWN router, not a full
  reload, and a forced reload can bounce the app back to its default view
  instead of landing on the clicked destination (this shipped as a real
  bug once — a matching link's URL would visibly change then snap back).
  The `GROUP_LEASH_INFO` handshake response (`{grouped, pattern}`, from
  `getLeashInfoFor`) is therefore cached in the content script and
  re-checked **synchronously** on every click — not re-fetched per click
  — so the decision to skip interception can be made before the native
  click would otherwise be prevented. The content script also patches
  `history.pushState`/`replaceState` and listens for `hashchange`/
  `popstate` to refresh that cache on every SPA-internal route change (the
  content script itself is never re-injected by these, only a real
  navigation does that) — otherwise the cached pattern could go stale for
  a tab that stays grouped across many in-app navigations. Only a
  NON-matching link, or a MODIFIER-click on a matching one, still goes
  through `handleLinkClick` — which remains the authoritative decision-maker
  (re-validates via its own `resolvePatternFor` using the live tab) for
  every case that does reach it, exactly as before this fix.
- **Groups can be pinned to the start of the tab strip.** The
  `groupsPinToStart` local preference (default off), checked in
  `reconcileGroups()`, moves every reconciled group (via
  `env.tabGroups.move(groupId, {index})`) to the start of its window on
  EVERY reconcile — not just when something was reopened — so it stays put
  even if the user (or the browser) moves it in between. Multiple pinned
  groups stack in title order (`getAllGroupTitles`'s own sort) via
  consecutive indices (0, 1, 2, …) assigned in `reconcileGroups()` and
  passed down to each `reconcileGroup()` call, rather than every pinned
  group independently fighting over index 0.
- **Startup reconcile only, never mid-session**, and only for the active
  profile's groups that have at least one saved rule. Delayed
  (`groupsStartupDelaySeconds`, default 15s) so the browser's own session
  restore has time to finish repopulating windows/tabs/groups first —
  reconciling against a still-incomplete snapshot could wrongly judge a
  not-yet-restored tab "missing" or "duplicate". Alarm registration for
  this delay lives in `background.js` (browser-chrome-only bits), same as
  the main sync alarm — `groups-core.js` itself only exposes the callable
  `reconcileGroups()`/`handleGroupsAlarm()`.
- **`reconcileGroups()` also respects the master `syncEnabled` switch** —
  pausing sync pauses the whole extension, groups module included.

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
