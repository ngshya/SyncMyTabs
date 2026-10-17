# Popup vs. options page, and the shared theme

> Moved out of `CLAUDE.md` to keep every session's base context small.
> Read it when you're working on what it covers.


Split in the same change auto-archive was added, once the popup had grown
enough settings that keeping everything in one place stopped being the
better trade-off. `popup.html`/`popup.js` is now deliberately minimal:
status, one on/off switch per feature module (open-tab sync — also the
master `syncEnabled` switch — tab groups, auto-archive), a "Sync now"
quick action, and a button that opens `options.html` as a plain tab (same
`browser.tabs.create({url: browser.runtime.getURL(...)})` mechanism the
first-run prompt already used). `options.html`/`options.js` holds
everything else: device name, profiles, the shared check interval (right
after profiles), and every module's detail settings grouped into three
cards in that same order (Open tabs sync / Tab groups / Auto-archive),
plus the theme selector. `browser.runtime.onInstalled` now opens
`options.html` (not `popup.html`) for first-run setup, since that's where
device name + profile setup live now.

`theme.css`/`theme.js` are shared between the two pages (and the custom
new tab page, `newtab.html`): `theme.css`
defines CSS custom-property tokens on bare `:root` (light, the default),
redefines them under `@media (prefers-color-scheme: dark)` guarded by
`:root:not([data-theme="light"])`, then redefines them again under
`:root[data-theme="dark"]` so an explicit choice always wins over the OS
setting in both directions. A fourth choice, `"black"`, shares the dark
block's selector and then overrides just the surfaces (pure black
background) in a block of its own at the end. `theme.js` reads
`themePreference` from `storage.local` (`"system"` default / `"light"` /
`"dark"` / `"black"`), stamps it as
a `data-theme` attribute on `<html>`, and listens for `storage.onChanged`
so a change made in one page is reflected live in the other if both happen
to be open at once. Applied asynchronously (a brief flash of the OS-default
theme before an explicit override applies is accepted — not worth a
synchronous-localStorage-cache workaround for a page this short-lived).
