# Custom new tab page (`newtab-core.js` + `newtab.html`/`newtab.js`)

> Split out of `CLAUDE.md` to keep the base file small — read this when
> you're actually working on the new tab page. Same 1-invariant-1-place
> documentation convention as `CLAUDE.md`'s Architecture section: summary
> + pointer here, full detail in the code.

Replaces the browser's new tab page (`chrome_url_overrides.newtab` in
`manifest.json` — supported on Chrome/Brave and Firefox): a clock and
date, a search box, this device's open tabs by window and browser tab
group, and the tabs open on the user's other devices on the same
profile.

- **Split in two: data in `newtab-core.js`, DOM in `newtab.js`.**
  `newtab-core.js` is an ordinary `env`-parameterized module
  (`createNewtabEngine(env, syncEngine)`), tested in Node like the
  others; `newtab.js` only renders what it returns and handles
  clicks/keys. See the header comments of both files.
- **The data goes through background.js messages
  (`NEWTAB_LOCAL`/`NEWTAB_REMOTE`), not a second engine in the page.**
  The remote half reads the bookmark tree through `readProfileEntries`,
  which self-heals duplicate folders with real writes — an engine living
  in every open new tab page would mean concurrent, un-serialized writers
  on the same tree. Two messages rather than one so local tabs (a single
  `tabs.query`) render instantly while the slower bookmark walk fills the
  "other devices" section in afterwards. See `handleMessage`'s comment
  in `newtab-core.js`.
- **Self-contained: no other module knows this one exists.**
  `sync-core.js`, `groups-core.js`, `archive-core.js`, `order-core.js`
  and the popup/options UI never reference it; `background.js` wires it
  with an `onMessage` listener of its own (after the one every other
  module shares), calling only `newtabEngine.handleMessage()`, which
  returns `null` for anything that isn't a `NEWTAB_*` message.
  `test/newtab-isolation.test.js` enforces both. Removing the feature
  comes down to deleting its three files plus its wiring lines
  (`importScripts`, the engine `const`, that listener, the manifest's
  override and `background.scripts` entry, `release.yml`'s file list).
- **New tab pages are recognized here and only here** —
  `isNewTabPageUrl` in `newtab-core.js`: a tab on the new tab page can
  report either the native URL (`chrome://newtab/` — what Chrome keeps
  for an overridden one) or the extension page's own URL (Firefox), and
  both match. Used to keep new tab pages out of the page's own list.
  `archive-core.js` and `order-core.js` keep them out of their own way
  without any new-tab knowledge, through the generic "http(s) tabs only"
  rule `sync-core.js` already applies to what it syncs (see their own
  docs).
- **The remote half is skipped entirely while sync is paused**
  (`{ paused: true }`, nothing read) — reading it can write to the
  bookmark tree (self-heal, creating a missing profile folder), and the
  master switch's contract is "nothing touches bookmarks in either
  direction". See `getRemoteData`'s comment.
- **Remote entries link to a local copy when there is one** (`localTabId`/
  `localWindowId`): with sync running, almost every remote tab is
  mirrored in here anyway, so that section is mostly a "what's open on
  which device" view; a click switches to the local copy, and only a
  not-yet-mirrored one is actually opened (in place, in the new tab).
- **Favicons: only the tab's own icon, never a third-party service.**
  `safeFaviconUrl` keeps only http(s)/`data:image/` icon URLs the browser
  already loaded for that tab, loaded with `no-referrer`; anything else
  gets a letter placeholder. A remote tab gets the icon of its local copy
  when it's also open here, a letter otherwise. A favicon service
  (google.com/s2/favicons and the like) would leak every open tab's
  domain off-device — PRIVACY.md promises nothing leaves the device. In
  the dark theme, favicons sit on a small light chip (defined in
  `newtab.html`, not the shared `theme.css`), since many are drawn for
  light backgrounds and a black one would vanish.
- **Local tabs come in the browser's own tab-strip order** — one
  `entries` list per window, where a tab group is a single entry at the
  position of its first tab, so ungrouped tabs between two groups stay
  between them. See `getLocalData` in `newtab-core.js`.
- **Fold state is the browser's, with an in-memory page override.** A
  group folded in the browser shows folded here; clicking its header on
  the page flips it for this page only, and only until the browser's own
  state for that group changes (then the browser wins again). Nothing is
  persisted. See `foldOverrides`/`isFolded` in `newtab.js`. While
  searching, every group with a match is shown open.
- **Every tab is numbered, for keyboard-only use.** Numbers run over the
  whole unfiltered list in display order (this window, other windows,
  then remote-only tabs — a remote tab also open here reuses the local
  tab's number), so they don't change while typing. A digits-only query
  matches numbers by prefix and selects the exact one for Enter; with no
  such number it falls back to text search. Positional, so they shift as
  tabs open/close/move. See `numberTabs`/`buildQuery` in `newtab.js`.
- **Layout: sticky search bar; two columns on a wide window** (≥1100px,
  media query in `newtab.html`) whenever the other-devices side has
  anything to show — decided on unfiltered data so typing never reflows
  it. The other-devices column is sticky with its own scroll. Since the
  remote half arrives after the local one, the last decision is kept as
  a synchronous `localStorage` hint (`newtabTwoColumns`) so the page
  doesn't jump on open. See `updateLayout` in `newtab.js`.
- **A click switches, then closes the new tab page behind it** — the
  blank tab you came from would otherwise pile up after every jump. See
  `switchTo` in `newtab.js`.
- **Everything is built with `textContent`, never `innerHTML`** — tab
  titles and URLs are arbitrary page-controlled text.
- **No on/off switch** — `chrome_url_overrides` is all-or-nothing per
  installation, and an extension page can't redirect back to the native
  new tab page. See `CLAUDE.md`'s Known limitations.
- **Live refresh, only while visible**: tab/tab-group events re-fetch the
  local half (150 ms debounce); bookmark events — every device heartbeat
  is one — re-fetch the remote half (1 s debounce). A hidden new tab page
  refreshes nothing until it's shown again (`visibilitychange`).
