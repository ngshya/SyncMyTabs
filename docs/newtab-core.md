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
  returns `null` for anything that isn't a `NEWTAB_*` message. Its
  settings card on the options page is built by `newtab-options.js`,
  which `options.html` loads (with `newtab-settings.js`) — `options.js`
  knows nothing about it. `test/newtab-isolation.test.js` enforces all
  three. Removing the feature comes down to deleting every `newtab*`
  file (and their tests) plus the wiring lines: `importScripts`, the
  engine `const`, that listener, the manifest's override,
  `background.scripts` entry and `search` permission, `options.html`'s
  two script tags, `release.yml`'s file list and syntax checks.
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
- **Layout: sticky, width-capped search bar; tabs in two columns on a
  wide window** (≥1000px, media query in `newtab.html`), filled in
  reading order — a tab on the left, the next on its right — so numbers
  still read in sequence. Section titles and group headers span the full
  width; a group's tabs are marked by a thin bar in its colour rather
  than an indent, so every grid's columns line up. Up/Down move by row
  (`rowNeighbour` in `newtab.js`), Left/Right through reading order.
- **Which sections show is a setting** — `newtabSections` in
  `storage.local` (`thisWindow`/`otherWindows`/`otherDevices`, all on by
  default), set from the options page's "New tab page" card
  (`newtab-options.js`, which keeps its own copy of the key and
  defaults). Applied live through `storage.onChanged`. Hidden sections
  get no numbers, and with "other devices" off the remote half isn't
  even requested, so nothing walks the bookmark tree for it.
- **Settings live in one place: `newtab-settings.js`** — the storage key
  (`newtabSections`, a historical name), every default and the options
  card's labels, as the global `NewtabSettings` (`load`/`save`/`onChange`/
  `merge`). Loaded by `newtab.html` and `options.html`; every other file
  reads settings through it, none keeps its own copy. A new setting is one
  line in its `OPTIONS` plus the code that uses it.
- **Web search from the same box** (`newtab-search.js` + the "web search"
  section of `newtab.js`). Enter still opens the selected tab; with no tab
  matching — or with Shift+Enter — the web row runs: an address is opened
  as such (`urlFromInput`), anything else goes to the browser's own
  default engine through the `search` permission's `search.query` (never
  a hardcoded engine; Google only as a fallback without that API, and
  called straight from the key/click handler — Firefox only allows it in
  a user action). Another service is picked with a one-letter prefix
  ("y lofi" → a YouTube chip; Backspace at the start drops it, giving a
  typed prefix's letter back) or Tab/Shift+Tab, which cycle the services
  and back to tab search; the services are also links under the web row.
  No search suggestions, on purpose: they'd send every keystroke to a
  search company — the query leaves the device only on Enter/click.
- **Search-box focus (`focusSearch`, on by default).** A browser opens a
  new tab with the cursor in its address bar, and no page can take it
  from there; the page reloads itself under its own address
  (`newtab.html?focus` — the marker stops a loop), which does put the
  cursor in the page. Costs: the address bar shows that address, and Back
  goes to the plain new tab page (which comes straight back). Hence a
  setting.
- **Clock** — bold; seconds by default (`clockSeconds`).
- **Optional Matrix rain** (`matrixRain`, off by default,
  `newtab-matrix.js`): a canvas behind everything (z-index -1, 16%
  opacity), drawn only while the page background is actually dark (read
  from the computed colour, so it follows theme.css without knowing its
  rules), never with `prefers-reduced-motion`, ~20 fps and nothing while
  hidden. The search and bookmarks bars are frosted (semi-opaque + blur)
  rather than solid, so the rain isn't cut by hard bands.
- **Optional bookmarks bar** (`newtabSections.bookmarksBar`, off by
  default): a copy of the browser's own bar along the top — centred, and
  at 45% opacity until hovered/focused or a menu is open — in
  `newtab-bookmarks.js` — a file of its own with its own data
  (`NEWTAB_BOOKMARKS` → `getBookmarksBar` in `newtab-core.js`) and
  listeners, sharing only the `--bm-h` CSS variable (its height, so the
  sticky search bar sits right below it). The bar folder is found by
  `folderType: "bookmarks-bar"` or the known per-browser ids, never one
  hardcoded id (`findBookmarksBarId`). Read-only. Bookmarklets are left
  out (an extension page can't run them); icons follow the favicon rule
  above (an open tab's own icon for that page or site, else a letter).
  It only re-renders when the bar's data actually changed — bookmark
  events fire constantly (sync heartbeats), and a redraw would close an
  open menu. Keys it handles stop at the bar, so `newtab.js`'s page-wide
  keyboard handling never sees them.
- **Date and time follow the browser's UI language** —
  `i18n.getUILanguage()`, not the page's default locale, falling back to
  the default only if Intl rejects the tag. The page's own labels stay
  English, like the rest of the extension's UI.
- **This device's tabs can be closed from the list** — a ✕ at the end
  of the row, shown on hover or keyboard focus, or Delete on the focused
  row (`closeTab` in `newtab.js`). Each row is two sibling buttons (the
  tab and its ✕), since HTML doesn't allow one inside the other. Other
  devices' tabs get none: closing one there would mean writing to the
  bookmark tree from the page, which only the background engine does. A
  close here is an ordinary `tabs.remove`, so sync treats it like any
  other close.
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
