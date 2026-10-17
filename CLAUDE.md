# CLAUDE.md

Guidance for Claude (and any AI agent) working in this repository. Kept
short on purpose — it's loaded into every session. Details live in
`docs/` (map below): read the doc for the area you're touching, not all
of them. **Don't read `README.md` to learn the code** — it's the
user-facing description (~33 KB); open it only to update it.

## What this repository is

**SyncMyTabs** is a Manifest V3 browser extension that syncs a user's open
tabs across devices, organized by profile, using **bookmarks as the
transport** — no server, no account: it reads/writes a structured bookmark
tree and relies on the user's existing bookmark sync (native browser sync,
Floccus, xBrowserSync, …) to move it between devices. Around that: a
tab-group "leashing" module, auto-archive of idle tabs, optional tab
ordering, and a custom new tab page.

## Branch & push workflow (IMPORTANT)

- **All development happens on `claude/svil`** — switch to it first:
  `git checkout claude/svil 2>/dev/null || git checkout -b claude/svil`.
  If its last PR was already merged, restart it from `main` (never stack
  on merged history).
- **Always push to `claude/svil`** (`git push -u origin claude/svil`).
  Never push to `main`/`master` or any other branch without the user's
  explicit permission. Open PRs **from `claude/svil`** into `main`.
- Merging to `main` with a bumped `version` **publishes a release**
  automatically (see `docs/release.md`).

## Cross-browser support (IMPORTANT)

**Everything must work on Chromium (Chrome/Brave) and Firefox.**

- Use APIs both have; anything Chrome-only (e.g. `tabGroups`) must be
  **feature-detected and degrade gracefully**.
- Bookmark-root ids differ (Chrome `"2"`/`"1"` vs Firefox
  `"unfiled_____"`/`"toolbar_____"`): always resolve them
  (`getRootParentId`, `findBookmarksBarId`), never hardcode one.
- Use `browser.*` (vendored `webextension-polyfill`), not raw promise
  `chrome.*` calls.
- The manifest carries both backgrounds (`service_worker` for Chrome,
  `scripts` for Firefox) + `browser_specific_settings.gecko`; keep both
  loadable. `scripts/build.js` tailors one manifest per store.
- No automated Firefox test: verify by hand in `about:debugging` when a
  change could differ there.

## Commands

```bash
npm test                 # Node suite: sync/groups/archive/order/newtab logic + static checks
npm run check            # node --check on every top-level .js
npm run test:browser     # real headless Chromium + the BUILT extension (Playwright) — UI, pages
npm run build            # build/chrome + build/firefox, exactly what ships
npm run screenshots -- <dir>   # new tab page / popup / options screenshots for a visual check
```

(`node --test test/` with a bare directory misbehaves on some Node
versions — the scripts pass explicit globs.)

## Project layout

| Path | Role |
|---|---|
| `manifest.json` | MV3 manifest, permissions, **version**, dual background |
| `sync-core.js` | All open-tab sync/reconcile logic, `createSyncEngine(env)` — never calls `browser.*` directly, everything through `env` (testable in Node). → `docs/sync-core.md` |
| `groups-core.js` + `link-leash-content.js` | Tab-group leashing (Chrome/Brave only). → `docs/groups-core.md` |
| `archive-core.js` | Auto-archive idle tabs (on by default). → `docs/archive-core.md` |
| `order-core.js` | Tab & group order (off by default). → `docs/order-core.md` |
| `newtab-core.js` | Data side of the new tab page, served via background messages. → `docs/newtab-core.md` |
| `newtab.html` + `newtab*.js` | The new tab page: `newtab.js` (list, search, keyboard), `newtab-settings.js` (all its settings: key, defaults, labels), `newtab-dom.js` (shared DOM helpers), `newtab-clock.js`, `newtab-search.js` (web-search helpers), `newtab-bookmarks.js` (optional bookmarks bar), `newtab-matrix.js` (optional rain), `newtab-options.js` (its card on the options page). → `docs/newtab-core.md` |
| `background.js` | Thin wiring: real `browser.*` listeners → engine `handle*()` functions; toolbar icon, alarms |
| `popup.html/.js`, `options.html/.js`, `theme.css/.js` | Compact popup, full settings page, shared light/dark/black theme. → `docs/ui.md` |
| `lazy.html/.js` | Lazy-restore placeholder page (loads the real URL on click) |
| `browser-polyfill.min.js`, `icons/` | Vendored polyfill; icons (`*-off` = paused) |
| `scripts/build.js` | **The list of files that ship** + per-store manifests. → `docs/release.md` |
| `scripts/screenshots.js` | `npm run screenshots` |
| `test/*.test.js` | Node suite; `test/sim-env.js` simulates several devices sharing one bookmark tree. → `docs/testing.md` |
| `test/browser/` | Browser tests + `helpers.js` (build, launch, fake web). → `docs/testing.md` |

## Docs map

| Read this | when you touch |
|---|---|
| `docs/sync-core.md` | sync/reconcile logic: bookmark tree shape, the "own bookmark only" rule, contagious close/reopen, debounce, TTL, safety rules |
| `docs/groups-core.md`, `docs/archive-core.md`, `docs/order-core.md`, `docs/newtab-core.md` | that module |
| `docs/testing.md` | tests: the multi-device simulator, its fakes and gotchas, browser tests |
| `docs/release.md` | the file list, the manifest, releasing |
| `docs/ui.md` | popup, options page, theme |
| `docs/known-limitations.md` | **before "fixing" anything that looks like a design flaw** — most are deliberate, agreed trade-offs |

**Documentation convention:** each invariant is documented ONCE, in full,
in the code comment nearest the function that implements it; docs give a
short summary + pointer. Enrich the code comment rather than duplicating
an essay into a doc.

## Rules that are easy to break

- **Sync logic goes in `sync-core.js`** (env-parameterized), not
  `background.js`; same pattern for every `*-core.js`. Tests drive the
  same `handle*()` functions the real listeners call.
- **Each device only ever writes its own status bookmark** (three
  sanctioned exceptions, see `docs/sync-core.md`).
- **Closes are only inferred from a live tab event** (`tabs.onRemoved`/
  navigation complete), never from the alarm, startup or a bookmark
  reaction.
- **The new tab page is self-contained**: nothing outside the `newtab*`
  files (and its own listener in `background.js`, its two script tags in
  `options.html`) knows it exists — `test/newtab-isolation.test.js`
  enforces it. Its data goes through background messages: the background
  engine is the only bookmark writer.
- **Defaults that are deliberate**: order-core off, new-tab bookmarks bar
  and Matrix rain off, auto-archive on, `closeDuplicateTabs` off. Don't
  flip one without the user asking.
- Pages build DOM with `textContent`, never `innerHTML` (titles are
  page-controlled). Favicons only from the browser's own loaded icons —
  never a third-party favicon service (PRIVACY.md promises nothing leaves
  the device).

## New feature checklist

1. Code in the right module (env-parameterized `*-core.js` for logic);
   a **test** next to it (`test/*.test.js` for logic,
   `test/browser/*.browser.js` for pages/UI).
2. A new top-level file → add it to `FILES` in `scripts/build.js`
   (`npm test` fails until you do) and, for a page script, its `<script>`
   tag.
3. A new permission → its justification in `PERMISSIONS.md`; anything
   that reads/sends new data → `PRIVACY.md` (+ its "Last updated").
4. User-visible → `README.md`; store-worthy → `STORE_LISTING.md`.
5. A new invariant → code comment + one line in the module's doc.
6. Behavior changed → **bump `version`** in `manifest.json` (semver).
7. `npm run check && npm test && npm run test:browser`; for UI,
   `npm run screenshots` and look.
8. Commit, push to `claude/svil`, PR into `main` (merging it releases).
