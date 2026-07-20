# Chrome Web Store — Permission Justifications

Copy-paste ready answers for the "Privacy practices" tab of the Chrome Web Store
Developer Dashboard. SyncMyTabs requests only the five permissions below, no host
permissions, no content scripts, and no remotely hosted code.

## Single purpose

> SyncMyTabs has a single purpose: to synchronize a user's open browser tabs
> across their own devices, organized by profile, by reading and writing a
> structured bookmark folder. It relies on the user's existing bookmark-sync
> mechanism to move that data between devices and has no server or account of
> its own.

## Permission justifications

### `bookmarks`
> Bookmarks are the extension's sync transport. SyncMyTabs stores the user's open
> tabs and its own metadata inside a single dedicated bookmark folder tree
> ("SyncMyTabs/…"), and reads that tree back to detect updates coming from the
> user's other devices. The bookmarks permission is required to create, read,
> update, and de-duplicate these folders and bookmarks.

### `tabs`
> The extension reads the URLs and titles of the user's open tabs in order to
> save them under the active profile, and it opens tabs/windows when the user
> restores a session from another device (via the "Replace" or "Add" actions).
> Access to tab URLs and titles requires the tabs permission.

### `storage`
> Used to store this device's local configuration and state: the device name,
> the list and active choice of profiles, the save interval, notification
> preferences, the last-seen update timestamp, and pending-notification records.
> All of this is stored locally via chrome.storage.local and never transmitted.

### `alarms`
> The extension saves the active profile's tabs on a configurable periodic
> interval, driven by a chrome.alarms alarm. The same alarm also powers a durable
> "sweep" that applies a restore notification's timeout action reliably even if
> the Manifest V3 service worker was suspended in the meantime.

### `notifications`
> When another of the user's devices publishes a tab update, the extension shows
> a notification with "Replace" and "Add" buttons so the user can choose whether
> and how to open the incoming tabs. The notifications permission is required to
> create and manage these prompts.

## Host permissions

> None. The extension declares no host permissions and does not read or modify
> the content of any web page.

## Remote code

> No. All JavaScript executed by the extension is included in the extension
> package. No code is fetched or evaluated from remote sources.

## Data usage disclosures

When completing the data-usage certification, the accurate answers are:

- **Data collected:** The extension handles tab URLs/titles and user-entered
  settings, but stores them only in the browser's bookmarks and local extension
  storage. It does **not** collect this data to any remote/author-controlled
  service.
- **Sold to third parties:** No.
- **Used or transferred for purposes unrelated to the item's core
  functionality:** No.
- **Used or transferred to determine creditworthiness or for lending:** No.

Cross-device transfer of the bookmark data is performed by the user's own
bookmark-sync mechanism (native browser sync or a third-party tool), not by
SyncMyTabs. See [`PRIVACY.md`](PRIVACY.md).
