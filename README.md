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
│   ├── "Example page"         ← one bookmark per (device, url) — see below
│   ├── "Another page"
│   └── …
└── work/
    └── …
```

Every open tab is a **bookmark shared across devices**, one per `(device,
url)` pair. Its title is the page title; its metadata (which device, open or
closed, and two timestamps) is packed into the bookmark's own URL. Each device
only ever writes **its own** entries — never another device's — so there's
never a conflicting write to the same bookmark.

- **Profiles.** A profile can be used by several devices at once (e.g.
  `default`, `work`, `school`). Exactly one is *active* per device at a time;
  automatic sync only ever happens between devices on the **same** active
  profile — a device on `home` ignores another device's `work` tabs entirely.
  A profile name created on *any* device automatically becomes selectable on
  every device.
- **Opening a tab.** As soon as you open one (or SyncMyTabs mirrors one in from
  another device), this device's own `(device, url)` bookmark is created/marked
  **open**. Other devices on the same profile notice — bookmark events, no
  polling — and if they don't have it open yet, they open it too (as a
  lightweight placeholder by default, see below) and mark their own entry open.
- **Closing a tab.** This device's own entry flips to **closed** — the
  bookmark isn't deleted yet, so the closure is itself a visible event other
  devices react to: **they close their own copy too**, closing propagates
  everywhere. Once *every* device that ever had that URL open shows closed,
  the whole group of bookmarks for that URL is deleted for good.
  **Closing a whole window, or quitting the browser, never propagates** —
  only closing an individual tab does, so a shutdown never wipes the session
  everywhere.
- **Cleanup (TTL).** If a device is uninstalled, or otherwise never comes back
  to agree "closed", its entries would otherwise linger forever. A configurable
  safety net (default on, 21 days) deletes any entry that hasn't been touched
  in that long. A tab you keep genuinely open is refreshed automatically well
  before that deadline, so this never affects a live tab — only a truly
  abandoned one.
- **Lazy restore** (default on). Tabs mirrored in from another device open as
  placeholders that don't hit the network until you actually view each one
  (each points at a local page that navigates to the real URL on first view),
  so a large incoming session costs almost nothing until you look at it.
- **Manual restore.** The popup's **Restore from device** picks any
  profile/device pair and opens its currently-open tabs on demand, via
  **Replace** or **Add** — handy to seed a new device, or to just peek at
  another profile's tabs without switching to it (peeked tabs are never
  registered as this device's own, so they don't get mirrored elsewhere).
- **Self-healing.** Some third-party sync tools *recreate* bookmarks instead of
  updating them, producing duplicate profile folders (or duplicate root
  folders). SyncMyTabs detects these and merges them, so the tree stays clean
  across any number of devices.

---

SyncMyTabs runs on **Chromium browsers (Chrome / Brave)** and **Firefox**.

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

**Popup** (toolbar icon):

- **Synchronization on/off** — a switch that **pauses sync in both directions**:
  while off, this device neither pushes its own tab changes nor reacts to other
  devices'. The toolbar icon changes to a greyed-out "paused" icon (with an
  **OFF** badge) so the state is obvious. Manual **Restore from device** still
  works. Sync resumes exactly where it left off when you switch it back on.
- See this device's name, check interval, and the last mirror activity.
- Switch the **active profile** and immediately sync under it.
- **Sync now** — force an immediate check in both directions.
- **Restore from device** — pick any profile, then any device that currently
  has tabs open under it, and open them via **Replace** or **Add**.

**Settings** (options page):

| Setting | Default | Description |
|---|---|---|
| Device name | — | Tags the tabs this device opens, so others know where they came from |
| Profiles | `default` | Manage which profiles exist and which is active |
| Check interval | 1 minute | Opens/closes are detected immediately; this only controls the background double-check cadence |
| Lazy restore | On | Open mirrored-in tabs as placeholders that don't load from the network until you view each one |
| Cleanup (TTL) | On, 21 days | Delete a tab's bookmark entries if they haven't been updated in this many days (safety net for a device that never comes back to agree "closed") |

Removing a profile from the list only removes it from *this device's* picker —
any tab data already saved under that name, on this or any other device, is kept
and stays restorable.

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
| `tabs` | Read open tab URLs/titles; open/close tabs to mirror and restore |
| `storage` | Store this device's settings and state |
| `alarms` | Drive the periodic double-check and cleanup sweep |

---

## Known limitations

- **No more pinned tabs / tab groups.** These were dropped when the sync
  mechanism was redesigned around shared per-tab bookmarks. Pinning/grouping is
  purely local now and isn't synced.
- **Firefox differences.** SyncMyTabs works on Firefox; the bookmark-root id
  differs (Chrome `"2"` vs Firefox `"unfiled_____"`), handled automatically by
  the runtime resolver.
- **Sync visibility.** Detection of remote updates depends entirely on your
  sync tool actually propagating bookmark changes to this device's local tree.
  SyncMyTabs has no insight into whether that underlying sync is healthy.
- **Clock-based ordering.** When devices disagree about whether a URL is open
  or closed, the newer of the two (by each device's local clock, recorded only
  at the moment of a genuine open/close — never invented by a routine
  liveness check) wins. Because it's eventually-consistent over your bookmark
  sync, a close can take a moment to propagate, and badly skewed clocks can
  misjudge which of two truly-concurrent actions was later. Keep clocks
  reasonably in sync (NTP is fine). Closing a whole window or quitting the
  browser deliberately never propagates (a safety choice so a shutdown never
  wipes the session everywhere); a tab you navigate away from (without closing
  its tab) is also not treated as closed.
- **No migration from pre-3.0 versions.** The bookmark tree shape changed
  (shared per-tab bookmarks instead of a snapshot folder per device). Upgrading
  starts fresh; any old `SyncMyTabs/<device>/…` data is left in place, unused —
  safe to delete by hand.

---

## Project layout

| File | Role |
|---|---|
| `manifest.json` | Manifest V3 definition, permissions, entry points (Chrome service worker + Firefox background scripts) |
| `background.js` | Background logic — all sync/save/restore |
| `popup.html` / `popup.js` | Toolbar popup UI |
| `options.html` / `options.js` | Settings page UI |
| `lazy.html` / `lazy.js` | Lazy-restore placeholder page |
| `browser-polyfill.min.js` | Mozilla's WebExtension polyfill (vendored) so `browser.*` works on Chrome too |
| `icons/` | Extension icons (16 / 48 / 128 px, plus `*-off` for the paused state) |

There is no build step — the repository *is* the unpacked extension. To hack on
it, edit the files and hit **Reload** on the extension (`chrome://extensions` or
`about:debugging` on Firefox).

## Releases & packaging

Packaging is automated. To cut a release:

1. Bump `version` in `manifest.json` (semver) and commit.
2. Tag it and push the tag:
   ```bash
   git tag v3.0.0 && git push origin v3.0.0
   ```

The [`release` workflow](.github/workflows/release.yml) then checks that the tag
matches the manifest version, syntax-checks the JS, and builds **two store-ready
zips** — `syncmytabs-<version>-chrome.zip` and `syncmytabs-<version>-firefox.zip`
— each with a manifest tailored to its store (Chrome: service worker only;
Firefox: background scripts only), then publishes both as a **GitHub
Release** on the [Releases page](../../releases). Upload the Chrome zip to the
Chrome Web Store and the Firefox zip to [AMO](https://addons.mozilla.org).

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
