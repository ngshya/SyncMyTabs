# Privacy Policy — SyncMyTabs

_Last updated: 2026-07-20_

SyncMyTabs is a browser extension that syncs your open tabs across your own
devices, organized by profile, using **bookmarks as the transport**. This policy
explains exactly what the extension accesses and what happens to that data.

## The short version

- SyncMyTabs has **no server, no account, and no backend of its own.**
- It **does not collect, transmit, sell, or share** any of your data with the
  author or any third party.
- Everything the extension reads or writes stays **on your device**, inside your
  browser (local extension storage and your bookmarks).
- No analytics, no tracking, no advertising, no telemetry.

## What the extension accesses, and why

| Data | Why it's accessed | Where it goes |
|---|---|---|
| **Open tab URLs and titles** | To save the active profile's open tabs and to reopen them when restoring from another device | Written only into your local bookmarks (see below) |
| **Bookmarks** | Bookmarks are the sync transport: the extension reads/writes a single `SyncMyTabs/…` folder tree | Stays in your browser's bookmark store |
| **Device name and settings** (device name, profile list, sync interval, notification preferences, last-seen timestamp) | To configure how this device behaves | Local extension storage (`chrome.storage.local`) only |

## How syncing actually works

SyncMyTabs writes your tab data into a structured bookmark folder and reads
changes back from it. It does **not** move that data between devices itself.

The actual cross-device transfer is performed entirely by **whatever
bookmark-sync mechanism you already use** — your browser's built-in sync, or a
third-party tool such as Floccus or xBrowserSync. That data therefore travels
through, and is governed by the privacy policy of, **the sync provider you have
chosen**, not SyncMyTabs. SyncMyTabs has no visibility into or control over that
channel.

## Data sharing

SyncMyTabs does **not** send your data to the author's servers (there are none),
and does **not** share it with any third party. The only place your tab data
goes is your own bookmarks, and from there only wherever your own chosen
bookmark-sync tool replicates it.

## Data retention and deletion

- Tab bookmarks live in your bookmarks until overwritten by the next save or
  deleted by you.
- Settings live in local extension storage until you change them or remove the
  extension.
- **Uninstalling the extension** removes its local storage. You can delete the
  `SyncMyTabs` bookmark folder at any time to remove all synced tab data.

## Permissions

The extension requests only the permissions required for the above
functionality: `bookmarks`, `tabs`, `storage`, `alarms`, and `notifications`.
It requests **no host permissions**, runs **no content scripts** on web pages,
and loads **no remote code** — all code ships inside the extension package. See
[`PERMISSIONS.md`](PERMISSIONS.md) for a per-permission justification.

## Children's privacy

SyncMyTabs is a general-purpose utility and is not directed at children. It does
not knowingly collect any information from anyone.

## Changes to this policy

If this policy changes, the updated version will be published in this repository
with a new "Last updated" date.

## Contact

Questions about this policy? Contact the maintainer at:
**[fill in a contact email or URL before publishing]**
