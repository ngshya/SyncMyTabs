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
  for Firefox) and `options_ui`; `browser_specific_settings.gecko` pins the
  Firefox id / min version. When you touch the manifest, keep both browsers
  loadable.
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
| `manifest.json` | Manifest V3, permissions, entry points, **version**; dual background (Chrome `service_worker` + Firefox `scripts`), `options_ui`, `browser_specific_settings.gecko` |
| `sync-core.js` | **All the sync/reconcile logic**, factored out of `background.js` and parameterized over an `env` (bookmarks/tabs/windows/storage/runtime) instead of calling `browser.*` directly — see "Testing" below. Plain script, no import/export syntax (loaded via `importScripts`/`background.scripts` like the polyfill); `module.exports` at the bottom is a Node-only no-op elsewhere. |
| `background.js` | Thin wiring: registers real `browser.*` event listeners and forwards them to `sync-core.js`'s `engine.handle*()` functions, plus browser-chrome-only bits (toolbar icon, alarm registration) that aren't sync logic |
| `popup.html` / `popup.js` | Toolbar popup UI |
| `options.html` / `options.js` | Settings page UI |
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
   node --check background.js && node --check sync-core.js && node --check popup.js && node --check options.js
   ```
4. **Run the test suite** (`npm test`) — see "Testing" above. Add/update
   tests for any reconcile-logic change.
5. **Manually verify** in the browser when behavior changes: load the folder via
   `chrome://extensions` → *Load unpacked*, then hit **Reload** on the extension
   after each change. The test suite covers the reconcile logic; it can't
   exercise the real `browser.*` APIs, the popup/options UI, or the manifest.
6. If behavior or the public surface changed, **bump `version` in
   `manifest.json`** (semver) and update `README.md`.
7. Commit with a clear message, then **push to `claude/svil`**.

## Architecture notes & conventions (v3 — shared per-tab bookmarks)

Understanding these will keep changes safe. This is a from-scratch redesign of
the sync mechanism (v2.x used a per-device snapshot folder + a `_events`
open/close-time blob; that's gone — no migration, see Known limitations).

- **Bookmark tree shape** (created under "Other Bookmarks"):
  ```
  SyncMyTabs/<profile>/<one bookmark per (device, url) pair>
  ```
  Profiles are the top-level unit now — there is no more per-device folder.
  Every tab-entry bookmark's `title` is the page title; its metadata is packed
  into the bookmark's own `url` (`parseTabEntryUrl` / `buildTabEntryUrl`):
  `u`=real url, `d`=device, `s`=`open`|`closed`, `t`=state-change time,
  `h`=heartbeat time. **A device only ever writes its own entries** — never
  another device's — so there is never a concurrent write to the same
  bookmark. This is the property that makes the whole design safe; don't
  introduce a code path where one device edits another's entry (bulk deletion
  of an entry everyone already agrees is `closed`, or a TTL-expired entry, is
  the one sanctioned exception — see cleanup below).
- **`t` vs `h` — do not conflate them.** `t` only ever moves on a genuine
  local open/close transition and is what decides open-vs-closed precedence
  when devices disagree (`reconcileMirror`'s `latestOpenT > latestCloseT`).
  `h` is bumped by routine liveness heartbeats so TTL cleanup doesn't sweep a
  tab that's simply been open a long time. Conflating them (letting a
  heartbeat touch `t`) reintroduces the exact race fixed in 2.6.2: a device
  slow to hear about a remote close could out-race it just by refreshing its
  own "still open" timestamp on a schedule. Keep them separate if you touch
  this.
- **SAFETY RULE: closes are only ever detected from a live, specific-tab
  event.** `closeMyGoneTabs` (which flips this device's own entries
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
- **Closing propagates; deletion needs full agreement.** A close never
  deletes the bookmark immediately — it flips `s=closed` so the closure is an
  observable event other devices react to (closing their own copy and
  flipping their own entry too). Only once *every* entry in a URL's group is
  `closed` does `cleanupProfileFolder` delete the whole group — safe for
  any device to do, since by then nobody is writing to those entries anymore.
- **TTL cleanup** (`ttlEnabled`/`ttlDays` in storage, default on/21 days) is
  the escape hatch for a group that will never reach full agreement (a device
  that's gone for good). It deletes any entry whose `h` is older than the
  threshold, regardless of state or which device wrote it — sanctioned because
  an entry that stale is, by construction, either genuinely abandoned or would
  have been heartbeat-refreshed by its own device if it weren't.
- **Parent folder id** is resolved at runtime from the bookmark tree
  (`getRootParentId`), cached, with a fallback to Chrome/Brave's `"2"`. Do not
  hardcode `"2"` in new code — go through the resolver so Firefox support stays
  reachable.
- **Unopened placeholders still count as "open".** `snapshotOwnTabs` resolves
  a lazy placeholder to its real URL (`realUrlOfTab`) and treats it the same
  as any other open tab — closing it (before or after the user ever looked at
  it) is handled identically either way.
- **Event-driven, no polling.** Remote updates are noticed via
  `bookmarks.onCreated` / `onChanged` on any tab-entry bookmark
  (`isTabEntryBookmark`), not a single fixed-title signal bookmark.
- **Master on/off switch.** `syncEnabled` (storage, default true) is checked
  once, at the top of `runReconcile` and `cleanupProfileFolder` — while
  paused, nothing touches bookmarks in either direction. The toolbar icon
  swaps to the `icons/icon*-off.png` set plus an "OFF" badge via
  `updateActionIcon`, driven off `chrome.storage.onChanged` so the popup
  toggle is the single source of truth.
- **No pinned tabs / tab groups.** Dropped in the v3 redesign to keep the
  per-tab-bookmark schema simple. Don't reintroduce them without discussion.
- **Self-healing.** Third-party sync tools sometimes recreate rather than
  update bookmarks, producing duplicate profile folders or duplicate root
  folders. `mergeFolderInto` merges same-named subfolders recursively and
  just moves bookmark children over (no title-based bookmark dedup anymore —
  a tab entry's title is the page title, not a fixed key); any incidental
  `(device,url)` duplicate left behind is cleaned up defensively by
  `reconcileMyOpenEntries` the next time that device reconciles.
- **Legacy root names.** The extension was formerly `OpenTabSync` / `Live
  Tabs Sync` and migrates such a root folder in place (`LEGACY_ROOT_NAMES`).
  Add to that list rather than breaking migration if the name ever changes
  again. This is unrelated to (and unaffected by) the v2→v3 schema change.

## Known limitations (don't "fix" without discussion)

- Chrome/Brave and Firefox are both supported targets (see **Cross-browser
  support** above).
- Open/close ordering between devices relies on each device's local clock
  (`t`, set only at the moment of a genuine transition — see the `t` vs `h`
  note above). This is architectural — there is no shared clock — so treat a
  badly-skewed-clock edge case as a documented trade-off, not a bug. Keep
  clocks reasonably in sync (NTP is fine).
- No migration from pre-3.0 versions. An upgrading user's old
  `SyncMyTabs/<device>/…` tree is left in place, unused. Don't add migration
  code for it without the user asking — this was a deliberate decision.
