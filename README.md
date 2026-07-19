# SyncMyTabs

A browser extension that syncs your open tabs across devices, organized by
profile, using **bookmarks as the transport** — no server, no account, no
cloud service of its own. It relies on whatever bookmark-sync tool you
already use (native browser sync, or a third-party plugin like Floccus /
xBrowserSync) to actually move data between devices; SyncMyTabs only reads
and writes bookmarks in a structured way and reacts to changes.

> Formerly named `OpenTabSync`, formerly `Live Tabs Sync`. The extension
> automatically migrates the old bookmark folder if it finds one.

## How it works

```
SyncMyTabs/                     (root bookmarks folder)
  manjaro-vivobook/              (device folder — one per device)
    default/                     (profile folder — one per profile)
      🔖 _last_sync               (metadata: last save time for this profile)
      🔖 (open tab bookmarks...)
    work/
      🔖 _last_sync
      🔖 (open tab bookmarks...)
  macbook-m3/
    default/
      ...
  🔖 _status                     (global signal: last device+profile+time to save)
```

- Each device is given a name by the user on first run.
- Each device can have multiple **profiles** (e.g. `default`, `work`,
  `school`). Only one profile is active at a time per device; open tabs are
  saved under the active profile's folder.
- On a configurable interval (default 1 minute), the extension saves the
  active profile's currently open tabs, replacing that folder's contents.
  Tabs with duplicate URLs are deduped; only `http(s)` tabs are saved.
  If nothing changed since the last save, nothing is touched (no unnecessary
  bookmark churn).
- A single `_status` bookmark at the root is updated (never recreated) with
  the last device/profile/timestamp that saved something. Other devices
  detect updates by listening to bookmark change events
  (`bookmarks.onChanged` / `onCreated`) — **fully event-driven, no polling**.
- When an update is detected from another device, a notification appears
  with **Replace** / **Add** buttons (clicking the notification body itself
  dismisses it with no action, standing in for a third "Ignore" option that
  the notifications API doesn't support). If the notification times out
  unanswered, a configurable default action is applied.
- Duplicate `_status` / `_last_sync` bookmarks (which can happen with some
  third-party sync tools that recreate bookmarks instead of updating them)
  are automatically detected and merged, keeping the most recent one.

## Install (developer mode)

1. Download/clone this repo.
2. Go to `brave://extensions` (or `chrome://extensions`).
3. Enable **Developer mode** (top right).
4. Click **Load unpacked** and select this folder.
5. On first run, a settings tab opens — give this device a name.
6. Repeat on each device you want to sync.

## Settings

Available from the extension's options page:

| Setting | Default | Description |
|---|---|---|
| Device name | — | Identifies this device's bookmark folder |
| Profiles | `default` | Manage which profiles exist and which is active |
| Save interval | 1 minute | How often the active profile's tabs are saved |
| Notification timeout | 15 seconds | How long the restore notification stays up |
| Default timeout action | Add | What happens if the notification times out unanswered (`Add`, `Replace`, or `None`) |

## Requirements

You need a bookmark-syncing mechanism already set up between your devices —
either the browser's built-in sync, or a third-party tool (Floccus,
xBrowserSync, etc.). SyncMyTabs doesn't sync bookmarks itself; it only reads
and writes them locally and relies on that existing sync to move the data.

## Known limitations

- `OTHER_BOOKMARKS_PARENT_ID` in `background.js` targets Chrome/Brave's
  "Other Bookmarks" folder (`"2"`). Firefox uses different folder IDs and
  isn't currently supported.
- Detection of remote updates depends entirely on your sync tool actually
  propagating bookmark changes to this device's local bookmark tree —
  SyncMyTabs has no visibility into whether that sync itself is working.

## License

MIT — see [LICENSE](LICENSE).
