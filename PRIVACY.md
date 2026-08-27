# Privacy Policy — SyncMyTabs

_Last updated: 2026-08-27_

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
| **Open tab URLs and titles** | To save the active profile's open tabs and to reopen them when mirrored in from another device | Written only into your local bookmarks (see below) |
| **Bookmarks** | Bookmarks are the sync transport: the extension reads/writes a single `SyncMyTabs/…` folder tree | Stays in your browser's bookmark store |
| **Device name and settings** (device name, profile list, sync interval, cleanup preference, last-activity timestamp) | To configure how this device behaves | Local extension storage (`chrome.storage.local`) only |
| **Tab group titles and leashing rules** (optional module, Chrome/Brave only — see below) | To keep a browser tab group's declared tabs present, and keep links clicked inside it from wandering outside its declared pages | Written into the same local bookmarks tree, under the active profile |
| **Clicked link URLs** (optional module) | Only on a tab that's inside a configured tab group: the clicked link's own href and click modifiers (ctrl/cmd/shift/middle-click), to decide whether to navigate in place, open alongside, or open a fresh ungrouped tab | Sent locally to the extension's own background page only — never off-device |
| **Tab activation times** (optional module) | To track when each of your tabs was last actually looked at, so the auto-archive module (off by default) can tell which ones have gone idle past your configured threshold | Local extension storage (`chrome.storage.local`) only |
| **Archived tab bookmarks** (optional module) | When auto-archive closes an idle tab, its title and URL are saved first as a plain bookmark, so nothing is lost | Written into the same local bookmarks tree, under the active profile |

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

The extension requests the permissions required for the above functionality:
`bookmarks`, `tabs`, `tabGroups`, `storage`, `alarms`, and the `<all_urls>`
host permission with one content script (`link-leash-content.js`), used
exclusively by the optional tab-group leashing module described above. That
content script only ever reads a clicked link's own href — never page
content — and only attaches its click listener on a tab it has first
confirmed (by asking the background page) is inside a configured tab group;
an ordinary, ungrouped tab is unaffected by it. The extension loads **no
remote code** — all code ships inside the extension package. See
[`PERMISSIONS.md`](PERMISSIONS.md) for a per-permission justification.

## Children's privacy

SyncMyTabs is a general-purpose utility and is not directed at children. It does
not knowingly collect any information from anyone.

## Changes to this policy

If this policy changes, the updated version will be published in this repository
with a new "Last updated" date.

## Contact

Questions about this policy? Contact the maintainer at:
**<https://y.shuyi.it/>**
