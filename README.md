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
├── manjaro-vivobook/          ← one folder per device (you name it)
│   ├── _status                ← this device's signal: last profile + time it saved
│   ├── default/               ← one folder per profile
│   │   ├── _last_sync         ← metadata: this profile's last save time
│   │   ├── _tab_meta          ← metadata: pinned/tab-group info (only if used)
│   │   └── (open-tab bookmarks…)
│   └── work/
│       ├── _last_sync
│       └── (open-tab bookmarks…)
└── macbook-m3/
    ├── _status
    └── default/
        └── …
```

- **Devices.** Each device names its own folder on first run
  (e.g. `manjaro-vivobook`).
- **Profiles.** A device can have several profiles (e.g. `default`, `work`,
  `school`). Exactly one is *active* at a time; the active profile's open tabs
  are what gets saved. Profiles are per-device, but a profile name created on
  *any* device automatically becomes selectable on every device.
- **Saving.** On a configurable interval (default: every 1 minute) the active
  profile's currently open tabs are written into its folder, replacing the
  previous contents. Only `http(s)` tabs are saved, duplicate URLs are deduped,
  and if nothing changed since the last save, **nothing is touched** — no
  needless bookmark churn (which would otherwise trigger your sync tool
  constantly). Tabs restored from another device that you **haven't opened
  yet** (lazy placeholders) don't count as part of this device's session, so
  they're never re-broadcast back (which would otherwise echo — and resurrect —
  the other device's tabs). **Pinned tabs and tab groups** (title + color) are
  preserved:
  they're recorded in a tiny per-profile `_tab_meta` metadata bookmark and
  reapplied on restore.
- **Detecting remote updates.** Each device has its **own** `_status` bookmark
  (inside its folder), updated in place with the last profile/timestamp it
  saved — so devices and profiles never overwrite each other's signal. Other
  devices notice via `bookmarks.onChanged` / `onCreated` — **fully event-driven,
  no polling** — and keep a **per-source** "last seen" timestamp, so a genuinely
  newer update is never skipped just because another device has a faster clock.
- **Restoring.** When an update from another device is detected, a notification
  appears with **Replace** and **Add** buttons:
  - **Replace** — open the remote tabs in a fresh window and close the old ones.
  - **Add** — open only the remote tabs you don't already have, in the current
    window.
  - Clicking the notification body itself just dismisses it (the notifications
    API allows only two buttons, so the body click stands in for a third
    "Ignore").
  - If the notification times out unanswered, a **configurable default action**
    is applied. This timeout is durable: it is honored even if the browser
    suspended the extension's background worker in the meantime.
  - By default, restored tabs open as **lightweight placeholders that don't hit
    the network until you actually view each tab** (each tab points at a local
    page that navigates to the real URL on first view), so restoring a large
    session costs almost nothing. This can be turned off in the settings.
- **Mirroring closes.** When a device you received tabs from later closes one of
  them, that close is mirrored here — but **only** for a placeholder tab you
  never opened (it's tagged with the source device/profile, so tabs you've
  opened or created yourself are never touched). Off-switchable in the settings.
- **Self-healing.** Some third-party sync tools *recreate* bookmarks instead of
  updating them, producing duplicate `_status` / `_last_sync` entries or even
  duplicate root folders. SyncMyTabs detects these and merges them, keeping the
  most recent, so the tree stays clean across any number of devices.

---

## Install (developer mode)

1. Download or clone this repository.
2. Open `brave://extensions` (or `chrome://extensions`).
3. Enable **Developer mode** (top-right).
4. Click **Load unpacked** and select this folder.
5. On first run a settings tab opens — give this device a name.
6. Repeat on every device you want to sync, and make sure your bookmark sync is
   active on each.

---

## Usage

**Popup** (toolbar icon):

- **Synchronization on/off** — a switch that **pauses sync in both directions**:
  while off, this device neither saves its tabs nor reacts to other devices'
  updates. The toolbar icon changes to a greyed-out "paused" icon (with an
  **OFF** badge) so the state is obvious. Manual **Restore from device** still
  works. Sync resumes exactly where it left off when you switch it back on.
- See this device's name, save interval, and the last signal received.
- Switch the **active profile** and immediately save under it.
- **Sync now** — save the current tabs and check for remote updates on demand.
- **Restore from device** — manually open the tabs saved by any device/profile,
  via **Replace** or **Add**, without waiting for a notification.

**Settings** (options page):

| Setting | Default | Description |
|---|---|---|
| Device name | — | Identifies this device's bookmark folder |
| Profiles | `default` | Manage which profiles exist and which is active |
| Save interval | 1 minute | How often the active profile's tabs are saved |
| Notification timeout | 15 seconds | How long the restore notification stays up |
| Default timeout action | Add | What happens if the notification times out unanswered (`Add`, `Replace`, or `None`) |
| Lazy restore | On | Open restored tabs as placeholders that don't load from the network until you view each one (saves memory/bandwidth when restoring many tabs) |
| Mirror closes | On | When the source device closes a tab you received but never opened, close it here too (never touches tabs you've opened or created) |

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
| `tabs` | Read open tab URLs/titles/pinned state; open tabs on restore |
| `tabGroups` | Read tab-group title/color on save; recreate groups on restore |
| `storage` | Store this device's settings and state |
| `alarms` | Drive the periodic save + durable notification timeout |
| `notifications` | Prompt you when another device has an update |

---

## Known limitations

- **Chrome / Brave first.** The root folder lives under "Other Bookmarks".
  The extension resolves that folder from the bookmark tree at runtime and
  falls back to Chrome/Brave's well-known id (`"2"`), so it isn't hardcoded —
  but it has only been exercised on Chromium-based browsers. Firefox uses
  different bookmark-root ids and is not officially supported yet.
- **Sync visibility.** Detection of remote updates depends entirely on your
  sync tool actually propagating bookmark changes to this device's local tree.
  SyncMyTabs has no insight into whether that underlying sync is healthy.
- **Clock-based ordering.** "Which update is newer" for a *given* device/profile
  is decided using that device's local clock (a timestamp embedded in its
  `_status`). Because each source is tracked independently, one device's wrong
  clock no longer makes another device's updates get skipped; the only remaining
  effect is that notifications from *different* devices may surface in an order
  that doesn't match real-world time. Keep clocks reasonably in sync (NTP is
  fine).

---

## Project layout

| File | Role |
|---|---|
| `manifest.json` | Manifest V3 definition, permissions, entry points |
| `background.js` | Service worker — all sync/save/restore logic |
| `popup.html` / `popup.js` | Toolbar popup UI |
| `options.html` / `options.js` | Settings page UI |
| `icons/` | Extension icons (16 / 48 / 128 px) |

There is no build step — the repository *is* the unpacked extension. To hack on
it, edit the files and hit **Reload** on the extension in `chrome://extensions`.

## Releases & packaging

Packaging is automated. To cut a release:

1. Bump `version` in `manifest.json` (semver) and commit.
2. Tag it and push the tag:
   ```bash
   git tag v2.0.1 && git push origin v2.0.1
   ```

The [`release` workflow](.github/workflows/release.yml) then checks that the tag
matches the manifest version, syntax-checks the JS, builds the store-ready
`syncmytabs-<version>.zip`, and publishes it as a **GitHub Release** — the zip
appears on the [Releases page](../../releases), ready to upload to the Chrome Web
Store.

For publishing to the store, see [`PRIVACY.md`](PRIVACY.md) (privacy policy) and
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
