# SyncMyTabs

**Sync your open browser tabs across devices — organized by profile, with no
server, no account, and no cloud service of its own.**

SyncMyTabs uses your **bookmarks as the transport**. It reads and writes a
small, structured bookmark tree and reacts to changes in it — nothing more.
The actual moving of data between devices is done by whatever bookmark-sync
mechanism you already use: your browser's built-in sync, or a third-party tool
like [Floccus](https://floccus.org/) or
[xBrowserSync](https://www.xbrowsersync.org/). If your bookmarks sync, your
tabs sync.

---

## About this project

SyncMyTabs is an experiment in AI-written software: every line of code,
every commit, and this README itself were written by an AI coding
assistant from plain-language instructions, without the human author
reading the code itself. Behavior is verified through the automated test
suite and manual testing of the extension, not through a code review — the
usual quality check for handwritten code is deliberately skipped here.
Keep that in mind when deciding how much to trust this codebase.

---

## Why bookmarks?

Most tab-sync tools need you to trust a server with your entire browsing
session. SyncMyTabs deliberately doesn't. It piggybacks on a channel you
already trust and already have set up — your bookmark sync — and stays
completely local otherwise. No sign-up, no backend, no telemetry.

The trade-off: SyncMyTabs is only as good as your bookmark sync. If that isn't
propagating changes, neither will your tabs. See [Requirements](#requirements).

---

## How it works

The extension maintains one root folder in your bookmarks with this shape:

```
SyncMyTabs/                    ← root folder (in "Other Bookmarks")
├── default/                   ← one folder per profile (shared across devices)
│   ├── "Example page"/        ← one folder per open URL
│   │   ├── _url                ← the real URL (folder name is cosmetic only)
│   │   ├── laptop-A             ← one bookmark per device that's weighed in
│   │   └── phone-B              ← its URL encodes that device's open/closed status
│   ├── "Another page"/
│   │   └── …
│   └── …
└── work/
    └── …
```

Every open URL gets its **own folder**, shared across devices. The folder's
name is purely cosmetic (the tab's title, or the URL itself if too long) — the
real URL always lives in the `_url` bookmark inside, so matching never depends
on the folder name. Inside that folder, each device that has ever opened or
closed the URL gets **one bookmark of its own**, named exactly like the
device, whose URL encodes that device's status (open/closed) and timestamps.
Each device only ever writes **its own** bookmark — never another device's —
so there's never a conflicting write to the same bookmark.

- **Profiles.** A profile can be used by several devices at once (e.g.
  `default`, `work`, `school`). Exactly one is *active* per device at a time;
  automatic sync only ever happens between devices on the **same** active
  profile — a device on `home` ignores another device's `work` tabs entirely.
  A profile name created on *any* device automatically becomes selectable on
  every device.
- **Opening a tab.** As soon as you open one, SyncMyTabs matches your active
  profile, creates the URL's folder if it doesn't exist yet (with its `_url`
  marker), and creates/marks **your own** device bookmark **open** inside it.
  Other devices on the same profile notice — bookmark events, no polling —
  and check every URL folder: if a folder has some device open and *they*
  don't have a bookmark of their own in it yet, they open the tab too (as a
  lightweight placeholder by default, see below) and add their own **open**
  bookmark. A brand-new URL isn't mirrored in on the very first sighting,
  though: it's confirmed still open on a later check, a short (20s) delay
  later, first — since bookmark sync can otherwise deliver a stale "still
  open" snapshot moments after the real thing was already closed and
  deleted everywhere else, which would open a tab for it that nothing could
  ever close again. This shrinks that risk without eliminating it entirely
  — see Known limitations.
- **Closing a tab.** Your own device bookmark flips to **closed** — and this
  is **contagious**: every other device that still shows the URL open
  follows suit automatically, closing its own matching tab and flipping its
  own bookmark closed too, until every device agrees and the folder is
  deleted. **Reopening propagates too**: opening the URL again resets any
  device that had already caught up to the earlier close, so it re-opens
  its own tab automatically as well — a device that never closed at all in
  the meantime is left completely untouched either way.
  **Closing a whole window, or quitting the browser, never propagates** —
  only closing an individual tab does, so a shutdown never wipes the session
  everywhere. **Navigating an open tab to a different address** counts as
  closing the old URL and opening the new one — both propagate the same way.
- Bookmarks update **immediately** on every genuine tab change (open, close,
  navigate), and the SyncMyTabs folder is re-checked **every time it
  changes** — there's no polling, no need to wait for the periodic check.
- **Cleanup (TTL).** If a device is uninstalled, or otherwise never comes back
  to agree "closed", its bookmark would otherwise linger forever. A
  configurable safety net (default on, **14 days**) deletes any device bookmark
  that hasn't been touched in that long; a URL folder disappears once every
  bookmark left in it (after that pruning) is closed, or none remain. A tab
  you keep genuinely open is refreshed automatically well before that
  deadline, so this never affects a live tab — only a truly abandoned one.
- **Lazy restore** (default on). Tabs mirrored in from another device open as
  placeholders that don't hit the network until you actually view each one
  (each points at a local page that navigates to the real URL on first view),
  so a large incoming session costs almost nothing until you look at it. By
  default the real page only loads on an explicit **click** on the
  placeholder, not just from switching to the tab — so a page that autoplays
  media (a YouTube video, for instance) never starts just because you tabbed
  past it. An opt-out setting restores the old "load as soon as the tab
  becomes visible" behavior.
- **Self-healing.** Some third-party sync tools *recreate* bookmarks instead of
  updating them, producing duplicate profile folders, duplicate root folders,
  or duplicate folders for the same URL. SyncMyTabs detects these and merges
  them, so the tree stays clean across any number of devices.

---

## Tab groups (leashing) — Chrome/Brave only

An independent module, layered on top of the same profile/bookmark
mechanism, for browser **tab groups** (Chrome/Brave's own tabbing feature;
Firefox has no such API, so this module is a silent no-op there): it keeps a
titled group's declared pages present, and keeps links clicked inside that
group from wandering outside them.

- **Rules, per group, per profile.** You give a browser tab group a title
  (e.g. "Work"), then declare one or more rules for it: a **leash pattern**
  (which page(s) this rule covers, AND what a clicked link must match to
  stay in that tab/group — one field does both jobs) and an optional
  **reopen URL** (a page this group should never be without). Rules sync via
  the same bookmark tree, under `SyncMyTabs/<profile>/_groups/<group
  title>/…`, scoped by the same active-profile concept as everything else.
- **Link leashing.** Click a link on a page inside a configured group: if it
  matches that page's leash pattern, it navigates the same tab (or opens
  alongside, in the *same* group, on a modifier-click) — **without
  reloading the page**, so client-side-routed apps (Telegram Web and
  similar single-page apps) handle the navigation themselves instead of
  getting force-reloaded; if it doesn't match, it *always* opens in a
  fresh, **ungrouped** tab instead of derailing the group. A page with no
  rule yet, or a rule with no leash pattern (a reopen-only rule), is left
  completely alone — normal browser behavior. A tab that isn't in any
  configured group is never touched by this at all.
- **Reconciliation.** Once per browser launch (after a short, configurable
  delay so the browser's own session restore finishes first) and then
  periodically after that, on the same check interval as tab sync,
  SyncMyTabs reopens any group's "reopen URL" that isn't currently open
  there, closes accidental duplicates of the same declared page (keeping the
  oldest), and — if you turn on "ungroup tabs matching no rule" (off by
  default) — detaches any tab in that group that matches none of its rules
  at all from the group. That's an ungroup, not a close: the tab stays open,
  it just leaves the group. Turning on "pin configured groups to the start
  of the tab bar" also keeps every reconciled group pinned at the start of
  its window on every check.
- **Untitled groups aren't supported.** A group's title is its only stable,
  cross-device identifier (a browser's internal group id is local and
  meaningless on another device) — an untitled group is simply invisible to
  this module.
- ⚠️ **Turn off your browser's own tab-group sync** (its account-level sync
  of tab-group membership, separate from bookmark sync) for any profile
  this module manages. Two independent mechanisms reconciling group
  membership at once — this module's rule-based checks and the browser's
  own — can fight each other. This is a browser setting, not something
  SyncMyTabs can detect or turn off on your behalf.
- Manage it all from the full settings page's **"Tab groups"** card:
  per-group rule editors (with quick-add buttons for tabs already open in
  that group), a leashing on/off switch, the ungroup-undeclared-tabs
  toggle, the pin-to-start toggle, the startup delay, and a manual
  "Reconcile groups now" button.

---

## Auto-archive idle tabs

Another independent module: tracks the last time each of your open tabs
actually had focus, and — off by default — archives one that's gone
unlooked-at for too long instead of letting it sit open forever.

- **Idle threshold** (default **3 days**, configurable). A tab counts as
  "looked at" whenever it's the active tab in a window that has focus —
  switching to it, or Alt-Tabbing back to a window that already had it
  active, both count. Merely being open in a background tab doesn't.
- **Archive, don't lose.** Once a tab crosses the threshold, it's saved as
  a plain bookmark — title and URL, just like a normal bookmark you made
  yourself — under `SyncMyTabs/<profile>/_archive/<year>/<month>/<day>/`
  (organized by the date it was archived, so a large archive stays easy to
  browse through and fish something back out of), and only then closed. A
  tab is never closed unless its bookmark was saved first. Since it's an
  ordinary bookmark, it syncs to your other devices the same way everything
  else here does, and you get it back exactly the way you'd get any
  bookmark back: open it from your bookmark manager. There's no separate
  "restore" feature in the extension — the bookmark folder *is* the
  restore mechanism.
- **Pinned tabs and tabs in a browser tab group are never touched**, no
  matter how idle — same exclusion the rest of SyncMyTabs applies
  everywhere else.
- **Off by default.** Closing tabs automatically is destructive, even with
  a bookmark left behind — turn it on from the full settings page's
  **"Auto-archive idle tabs"** card, where you can also change the idle
  threshold and trigger a manual check.
- **Clear archived tabs.** The same card has a button to delete every
  archived bookmark for the active profile in one go, for when you just
  want to empty it out — it asks for confirmation first, since (unlike
  removing a profile from the picker or deleting a group's rules) this
  permanently deletes actual saved history, not just a local preference.
- Runs on the same check interval as tab sync, at browser startup and then
  periodically — no separate interval setting to configure.

---

SyncMyTabs runs on **Chromium browsers (Chrome / Brave)** and **Firefox**
(the tab-groups module above is Chrome/Brave only; everything else works
identically on both).

## Install (developer mode)

**Chrome / Brave**

1. Download or clone this repository.
2. Open `chrome://extensions` (or `brave://extensions`).
3. Enable **Developer mode** (top-right).
4. Click **Load unpacked** and select this folder.

**Firefox**

1. Download or clone this repository.
2. Open `about:debugging#/runtime/this-firefox`.
3. Click **Load Temporary Add-on…** and pick this folder's `manifest.json`.
   (Temporary add-ons are removed when Firefox restarts; a signed build from
   [AMO](https://addons.mozilla.org) installs permanently.)

Then, on either browser:

5. On first run a settings tab opens — give this device a name.
6. Repeat on every device you want to sync, and make sure your bookmark sync is
   active on each.

---

## Usage

The **popup** (click the toolbar icon) is a compact status/quick-toggle
panel: your active profile, an on/off switch for each of the three feature
modules (open-tab sync, tab groups, auto-archive), a **Sync now** button,
the last mirror activity, and a button to open the **full settings page**
for everything else. The toolbar icon itself changes to a greyed-out
"paused" icon (with an **OFF** badge) whenever sync is off, so the state is
obvious without opening anything.

The full settings page (**Open full settings** in the popup, or the tab
that opens automatically on first run) holds:

- **Device name** — tags the tabs this device opens, so others know where they
  came from. Saved as soon as you leave the field.
- **Profiles** — manage which profiles exist, which one is active on this
  device, and switch instantly. Removing one from the list only removes it
  from *this device's* picker — data already saved under that name, on this or
  any other device, is kept and stays restorable.
- **Theme** — System (default, follows your OS), Light, or Dark.
- **Check interval** (default 1 minute) — opens/closes sync immediately
  regardless; this only controls the background double-check cadence, shared
  by the tab-groups and auto-archive checks too.
- **Open tabs sync** card — also the **master switch**: turning it off
  pauses sync, tab groups, AND auto-archive, in both directions, until you
  switch it back on.
  - **Lazy restore** (default on) — open mirrored-in tabs as placeholders that
    don't load from the network until you view each one.
  - **Require a click to load a lazy tab** (default on) — a lazily-restored
    placeholder waits for an explicit click before loading the real page,
    instead of loading as soon as you switch to the tab; prevents autoplay
    (e.g. a YouTube video) from starting just because you switched to it. Turn
    off to restore the old "load as soon as visible" behavior.
  - **Cleanup / TTL** (default on, **14 days**) — delete a device's bookmark
    entry if it hasn't been updated in this many days (safety net for a device
    that never comes back to agree "closed").
  - **Close duplicate tabs with the same URL** (default **off** — closing tabs
    automatically is destructive) — periodically closes any extra local tabs
    that share the exact same URL, keeping the oldest. Matching is by exact
    URL string, so e.g. a trailing-slash or query-string difference isn't
    considered a duplicate.
  - **Sync now** — force an immediate check in both directions.
- **Tab groups** card (Chrome/Brave only) — the leashing module's own
  on/off switch, the tab-group-sync warning, the "ungroup tabs matching no
  rule" toggle (off by default), the pin-to-start toggle, the startup check
  delay, per-group rule editors, and **Reconcile groups now** — see
  [Tab groups (leashing)](#tab-groups-leashing--chromebrave-only) above.
- **Auto-archive idle tabs** card — its own on/off switch (off by default),
  the idle-days threshold, **Archive idle tabs now**, and **Clear archived
  tabs** (asks for confirmation first) — see
  [Auto-archive idle tabs](#auto-archive-idle-tabs) above.

Every field except the checkboxes/switches (which save immediately) saves
when you leave it (blur, or press Enter).

---

## Requirements

You need a bookmark-syncing mechanism already set up between your devices —
either the browser's built-in sync, or a third-party tool (Floccus,
xBrowserSync, etc.). **SyncMyTabs does not sync bookmarks itself**; it only
reads and writes them locally and relies on that existing sync to move the data.

Permissions requested (all used locally, nothing leaves your machine on
SyncMyTabs' own initiative):

| Permission | Why |
|---|---|
| `bookmarks` | Read/write the SyncMyTabs bookmark tree |
| `tabs` | Read open tab URLs/titles; open/close/group tabs to mirror, restore, and reconcile tab groups |
| `tabGroups` | Tab-group leashing module only (Chrome/Brave — no such API on Firefox): read a group's title, create/update a group when reopening a missing declared tab |
| `storage` | Store this device's settings and state |
| `alarms` | Drive the periodic double-check, cleanup sweep, tab-groups reconcile, and auto-archive idle check |
| `<all_urls>` host permission + content script | Tab-group leashing module only: intercepts a link click on a page that's inside a *configured* tab group (see [Tab groups (leashing)](#tab-groups-leashing--chromebrave-only)) — an ungrouped tab is unaffected |

---

## Known limitations

- **No more pinned tabs.** Dropped when the sync mechanism was redesigned
  around shared per-tab bookmarks. Pinning is purely local now and isn't
  synced (a pinned tab still syncs like any other open tab; only the "pinned"
  attribute itself doesn't carry over).
- **Tabs inside a browser tab group are skipped entirely, not just
  un-grouped.** On Chromium browsers with tab groups (Chrome/Brave), a tab
  you've put in a group is treated as invisible to sync in both directions:
  it never gets its own bookmark entry, it's never closed by a remote device,
  and an incoming remote open won't duplicate it. Firefox has no tab-group
  API exposed to extensions, so this is a no-op there — every tab syncs
  normally.
- **Firefox differences.** SyncMyTabs works on Firefox; the bookmark-root id
  differs (Chrome `"2"` vs Firefox `"unfiled_____"`), handled automatically by
  the runtime resolver.
- **Sync visibility.** Detection of remote updates depends entirely on your
  sync tool actually propagating bookmark changes to this device's local tree.
  SyncMyTabs has no insight into whether that underlying sync is healthy.
- **URLs are matched as exact strings, never normalized.** `https://a.com`
  and `https://a.com/` (or with/without `www`, a different query string,
  etc.) are treated as two distinct URLs — each can end up with its own
  folder and its own mirrored tab, which can look like a duplicate even
  though the code sees two different URLs. The opt-in "close duplicate
  tabs" cleanup only catches *exact*-URL duplicates on one device; it can't
  merge two near-identical URLs into one.
- **Closing and reopening are both contagious.** There's no shared clock and
  no cross-device "who's newer" comparison — closing a tab anywhere closes it
  everywhere, and reopening it anywhere reopens it on every device that had
  already caught up to the earlier close (see "How it works" above). This is
  deliberate, but it means a reopen can't tell a peer's *stale* closed state
  (left over from a since-undone close) apart from that same peer's *own*,
  separate, intentional close — a reopen anywhere forces a reopen on every
  currently-closed device, regardless of why each one is closed.
- **A remote open can still, rarely, resurrect an already-closed URL.** The
  20s confirm-before-mirror delay (see "How it works" above) shrinks the
  window for this but is a fixed heuristic, not a real guarantee — a device
  that's offline, asleep, or simply behind by longer than that when it
  catches up can still act on a stale "still open elsewhere" snapshot for a
  URL that was, in reality, already closed and fully deleted everywhere
  else, reopening it with nothing left to close it again automatically
  (you'd just close it yourself once noticed).
- **Tab-group leashing is Chrome/Brave only, and untitled groups aren't
  supported.** Firefox has no tab-groups API to extensions, so the whole
  module is a silent no-op there. A group's title is its only stable,
  cross-device identifier — give it one, or the leashing/reconcile module
  simply can't see it.
- **A tab grouped AFTER its page already loaded won't get leashing until
  reloaded.** The content script asks once, on load, whether its tab is
  currently grouped, and only attaches click listeners if so — deliberately,
  so ordinary (ungrouped) browsing is never affected by intercepting every
  click on every page. Dragging a tab into a group without reloading it is
  the one case leashing won't pick up until the next reload.
- **No migration from pre-4.0 versions.** The bookmark tree shape changed
  (a folder per open URL, instead of one flat bookmark per (device, url)).
  Upgrading starts fresh; any old `SyncMyTabs/<profile>/…` or
  `SyncMyTabs/<device>/…` data from a prior version is left in place, unused —
  safe to delete by hand.
- **Archived tabs are a one-way export, not a restore feature.** Auto-archive
  only ever writes bookmarks to `_archive`; there's no in-extension
  "browse/restore archived tabs" UI. Restoring one is the same as opening
  any other bookmark, through your browser's own bookmark manager.
- **The browser's own tab-group sync should be off** for any profile the
  tab-groups module manages — see its own section above. SyncMyTabs can't
  detect or disable it for you; this is a browser-level setting.

---

## Project layout

| File | Role |
|---|---|
| `manifest.json` | Manifest V3 definition, permissions, entry points (Chrome service worker + Firefox background scripts) |
| `sync-core.js` | All the open-tab sync/reconcile logic, testable independently of a real browser (see Testing below) |
| `groups-core.js` | The independent tab-group leashing module's logic — its own bookmark-backed rule storage, link-leash decision, and reconcile pass — same `env`-parameterized, testable style as `sync-core.js` |
| `archive-core.js` | The independent auto-archive module's logic — tracks tab focus, saves+closes idle ones — same `env`-parameterized, testable style |
| `background.js` | Thin wiring: real browser events → `sync-core.js` / `groups-core.js` / `archive-core.js` |
| `link-leash-content.js` | Content script for the leashing module — intercepts link clicks on a tab it's confirmed is inside a configured group |
| `popup.html` / `popup.js` | Compact toolbar popup — status, per-module on/off switches, Sync now, and a link to full settings |
| `options.html` / `options.js` | Full settings page — device name, profiles, check interval, every module's detail settings, theme |
| `theme.css` / `theme.js` | Shared dark/light/system theme, used by both the popup and the settings page |
| `lazy.html` / `lazy.js` | Lazy-restore placeholder page |
| `browser-polyfill.min.js` | Mozilla's WebExtension polyfill (vendored) so `browser.*` works on Chrome too |
| `icons/` | Extension icons (16 / 48 / 128 px, plus `*-off` for the paused state) |
| `test/` | Test suite (see Testing below) |

There is no build step — the repository *is* the unpacked extension. To hack on
it, edit the files and hit **Reload** on the extension (`chrome://extensions` or
`about:debugging` on Firefox).

## Testing

```bash
npm test
```

The sync/reconcile logic (`sync-core.js`) is factored so it never calls
`browser.*` directly — it takes an `env` object instead, which lets the exact
same code run against a simulated multi-device environment
(`test/sim-env.js`) in plain Node, no real browser needed. Tests spin up
2-4 simulated devices sharing one profile, open/close/navigate tabs on them,
and assert the mirror converges to the right state — see `CLAUDE.md` for how
it's put together and how to add more.

## Releases & packaging

Packaging is automated, and cutting a release just means bumping the version:

1. Bump `version` in `manifest.json` (semver) and commit/merge it to `main`.

That's it — merging to `main` with a new version **automatically** triggers the
[`release` workflow](.github/workflows/release.yml), which syntax-checks the JS,
runs the test suite, and builds **two store-ready zips** —
`syncmytabs-<version>-chrome.zip` and `syncmytabs-<version>-firefox.zip` — each
with a manifest tailored to its store (Chrome: service worker only; Firefox:
background scripts only), then publishes both as a **GitHub Release** on the
[Releases page](../../releases). A merge that *doesn't* bump the version (e.g. a
docs-only change) is a no-op for this workflow — it doesn't fail, it just has
nothing new to release.

You can still cut a release the old way if you'd rather not wait for a merge:
push a matching tag (`git tag v3.0.0 && git push origin v3.0.0`), or trigger it
manually from the Actions tab (`Release` → `Run workflow`).

Upload the Chrome zip to the Chrome Web Store and the Firefox zip to
[AMO](https://addons.mozilla.org).

For publishing, see [`PRIVACY.md`](PRIVACY.md) (privacy policy) and
[`PERMISSIONS.md`](PERMISSIONS.md) (per-permission justifications).

---

## Privacy

SyncMyTabs has no server and no account: it collects, transmits, sells, and
shares **nothing**. Everything stays on your device (local extension storage and
your bookmarks); cross-device transfer is done by your own bookmark-sync tool.

- **Privacy policy:** [`PRIVACY.md`](PRIVACY.md) — public URL for the Chrome Web
  Store: <https://github.com/ngshya/SyncMyTabs/blob/main/PRIVACY.md>

---

## License

**PolyForm Noncommercial License 1.0.0** — see [LICENSE](LICENSE).

You may use, copy, modify, and distribute this software **for any
noncommercial purpose** (personal use, hobby projects, research, education,
nonprofits, government, etc.). **Commercial use is not permitted** — you may
not use this codebase in a paid product or service, or otherwise for
commercial advantage. If you need a commercial license, contact the author.
