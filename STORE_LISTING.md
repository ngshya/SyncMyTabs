# Chrome Web Store listing copy

Copy-paste ready text for the Chrome Web Store Developer Dashboard's "Store
listing" tab — plain text only (the store shows no Markdown: no bold, no
links), which is why the README's opening paragraphs are written the same
way: they're the description's first three paragraphs, verbatim. Keep this in sync with `README.md` when the feature set
changes — same spirit as `PERMISSIONS.md`/`PRIVACY.md`.

## Summary (132 characters max)

> Sync your open tabs across devices through your own bookmarks, plus a new tab page listing them all. No server, no account.

(123 characters)

## Description

```
Sync your open browser tabs across devices — organized by profile, with no server, no account, and no cloud service of its own.

SyncMyTabs uses your bookmarks as the transport. It reads and writes a small, structured bookmark tree and reacts to changes in it — nothing more. The actual moving of data between devices is done by whatever bookmark-sync mechanism you already use: your browser's built-in sync, or a third-party tool like Floccus or xBrowserSync. If your bookmarks sync, your tabs sync.

It also replaces the new tab page with one that lists every tab you have open — by window and tab group, searchable, each one a click or a number away. That makes it a natural fit for browsing in full screen, or with the tab bar hidden or kept narrow: every tab is always one new tab away.

KEY FEATURES

• Live two-way tab sync, organized by profile (e.g. "Home", "Work"), so different sets of tabs stay independent but always in sync with themselves across every device on that profile.

• Lazy restore — tabs mirrored in from another device open as lightweight placeholders and only load for real once you view them. By default, they wait for a click before loading, so a restored YouTube tab never autoplays just because you switched to it.

• Tab groups (Chrome/Brave) — keep a titled tab group's key pages present on every device, and keep links clicked inside it from wandering outside the group. Group rules sync the same way tabs do.

• Auto-archive idle tabs (on by default, adjustable or toggleable off) — tabs you haven't looked at in a while (you choose the threshold, down to the minute) are saved as a bookmark and closed automatically, so your tab bar doesn't grow forever. The ones archived in the last few days are listed on the new tab page, one click away from coming back.

• Tab & group order (optional, off by default) — keep tab groups (Chrome/Brave) at the start of the window, alphabetically, followed by your other tabs sorted by how recently you used them. Only reorders once you've stepped away or been reading for a while, never while you're actively switching between tabs.

• A minimal new tab page — the time, a search box, every tab you have open (by window and tab group), and the tabs auto-archived over the last 7 days (you choose how many), by day, so you can reopen one with a click. Start typing to filter, or type a tab's number and press Enter to jump straight there — no mouse needed. The same box searches the web (your default engine, or Google, Maps, YouTube, Claude, Perplexity, Wikipedia with a one-letter shortcut). Only one new tab page per window, so they don't pile up. Optional Matrix rain in dark mode. You choose which sections it shows, and can add a copy of your bookmarks bar at the top so the browser's own can stay hidden. Note: SyncMyTabs replaces your new tab page; on Chrome, choose "Keep it" when asked — "Change it back" turns off the whole extension, sync included.

• Light, dark, pure black, or system theme.

• Nothing leaves your device except through your own bookmark sync — no account, no sign-up, no analytics, no ads.

PRIVACY
SyncMyTabs has no server and collects nothing. Everything happens locally, inside your browser's own storage and bookmarks.

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
