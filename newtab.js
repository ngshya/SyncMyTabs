// ============================================================
// SyncMyTabs - newtab.js
//
// DOM layer of the custom new tab page (newtab.html, wired via
// manifest.json's chrome_url_overrides.newtab): a clock, a search box,
// this device's open tabs grouped by window and tab group, and the tabs
// open on the user's other devices. All the data assembly lives in
// newtab-core.js (served by background.js's NEWTAB_LOCAL/NEWTAB_REMOTE
// messages, see its header comment for why it isn't done here); this
// file only renders it and reacts to clicks/keys.
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
// ============================================================

(function () {
  // Per-device UI convenience (which groups are folded on this page),
  // same storage.local convention as every other local preference —
  // keyed by group title, the only stable identity a group has (see
  // groups-core.js), or `#<id>` for an untitled one.
  const COLLAPSED_KEY = "newtabCollapsedGroups";

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
  const searchEl = document.getElementById("search");
  const localEl = document.getElementById("local");
  const remoteEl = document.getElementById("remote");
  const remoteSectionEl = document.getElementById("remoteSection");
  const emptyEl = document.getElementById("empty");

  let selfTab = null;
  let localData = { windows: [] };
  let remoteData = { paused: false, devices: [] };
  let collapsed = new Set();

  // ---- clock ----

  const timeFmt = new Intl.DateTimeFormat(undefined, { hour: "2-digit", minute: "2-digit" });
  const dateFmt = new Intl.DateTimeFormat(undefined, {
    weekday: "long",
    day: "numeric",
    month: "long",
    year: "numeric",
  });

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

  function matches(terms, ...fields) {
    if (terms.length === 0) return true;
    const haystack = fields.join(" ").toLowerCase();
    return terms.every((t) => haystack.includes(t));
  }

  function itemButton(entry, key, meta, onActivate, isCurrent) {
    const btn = el("button", "item" + (isCurrent ? " current" : ""));
    btn.type = "button";
    btn.dataset.key = key;
    btn.title = entry.url;
    btn.append(iconFor(entry), el("span", "title", entry.title || entry.url), el("span", "meta", meta));
    btn.addEventListener("click", onActivate);
    return btn;
  }

  function groupKey(group) {
    return group.title || `#${group.id}`;
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

  async function toggleGroup(key) {
    if (collapsed.has(key)) collapsed.delete(key);
    else collapsed.add(key);
    render();
    try {
      await browser.storage.local.set({ [COLLAPSED_KEY]: Array.from(collapsed) });
    } catch (e) {}
  }

  // ---- render ----

  function renderGroup(group, tabs, filtering, isMyWindow) {
    const key = groupKey(group);
    const isCollapsed = !filtering && collapsed.has(key);
    const wrap = el("div", "group" + (isCollapsed ? " collapsed" : ""));
    const color = GROUP_COLORS[group.color] || GROUP_COLORS.grey;
    wrap.style.setProperty("--group-color", color);

    const header = el("button", "group-header");
    header.type = "button";
    header.dataset.key = `g:${key}`;
    header.setAttribute("aria-expanded", String(!isCollapsed));
    const dot = el("span", "dot");
    dot.style.background = color;
    header.append(
      dot,
      el("span", "", group.title || "Untitled group"),
      el("span", "count", String(tabs.length)),
      el("span", "chevron", "▾")
    );
    header.addEventListener("click", () => toggleGroup(key));

    const list = el("div", "group-tabs");
    for (const t of tabs) {
      list.append(
        itemButton(t, `t:${t.id}`, hostOf(t.url), () => switchTo(t.id, t.windowId), t.active && !isMyWindow)
      );
    }
    wrap.append(header, list);
    return wrap;
  }

  function render() {
    const focusedKey = (document.activeElement && document.activeElement.dataset.key) || null;
    const terms = searchEl.value.toLowerCase().split(/\s+/).filter(Boolean);
    const filtering = terms.length > 0;
    let visible = 0;

    // This device — the window this page lives in first.
    localEl.replaceChildren();
    const myWindowId = selfTab ? selfTab.windowId : null;
    const windows = localData.windows
      .slice()
      .sort((a, b) => Number(b.id === myWindowId) - Number(a.id === myWindowId));
    const labelWindows = windows.length > 1;
    let windowNumber = 1;
    for (const win of windows) {
      const isMyWindow = win.id === myWindowId;
      const block = document.createDocumentFragment();
      let count = 0;

      for (const g of win.groups) {
        const groupHit = filtering && matches(terms, g.title);
        const tabs = g.tabs.filter((t) => groupHit || matches(terms, t.title, t.url, g.title));
        if (tabs.length === 0) continue;
        block.append(renderGroup(g, tabs, filtering, isMyWindow));
        count += tabs.length;
      }
      for (const t of win.tabs) {
        if (!matches(terms, t.title, t.url)) continue;
        const meta = hostOf(t.url) + (t.pinned ? " · pinned" : "");
        block.append(
          itemButton(t, `t:${t.id}`, meta, () => switchTo(t.id, t.windowId), t.active && !isMyWindow)
        );
        count += 1;
      }

      if (count === 0) continue;
      const label = isMyWindow ? "This window" : `Window ${++windowNumber}`;
      localEl.append(el("div", "section-title", labelWindows ? label : "Open tabs"), block);
      visible += count;
    }

    // Other devices.
    remoteEl.replaceChildren();
    let remoteVisible = 0;
    if (remoteData.paused && !filtering) {
      remoteEl.append(el("div", "note", "Sync is paused — tabs on your other devices aren't shown."));
    }
    for (const device of remoteData.devices) {
      const tabs = device.tabs.filter((t) => matches(terms, t.title, t.url, device.name));
      if (tabs.length === 0) continue;
      remoteEl.append(el("div", "sub-title", device.name));
      for (const t of tabs) {
        const isLocal = t.localTabId !== null && t.localTabId !== undefined;
        remoteEl.append(
          itemButton(
            t,
            `r:${device.name}|${t.url}`,
            isLocal ? "open here" : hostOf(t.url),
            () => (isLocal ? switchTo(t.localTabId, t.localWindowId) : openHere(t.url)),
            false
          )
        );
      }
      remoteVisible += tabs.length;
    }
    remoteSectionEl.hidden = remoteVisible === 0 && !(remoteData.paused && !filtering);
    visible += remoteVisible;

    emptyEl.hidden = !(filtering && visible === 0);

    // A re-render (a tab finished loading somewhere, say) mustn't yank
    // keyboard focus out from under someone arrowing through the list.
    if (focusedKey) {
      const again = document.querySelector(`[data-key="${CSS.escape(focusedKey)}"]`);
      if (again) again.focus();
    }
  }

  // ---- keyboard: type-to-search, Enter opens the first match, arrows move ----

  function navigables() {
    return Array.from(document.querySelectorAll("main .item, main .group-header")).filter(
      (n) => n.offsetParent !== null
    );
  }

  document.addEventListener("keydown", (e) => {
    const modified = e.ctrlKey || e.metaKey || e.altKey;
    if (document.activeElement === searchEl) {
      if (e.key === "Enter") {
        const first = navigables().find((n) => n.classList.contains("item"));
        if (first && searchEl.value.trim()) {
          e.preventDefault();
          first.click();
        }
      } else if (e.key === "ArrowDown") {
        const nav = navigables();
        if (nav[0]) {
          e.preventDefault();
          nav[0].focus();
        }
      } else if (e.key === "Escape" && searchEl.value) {
        e.preventDefault();
        searchEl.value = "";
        render();
      }
      return;
    }

    const nav = navigables();
    const i = nav.indexOf(document.activeElement);
    if (e.key === "ArrowDown" && i !== -1) {
      e.preventDefault();
      (nav[i + 1] || nav[i]).focus();
    } else if (e.key === "ArrowUp" && i !== -1) {
      e.preventDefault();
      if (i === 0) searchEl.focus();
      else nav[i - 1].focus();
    } else if (e.key === "Escape") {
      searchEl.focus();
    } else if (e.key.length === 1 && e.key !== " " && !modified) {
      // Typing anywhere on the page lands in the search box.
      searchEl.focus();
    }
  });

  searchEl.addEventListener("input", render);

  // ---- data loading + live refresh ----

  async function loadLocal() {
    try {
      const data = await browser.runtime.sendMessage({ type: "NEWTAB_LOCAL" });
      if (data && Array.isArray(data.windows)) localData = data;
    } catch (e) {}
    render();
  }

  async function loadRemote() {
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
    for (const ev of ["onCreated", "onUpdated", "onRemoved", "onMoved"]) {
      if (browser.tabGroups[ev]) browser.tabGroups[ev].addListener(scheduleLocal);
    }
  }
  for (const ev of ["onCreated", "onChanged", "onRemoved", "onMoved"]) {
    browser.bookmarks[ev].addListener(scheduleRemote);
  }

  document.addEventListener("visibilitychange", () => {
    if (!document.hidden) {
      loadLocal();
      loadRemote();
    }
  });

  // ---- start ----

  tick();
  setInterval(tick, 1000);

  (async () => {
    try {
      selfTab = await browser.tabs.getCurrent();
    } catch (e) {}
    try {
      const { [COLLAPSED_KEY]: saved } = await browser.storage.local.get(COLLAPSED_KEY);
      collapsed = new Set(Array.isArray(saved) ? saved : []);
    } catch (e) {}
    searchEl.focus();
    await loadLocal();
    loadRemote();
  })();
})();
