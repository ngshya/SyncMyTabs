// Lazy-restore placeholder page.
//
// SyncMyTabs opens restored tabs pointing here, with the real target
// encoded in the query string (?u=<url>&t=<title>). Nothing is fetched
// from the network for the real page until this tab first becomes
// visible — i.e. until the user actually opens/switches to it — at
// which point we replace ourselves with the real URL. A click anywhere
// triggers the same thing immediately.
//
// Default behavior: an explicit CLICK is required to load the real
// page — becoming visible (switching to the tab) is NOT enough by
// itself. This exists for pages that autoplay media as soon as they
// load and are visible/focused (a YouTube video, for instance):
// switching to the tab would otherwise silently start playback before
// the user meant to actually open it. Set lazyRequireClick to `false`
// in storage.local to go back to the original "load as soon as the
// tab becomes visible" behavior instead.

(function () {
  const params = new URLSearchParams(location.search);
  const real = params.get("u") || "";
  const title = params.get("t") || real;

  // Only ever navigate to real web pages; ignore anything else so a
  // crafted placeholder URL can't turn into javascript:/data: etc.
  function isHttp(u) {
    return /^https?:\/\//i.test(u);
  }

  if (title) document.title = title;
  const titleEl = document.getElementById("title");
  if (titleEl && title) titleEl.textContent = title;
  const urlEl = document.getElementById("url");
  if (urlEl && real) urlEl.textContent = real;

  let navigated = false;
  function go() {
    if (navigated) return;
    if (!isHttp(real)) return;
    navigated = true;
    // replace() so the placeholder doesn't linger in session history
    location.replace(real);
  }

  if (!isHttp(real)) {
    const hint = document.getElementById("hint");
    if (hint) hint.style.display = "none";
    return;
  }

  // Explicit click always loads the real page immediately, regardless
  // of the preference below.
  document.addEventListener("click", go);

  function loadOnVisible() {
    if (document.visibilityState === "visible") {
      go();
    } else {
      document.addEventListener("visibilitychange", function onVis() {
        if (document.visibilityState === "visible") {
          document.removeEventListener("visibilitychange", onVis);
          go();
        }
      });
    }
  }

  // Default ON (require a click): only an explicit `lazyRequireClick:
  // false` in storage.local restores the old auto-load-on-visible
  // behavior. browser-polyfill.min.js makes `browser` available on
  // Chrome too; on Firefox it's native. Any failure reading storage
  // (or `browser` being unavailable for some reason) falls back to the
  // SAME default — require a click — rather than silently auto-loading.
  try {
    browser.storage.local
      .get("lazyRequireClick")
      .then(({ lazyRequireClick }) => {
        if (lazyRequireClick === false) loadOnVisible();
      })
      .catch(() => {});
  } catch (e) {}
})();
