# Chrome Web Store listing copy

Copy-paste ready text for the Chrome Web Store Developer Dashboard's "Store
listing" tab — plain text only (the store shows no Markdown: no bold, no
links). The README opens with the description's first three paragraphs,
verbatim, so the two stay the same. Keep this in sync with `README.md` when
the feature set changes — same spirit as `PERMISSIONS.md`/`PRIVACY.md`.

## Summary (132 characters max)

> Sync your open tabs across every device through your own bookmarks, plus a new tab page listing them all. No server, no account.

(128 characters)

## Description

Same format as every earlier version (tagline, intro, HOW IT WORKS, FEATURES
with "-" bullets, PRIVACY BY DESIGN) — keep it that way when updating, so
the listing reads consistently across releases.

```
Sync your open tabs across every device — no server, no account, no cloud.

SyncMyTabs keeps your open tabs in sync everywhere, using the bookmark sync you already trust — your browser's built-in sync, Floccus, xBrowserSync, or anything else. No server of its own. No sign-up. If your bookmarks sync, your tabs sync.

It also turns your new tab page into a list of every tab you have open — by window and tab group, searchable, one keystroke away. Perfect for browsing in full screen, or with the tab bar hidden or kept narrow.

HOW IT WORKS
SyncMyTabs stores your tabs in a small, structured bookmark folder. Whatever already syncs your bookmarks carries the data between devices — nothing new to trust, nothing to configure.

FEATURES
- Live two-way tab sync, organized by profile (Home, Work...) — each stays independent, always in sync with itself across devices.
- Lazy restore — tabs from other devices open as placeholders and only load when you click them. No surprise autoplay on a restored YouTube tab.
- Tab group sync (Chrome/Brave) — keep a group's pages and its rules consistent on every device.
- Auto-archive idle tabs (on by default, easy to turn off) — old tabs get bookmarked and closed automatically, on a schedule you set. The last week's are on the new tab page, one click away.
- Smart tab order (optional) — groups first, then by most recently used.
- New tab page — every open tab by window and tab group, plus the recently archived ones. Type to filter, type a tab's number to jump to it, or search the web (your default engine, or Google, Maps, YouTube, Claude, Perplexity, Wikipedia with a one-letter shortcut). One per window, so they don't pile up. Optional bookmarks bar and Matrix rain.
- Light, dark, black, or system theme.

Note: SyncMyTabs replaces your new tab page. When Chrome asks, choose "Keep it" — "Change it back" turns off the whole extension, sync included.

PRIVACY BY DESIGN
No server. No account. No analytics. No ads. Everything stays on your device — the only thing that leaves it is your own bookmark sync, and a web search you start from the new tab page, sent only to the service you picked.

Free and open source.
```

## Screenshots

Upload in this order (Store listing → Graphic assets → Screenshots, five at
most), all 1280×800 from [`store-assets/`](store-assets/):

1. `screenshot-2-newtab-dark-1280x800.jpg` — the new tab page (dark)
2. `screenshot-4-newtab-matrix-black-1280x800.jpg` — black theme, Matrix rain
3. `screenshot-3-newtab-light-1280x800.jpg` — the new tab page (light)
4. `screenshot-5-newtab-matrix-dark-1280x800.jpg` — dark theme, Matrix rain
5. `screenshot-1-overview-1280x800.png` — settings page + popup

## What's new (for the release / an announcement)

```
4.18.0
• New tab page: only one per window — opening a new one closes the older ones in that window, so blank new tabs don't pile up (a setting, on by default).

4.17.0
• New tab page: a "recently auto-archived" section — the tabs auto-archive closed over the last 7 days (adjustable, 1 = today only), grouped by day; one click reopens a tab right there.
• New tab page: the "tabs on your other devices" section is gone — sync already opens every one of those tabs on this device, so it only repeated your own list.
```

## Category

Productivity

## Language

English

## Related docs

- [`README.md`](README.md) — full user-facing description
- [`PRIVACY.md`](PRIVACY.md) — privacy policy (public URL for the "Privacy practices" tab)
- [`PERMISSIONS.md`](PERMISSIONS.md) — per-permission justifications
- [`store-assets/`](store-assets/) — listing screenshots
