# Chrome Web Store — Permission Justifications

Copy-paste ready answers for the "Privacy practices" tab of the Chrome Web Store
Developer Dashboard. SyncMyTabs requests the permissions below, including a
broad host permission and a content script for its tab-group leashing module
(see "Host permissions" and "Content scripts"), and no remotely hosted code.

## Single purpose

> SyncMyTabs has a single purpose: to synchronize a user's open browser tabs
> across their own devices, organized by profile, by reading and writing a
> structured bookmark folder. It relies on the user's existing bookmark-sync
> mechanism to move that data between devices and has no server or account of
> its own. An optional, independent module (Chrome/Brave only) extends this to
> the user's browser tab groups: it keeps a titled group's declared tabs
> present (reopening one that's missing, closing accidental duplicates) and
> keeps clicked links inside that group from wandering outside its declared
> pages — the same bookmark-based sync mechanism carries this module's
> configuration across devices too, scoped by the same profile.

## Permission justifications

### `bookmarks`
> Bookmarks are the extension's sync transport. SyncMyTabs stores the user's
> open tabs, tab-group configuration, and its own metadata inside a single
> dedicated bookmark folder tree ("SyncMyTabs/…"), and reads that tree back to
> detect updates coming from the user's other devices. The bookmarks
> permission is required to create, read, update, and de-duplicate these
> folders and bookmarks.

### `tabs`
> The extension reads the URLs and titles of the user's open tabs in order to
> record them under the active profile, detects when the user opens or closes
> one, and opens/closes/groups tabs when mirroring a tab in from another
> device or reconciling a browser tab group's declared tabs. Access to tab
> URLs, titles, and group membership requires the tabs permission.

### `tabGroups`
> Used only by the optional tab-group leashing module (Chrome/Brave; there is
> no such API on Firefox). Reads a browser tab group's title (the stable,
> cross-device key its bookmark-based configuration is keyed by) and creates/
> updates a group when reopening a missing declared tab.

### `storage`
> Used to store this device's local configuration and state: the device name,
> the list and active choice of profiles, the save interval, the cleanup
> (TTL) preference, the tab-group leashing module's own on/off and
> close-undeclared-tabs preferences, and the last-activity timestamp shown in
> the popup. All of this is stored locally via chrome.storage.local and never
> transmitted.

### `alarms`
> The extension periodically re-checks the active profile's tabs against the
> synced bookmark state, sweeps stale entries per the configurable cleanup
> setting, and (once per browser launch, after a short configurable delay)
> reconciles the active profile's declared tab groups — all driven by
> chrome.alarms alarms.

## Host permissions

> `<all_urls>`, used exclusively by the optional tab-group leashing module's
> content script (see below) to intercept link clicks on pages the user has
> put inside a titled tab group. The extension does not read, modify, or
> transmit page content otherwise, and a tab that isn't inside a browser tab
> group is completely unaffected — link-leash-content.js only attaches its
> click listeners after confirming with the background page that the current
> tab is actually grouped.

## Content scripts

> `link-leash-content.js` runs on every page (`<all_urls>`, `document_start`)
> so it CAN intercept a link click the moment a tab is grouped, but it only
> ever attaches a click/middle-click listener after asking the background
> page whether this specific tab is currently inside a browser tab group —
> on the overwhelming majority of tabs (ungrouped, ordinary browsing) it asks
> once and then does nothing further. When a listener is attached, a click on
> an `<a href>` is intercepted (`preventDefault`) and its target URL and
> click modifiers (ctrl/cmd/shift/middle-click) are sent to the background
> page, which decides — per that group's bookmark-stored rules — whether to
> navigate the current tab, open a new tab in the same group, or open a new
> ungrouped tab. No page content is read beyond the clicked link's own href;
> nothing is transmitted off-device.

## Remote code

> No. All JavaScript executed by the extension is included in the extension
> package. No code is fetched or evaluated from remote sources.

## Data usage disclosures

When completing the data-usage certification, the accurate answers are:

- **Data collected:** The extension handles tab URLs/titles, tab-group titles
  and leashing rules, and user-entered settings, but stores them only in the
  browser's bookmarks and local extension storage. It does **not** collect
  this data to any remote/author-controlled service. The content script only
  ever reads a clicked link's own href, never page content, and only sends it
  to the extension's own background page (locally, never off-device).
- **Sold to third parties:** No.
- **Used or transferred for purposes unrelated to the item's core
  functionality:** No.
- **Used or transferred to determine creditworthiness or for lending:** No.

Cross-device transfer of the bookmark data is performed by the user's own
bookmark-sync mechanism (native browser sync or a third-party tool), not by
SyncMyTabs. See [`PRIVACY.md`](PRIVACY.md).
