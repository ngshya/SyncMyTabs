// ============================================================
// SyncMyTabs - link-leash-content.js
//
// Content script for the tab-group "leashing" module (see
// groups-core.js / CLAUDE.md). Intercepts left/middle clicks on links
// and hands them to background.js's LINK_CLICK handler
// (groupsEngine.handleLinkClick), which decides whether to navigate in
// place, open alongside in the same group, or open a fresh ungrouped
// tab.
//
// Deliberately does NOT attach its click listeners on every page: it
// first asks the background page (AM_I_GROUPED) whether THIS tab is
// currently inside a browser tab group at all, and only intercepts
// clicks if so. This keeps the vast majority of ordinary browsing (any
// non-grouped tab — the common case) completely unaffected by this
// module, rather than capturing/preventDefault-ing every click on every
// page just to fall back to default behavior on the server side. The
// trade-off: a tab grouped AFTER this page already loaded won't get
// leashing until it's reloaded — an accepted, documented limitation
// (see CLAUDE.md).
// ============================================================
(function () {
  function findAnchor(el) {
    while (el && el !== document) {
      if (el.tagName === "A" && el.hasAttribute("href")) return el;
      el = el.parentElement;
    }
    return null;
  }

  function shouldIgnore(anchor) {
    if (!anchor) return true;
    const href = anchor.getAttribute("href");
    if (!href) return true;
    if (href.startsWith("javascript:") || href.startsWith("mailto:") || href.startsWith("tel:")) {
      return true;
    }
    if (anchor.hasAttribute("download")) return true;
    return false;
  }

  function sendClick(anchor, modifiers) {
    browser.runtime.sendMessage({ type: "LINK_CLICK", href: anchor.href, modifiers });
  }

  function attachListeners() {
    // Left click
    document.addEventListener(
      "click",
      function (e) {
        if (e.button !== 0) return;
        const anchor = findAnchor(e.target);
        if (shouldIgnore(anchor)) return;
        e.preventDefault();
        e.stopPropagation();
        sendClick(anchor, {
          newTab: e.ctrlKey || e.metaKey || e.shiftKey || anchor.target === "_blank",
          background: e.ctrlKey || e.metaKey,
        });
      },
      true
    );

    // Middle click (wheel)
    document.addEventListener(
      "auxclick",
      function (e) {
        if (e.button !== 1) return;
        const anchor = findAnchor(e.target);
        if (shouldIgnore(anchor)) return;
        e.preventDefault();
        e.stopPropagation();
        sendClick(anchor, { newTab: true, background: true });
      },
      true
    );
  }

  browser.runtime
    .sendMessage({ type: "AM_I_GROUPED" })
    .then((res) => {
      if (res && res.grouped) attachListeners();
    })
    .catch(() => {});
})();
