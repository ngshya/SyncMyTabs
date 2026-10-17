// ============================================================
// SyncMyTabs - newtab-dom.js
//
// Small DOM helpers shared by the new tab page's scripts (newtab.js,
// newtab-bookmarks.js, newtab-clock.js), so each doesn't keep its own
// copy. Exposes a single global, `NewtabDom`. Everything is built with
// createElement/textContent, never innerHTML: tab and bookmark titles are
// arbitrary page-controlled text.
// ============================================================

const NewtabDom = (function () {
  function el(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  }

  function hostOf(url) {
    try {
      const u = new URL(url);
      return u.host || u.protocol.replace(":", "");
    } catch (e) {
      return "";
    }
  }

  // A one-letter placeholder icon: the site's first letter, else the title's.
  function letterIcon(entry) {
    const label = hostOf(entry.url).replace(/^www\./, "") || entry.title || "?";
    return el("span", "icon", label.charAt(0).toUpperCase());
  }

  // `favIconUrl` is only ever set by newtab-core.js to an icon the browser
  // already loaded for an open tab (never a third-party favicon service —
  // see safeFaviconUrl there). no-referrer so even that one request
  // doesn't announce which extension page asked for it.
  function iconFor(entry) {
    if (!entry.favIconUrl) return letterIcon(entry);
    const img = el("img", "icon");
    img.alt = "";
    img.referrerPolicy = "no-referrer";
    img.src = entry.favIconUrl;
    img.addEventListener("error", () => img.replaceWith(letterIcon(entry)));
    return img;
  }

  // The browser's own display language, not whatever the page happens to
  // default to: i18n.getUILanguage() is exactly that on both Chrome and
  // Firefox. undefined (= Intl's default) if it's somehow not a tag Intl
  // accepts.
  function uiLocale() {
    try {
      const lang = browser.i18n.getUILanguage();
      Intl.DateTimeFormat.supportedLocalesOf([lang]); // throws on a malformed tag
      return lang;
    } catch (e) {
      return undefined;
    }
  }

  return { el, hostOf, letterIcon, iconFor, uiLocale };
})();
