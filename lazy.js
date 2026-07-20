// Lazy-restore placeholder page.
//
// SyncMyTabs opens restored tabs pointing here, with the real target
// encoded in the query string (?u=<url>&t=<title>). Nothing is fetched
// from the network for the real page until this tab first becomes
// visible — i.e. until the user actually opens/switches to it — at
// which point we replace ourselves with the real URL. A click anywhere
// triggers the same thing immediately.

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

  // Load as soon as the tab is shown; if it's already visible (e.g. it
  // was opened as the active tab), load right away.
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

  // Explicit click is a fallback for any environment where the
  // visibility event doesn't fire as expected.
  document.addEventListener("click", go);
})();
