// ============================================================
// SyncMyTabs - newtab-bookmarks.js
//
// The new tab page's optional copy of the browser's bookmarks bar, so the
// browser's own bar can stay hidden: a single line at the very top of
// newtab.html (sticky, above the search bar), with the bar's bookmarks
// and folders in the browser's own order. A folder opens a menu, nested
// folders open further menus to the side, and whatever doesn't fit on
// the line goes into a "»" menu at its end — the same shape as the
// browser's bar.
//
// Off by default; turned on from the options page's "New tab page" card
// (newtab-options.js) — `bookmarksBar` in newtab-settings.js. Applied
// live.
//
// Independent of newtab.js: its own file, its own data (background.js's
// NEWTAB_BOOKMARKS message → newtab-core.js's getBookmarksBar, read-only),
// its own listeners. The only thing it shares with the rest of the page is
// the --bm-h CSS variable (its height), which newtab.html uses to park the
// sticky search bar right below it. Keys it handles inside the bar and its
// menus stop there, so newtab.js's page-wide keyboard handling (type to
// search, arrows through the tab list) never sees them.
//
// Opening a bookmark behaves like the browser's bar: a click opens it in
// this tab; Ctrl/Cmd-click or a middle click in a new background tab
// (Ctrl+Shift: in the foreground); Shift-click in a new window.
//
// DOM built with createElement/textContent only, like newtab.js —
// bookmark titles are arbitrary text.
// ============================================================

(function () {
  const barEl = document.getElementById("bookmarksBar");
  const itemsEl = barEl.querySelector(".bm-items");
  const menusEl = document.getElementById("bookmarkMenus");

  let enabled = false;
  let bar = null; // { id, children } from newtab-core.js, or null
  let lastJson = "";
  let selfTabId = null;
  const menus = []; // open menus, outermost first: { el, anchor }

  const { el, iconFor } = NewtabDom;

  function folderIcon() {
    const NS = "http://www.w3.org/2000/svg";
    const svg = document.createElementNS(NS, "svg");
    svg.setAttribute("viewBox", "0 0 16 16");
    svg.setAttribute("class", "bm-folder-icon");
    svg.setAttribute("aria-hidden", "true");
    const path = document.createElementNS(NS, "path");
    path.setAttribute(
      "d",
      "M2 4.5A1.5 1.5 0 0 1 3.5 3h2.8l1.4 1.5h4.8A1.5 1.5 0 0 1 14 6v5.5a1.5 1.5 0 0 1-1.5 1.5h-9A1.5 1.5 0 0 1 2 11.5z"
    );
    svg.append(path);
    return svg;
  }

  // ---- opening a bookmark ----

  async function openBookmark(url, e) {
    closeMenus();
    const newTab = e.button === 1 || e.ctrlKey || e.metaKey;
    try {
      if (e.shiftKey && !newTab) await browser.windows.create({ url });
      else if (newTab) await browser.tabs.create({ url, active: !!e.shiftKey });
      else if (selfTabId !== null) await browser.tabs.update(selfTabId, { url });
      else location.href = url;
    } catch (err) {}
  }

  // A real <a href> (so hovering shows the address like any link), with
  // every way of opening it routed through openBookmark — chrome:// and
  // similar addresses can't be navigated to by a page's own link.
  function bookmarkLink(node, className) {
    const a = el("a", className);
    a.href = node.url;
    a.title = node.title ? `${node.title}\n${node.url}` : node.url;
    a.dataset.bmId = node.id;
    a.append(iconFor(node));
    if (node.title) a.append(el("span", "bm-title", node.title));
    a.addEventListener("click", (e) => {
      e.preventDefault();
      openBookmark(node.url, e);
    });
    a.addEventListener("auxclick", (e) => {
      if (e.button !== 1) return;
      e.preventDefault();
      openBookmark(node.url, e);
    });
    return a;
  }

  // ---- menus ----

  function closeMenus(fromLevel = 0) {
    while (menus.length > fromLevel) {
      const { el: menu, anchor } = menus.pop();
      menu.remove();
      anchor.classList.remove("open");
      anchor.setAttribute("aria-expanded", "false");
    }
    barEl.classList.toggle("menu-open", menus.length > 0);
  }

  // Opens `nodes` as a menu at depth `level` (0 = dropped from the bar,
  // deeper = to the side of the folder entry that opened it), replacing
  // whatever was open at that depth or deeper.
  function openMenu(nodes, anchor, level, focusFirst) {
    closeMenus(level);
    const menu = el("div", "bm-menu");
    menu.setAttribute("role", "menu");
    menu.dataset.level = String(level);

    let previousWasEntry = false;
    for (const node of nodes) {
      if (node.kind === "separator") {
        if (previousWasEntry) menu.append(el("div", "bm-menu-gap"));
        previousWasEntry = false;
        continue;
      }
      previousWasEntry = true;
      if (node.kind === "bookmark") {
        const a = bookmarkLink(node, "bm-entry");
        a.setAttribute("role", "menuitem");
        if (!node.title) a.append(el("span", "bm-title", node.url));
        a.addEventListener("mouseenter", () => hoverIntent(() => closeMenus(level + 1)));
        menu.append(a);
      } else {
        const btn = el("button", "bm-entry bm-folder");
        btn.type = "button";
        btn.setAttribute("role", "menuitem");
        btn.setAttribute("aria-haspopup", "menu");
        btn.setAttribute("aria-expanded", "false");
        btn.append(folderIcon(), el("span", "bm-title", node.title || "Folder"), el("span", "bm-arrow", "▸"));
        btn.addEventListener("click", () => openMenu(node.children, btn, level + 1, false));
        btn.addEventListener("mouseenter", () => hoverIntent(() => openMenu(node.children, btn, level + 1, false)));
        menu.append(btn);
      }
    }
    if (!menu.querySelector(".bm-entry")) menu.append(el("div", "bm-empty", "(empty)"));

    menusEl.append(menu);
    menus.push({ el: menu, anchor });
    barEl.classList.add("menu-open"); // stays fully opaque while a menu is open
    anchor.classList.add("open");
    anchor.setAttribute("aria-expanded", "true");
    placeMenu(menu, anchor, level);
    if (focusFirst) {
      const first = menu.querySelector(".bm-entry");
      if (first) first.focus();
    }
  }

  // Below the bar item for the first level, to the right of the folder
  // entry for deeper ones — flipped to the left (or clamped) when it
  // would run off the window.
  function placeMenu(menu, anchor, level) {
    const r = anchor.getBoundingClientRect();
    const w = menu.offsetWidth;
    const h = menu.offsetHeight;
    const margin = 8;
    let left;
    let top;
    if (level === 0) {
      left = Math.min(r.left, innerWidth - w - margin);
      top = r.bottom + 4;
    } else {
      left = r.right + w + margin <= innerWidth ? r.right - 2 : r.left - w + 2;
      top = r.top - 5;
    }
    menu.style.left = `${Math.max(margin, left)}px`;
    menu.style.top = `${Math.max(margin, Math.min(top, innerHeight - h - margin))}px`;
  }

  // Nested menus open/close on hover after a short pause, so sweeping the
  // pointer diagonally towards a submenu doesn't snap it shut on the way.
  let hoverTimer = null;
  function hoverIntent(fn) {
    clearTimeout(hoverTimer);
    hoverTimer = setTimeout(fn, 180);
  }

  // ---- the bar ----

  function topItem(node) {
    if (node.kind === "separator") return el("span", "bm-sep");
    if (node.kind === "bookmark") return bookmarkLink(node, "bm-item");
    const btn = el("button", "bm-item bm-folder");
    btn.type = "button";
    btn.title = node.title;
    btn.setAttribute("aria-haspopup", "menu");
    btn.setAttribute("aria-expanded", "false");
    btn.append(folderIcon(), el("span", "bm-title", node.title || "Folder"));
    btn.addEventListener("click", () => {
      if (menus.length && menus[0].anchor === btn) closeMenus();
      else openMenu(node.children, btn, 0, false);
    });
    // With a menu already open, moving across the bar switches to the
    // folder under the pointer, like a menu bar.
    btn.addEventListener("mouseenter", () => {
      if (menus.length && menus[0].anchor !== btn) openMenu(node.children, btn, 0, false);
    });
    btn._bmChildren = node.children;
    return btn;
  }

  function render() {
    closeMenus();
    itemsEl.replaceChildren();
    const nodes = (bar && bar.children) || [];
    setVisible(enabled && nodes.length > 0);
    if (!enabled || nodes.length === 0) return;

    const items = nodes.map((node) => {
      const item = topItem(node);
      item._bmNode = node;
      return item;
    });
    const more = el("button", "bm-item bm-more", "»");
    more.type = "button";
    more.title = "More bookmarks";
    more.setAttribute("aria-haspopup", "menu");
    more.addEventListener("click", () => {
      if (menus.length && menus[0].anchor === more) closeMenus();
      else openMenu(more._bmNodes || [], more, 0, false);
    });
    itemsEl.append(...items, more);
    layoutOverflow();
    setVisible(true); // again, now that it has content to measure
  }

  // Whatever doesn't fit on the line is hidden from the bar and listed in
  // the "»" menu instead, in the same order.
  // Measured left-aligned (the "measuring" class): the bar is centred, and
  // a centred line that's too long would spill off BOTH ends, which a
  // left-to-right fit check can't see.
  function layoutOverflow() {
    itemsEl.classList.add("measuring");
    try {
      fitItems();
    } finally {
      itemsEl.classList.remove("measuring");
    }
  }

  function fitItems() {
    const children = Array.from(itemsEl.children);
    const more = children.pop();
    for (const c of children) c.hidden = false;
    more.hidden = true;
    if (children.length === 0) return;
    const fits = (c, limit) => c.offsetLeft + c.offsetWidth <= limit;
    if (children.every((c) => fits(c, itemsEl.clientWidth))) return;

    more.hidden = false;
    const limit = itemsEl.clientWidth - more.offsetWidth - 4;
    const overflow = [];
    for (const c of children) {
      if (overflow.length || !fits(c, limit)) {
        c.hidden = true;
        overflow.push(c._bmNode);
      }
    }
    more._bmNodes = overflow;
  }

  function setVisible(on) {
    barEl.hidden = !on;
    document.documentElement.style.setProperty("--bm-h", on ? `${barEl.offsetHeight}px` : "0px");
  }

  // ---- keyboard ----

  function barItems() {
    return Array.from(itemsEl.children).filter((c) => !c.hidden && !c.classList.contains("bm-sep"));
  }

  function menuEntries(menu) {
    return Array.from(menu.querySelectorAll(".bm-entry"));
  }

  function openFromBar(item) {
    if (item.classList.contains("bm-more")) openMenu(item._bmNodes || [], item, 0, true);
    else if (item._bmChildren) openMenu(item._bmChildren, item, 0, true);
  }

  // Left/Right along the bar, Down (or Enter) into a folder; inside a menu
  // Up/Down move, Right opens a subfolder, Left/Esc go back out. Handled
  // keys stop here so newtab.js's own page-wide keys never see them.
  function onKeydown(e) {
    const target = document.activeElement;
    const inBar = itemsEl.contains(target);
    const menuEl = target && target.closest && target.closest(".bm-menu");
    let handled = true;

    if (inBar) {
      const items = barItems();
      const i = items.indexOf(target);
      if (e.key === "ArrowRight" || e.key === "ArrowLeft") {
        const next = items[(i + (e.key === "ArrowRight" ? 1 : -1) + items.length) % items.length];
        closeMenus();
        if (next) next.focus();
      } else if (e.key === "ArrowDown" && (target._bmChildren || target.classList.contains("bm-more"))) {
        openFromBar(target);
      } else if ((e.key === "Enter" || e.key === " ") && target.tagName === "BUTTON") {
        openFromBar(target);
      } else if (e.key === "Escape" && menus.length) {
        closeMenus();
      } else handled = false; // Esc with nothing open: newtab.js takes it back to the search box
    } else if (menuEl) {
      const level = Number(menuEl.dataset.level);
      const entries = menuEntries(menuEl);
      const i = entries.indexOf(target);
      if (e.key === "ArrowDown" || e.key === "ArrowUp") {
        const next = entries[(i + (e.key === "ArrowDown" ? 1 : -1) + entries.length) % entries.length];
        if (next) next.focus();
      } else if ((e.key === "ArrowRight" || e.key === "Enter" || e.key === " ") && target.classList.contains("bm-folder")) {
        target.click();
        const sub = menus[level + 1];
        const first = sub && sub.el.querySelector(".bm-entry");
        if (first) first.focus();
      } else if (e.key === "ArrowLeft" && level > 0) {
        const anchor = menus[level].anchor;
        closeMenus(level);
        anchor.focus();
      } else if (e.key === "ArrowLeft" || e.key === "ArrowRight") {
        // Top-level menu: on to the neighbouring bar item.
        const items = barItems();
        const i0 = items.indexOf(menus[0].anchor);
        const next = items[(i0 + (e.key === "ArrowRight" ? 1 : -1) + items.length) % items.length];
        closeMenus();
        if (next) {
          next.focus();
          if (next._bmChildren || next.classList.contains("bm-more")) openFromBar(next);
        }
      } else if (e.key === "Escape") {
        const anchor = menus[level].anchor;
        closeMenus(level);
        anchor.focus();
      } else if (e.key === "Tab") {
        closeMenus();
        handled = false;
      } else handled = false;
    } else handled = false;

    if (handled) {
      e.preventDefault();
      e.stopPropagation();
    }
  }
  barEl.addEventListener("keydown", onKeydown);
  menusEl.addEventListener("keydown", onKeydown);

  // A press anywhere outside the bar and its menus closes them.
  document.addEventListener("mousedown", (e) => {
    if (!menus.length) return;
    if (barEl.contains(e.target) || menusEl.contains(e.target)) return;
    closeMenus();
  });
  window.addEventListener("blur", () => closeMenus());
  window.addEventListener("resize", () => {
    closeMenus();
    if (enabled && bar) {
      layoutOverflow();
      setVisible(!barEl.hidden);
    }
  });

  // ---- data + live refresh ----

  async function loadSetting() {
    enabled = !!(await NewtabSettings.load()).bookmarksBar;
  }

  // Re-renders only when something actually changed: bookmark events fire
  // all the time (every device's sync heartbeat is one), and redrawing the
  // bar for nothing would also close a menu someone is in the middle of.
  async function load() {
    if (!enabled) {
      bar = null;
      lastJson = "";
      render();
      return;
    }
    let reply = null;
    try {
      reply = await browser.runtime.sendMessage({ type: "NEWTAB_BOOKMARKS" });
    } catch (e) {}
    const next = (reply && reply.bar) || null;
    const json = JSON.stringify(next);
    if (json === lastJson) return;
    lastJson = json;
    bar = next;
    render();
  }

  let timer = null;
  function scheduleLoad() {
    clearTimeout(timer);
    timer = setTimeout(() => !document.hidden && enabled && load(), 400);
  }

  for (const ev of ["onCreated", "onChanged", "onRemoved", "onMoved", "onChildrenReordered"]) {
    if (browser.bookmarks[ev]) browser.bookmarks[ev].addListener(scheduleLoad);
  }
  browser.tabs.onUpdated.addListener((tabId, changeInfo) => {
    if (changeInfo.favIconUrl) scheduleLoad(); // icons come from open tabs
  });
  NewtabSettings.onChange((settings) => {
    enabled = !!settings.bookmarksBar;
    load();
  });
  document.addEventListener("visibilitychange", () => {
    if (!document.hidden && enabled) load();
  });

  (async () => {
    try {
      const tab = await browser.tabs.getCurrent();
      if (tab) selfTabId = tab.id;
    } catch (e) {}
    await loadSetting();
    load();
  })();
})();
