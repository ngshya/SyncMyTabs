# CLAUDE.md

Guidance for Claude (and any AI agent) working in this repository.

## What this repository is

**SyncMyTabs** is a browser extension (Manifest V3, Chrome/Brave) that syncs a
user's open tabs across devices, organized by profile, using **bookmarks as the
transport**. It has no server, no account, and no cloud service of its own — it
reads/writes a structured bookmark tree and reacts to changes, relying on the
user's existing bookmark sync (native browser sync, Floccus, xBrowserSync, …) to
actually move data between devices.

See `README.md` for the full user-facing description. This file is about
*working on the code*.

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
| `manifest.json` | Manifest V3 definition, permissions, entry points, **version** |
| `background.js` | Service worker — all sync / save / restore logic |
| `popup.html` / `popup.js` | Toolbar popup UI |
| `options.html` / `options.js` | Settings page UI |
| `lazy.html` / `lazy.js` | Lazy-restore placeholder page (loads the real URL only when the tab is first viewed) |
| `icons/` | Extension icons (16 / 48 / 128 px) |

There is **no build step and no dependencies** — the repository *is* the
unpacked extension. There is no test suite. The only CI is a **release
workflow** (`.github/workflows/release.yml`): pushing a `v*` tag whose number
matches `manifest.json` builds the store-ready zip and publishes it as a GitHub
Release. Store-listing docs live in `PRIVACY.md` and `PERMISSIONS.md`.

## How to work on it

1. **Switch to `claude/svil`** (see above) before editing.
2. Edit the plain JS/HTML files directly.
3. **Syntax-check** any JS you touched:
   ```bash
   node --check background.js && node --check popup.js && node --check options.js
   ```
4. **Manually verify** in the browser when behavior changes: load the folder via
   `chrome://extensions` → *Load unpacked*, then hit **Reload** on the extension
   after each change. There is no automated way to exercise the extension.
5. If behavior or the public surface changed, **bump `version` in
   `manifest.json`** (semver) and update `README.md`.
6. Commit with a clear message, then **push to `claude/svil`**.

## Architecture notes & conventions

Understanding these will keep changes safe:

- **Bookmark tree shape** (created under "Other Bookmarks"):
  ```
  SyncMyTabs/<device>/<profile>/{_last_sync, _tab_meta, …tab bookmarks…}
  SyncMyTabs/_status
  ```
  `_status` (root) and `_last_sync` / `_tab_meta` (per profile) are **metadata
  bookmarks**, never treated as tabs (`isMetaTitle` / `isProfileMetaTitle`). Keep
  them updated **in place** — recreating them causes duplicates and needless sync
  churn. `_tab_meta` holds pinned/tab-group info as JSON in its URL and is
  removed entirely when a profile has no pinned or grouped tabs.
- **Parent folder id** is resolved at runtime from the bookmark tree
  (`getRootParentId`), cached, with a fallback to Chrome/Brave's `"2"`. Do not
  hardcode `"2"` in new code — go through the resolver so Firefox support stays
  reachable.
- **No needless writes.** `saveOpenTabs` compares a signature of the current tab
  set (URLs + pinned/group) against the saved one and does nothing if unchanged.
  Preserve this: every bookmark write triggers the user's sync tool.
- **Unopened placeholders are not "your" tabs.** `saveOpenTabs` skips tabs that
  are still lazy placeholders (`placeholderInfo` non-null). Saving them would
  re-broadcast another device's tabs as this device's session and, with auto-Add
  on the other side, resurrect tabs it just closed. Only real/opened tabs are
  saved; `realUrlOfTab` is still used for de-duplication when *adding* tabs.
- **Event-driven detection.** Remote updates are noticed via
  `bookmarks.onChanged` / `onCreated` on `_status` — there is **no polling**.
- **Lazy placeholders carry their origin.** Restored tabs (when lazy restore is
  on) point at `lazy.html?u=<url>&t=<title>&sd=<device>&sp=<profile>`. The
  `sd`/`sp` tags let `mirrorRemoteCloses` match an *unopened* placeholder back to
  the remote session it came from and close it when that session drops the URL.
  Only unopened placeholders from that exact source are ever auto-closed — never
  the user's own or already-opened tabs. `placeholderInfo` is the single decoder;
  keep the tagging and matching in sync if you touch either.
- **MV3 service worker is ephemeral.** It can be torn down at any time. Do **not**
  rely on in-memory state or bare `setTimeout` for anything that must outlive a
  suspension. The notification timeout is made durable by persisting pending
  notifications in `chrome.storage.local` (`pendingNotifs`) and re-checking them
  in `sweepExpiredNotifications`, which runs on every alarm and on startup. Follow
  that pattern for any new deferred work.
- **Notification resolution mutex.** A pending notification can be resolved by a
  button click, a body click, the `setTimeout`, or the sweep.
  `chrome.notifications.clear()` returning `true` is the single "I own this"
  signal — user interactions close the notification themselves, so later
  resolvers back off. Keep this invariant if you touch notification handling.
- **Self-healing.** Third-party sync tools sometimes recreate rather than update
  bookmarks, producing duplicate `_status` / `_last_sync` / root folders. The
  code detects and merges these (`dedupeNamedBookmark`, `mergeFolderInto`). Keep
  new metadata handling idempotent and duplicate-tolerant.
- **Legacy names.** The extension was formerly `OpenTabSync` / `Live Tabs Sync`
  and migrates such a root folder in place (`LEGACY_ROOT_NAMES`). Add to that
  list rather than breaking migration if the name ever changes again.

## Known limitations (don't "fix" without discussion)

- Chrome/Brave first; Firefox uses different bookmark-root ids and is untested.
- Ordering of updates uses each device's local clock (timestamp in `_status`);
  badly skewed clocks can misorder updates. This is architectural — there is no
  shared clock — so treat it as a documented trade-off, not a bug.
