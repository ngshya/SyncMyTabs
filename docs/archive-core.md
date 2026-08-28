# Auto-archive idle tabs (`archive-core.js`)

> Split out of `CLAUDE.md` to keep the base file small — read this when
> you're actually working on `archive-core.js`. Same 1-invariant-1-place
> documentation convention as `CLAUDE.md`'s Architecture section: summary
> + pointer here, full detail in the code (this module's header comment
> and per-function comments already carry most of it near-verbatim).

A third independent module: tracks the last time each of this device's own
tabs was actually looked at, and — opt-in, off by default since it's
destructive — once a tab has gone unlooked-at for longer than a
configurable threshold (default 3 days), saves it as a plain bookmark and
closes it. Pinned tabs and tabs inside a browser tab group are never
candidates, same exclusion `sync-core.js` applies everywhere else.

- **The idle threshold is three independent fields — `archiveIdleDays`/
  `archiveIdleHours`/`archiveIdleMinutes` — not one combined total**, so
  the options page can be three plain number inputs with no lossy
  round-tripping. `MIN_ARCHIVE_IDLE_MS` (1 minute) is an absolute floor.
  Full field semantics (`??` vs `||`, why): see the comments above
  `MIN_ARCHIVE_IDLE_MS` and `archiveIdleThreshold` in `archive-core.js`.
- **Bookmark tree shape**:
  ```
  SyncMyTabs/<profile>/_archive/<year>/<month>/<day>/<one plain bookmark per archived tab>
  ```
  SIBLING to the per-URL folders and `_groups`, invisible to
  `readProfileEntries`. An archived entry is a PLAIN bookmark (title/url),
  browsable through the ordinary bookmark manager — nothing here is ever
  parsed back out by the extension. Full nesting rationale (local calendar
  date via `Date.now()`, zero-padding): see the comment above `archiveTab`
  in `archive-core.js`.
- **`clearArchiveForActiveProfile` empties the archive outright** — safe
  to call anytime, including with nothing archived yet. Wired to the
  options page's "Clear archived tabs" button, the ONE place in this
  codebase's UI with a `confirm()` dialog (permanently deletes saved
  history, not just config). See the comment above
  `clearArchiveForActiveProfile` in `archive-core.js` and the handler in
  `options.js`.
- **Activity is tracked broadly, acted on narrowly** — every tab's
  last-active time is recorded regardless of pinned/grouped state, but
  only eligible tabs are ever archive candidates, so an unpinned/
  ungrouped tab keeps its real history instead of looking artificially
  stale. See the module header comment in `archive-core.js`.
- **Persisted in `storage.local`, not just an in-memory `Map`** — a
  suspended/restarted service worker would otherwise silently lose all
  history. `handleStartupSeed` reseeds everything to "now" on a genuine
  browser restart (tab ids aren't stable across one). See the comment
  above the "activity tracking" section in `archive-core.js`.
- **A tab with no recorded activity is seeded to "now", never treated as
  already stale** — safe for both a fresh launch and the first time the
  feature is ever enabled; no mass-archiving stampede. See the comment
  above `seedAndPruneActivity` in `archive-core.js`.
- **Tracking runs unconditionally; only the destructive action is gated
  on `archiveEnabled`.** See the module header comment in
  `archive-core.js`.
- **A tab is never closed unless its bookmark was saved first** —
  `archiveTab` returns `false` on any write failure and `reconcileArchive`
  skips the close in that case.
- **Closing an archived tab goes through the ordinary `env.tabs.remove()`**
  — fires a real `tabs.onRemoved`, so an archived tab that was ALSO a
  `sync-core.js`-tracked open URL naturally flips to "closed" there too,
  via the existing contagious-close mechanism. No special-casing needed.
  See the module header comment in `archive-core.js`.
- **No separate "archive check interval" setting** — `reconcileArchive`
  piggybacks on the SAME periodic alarm as the main tab-sync check. See
  the `saveTabsAlarm` handler in `background.js`.
- **`windows.onFocusChanged` looks up the newly-focused window's own
  active tab** and records activity for it — covers the "window regains
  OS focus without a new `tabs.onActivated`" case. See the comment above
  `handleWindowFocusChanged` in `archive-core.js`.
