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
  *any* device automatically becomes selectable on every device. **Profiles are
  independent:** automatic sync only happens between devices using the **same**
  active profile — a device on `home` ignores another device's `work` updates.
  (Switching your active profile re-checks other devices for that profile, and
  you can still pull any profile by hand via **Restore from device**.)
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
  An update is only acted on when its profile **matches this device's active
  profile** (see Profiles above).
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
- **Full session mirror** (default on). For devices on the **same profile**, the
  tab set is kept in sync **both ways**: open a tab on one device and it appears
  on the others; **close it anywhere and it closes everywhere**. Each device
  records per-URL open times and close "tombstones" (in a small `_events`
  metadata bookmark), and a URL is considered open when its newest open is newer
  than its newest close. A close is detected by diffing this device's saved tabs
  against the live ones (no fragile per-tab bookkeeping), and the closed tab's
  bookmark is removed **immediately** from this device's own folder — it doesn't
  wait for the next periodic save. Safety rails: closing a **whole window or
  quitting** the browser never propagates (only closing individual tabs does),
  and a device's own reconcile-driven closes never loop back. Turn it off in the
  settings to fall back to the milder placeholder-only mirror below.
- **Mirroring closes (mild).** When full mirror is *off*: a close is mirrored
  here **only** for a placeholder tab you never opened (tagged with the source
  device/profile, so tabs you've opened or created yourself are never touched).
- **Self-healing.** Some third-party sync tools *recreate* bookmarks instead of
  updating them, producing duplicate `_status` / `_last_sync` entries or even
  duplicate root folders. SyncMyTabs detects these and merges them, keeping the
  most recent, so the tree stays clean across any number of devices.

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
| Full session mirror | On | Keep the profile's tabs in sync **both ways** across your devices — open/close on one device reflects on the others. When on, it replaces the Add/Replace notification with automatic sync |
| Mirror closes | On | Only when **full session mirror is off**: close tabs you received but never opened when the source device closes them (placeholders only) |

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

- **Firefox differences.** SyncMyTabs works on Firefox, but two Chrome-only
  features degrade there:
  - **Tab groups** — Firefox has no tab-groups API, so groups aren't saved or
    recreated (pinned tabs, and everything else, still work).
  - **Notification buttons** — Firefox notifications don't show the
    **Replace** / **Add** buttons; make your choice from the popup's **Restore
    from device** instead (the default timeout action still applies).
  The bookmark-root id also differs (Chrome `"2"` vs Firefox `"unfiled_____"`) —
  handled automatically by the runtime resolver.
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
- **Full session mirror caveats.** Open/close ordering of the *same* URL across
  devices also relies on those clocks, so badly skewed clocks can misjudge
  whether a URL is open or closed. Because it's eventually-consistent over your
  bookmark sync, a close can take a moment to propagate. Closing a whole window
  or quitting the browser deliberately does **not** propagate (a safety choice so
  a shutdown never wipes the session everywhere). Turn the feature off in the
  settings if you'd rather each device keep an independent tab set.

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
   git tag v2.0.1 && git push origin v2.0.1
   ```

The [`release` workflow](.github/workflows/release.yml) then checks that the tag
matches the manifest version, syntax-checks the JS, and builds **two store-ready
zips** — `syncmytabs-<version>-chrome.zip` and `syncmytabs-<version>-firefox.zip`
— each with a manifest tailored to its store (Chrome: service worker only;
Firefox: background scripts, no `tabGroups`), then publishes both as a **GitHub
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
