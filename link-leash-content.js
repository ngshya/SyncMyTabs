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
// Deliberately does NOT intercept every click on every page, unlike a
// naive port — it first asks the background page (GROUP_LEASH_INFO)
// whether THIS tab is currently inside a browser tab group at all, and
// only attaches its click/auxclick listeners if so. This keeps the
// vast majority of ordinary browsing (any non-grouped tab) completely
// unaffected. The trade-off: a tab grouped AFTER its page already
// loaded won't get leashing until reloaded (see CLAUDE.md).
//
// It ALSO caches the resolved leash pattern from that same handshake
// and re-checks it SYNCHRONOUSLY on every click, instead of an async
// round-trip per click. This matters for more than performance: a
// PLAIN click on a link that already matches the pattern is left
// COMPLETELY UNTOUCHED — no preventDefault, no message sent — letting
// the browser's native click handling run. That's the one case where
// no intervention is correct AND necessary: routing it through
// background.js's tabs.update() instead (a hard, address-bar-equivalent
// navigation) breaks any client-side-routed app (Telegram Web and
// similar SPAs using pushState/hash routing for in-app navigation) —
// their own JS router expects a lightweight same-document transition,
// not a full reload, and a forced reload can bounce the app back to
// its default view instead of landing on the clicked destination. Only
// the cases that genuinely need intervention — a NON-matching link
// (must open a fresh ungrouped tab instead) or a MODIFIER click on a
// matching link (must open alongside, in the same group) — are
// intercepted at all.
//
// Since this is a content script, not the background page, it carries
// its own tiny copy of the glob/regex pattern matcher (matchesPattern/
// globToRegExp) rather than loading the whole of groups-core.js here —
// keep the two in sync if you touch the matching semantics.
// ============================================================
(function () {
  function globToRegExp(glob) {
    const escaped = glob.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*");
    return new RegExp("^" + escaped + "$");
  }

  function matchesPattern(url, pattern) {
    if (!pattern) return false;
    try {
      if (pattern.startsWith("regex:")) {
        return new RegExp(pattern.slice(6)).test(url);
      }
      return globToRegExp(pattern).test(url);
    } catch (e) {
      return false;
    }
  }

  // Cached from the last GROUP_LEASH_INFO handshake — read synchronously
  // by every click, refreshed on load and on every SPA-style URL change.
  let leashInfo = { grouped: false, pattern: null };
  let listenersAttached = false;

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

  function onClick(e) {
    if (e.button !== 0) return;
    const anchor = findAnchor(e.target);
    if (shouldIgnore(anchor)) return;

    const modifiers = {
      newTab: e.ctrlKey || e.metaKey || e.shiftKey || anchor.target === "_blank",
      background: e.ctrlKey || e.metaKey,
    };

    // The one case that must be left COMPLETELY alone: a plain click on
    // a link that already matches the leash pattern. Native behavior
    // (same-tab navigation) is exactly what's wanted, and letting the
    // page's own router handle it — instead of a forced hard reload via
    // tabs.update() — is what keeps client-side-routed apps working.
    if (!modifiers.newTab && leashInfo.grouped && matchesPattern(anchor.href, leashInfo.pattern)) {
      return;
    }

    e.preventDefault();
    e.stopPropagation();
    sendClick(anchor, modifiers);
  }

  function onAuxClick(e) {
    if (e.button !== 1) return;
    const anchor = findAnchor(e.target);
    if (shouldIgnore(anchor)) return;
    e.preventDefault();
    e.stopPropagation();
    sendClick(anchor, { newTab: true, background: true });
  }

  function attachListenersOnce() {
    if (listenersAttached) return;
    listenersAttached = true;
    document.addEventListener("click", onClick, true);
    document.addEventListener("auxclick", onAuxClick, true);
  }

  function refreshLeashInfo() {
    browser.runtime
      .sendMessage({ type: "GROUP_LEASH_INFO" })
      .then((res) => {
        leashInfo = res && res.grouped ? res : { grouped: false, pattern: null };
        if (leashInfo.grouped) attachListenersOnce();
      })
      .catch(() => {});
  }

  // Re-check on every SPA-style URL change (hash change, or a
  // pushState/replaceState-driven route change — most client-side
  // routers use one of these) so the cached pattern never goes stale
  // for a tab that stays grouped across many in-app navigations. The
  // content script itself is never torn down/reinjected by these (only
  // a real, full navigation does that), so this is the only way it
  // learns a client-side route actually changed.
  window.addEventListener("hashchange", refreshLeashInfo);
  window.addEventListener("popstate", refreshLeashInfo);
  for (const fn of ["pushState", "replaceState"]) {
    const original = history[fn];
    history[fn] = function (...args) {
      const result = original.apply(this, args);
      refreshLeashInfo();
      return result;
    };
  }

  refreshLeashInfo();
})();
