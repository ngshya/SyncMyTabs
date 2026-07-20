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

> Formerly named `OpenTabSync`, formerly `Live Tabs Sync`. On startup the
> extension automatically migrates an old-named bookmark folder in place, so
> existing synced data is never orphaned by the rename.

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
│   ├── default/               ← one folder per profile
│   │   ├── _last_sync         ← metadata: this profile's last save time
│   │   └── (open-tab bookmarks…)
│   └── work/
│       ├── _last_sync
│       └── (open-tab bookmarks…)
├── macbook-m3/
│   └── default/
│       └── …
└── _status                    ← global signal: last device/profile/time saved
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
  constantly).
- **Detecting remote updates.** A single `_status` bookmark at the root is
  updated in place with the last device/profile/timestamp that saved anything.
  Other devices notice via `bookmarks.onChanged` / `onCreated` — it's
  **fully event-driven, no polling**.
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
| `tabs` | Read open tab URLs/titles; open tabs on restore |
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
- **Clock-based ordering.** "Which update is newer" is decided using each
  device's local clock (a timestamp embedded in `_status`). If a device's clock
  is badly wrong, a legitimately newer update could be ignored, or a stale one
  surfaced. Keep your devices' clocks reasonably in sync (normal NTP is fine).

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

## License

**PolyForm Noncommercial License 1.0.0** — see [LICENSE](LICENSE).

You may use, copy, modify, and distribute this software **for any
noncommercial purpose** (personal use, hobby projects, research, education,
nonprofits, government, etc.). **Commercial use is not permitted** — you may
not use this codebase in a paid product or service, or otherwise for
commercial advantage. If you need a commercial license, contact the author.
