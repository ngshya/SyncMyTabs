# Custom new tab page (`newtab-core.js` + `newtab.html`/`newtab.js`)

> Split out of `CLAUDE.md` to keep the base file small — read this when
> you're actually working on the new tab page. Same 1-invariant-1-place
> documentation convention as `CLAUDE.md`'s Architecture section: summary
> + pointer here, full detail in the code.

Replaces the browser's new tab page (`chrome_url_overrides.newtab` in
`manifest.json` — supported on Chrome/Brave and Firefox): a clock and
date, a search box, this device's open tabs grouped by window and browser
tab group, and the tabs open on the user's other devices on the same
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
  "other devices" section in afterwards. See `newtab-core.js`'s header
  and the comment on the two message handlers in `background.js`.
- **New tab pages are recognized by `syncEngine.isNewTabPage(tab)`** (pure
  helper `isNewTabPageUrl` in `sync-core.js`): a tab on the new tab page
  can report either the native URL (`chrome://newtab/` — what Chrome
  keeps for an overridden one) or the extension page's own URL
  (Firefox) — both match. Used in three places: the page leaves new tab
  pages out of its own list, `order-core.js` sorts them last instead of
  by recency, and (via the broader http(s)-only rule)
  `archive-core.js` never archives one. See `isNewTabPageUrl`'s comment.
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
  already loaded for that tab, loaded with `no-referrer`; anything else,
  and every remote tab, gets a letter placeholder. A favicon service
  (google.com/s2/favicons and the like) would leak every open tab's
  domain off-device — PRIVACY.md promises nothing leaves the device.
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
