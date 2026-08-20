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
| `manifest.json` | Manifest V3, permissions, entry points, **version**; dual background (Chrome `service_worker` + Firefox `scripts`), `browser_specific_settings.gecko` |
| `sync-core.js` | **All the sync/reconcile logic**, factored out of `background.js` and parameterized over an `env` (bookmarks/tabs/windows/storage/runtime) instead of calling `browser.*` directly — see "Testing" below. Plain script, no import/export syntax (loaded via `importScripts`/`background.scripts` like the polyfill); `module.exports` at the bottom is a Node-only no-op elsewhere. |
| `background.js` | Thin wiring: registers real `browser.*` event listeners and forwards them to `sync-core.js`'s `engine.handle*()` functions, plus browser-chrome-only bits (toolbar icon, alarm registration) that aren't sync logic |
| `popup.html` / `popup.js` | The **only** UI — toolbar popup holding status and all settings (device name, profiles, interval, lazy restore, TTL). No separate options page; `browser.runtime.onInstalled` opens `popup.html` as a plain tab for first-run setup, since popups can't be opened programmatically. |
| `lazy.html` / `lazy.js` | Lazy-restore placeholder page (loads the real URL only when the tab is first viewed) |
| `browser-polyfill.min.js` | Vendored Mozilla WebExtension polyfill so `browser.*` is promise-based on Chrome too |
| `icons/` | Extension icons (16 / 48 / 128 px, plus `*-off` for the paused state) |
| `test/` | The test suite for `sync-core.js` — see "Testing" below |

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

Run the suite:
```bash
npm test                    # same as: node --test test/*.test.js
```
(`node --test test/` — a bare directory path, no glob — misbehaves on at
least some Node versions; always pass the explicit glob.)

When you change reconcile behavior in `sync-core.js`, add/update a test in
`test/` alongside it — this is the actual regression net for the safety rules
documented below (the phantom-duplicate-entry guard and the "closes are only
detected from a live tab event" rule both have regression tests; a change
that violates either should make one fail).

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
  whole design safe; don't introduce a code path where one device edits
  another's status bookmark (TTL-driven removal of a stale entry, or bulk
  deletion of a folder everyone already agrees is fully `closed`, are the
  sanctioned exceptions — see cleanup below).
- **Closing is per-device and STICKY — not timestamp-voted.** This is the
  key behavioral difference from v3. Once a device's own status bookmark
  exists in a folder — open OR closed — only **that device's own** later
  open/close actions on that URL ever change it again. It is never
  overridden by another device's state, in either direction: a device that's
  already closed its copy is never silently reopened just because others are
  still open, and a device that's still open is never forced closed just
  because another device closed. A device with no bookmark of its own yet
  mirrors in whatever's open elsewhere (see `reconcileMirror`'s `mine`
  check). This intentionally replaces v3's `latestOpenT > latestCloseT`
  cross-device precedence formula.
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
- **Closing propagates as an event, but deletion needs full agreement.** A
  close never deletes anything immediately — it flips the device's own
  bookmark to `closed`, an observable event other devices react to per the
  sticky rule above. Only once **every** device that ever weighed in on a
  URL shows closed does `reconcileMirror` (immediately) or
  `cleanupProfileFolder` (as a periodic backstop) delete the whole folder —
  safe for any device to do, since by then nobody is writing to those
  bookmarks anymore.
- **TTL cleanup** (`ttlEnabled`/`ttlDays` in storage, default on/**1 day**)
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
  into a local pinned tab or group. See `test/tab-groups.test.js`. Don't
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

## Known limitations (don't "fix" without discussion)

- Chrome/Brave and Firefox are both supported targets (see **Cross-browser
  support** above).
- **A device's own close is sticky, not timestamp-voted** (see the
  Architecture section above) — there is no shared clock and no cross-device
  "who's newer" comparison anymore. This is architectural and deliberate per
  the user's own spec for the v4 redesign: a URL can legitimately stay open
  on one device indefinitely after every other device has closed its copy,
  until that one device closes its own tab too. Don't "fix" this into a
  timestamp-voted model without discussion.
- No migration from pre-4.0 versions. An upgrading user's old
  `SyncMyTabs/<profile>/…` (v3, flat per-(device,url) bookmarks) or
  `SyncMyTabs/<device>/…` (pre-3.0) tree is left in place, unused. Don't add
  migration code for it without the user asking — this was a deliberate
  decision.
