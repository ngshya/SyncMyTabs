// ============================================================
// SyncMyTabs - newtab.js
//
// DOM layer of the custom new tab page (newtab.html, wired via
// manifest.json's chrome_url_overrides.newtab): a clock, a search box,
// this device's open tabs by window in the browser's own tab-strip order
// (tab groups where they sit, folded when they're folded in the
// browser), and the tabs open on the user's other devices. All the data
// assembly lives in newtab-core.js (served by background.js's
// NEWTAB_LOCAL/NEWTAB_REMOTE messages, see its header comment for why it
// isn't done here); this file only renders it and reacts to clicks/keys.
//
// Every node is built with createElement/textContent, never innerHTML:
// tab titles and URLs are arbitrary text controlled by whatever page is
// open in that tab.
//
// Clicking a tab switches to it (focusing its window too), then closes
// this new tab page behind it — having just jumped to an existing tab,
// the blank one you came from would otherwise just pile up. A tab
// that's only open on another device opens right here, in this same
// tab, instead.
//
// Keyboard-only use: every listed tab has a number (see numberTabs);
// typing digits narrows the list to that number and Enter opens it.
// Any other text searches titles/URLs, Enter opens the first match.
// ============================================================

(function () {
  // Which sections the page shows — set from the options page's "New tab
  // page" card (newtab-options.js, which keeps its own copy of this key
  // and these defaults).
  const SECTIONS_KEY = "newtabSections";
  const DEFAULT_SECTIONS = { thisWindow: true, otherWindows: true, otherDevices: true };

  // Chrome/Brave's own tab-group palette, as tabGroups reports it.
  const GROUP_COLORS = {
    grey: "#5f6368",
    blue: "#1a73e8",
    red: "#d93025",
    yellow: "#f9ab00",
    green: "#1e8e3e",
    pink: "#d01884",
    purple: "#9334e6",
    cyan: "#007b83",
    orange: "#fa903e",
  };

  const timeEl = document.getElementById("time");
  const dateEl = document.getElementById("date");
  const searchBarEl = document.getElementById("searchBar");
  const searchEl = document.getElementById("search");
  const localEl = document.getElementById("local");
  const remoteEl = document.getElementById("remote");
  const remoteSectionEl = document.getElementById("remoteSection");
  const emptyEl = document.getElementById("empty");

  let selfTab = null;
  let localData = { windows: [] };
  let remoteData = { paused: false, devices: [] };
  let sections = { ...DEFAULT_SECTIONS };

  // A group's fold state on this page is the browser's own (`collapsed`
  // from tabGroups) — clicking its header here overrides that, in memory
  // only and only until the browser's state changes: groupId →
  // { collapsed, browserCollapsed } where `browserCollapsed` is what the
  // browser said when the header was clicked. Folding/unfolding the group
  // in the browser afterwards wins again (see isFolded).
  const foldOverrides = new Map();

  // ---- clock ----

  // The browser's own display language, not whatever the page happens to
  // default to: i18n.getUILanguage() is exactly that on both Chrome and
  // Firefox. Falls back to the default locale if it's somehow not a tag
  // Intl accepts.
  function uiLocale() {
    try {
      const lang = browser.i18n.getUILanguage();
      Intl.DateTimeFormat.supportedLocalesOf([lang]); // throws on a malformed tag
      return lang;
    } catch (e) {
      return undefined;
    }
  }
  const locale = uiLocale();
  const timeFmt = new Intl.DateTimeFormat(locale, { hour: "numeric", minute: "2-digit" });
  const dateFmt = new Intl.DateTimeFormat(locale, {
    weekday: "long",
    day: "numeric",
    month: "long",
    year: "numeric",
  });
  if (locale) dateEl.lang = locale; // so ::first-letter capitalizes by that language's rules

  function tick() {
    const now = new Date();
    timeEl.textContent = timeFmt.format(now);
    dateEl.textContent = dateFmt.format(now);
  }

  // ---- small DOM helpers ----

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

  function letterIcon(entry) {
    const label = hostOf(entry.url).replace(/^www\./, "") || entry.title || "?";
    return el("span", "icon", label.charAt(0).toUpperCase());
  }

  // `favIconUrl` is only ever set by newtab-core.js to the tab's OWN
  // icon (never a third-party favicon service — see safeFaviconUrl
  // there). no-referrer so even that one request doesn't announce which
  // extension page asked for it.
  function iconFor(entry) {
    if (!entry.favIconUrl) return letterIcon(entry);
    const img = el("img", "icon");
    img.alt = "";
    img.referrerPolicy = "no-referrer";
    img.src = entry.favIconUrl;
    img.addEventListener("error", () => img.replaceWith(letterIcon(entry)));
    return img;
  }

  function entryTabs(entry) {
    return entry.kind === "tab" ? [entry.tab] : entry.group.tabs;
  }

  function itemButton(entry, key, num, meta, onActivate, isCurrent) {
    const btn = el("button", "item" + (isCurrent ? " current" : ""));
    btn.type = "button";
    btn.dataset.key = key;
    btn.dataset.num = String(num);
    btn.title = entry.url;
    btn.append(
      el("span", "num", String(num)),
      iconFor(entry),
      el("span", "title", entry.title || entry.url),
      el("span", "meta", meta)
    );
    btn.addEventListener("click", onActivate);
    return btn;
  }

  // ---- numbering + matching ----

  // Every listed tab gets a number, in display order over the WHOLE,
  // unfiltered list of the sections being shown — this window, then the
  // other windows, then the other devices — so a tab keeps its number
  // while you type, and a tab inside a folded group has one too. A remote
  // tab that's also listed here reuses the local tab's number (it's the
  // same tab a click would switch to); only the others get numbers of
  // their own, after the local ones. Numbers follow positions, so they
  // shift when tabs open/close/move.
  function numberTabs(windows) {
    const local = new Map(); // local tab id → number
    let n = 0;
    for (const win of windows) {
      for (const entry of win.entries) for (const t of entryTabs(entry)) local.set(t.id, ++n);
    }
    const remote = new Map(); // `${device}|${url}` → number
    if (sections.otherDevices) {
      for (const device of remoteData.devices) {
        for (const t of device.tabs) {
          const mine = t.localTabId !== null && t.localTabId !== undefined && local.get(t.localTabId);
          remote.set(`${device.name}|${t.url}`, mine || ++n);
        }
      }
    }
    return { local, remote, max: n };
  }

  // A query of digits only is a tab number: it matches every tab whose
  // number STARTS with those digits (typing "1" on the way to "12" keeps
  // 12 in view), and the exact one gets selected (see markSelected).
  // Falls back to plain text search when no tab has such a number, so a
  // "2026" still finds titles containing it on a short list.
  function buildQuery(numbers) {
    const raw = searchEl.value.trim();
    const terms = raw.toLowerCase().split(/\s+/).filter(Boolean);
    let digits = null;
    if (/^\d+$/.test(raw)) {
      const all = [...numbers.local.values(), ...numbers.remote.values()];
      if (all.some((num) => String(num).startsWith(raw))) digits = raw;
    }
    return {
      active: terms.length > 0,
      digits,
      hit(num, ...fields) {
        if (digits !== null) return String(num).startsWith(digits);
        if (terms.length === 0) return true;
        const haystack = fields.join(" ").toLowerCase();
        return terms.every((t) => haystack.includes(t));
      },
    };
  }

  // ---- actions ----

  async function switchTo(tabId, windowId) {
    try {
      await browser.windows.update(windowId, { focused: true });
      await browser.tabs.update(tabId, { active: true });
    } catch (e) {
      return; // closed in the meantime — the next refresh drops it from the list
    }
    if (selfTab && selfTab.id !== tabId) {
      try {
        await browser.tabs.remove(selfTab.id);
      } catch (e) {}
    }
  }

  async function openHere(url) {
    if (selfTab) {
      await browser.tabs.update(selfTab.id, { url });
    } else {
      location.href = url;
    }
  }

  function isFolded(group) {
    const o = foldOverrides.get(group.id);
    if (o && o.browserCollapsed === group.collapsed) return o.collapsed;
    foldOverrides.delete(group.id); // the browser's own state moved on — it wins again
    return group.collapsed;
  }

  function toggleGroup(group) {
    foldOverrides.set(group.id, { collapsed: !isFolded(group), browserCollapsed: group.collapsed });
    render();
  }

  // ---- render ----

  // Tabs are laid out in a `.tab-grid`: one column on a narrow window,
  // two on a wide one (media query in newtab.html), filled in reading
  // order — a tab on the left, the next one on its right, and so on —
  // so the numbers still read in sequence. A group header always spans
  // the full width, with its own tabs in a grid of their own.

  function renderGroup(group, tabs, query, numbers, isMyWindow) {
    // While searching, every group with a match is open — a number typed
    // for a tab inside a folded group must still show that tab.
    const folded = !query.active && isFolded(group);
    const wrap = el("div", "group" + (folded ? " collapsed" : ""));
    const color = GROUP_COLORS[group.color] || GROUP_COLORS.grey;
    wrap.style.setProperty("--group-color", color);

    const header = el("button", "group-header");
    header.type = "button";
    header.dataset.key = `g:${group.id}`;
    header.setAttribute("aria-expanded", String(!folded));
    const dot = el("span", "dot");
    dot.style.background = color;
    header.append(
      dot,
      el("span", "", group.title || "Untitled group"),
      el("span", "count", String(tabs.length)),
      el("span", "chevron", "▾")
    );
    header.addEventListener("click", () => toggleGroup(group));

    const list = el("div", "group-tabs tab-grid");
    for (const t of tabs) {
      const num = numbers.local.get(t.id);
      list.append(itemButton(t, `t:${t.id}`, num, hostOf(t.url), () => switchTo(t.id, t.windowId), t.active && !isMyWindow));
    }
    wrap.append(header, list);
    return wrap;
  }

  function render() {
    const focusedKey = (document.activeElement && document.activeElement.dataset.key) || null;
    const myWindowId = selfTab ? selfTab.windowId : null;
    const allWindows = localData.windows
      .slice()
      .sort((a, b) => Number(b.id === myWindowId) - Number(a.id === myWindowId));
    const labelWindows = allWindows.length > 1;
    const windows = allWindows.filter((w) => (w.id === myWindowId ? sections.thisWindow : sections.otherWindows));
    const numbers = numberTabs(windows);
    const query = buildQuery(numbers);
    document.querySelector("main").style.setProperty("--num-w", `${Math.max(2, String(numbers.max).length)}ch`);
    let visible = 0;

    // This device — the window this page lives in first, each window in
    // its own tab-strip order (newtab-core.js's `entries`).
    localEl.replaceChildren();
    for (const win of windows) {
      const isMyWindow = win.id === myWindowId;
      const block = document.createDocumentFragment();
      let run = null; // the grid consecutive ungrouped tabs go into
      let count = 0;

      for (const entry of win.entries) {
        if (entry.kind === "tab") {
          const t = entry.tab;
          const num = numbers.local.get(t.id);
          if (!query.hit(num, t.title, t.url)) continue;
          const meta = hostOf(t.url) + (t.pinned ? " · pinned" : "");
          if (!run) block.append((run = el("div", "tab-grid")));
          run.append(itemButton(t, `t:${t.id}`, num, meta, () => switchTo(t.id, t.windowId), t.active && !isMyWindow));
          count += 1;
        } else {
          const g = entry.group;
          const groupHit = query.active && query.digits === null && query.hit(0, g.title);
          const tabs = g.tabs.filter((t) => groupHit || query.hit(numbers.local.get(t.id), t.title, t.url, g.title));
          if (tabs.length === 0) continue;
          block.append(renderGroup(g, tabs, query, numbers, isMyWindow));
          run = null;
          count += tabs.length;
        }
      }

      if (count === 0) continue;
      // Labels stay those of the full window list, so hiding "this
      // window" doesn't renumber the others.
      const label = isMyWindow ? "This window" : `Window ${allWindows.indexOf(win) + 1}`;
      localEl.append(el("div", "section-title", labelWindows ? label : "Open tabs"), block);
      visible += count;
    }

    // Other devices.
    remoteEl.replaceChildren();
    let remoteVisible = 0;
    if (sections.otherDevices) {
      if (remoteData.paused && !query.active) {
        remoteEl.append(el("div", "note", "Sync is paused — tabs on your other devices aren't shown."));
      }
      for (const device of remoteData.devices) {
        const tabs = device.tabs.filter((t) =>
          query.hit(numbers.remote.get(`${device.name}|${t.url}`), t.title, t.url, device.name)
        );
        if (tabs.length === 0) continue;
        const grid = el("div", "tab-grid");
        for (const t of tabs) {
          const key = `${device.name}|${t.url}`;
          const isLocal = t.localTabId !== null && t.localTabId !== undefined;
          grid.append(
            itemButton(
              t,
              `r:${key}`,
              numbers.remote.get(key),
              isLocal ? "open here" : hostOf(t.url),
              () => (isLocal ? switchTo(t.localTabId, t.localWindowId) : openHere(t.url)),
              false
            )
          );
        }
        remoteEl.append(el("div", "sub-title", device.name), grid);
        remoteVisible += tabs.length;
      }
    }
    remoteSectionEl.hidden = remoteVisible === 0 && !(sections.otherDevices && remoteData.paused && !query.active);
    visible += remoteVisible;

    const nothingShown = !sections.thisWindow && !sections.otherWindows && !sections.otherDevices;
    emptyEl.textContent = nothingShown
      ? "Every tab section is turned off — choose what this page shows in SyncMyTabs's settings."
      : "No matching tabs.";
    emptyEl.hidden = !(nothingShown || (query.active && visible === 0));
    markSelected(query);

    // A re-render (a tab finished loading somewhere, say) mustn't yank
    // keyboard focus out from under someone arrowing through the list.
    if (focusedKey) {
      const again = document.querySelector(`[data-key="${CSS.escape(focusedKey)}"]`);
      if (again) again.focus();
    }
  }

  // While searching, the tab Enter would open is highlighted: the exact
  // number match when the query is a number, the first match otherwise.
  function markSelected(query) {
    const items = Array.from(document.querySelectorAll("main .item"));
    for (const item of items) item.classList.remove("selected");
    if (!query.active) return;
    const exact = query.digits !== null && items.find((n) => n.dataset.num === query.digits);
    const pick = exact || items[0];
    if (pick) pick.classList.add("selected");
  }

  // ---- keyboard: type-to-search, Enter opens the selected match, arrows move ----

  function navigables() {
    return Array.from(document.querySelectorAll("main .item, main .group-header")).filter(
      (n) => n.offsetParent !== null
    );
  }

  // Up/Down move by ROW, which in the two-column grid isn't the same as
  // the next/previous element: the nearest row above/below, then the
  // entry in it closest horizontally (a group header spans both
  // columns). Left/Right step through reading order.
  function rowNeighbour(current, dir) {
    const r = current.getBoundingClientRect();
    const cx = r.left + r.width / 2;
    let best = null;
    let bestDy = Infinity;
    let bestDx = Infinity;
    for (const n of navigables()) {
      const q = n.getBoundingClientRect();
      const dy = dir > 0 ? q.top - r.top : r.top - q.top;
      if (dy <= 1) continue;
      const dx = Math.abs(q.left + q.width / 2 - cx);
      if (dy < bestDy - 1 || (Math.abs(dy - bestDy) <= 1 && dx < bestDx)) {
        best = n;
        bestDy = dy;
        bestDx = dx;
      }
    }
    return best;
  }

  document.addEventListener("keydown", (e) => {
    const modified = e.ctrlKey || e.metaKey || e.altKey;
    if (document.activeElement === searchEl) {
      if (e.key === "Enter") {
        const selected = document.querySelector("main .item.selected");
        if (selected) {
          e.preventDefault();
          selected.click();
        }
      } else if (e.key === "ArrowDown") {
        const target = document.querySelector("main .item.selected") || navigables()[0];
        if (target) {
          e.preventDefault();
          target.focus();
        }
      } else if (e.key === "Escape" && searchEl.value) {
        e.preventDefault();
        searchEl.value = "";
        onSearchInput();
      }
      return;
    }

    const nav = navigables();
    const i = nav.indexOf(document.activeElement);
    if (i !== -1 && (e.key === "ArrowDown" || e.key === "ArrowUp")) {
      e.preventDefault();
      const next = rowNeighbour(nav[i], e.key === "ArrowDown" ? 1 : -1);
      if (next) next.focus();
      else if (e.key === "ArrowUp") searchEl.focus();
    } else if (i !== -1 && (e.key === "ArrowRight" || e.key === "ArrowLeft")) {
      e.preventDefault();
      const next = nav[i + (e.key === "ArrowRight" ? 1 : -1)];
      if (next) next.focus();
    } else if (e.key === "Escape") {
      searchEl.focus();
    } else if (e.key.length === 1 && e.key !== " " && !modified) {
      // Typing anywhere on the page — a digit included — lands in the
      // search box.
      searchEl.focus();
    }
  });

  // The search bar stays pinned at the top while the list scrolls under
  // it; a new query jumps back to the start of the (now filtered) list.
  function onSearchInput() {
    render();
    window.scrollTo(0, 0);
  }
  searchEl.addEventListener("input", onSearchInput);

  // The selection highlight only means something while Enter would act
  // on it, i.e. while the search box has focus.
  searchEl.addEventListener("focus", () => document.body.classList.add("searching"));
  searchEl.addEventListener("blur", () => document.body.classList.remove("searching"));

  // Keyboard focus scrolling a row into view must clear the sticky
  // search bar (newtab.html's scroll-padding-top), so it needs the bar's
  // real height.
  function measureBar() {
    document.documentElement.style.setProperty("--bar-h", `${searchBarEl.offsetHeight}px`);
  }
  window.addEventListener("resize", measureBar);

  // ---- data loading + live refresh ----

  async function loadSections() {
    try {
      const { [SECTIONS_KEY]: saved } = await browser.storage.local.get(SECTIONS_KEY);
      sections = { ...DEFAULT_SECTIONS, ...(saved && typeof saved === "object" ? saved : {}) };
    } catch (e) {}
  }

  async function loadLocal() {
    try {
      const data = await browser.runtime.sendMessage({ type: "NEWTAB_LOCAL" });
      if (data && Array.isArray(data.windows)) localData = data;
    } catch (e) {}
    render();
  }

  // Not even asked for while the section is turned off — no reason to
  // walk the bookmark tree for something that isn't shown.
  async function loadRemote() {
    if (!sections.otherDevices) return;
    try {
      const data = await browser.runtime.sendMessage({ type: "NEWTAB_REMOTE" });
      if (data && Array.isArray(data.devices)) remoteData = data;
    } catch (e) {}
    render();
  }

  function debounce(fn, ms) {
    let timer = null;
    return () => {
      clearTimeout(timer);
      timer = setTimeout(fn, ms);
    };
  }

  // Only while this page is actually visible — a background new tab
  // has no reason to keep re-reading the bookmark tree. The remote half
  // is debounced harder: every device's heartbeat is a bookmark change.
  const scheduleLocal = debounce(() => !document.hidden && loadLocal(), 150);
  const scheduleRemote = debounce(() => !document.hidden && loadRemote(), 1000);

  for (const ev of ["onCreated", "onRemoved", "onMoved", "onActivated", "onAttached", "onDetached"]) {
    browser.tabs[ev].addListener(scheduleLocal);
  }
  browser.tabs.onUpdated.addListener((tabId, changeInfo) => {
    scheduleLocal();
    if (changeInfo.url) scheduleRemote(); // "open here" links follow local URLs
  });
  browser.tabs.onCreated.addListener(scheduleRemote);
  browser.tabs.onRemoved.addListener(scheduleRemote);
  if (browser.tabGroups) {
    // onUpdated covers a group being folded/unfolded in the browser.
    for (const ev of ["onCreated", "onUpdated", "onRemoved", "onMoved"]) {
      if (browser.tabGroups[ev]) browser.tabGroups[ev].addListener(scheduleLocal);
    }
  }
  for (const ev of ["onCreated", "onChanged", "onRemoved", "onMoved"]) {
    browser.bookmarks[ev].addListener(scheduleRemote);
  }

  // Sections changed on the options page: applied live.
  browser.storage.onChanged.addListener(async (changes, area) => {
    if (area !== "local" || !changes[SECTIONS_KEY]) return;
    await loadSections();
    render();
    loadRemote();
  });

  document.addEventListener("visibilitychange", () => {
    if (!document.hidden) {
      loadLocal();
      loadRemote();
    }
  });

  // ---- start ----

  tick();
  setInterval(tick, 1000);
  measureBar();

  (async () => {
    try {
      selfTab = await browser.tabs.getCurrent();
    } catch (e) {}
    await loadSections();
    searchEl.focus();
    // autofocus may have focused it before the listener above existed.
    document.body.classList.toggle("searching", document.activeElement === searchEl);
    await loadLocal();
    loadRemote();
  })();
})();
