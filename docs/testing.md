# Testing

> Moved out of `CLAUDE.md` to keep every session's base context small.
> Read it when you're working on what it covers.


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

`order-core.js` tests follow the same "separate module, own helper"
pattern again — `test/order-test-helpers.js`'s `orderEngineFor(device,
archiveEngine)` builds `createOrderEngine(device.env, device.engine,
archiveEngine)` (an already-built `archiveEngineFor(device)` instance
must be passed in — order-core.js reuses its activity map, see its own
CONTRACT comment) and wires `tabs.onMoved`/`tabGroups.onMoved`.
Deliberately **not** queued onto `world.pending` like every other hook
here — this one backs order-core.js's own synchronous "was this move
mine" guard (`reorderInProgress`), which only means anything if it runs
at the moment the move happens, not on a later `flush()`; `SimTabsApi
.move()`/`SimTabGroupsApi.move()` `await` this hook directly before
their own promise resolves, for the same reason. This is also where
`SimTabsApi` gained REAL strip-order tracking (`tab.index`, a per-window
`orderByWindow` array) — previously every tab's `.index` was simply
`undefined`, which had already been silently making
`groups-core.js`'s own `matchingTabs.sort((a,b) => a.index - b.index)`
a no-op for every existing test scenario before order-core.js needed
real ordering to test anything meaningful.

Run the suite:
```bash
npm test                    # same as: node --test test/*.test.js
```
(`node --test test/` — a bare directory path, no glob — misbehaves on at
least some Node versions; always pass the explicit glob.)

`newtab-core.js` tests (`test/newtab-core.test.js`) build
`createNewtabEngine(device.env, device.engine)` inline — no event wiring
to set up, it only ever reads on request. `test/newtab-isolation.test.js`
statically checks the module stays self-contained (see its section
below).

When you change reconcile behavior in `sync-core.js`, `groups-core.js`,
`archive-core.js`, `order-core.js`, or `newtab-core.js`, add/update a test in `test/`
alongside it — this is the actual regression net for the safety rules
documented below (the phantom-duplicate-entry guard, the "closes are only
detected from a live tab event" rule, and the mirror-open debounce all
have regression tests; a change that violates any of them should make one
fail).

`popup.js`/`options.js`/`theme.js` (and `lazy.js`, `newtab.js`,
`link-leash-content.js`) are DOM/browser-API-only and stay outside the Node
suite's scope, same as before — verify those live in a real (or headless,
via Playwright) browser. Playwright + Chromium are available in the cloud
environment: `chromium.launchPersistentContext(dir, { channel: "chromium",
headless: true, args: ["--disable-extensions-except=<repo>",
"--load-extension=<repo>"] })` loads the real unpacked extension
(`channel: "chromium"` matters — the default headless shell can't load
extensions), and `context.serviceWorkers()[0].evaluate(...)` runs
`chrome.*` calls in the background script to set up tabs/groups/storage.

## Browser tests (`test/browser/`, `npm run test:browser`)

Everything DOM/browser-API-only — the new tab page, the popup/options
pages — is tested in a real headless Chromium with the real extension,
via Playwright. `test/browser/helpers.js` does the setup once for every
file: builds the Chrome package with `scripts/build.js` (so the tests load
exactly what ships), launches Chromium with it, fakes the whole web with
request interception (any http(s) URL is a tiny page with a `<title>`
from the test and a `data:` favicon — no network, no certificates), and
offers helpers: `openNewtab()`, `openPage("options.html")`,
`openSite(url)`, `bg(fn)` (runs `chrome.*` in the service worker),
`setSettings({...})` (new tab page settings), `setStorage`,
`addRemoteTab(device, title, url)` (a fake other device in the synced
tree), `bookmarksBarId()`, and collects page errors in `b.errors`.

Files: `newtab` (strip order, folding, numbers, columns, other devices,
close, settings, switching), `bookmarks` (the optional bar), `search`
(web search), `features` (search-box focus, clock, Matrix rain, options
card), `ui` (popup/options prefs, background messages, black theme).
Add to the matching file, or a new `*.browser.js`, rather than writing a
throwaway script.

Notes: Playwright isn't a dependency of the repo — the helper finds it
via `NODE_PATH`/a global install (in the cloud environment it's in
`/opt/node-tools/node_modules`) and skips every browser test without it.
A tab the extension itself creates with `chrome.tabs.create` can slip
past request interception for its first load — open test sites with
`openSite`. The search-box focus redirect (`focusSearch`) is off by
default in tests (it replaces the page with a new tab right after opening);
`features.browser.js` turns it on to test it. Headless Chromium has no
address bar, so "the cursor left the address bar" can only be verified by
hand.

`npm run screenshots -- <dir>` takes screenshots of the new tab page
(light/dark/black, search, narrow), the popup and the options card with
the same setup, for a quick visual check.
