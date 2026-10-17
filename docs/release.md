# Packaging & release

> Moved out of `CLAUDE.md` to keep every session's base context small.
> Read it when you're touching the release, the file list, or the manifest.

There is **no build step for development** — the repository *is* the
unpacked extension (the polyfill is vendored, not built; `package.json`
exists only for dev scripts, no runtime dependencies).

**What ships is decided in one place: `scripts/build.js`** — its `FILES`
list, plus a per-store manifest (Chrome: `background.service_worker` only,
no gecko settings; Firefox: `background.scripts` only).
`npm run build` → `build/chrome`, `build/firefox`.

**A file missing from `FILES` ships a broken extension that "Load
unpacked" on the repo folder never shows** (the repo always has every
file). It happened once: a missing `archive-core.js` made `importScripts`
throw, so *no* background listener registered (sync and groups included);
a missing `options.html` broke "Open full settings"; a missing `theme.css`
left every CSS variable undefined. `test/release-files.test.js` now fails
if any top-level `.js`/`.html`/`.css` file, any file the manifest
references, any script/stylesheet a packaged page loads, or any
`importScripts` entry isn't in `FILES`. The browser tests
(`npm run test:browser`) load the *built* Chrome folder for the same
reason.

**The release workflow** (`.github/workflows/release.yml`) fires on every
push to `main` (every PR merge): if `manifest.json`'s `version` isn't
released yet, it runs `npm run check` (syntax) and the Node test suite,
`node scripts/build.js build`, zips both folders, runs `web-ext lint` on
the Firefox one (informational), and publishes a GitHub Release with both
zips. A merge that doesn't bump the version is skipped, not failed. It can
also be triggered by pushing a matching `v*` tag, or manually from the
Actions tab — both fail loudly if that version was already released.

**Releasing = bump `version` in `manifest.json`, merge the PR.** Then
check the run finished and the release has both zips; download the Chrome
zip and run a browser test file against it if in doubt.

Store-listing docs: `PRIVACY.md`, `PERMISSIONS.md` (one justification per
permission — add one for any new permission), `STORE_LISTING.md`; listing
screenshots in `store-assets/`.
