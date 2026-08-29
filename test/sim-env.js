// ============================================================
// test/sim-env.js
//
// A fake multi-device environment that the exact same sync-core.js
// engine runs against, without a real browser: one shared, in-memory
// "synced bookmark tree" (SimWorld), and one simulated device (tabs,
// windows, local storage) per SimDevice. Every device's env.bookmarks
// is the SAME SimWorld tree — i.e. bookmark sync is simulated as
// instantaneous — which is the right simplification for testing
// whether the RECONCILE LOGIC itself is correct (does the mirror
// converge to the right open/closed state), as opposed to testing
// timing/propagation-delay races (which the project already documents
// as an accepted, architectural limitation — see CLAUDE.md).
//
// Each SimDevice exposes a small, high-level test API — openTab,
// closeTab, navigateTab, updateTabs (a batch open/close), tick
// (simulate the periodic alarm), startup — that plays the role of a
// real browser dispatching tab/bookmark events: when a real browser
// would fire tabs.onRemoved/onUpdated or a bookmarks.on* event,
// SimDevice calls the SAME engine.handle*() wiring functions
// background.js calls, so tests exercise the real event-wiring
// decisions (e.g. the isWindowClosing guard, or which status counts as
// "navigation complete"), not a re-implementation of them.
// ============================================================

const { createSyncEngine } = require("../sync-core.js");

let idCounter = 1;
function nextId() {
  return String(idCounter++);
}

// Tab group ids are kept NUMERIC on purpose, unlike every other id in
// this simulator (tabs/windows/bookmarks are all opaque strings here) —
// mirroring the real chrome.tabGroups API, whose group ids are numbers.
// sync-core.js's isInTabGroup / groups-core.js's isGrouped both check
// `typeof tab.groupId === "number"`, so a string id here would silently
// make every grouped-tab test look ungrouped.
let groupIdCounter = 1000;
function nextGroupId() {
  return groupIdCounter++;
}

function makeFolder(id, parentId, title) {
  return { id, parentId, title, dateAdded: Date.now(), children: [] };
}

// ------------------------------------------------------------
// The shared bookmark tree + cross-device event propagation.
// ------------------------------------------------------------
class SimBookmarksApi {
  constructor(world) {
    this.world = world;
  }

  _allNodes() {
    const out = [];
    const walk = (n) => {
      out.push(n);
      if (n.children) for (const c of n.children) walk(c);
    };
    walk(this.world.root);
    return out;
  }

  _byId(id) {
    return this._allNodes().find((n) => n.id === id) || null;
  }

  _parentOf(id) {
    const node = this._byId(id);
    return node ? this._byId(node.parentId) : null;
  }

  async search({ title }) {
    return this._allNodes()
      .filter((n) => n.title === title)
      .map((n) => ({ ...n, children: undefined }));
  }

  async getChildren(id) {
    const node = this._byId(id);
    return node && node.children ? node.children.map((c) => ({ ...c })) : [];
  }

  async getTree() {
    return [this.world.root];
  }

  async create({ parentId, title, url }) {
    const parent = this._byId(parentId);
    if (!parent) throw new Error(`no such parent ${parentId}`);
    const node = { id: nextId(), parentId, title, dateAdded: Date.now() };
    if (url !== undefined) node.url = url;
    else node.children = [];
    parent.children.push(node);
    if (url !== undefined) this.world._notifyEvent({ type: "created", title, url });
    return { ...node };
  }

  async update(id, changes) {
    const node = this._byId(id);
    if (!node) throw new Error(`no such bookmark ${id}`);
    if (changes.title !== undefined) node.title = changes.title;
    if (changes.url !== undefined) node.url = changes.url;
    if (node.url !== undefined) {
      this.world._notifyEvent({ type: "changed", title: node.title, url: node.url });
    }
    return { ...node };
  }

  async remove(id) {
    const node = this._byId(id);
    if (!node) throw new Error(`no such bookmark ${id}`);
    const parent = this._parentOf(id);
    parent.children = parent.children.filter((c) => c.id !== id);
    this.world._notifyEvent({ type: "removed" });
  }

  async removeTree(id) {
    const parent = this._parentOf(id);
    if (parent) parent.children = parent.children.filter((c) => c.id !== id);
    this.world._notifyEvent({ type: "removed" });
  }

  async move(id, { parentId }) {
    const node = this._byId(id);
    if (!node) throw new Error(`no such bookmark ${id}`);
    const oldParent = this._parentOf(id);
    const newParent = this._byId(parentId);
    oldParent.children = oldParent.children.filter((c) => c.id !== id);
    node.parentId = parentId;
    newParent.children.push(node);
    return { ...node };
  }
}

// Per-device fake tabs. `status` defaults to "complete" — tests that
// want to exercise the mid-navigation guard use openTabLoading() +
// finishNavigation() instead of the plain openTab() helper.
//
// Tab STRIP ORDER (tab.index) is modeled for real, per window
// (`orderByWindow`: windowId -> [tabId, ...] in on-screen order) — an
// earlier version of this simulator didn't track order at all (every
// tab's `.index` was simply `undefined`), which order-core.js's own
// tests need to be meaningful, and which also silently made
// groups-core.js's existing `matchingTabs.sort((a,b) => a.index -
// b.index)` a no-op (comparing undefined-undefined) that happened to
// not matter for any PRIOR test scenario. `_reindexWindow` is the one
// place that (re)assigns every tab's `.index` field from its position
// in the order array — call it after any mutation to that array, never
// hand-patch `.index` directly.
class SimTabsApi {
  constructor() {
    this.tabs = new Map();
    this.orderByWindow = new Map(); // windowId -> [tabId, ...] in strip order
  }

  _orderArrayFor(windowId) {
    let arr = this.orderByWindow.get(windowId);
    if (!arr) {
      arr = [];
      this.orderByWindow.set(windowId, arr);
    }
    return arr;
  }

  _reindexWindow(windowId) {
    const arr = this._orderArrayFor(windowId);
    arr.forEach((id, i) => {
      const t = this.tabs.get(id);
      if (t) t.index = i;
    });
  }

  _removeFromOrder(tab) {
    const arr = this._orderArrayFor(tab.windowId);
    const i = arr.indexOf(tab.id);
    if (i !== -1) arr.splice(i, 1);
    this._reindexWindow(tab.windowId);
  }

  // Real filtering by the fields this codebase actually queries by
  // (windowId, active, groupId, pinned) — matches the real
  // chrome.tabs.query() contract of "every specified field must match,
  // unspecified fields are unconstrained". An earlier version of this
  // simulator ignored queryInfo entirely and always returned every tab,
  // which every existing caller happened not to notice (none of their
  // test scenarios had cross-window/cross-group noise tabs to reveal
  // it) — real filtering is required for archive-core.js's
  // windowId+active lookup to mean anything.
  async query(queryInfo = {}) {
    let list = Array.from(this.tabs.values());
    if (queryInfo.windowId !== undefined) {
      list = list.filter((t) => t.windowId === queryInfo.windowId);
    }
    if (queryInfo.active !== undefined) {
      list = list.filter((t) => !!t.active === !!queryInfo.active);
    }
    if (queryInfo.groupId !== undefined) {
      list = list.filter((t) => t.groupId === queryInfo.groupId);
    }
    if (queryInfo.pinned !== undefined) {
      list = list.filter((t) => !!t.pinned === !!queryInfo.pinned);
    }
    // Real chrome.tabs.query() returns tabs in on-screen strip order —
    // sort by (windowId, index) so a caller (groups-core.js's own
    // `matchingTabs.sort((a,b) => a.index - b.index)`, or order-core.js
    // reading a whole window's layout) sees the same ordering a real
    // browser would, not Map insertion order.
    list = list.slice().sort((a, b) => {
      if (a.windowId !== b.windowId) return String(a.windowId).localeCompare(String(b.windowId));
      return (a.index || 0) - (b.index || 0);
    });
    return list.map((t) => ({ ...t }));
  }

  // Deactivates every OTHER tab in the same window — mirrors the real
  // browser's "only one active tab per window" invariant, which nothing
  // enforced here before archive-core.js's windowId+active query needed
  // it to mean something. Also fires a real tabs.onActivated
  // ({tabId, windowId}), same as any create()/update() that makes a tab
  // active, or an explicit test-driven activation (see
  // test/archive-test-helpers.js's activateTab).
  _setActiveTab(id) {
    const tab = this.tabs.get(id);
    if (!tab) return;
    for (const t of this.tabs.values()) {
      if (t.windowId === tab.windowId) t.active = t.id === id;
    }
    if (this.onActivated) this.onActivated({ tabId: tab.id, windowId: tab.windowId });
  }

  async create({
    url,
    title,
    active,
    windowId,
    status,
    groupId,
    pinned,
    openerTabId,
    index,
  }) {
    const id = nextId();
    let effectiveGroupId = groupId;
    if (effectiveGroupId === undefined && openerTabId !== undefined) {
      // Mirrors a real Chrome/Brave quirk that groups-core.js's
      // link-leashing has to actively guard against: a tab created
      // adjacent to a grouped tab (openerTabId + an adjacent index —
      // exactly how every caller here opens one) can silently auto-join
      // that SAME group purely from the adjacency, with no explicit
      // groupId requested at all. Without simulating this, a test could
      // never catch a caller that forgets to explicitly ungroup
      // afterward when that's not what's wanted (see
      // test/groups-leash.test.js).
      const opener = this.tabs.get(openerTabId);
      if (opener && typeof opener.groupId === "number" && opener.groupId !== -1) {
        effectiveGroupId = opener.groupId;
      }
    }
    const tab = {
      id,
      url,
      pendingUrl: undefined,
      title: title || url,
      status: status || "complete",
      active: !!active,
      // Falls back to whichever window is currently "focused" in this
      // device's simulated windowsApi — NOT a hardcoded id. A caller
      // that never specifies windowId (the common case: SimDevice's own
      // openTab/openGroupedTab/etc.) still lands its tab in the same
      // window windows.getLastFocused()/windowsApi.focus() would report,
      // which is what makes windows.onFocusChanged's own
      // tabs.query({windowId, active:true}) lookup findable at all (see
      // archive-core.js / test/archive-core.test.js).
      windowId: windowId || (this.windowsApi && this.windowsApi.defaultWindowId) || "1",
      groupId: effectiveGroupId === undefined ? -1 : effectiveGroupId,
      pinned: !!pinned,
      index: 0, // placeholder — _reindexWindow below assigns the real value
    };
    this.tabs.set(id, tab);

    // Strip-order placement: an explicit `index` wins (real callers pass
    // this to open a tab adjacent to another, e.g. groups-core.js's
    // fallbackOpen/handleLinkClick with `index: tab.index + 1`); failing
    // that, a tab created directly INTO an already-open group is placed
    // right after that group's last current member — mirroring real
    // Chrome, which never lets tabs.create() silently break a group's
    // on-screen contiguity — never just appended past unrelated tabs.
    // Everything else (the common case) is appended at the window's end.
    const order = this._orderArrayFor(tab.windowId);
    let insertAt = order.length;
    if (typeof index === "number") {
      insertAt = Math.max(0, Math.min(index, order.length));
    } else if (typeof effectiveGroupId === "number" && effectiveGroupId !== -1) {
      let lastMemberPos = -1;
      order.forEach((otherId, i) => {
        const other = this.tabs.get(otherId);
        if (other && other.groupId === effectiveGroupId) lastMemberPos = i;
      });
      if (lastMemberPos !== -1) insertAt = lastMemberPos + 1;
    }
    order.splice(insertAt, 0, id);
    this._reindexWindow(tab.windowId);

    if (active) this._setActiveTab(id);
    // Mirrors a real quirk that matters for archive-core.js: any tab
    // creation, from ANY code path (a direct open, a mirror-driven
    // open, a group reconcile reopen, …), fires a real tabs.onCreated
    // event — firing it from this one shared primitive, rather than
    // from each higher-level SimDevice helper individually, is what
    // keeps every creation path covered uniformly (same reasoning as
    // remove()'s onRemoved below).
    if (this.onCreated) this.onCreated({ ...tab });
    return { ...tab };
  }

  // Plain in-place navigation (no onUpdated dispatch here — tests that
  // need the engine to react to a navigation use the higher-level
  // SimDevice.navigateTab(), which calls handleTabUpdated itself; this
  // is just the raw API groups-core.js's link-leashing calls when it
  // decides to navigate a tab to a clicked link).
  async update(id, changes) {
    const tab = this.tabs.get(id);
    if (!tab) throw new Error(`no such tab ${id}`);
    Object.assign(tab, changes);
    if (changes.active) this._setActiveTab(id);
    return { ...tab };
  }

  // Mirrors a real quirk that matters: browser.tabs.remove() ALWAYS
  // fires tabs.onRemoved for what it removed — including removals
  // OUR OWN code triggers (e.g. reconcileMirror closing a tab because
  // the group is no longer present). That's what makes this device's
  // own entry get flipped to "closed" after a mirror-driven close: it
  // isn't done inline in reconcileMirror, it happens because the
  // removal loops back through the normal onRemoved handling. Skipping
  // this in the simulator would hide that dependency.
  async remove(idOrIds, removeInfo = {}) {
    const ids = Array.isArray(idOrIds) ? idOrIds : [idOrIds];
    for (const id of ids) {
      const tab = this.tabs.get(id);
      if (!tab) continue;
      this._removeFromOrder(tab);
      this.tabs.delete(id);
      if (this.onRemoved) this.onRemoved(id, removeInfo);
    }
  }

  // chrome.tabs.move()-alike, for order-core.js. Moves one or more tabs
  // (already-grouped tabs included — see order-core.js's own comment on
  // why it only ever moves a group's members as one contiguous block via
  // tabGroups.move, never through here individually) to `index` within
  // `windowId` (defaulting to the tabs' own current window, same
  // semantics as the real API when windowId is omitted). All moved ids
  // must already share one window — order-core.js never mixes windows
  // in one call, so this doesn't bother supporting a cross-window batch.
  // Preserves the moved ids' relative order among themselves, exactly
  // like the real API. Returns the updated Tab object(s), and fires
  // `.onMoved` per id (used by order-core.js's own tests to verify a
  // move it triggered doesn't look like a foreign/manual one — see
  // reorderInProgress in order-core.js).
  async move(idOrIds, { index, windowId } = {}) {
    const ids = Array.isArray(idOrIds) ? idOrIds : [idOrIds];
    const tabs = ids.map((id) => this.tabs.get(id)).filter(Boolean);
    if (tabs.length === 0) return Array.isArray(idOrIds) ? [] : undefined;
    const targetWindowId = windowId !== undefined ? windowId : tabs[0].windowId;

    for (const tab of tabs) {
      this._removeFromOrder(tab);
      tab.windowId = targetWindowId;
    }
    const order = this._orderArrayFor(targetWindowId);
    const insertAt = Math.max(0, Math.min(index, order.length));
    order.splice(insertAt, 0, ...tabs.map((t) => t.id));
    this._reindexWindow(targetWindowId);

    for (const tab of tabs) {
      // Awaited (unlike onRemoved/onCreated/onActivated elsewhere in
      // this file, which are fire-and-forget or queued onto
      // world.pending for deferred, flush()-driven propagation) — this
      // event backs order-core.js's own synchronous "was this move
      // mine" guard (reorderInProgress), which only works if the
      // listener runs and finishes BEFORE move()'s own promise
      // resolves, not on some later microtask/flush. Safe even if a
      // future hook here doesn't return a promise: `await`ing a
      // non-promise is a same-tick no-op.
      if (this.onMoved) {
        await this.onMoved(tab.id, { windowId: tab.windowId, toIndex: tab.index });
      }
    }
    const results = tabs.map((t) => ({ ...t }));
    return Array.isArray(idOrIds) ? results : results[0];
  }

  // Collapses every current member of group `gid` into one contiguous
  // block in its window's strip order — real Chrome never leaves a
  // group's tabs scattered, so group()/ungroup() below keep this
  // invariant true after every call, the same way tabGroups.move()
  // does for an explicit reposition. Settles the block at the EARLIEST
  // position any current member already occupies (rather than some
  // arbitrary end-of-window jump), so grouping a batch of tabs that
  // were already sitting next to each other is a no-op-looking
  // consolidation, not a surprising relocation.
  _consolidateGroupBlock(gid) {
    const members = Array.from(this.tabs.values()).filter((t) => t.groupId === gid);
    if (members.length === 0) return;
    const windowId = members[0].windowId;
    const order = this._orderArrayFor(windowId);
    const sorted = members.slice().sort((a, b) => order.indexOf(a.id) - order.indexOf(b.id));
    const targetPos = Math.min(...sorted.map((m) => order.indexOf(m.id)));
    for (const m of sorted) {
      const i = order.indexOf(m.id);
      if (i !== -1) order.splice(i, 1);
    }
    order.splice(Math.min(targetPos, order.length), 0, ...sorted.map((m) => m.id));
    this._reindexWindow(windowId);
  }

  // chrome.tabs.group()-alike, for groups-core.js's reconcileGroup /
  // handleLinkClick. `groupId` moves existing tabs into an already-open
  // group; omitting it (with `createProperties`) creates a fresh one.
  // Returns the (possibly new) numeric group id, like the real API.
  async group({ tabIds, groupId, createProperties }) {
    const ids = Array.isArray(tabIds) ? tabIds : [tabIds];
    let gid = groupId;
    if (gid === undefined) {
      gid = nextGroupId();
      const windowId = createProperties && createProperties.windowId;
      this.tabGroupsApi._ensureGroup(gid, windowId);
    }
    for (const id of ids) {
      const tab = this.tabs.get(id);
      if (tab) tab.groupId = gid;
    }
    this._consolidateGroupBlock(gid);
    return gid;
  }

  // chrome.tabs.ungroup()-alike.
  async ungroup(tabIdOrIds) {
    const ids = Array.isArray(tabIdOrIds) ? tabIdOrIds : [tabIdOrIds];
    for (const id of ids) {
      const tab = this.tabs.get(id);
      if (tab) tab.groupId = -1;
    }
  }
}

// Per-device fake chrome.tabGroups. Groups are local to one simulated
// device/browser — exactly like the real API — never shared through
// SimWorld's bookmark tree; only a group's RULES (stored via
// groups-core.js) sync across devices.
class SimTabGroupsApi {
  constructor(tabsApi) {
    this.tabsApi = tabsApi;
    this.groups = new Map(); // id -> {id, title, color, windowId}
  }

  async query(queryInfo = {}) {
    let list = Array.from(this.groups.values());
    if (queryInfo.windowId !== undefined) {
      list = list.filter((g) => g.windowId === queryInfo.windowId);
    }
    return list.map((g) => ({ ...g }));
  }

  async get(id) {
    const g = this.groups.get(id);
    if (!g) throw new Error(`no such group ${id}`);
    return { ...g };
  }

  async update(id, changes) {
    const g = this.groups.get(id);
    if (!g) throw new Error(`no such group ${id}`);
    Object.assign(g, changes);
    return { ...g };
  }

  // chrome.tabGroups.move()-alike. Moves every current member tab of
  // this group as one contiguous block to `index` (real strip-order
  // reordering, via tabsApi.move() below — order-core.js's own tests
  // depend on this being real, not just recorded). Also still sets
  // `g.position` for the existing groups-reconcile pin-to-start tests,
  // which only ever assert that field directly.
  async move(id, { index, windowId } = {}) {
    const g = this.groups.get(id);
    if (!g) throw new Error(`no such group ${id}`);
    const members = Array.from(this.tabsApi.tabs.values())
      .filter((t) => t.groupId === id)
      .sort((a, b) => a.index - b.index)
      .map((t) => t.id);
    if (members.length > 0) {
      await this.tabsApi.move(members, { index, windowId: windowId || g.windowId });
    }
    g.position = index;
    if (windowId !== undefined) g.windowId = windowId;
    // Awaited — same reasoning as SimTabsApi.move()'s own onMoved above.
    if (this.onMoved) await this.onMoved(id, { windowId: g.windowId, toIndex: index });
    return { ...g };
  }

  // internal: registers a fresh (initially untitled) group — called by
  // SimTabsApi.group() when it's asked to create one.
  _ensureGroup(id, windowId) {
    if (!this.groups.has(id)) {
      this.groups.set(id, { id, title: undefined, color: "grey", windowId });
    }
    return this.groups.get(id);
  }
}

class SimWindowsApi {
  constructor(tabsApi) {
    this.tabsApi = tabsApi;
    this.windows = new Map();
    const w = { id: nextId(), type: "normal" };
    this.windows.set(w.id, w);
    this.defaultWindowId = w.id;
  }

  async getLastFocused() {
    const w = this.windows.get(this.defaultWindowId);
    if (!w) throw new Error("no window");
    return { ...w };
  }

  async getAll() {
    return Array.from(this.windows.values()).map((w) => ({ ...w }));
  }

  // Simulates OS focus moving to a different browser window (Alt-Tab, a
  // click on another window, …) — for archive-core.js's
  // windows.onFocusChanged wiring. Not called by any SimDevice helper
  // automatically (multi-window scenarios are rare in this suite);
  // tests that need it call this directly.
  focus(windowId) {
    if (!this.windows.has(windowId)) return;
    this.defaultWindowId = windowId;
    if (this.onFocusChanged) this.onFocusChanged(windowId);
  }

  async create({ url }) {
    const w = { id: nextId(), type: "normal" };
    this.windows.set(w.id, w);
    this.defaultWindowId = w.id;
    const urls = Array.isArray(url) ? url : [url];
    const tabs = [];
    for (const u of urls) {
      const tab = await this.tabsApi.create({
        url: u,
        windowId: w.id,
        active: tabs.length === 0,
      });
      tabs.push(tab);
    }
    return { ...w, tabs };
  }

  async remove(id) {
    for (const [tid, t] of this.tabsApi.tabs) {
      if (t.windowId === id) this.tabsApi.tabs.delete(tid);
    }
    this.windows.delete(id);
  }
}

class SimStorage {
  constructor(initial = {}) {
    this.data = { ...initial };
  }

  async get(keys) {
    if (keys == null) return { ...this.data };
    if (typeof keys === "string") return { [keys]: this.data[keys] };
    if (Array.isArray(keys)) {
      const out = {};
      for (const k of keys) out[k] = this.data[k];
      return out;
    }
    const out = {};
    for (const k of Object.keys(keys)) {
      out[k] = k in this.data ? this.data[k] : keys[k];
    }
    return out;
  }

  async set(obj) {
    Object.assign(this.data, obj);
  }
}

// ------------------------------------------------------------
// One simulated device: its own tabs/windows/storage, bound to the
// world's shared bookmark tree, driving a real sync-core engine.
// ------------------------------------------------------------
class SimDevice {
  constructor(
    world,
    {
      deviceName,
      activeProfile = "default",
      storage = {},
      // Overrides sync-core.js's real mirror-open debounce (see its own
      // comment). Defaults to 0 — SimWorld's shared, instantaneous
      // bookmark tree deliberately doesn't model sync propagation delay,
      // so every ordinary test keeps its existing "mirrors in on the
      // very next flush()" behavior. Tests specifically exercising the
      // debounce mechanism pass a non-zero value here instead.
      mirrorOpenDebounceMs = 0,
      // Overrides order-core.js's own trailing reorder-guard grace
      // period (see its own comment). Defaults to 0 for the same
      // reason as mirrorOpenDebounceMs above: SimTabsApi/SimTabGroupsApi
      // fire onMoved synchronously (no real event-loop delay to guard
      // against here), so a real wall-clock wait would only slow every
      // test down for no correctness benefit.
      reorderGuardGraceMs = 0,
    }
  ) {
    this.world = world;
    this.deviceName = deviceName;
    this.tabsApi = new SimTabsApi();
    this.tabGroupsApi = new SimTabGroupsApi(this.tabsApi);
    this.tabsApi.tabGroupsApi = this.tabGroupsApi;
    this.windowsApi = new SimWindowsApi(this.tabsApi);
    // Cross-wired so SimTabsApi.create()'s windowId default can fall
    // back to "whichever window is currently focused" instead of a
    // hardcoded id — see create()'s own comment.
    this.tabsApi.windowsApi = this.windowsApi;
    this.storage = new SimStorage({
      deviceName,
      activeProfile,
      profiles: [activeProfile],
      syncEnabled: true,
      ...storage,
    });
    const env = {
      bookmarks: world.bookmarksApiFor(this),
      tabs: this.tabsApi,
      tabGroups: this.tabGroupsApi,
      windows: this.windowsApi,
      storage: { local: this.storage },
      runtime: { getURL: (p) => `sim-extension://${p}` },
      mirrorOpenDebounceMs,
      reorderGuardGraceMs,
    };
    this.env = env;
    this.engine = createSyncEngine(env);
    // Any tabs.remove() — ours or a "user" closing a tab via
    // closeTab() below — fires onRemoved, exactly like a real browser.
    this.tabsApi.onRemoved = (id, removeInfo) => {
      world.pending.push(
        Promise.resolve().then(() => this.engine.handleTabRemoved(id, removeInfo))
      );
    };
    world.registerDevice(this);
  }

  _findTabByUrl(url) {
    return Array.from(this.tabsApi.tabs.values()).find(
      (t) => this.engine.realUrlOfTab(t) === url
    );
  }

  // Opens a tab that completes navigation immediately (the common
  // case for tests). Returns the tab. `opts.groupId` simulates opening
  // directly into a browser tab group (Chrome/Brave tabGroups) —
  // omitted/-1 means ungrouped.
  async openTab(url, title, opts = {}) {
    const tab = await this.tabsApi.create({
      url,
      title,
      active: true,
      status: "complete",
      groupId: opts.groupId,
      pinned: opts.pinned,
    });
    await this.engine.handleTabUpdated(tab.id, { status: "complete" });
    await this.world.flush();
    return tab;
  }

  // Simulates dragging an already-open tab into (or out of, with
  // groupId -1) a browser tab group. Deliberately does NOT fire any
  // engine event: a real browser's tabs.onUpdated for a groupId change
  // never carries status "complete" (grouping doesn't reload the page),
  // so nothing reacts until some other live tab event triggers the next
  // reconcile — exactly what a test wants to exercise.
  setTabGroup(url, groupId) {
    const tab = this._findTabByUrl(url);
    if (!tab) throw new Error(`no tab open at ${url} on ${this.deviceName}`);
    tab.groupId = groupId;
  }

  // Creates (or reuses) an open, TITLED tab group in this device's
  // default window and returns its numeric id — for groups-core.js
  // tests that need a group to already exist before opening tabs into
  // it, distinct from setTabGroup's bare numeric-groupId version.
  ensureOpenGroup(title) {
    const existing = Array.from(this.tabGroupsApi.groups.values()).find(
      (g) => g.title === title
    );
    if (existing) return existing.id;
    const id = nextGroupId();
    this.tabGroupsApi.groups.set(id, {
      id,
      title,
      color: "grey",
      windowId: this.windowsApi.defaultWindowId,
    });
    return id;
  }

  // Opens a tab already inside a titled group (creating the group in
  // this window if it doesn't exist yet).
  async openGroupedTab(url, title, groupTitle) {
    const groupId = this.ensureOpenGroup(groupTitle);
    return this.openTab(url, title, { groupId });
  }

  // Opens a tab that's still mid-navigation (an intermediate URL,
  // status "loading") — for regression-testing the phantom-duplicate
  // guard. Follow up with finishNavigation().
  async openTabLoading(intermediateUrl) {
    const tab = await this.tabsApi.create({
      url: intermediateUrl,
      active: true,
      status: "loading",
    });
    // Deliberately do NOT call handleTabUpdated — a real "loading"
    // changeInfo never has status "complete", so nothing reacts yet.
    await this.world.flush();
    return tab;
  }

  async finishNavigation(tabId, finalUrl, title) {
    const tab = this.tabsApi.tabs.get(tabId);
    if (!tab) throw new Error(`no such tab ${tabId}`);
    tab.url = finalUrl;
    tab.status = "complete";
    if (title) tab.title = title;
    await this.engine.handleTabUpdated(tabId, { status: "complete" });
    await this.world.flush();
  }

  async closeTab(url) {
    const tab = this._findTabByUrl(url);
    if (!tab) return;
    await this.tabsApi.remove(tab.id);
    await this.world.flush();
  }

  // Simulates closing a whole window (or quitting the browser): every
  // tab fires onRemoved with isWindowClosing true, which must NEVER
  // propagate a close. Useful for the corresponding safety-rail test.
  async closeAllTabsAsWindowClosing() {
    const ids = Array.from(this.tabsApi.tabs.keys());
    await this.tabsApi.remove(ids, { isWindowClosing: true });
    await this.world.flush();
  }

  async navigateTab(fromUrl, toUrl, title) {
    const tab = this._findTabByUrl(fromUrl);
    if (!tab) throw new Error(`no tab open at ${fromUrl} on ${this.deviceName}`);
    tab.url = toUrl;
    tab.status = "complete";
    if (title) tab.title = title;
    await this.engine.handleTabUpdated(tab.id, { status: "complete" });
    await this.world.flush();
  }

  // Convenience batch operation: open several URLs and/or close
  // several, in one call — e.g.
  //   await device.updateTabs({ open: ["https://a.example/"], close: ["https://b.example/"] });
  async updateTabs({ open = [], close = [] } = {}) {
    for (const entry of open) {
      const { url, title } = typeof entry === "string" ? { url: entry } : entry;
      await this.openTab(url, title);
    }
    for (const url of close) {
      await this.closeTab(url);
    }
  }

  async tick() {
    await this.engine.handleAlarm();
    await this.world.flush();
  }

  async startup() {
    await this.engine.handleStartup();
    await this.world.flush();
  }

  async switchProfile(profile) {
    await this.storage.set({ activeProfile: profile });
    await this.engine.handleSwitchProfileAndSave();
    await this.world.flush();
  }

  async syncNow() {
    await this.engine.handleSyncNow();
    await this.world.flush();
  }

  // Currently-open (real, non-placeholder-pending) http(s) URLs this
  // device's tabs show.
  openUrls() {
    return Array.from(this.tabsApi.tabs.values())
      .map((t) => this.engine.realUrlOfTab(t))
      .filter((u) => /^https?:\/\//.test(u))
      .sort();
  }

  // This device's own status bookmark for `profile` (default: whatever's
  // active), one per URL folder it has weighed in on — [{real, state,
  // t, h}, ...].
  async myEntries(profile) {
    const p = profile || (await this.engine.getActiveProfile());
    const folder = await this.engine.getOrCreateProfileFolder(p);
    const tree = await this.engine.readProfileEntries(folder.id);
    const out = [];
    for (const [url, folderEntry] of tree) {
      const mine = folderEntry.devices.get(this.deviceName);
      if (mine && mine.length) out.push({ real: url, ...mine[0] });
    }
    return out;
  }
}

// ------------------------------------------------------------
// The world: the shared tree + device registry + deferred
// cross-device notification queue (so propagation is async, like a
// real bookmarks.onCreated/onChanged event, without needing real
// timers — tests just `await world.flush()`, which every SimDevice
// method already does for you).
// ------------------------------------------------------------
class SimWorld {
  constructor() {
    this.root = makeFolder("0", null, "");
    this.root.children.push(makeFolder("2", "0", "Other Bookmarks"));
    this.devices = [];
    this.pending = [];
  }

  bookmarksApiFor() {
    if (!this._bookmarksApi) this._bookmarksApi = new SimBookmarksApi(this);
    return this._bookmarksApi;
  }

  registerDevice(device) {
    this.devices.push(device);
  }

  // Simulates a device going permanently offline (uninstalled, or just
  // never coming back) — it stops reacting to any bookmark propagation
  // from other devices, but its own local tab state is untouched. Used
  // for TTL tests: without this, the world's "instant sync" simulation
  // would have every device react to every change, which is realistic
  // for devices that ARE online but doesn't let a test model "this
  // device is gone for good".
  disconnectDevice(device) {
    this.devices = this.devices.filter((d) => d !== device);
  }

  addDevice(opts) {
    return new SimDevice(this, opts);
  }

  _notifyEvent(event) {
    for (const dev of this.devices) {
      if (event.type === "removed") {
        this.pending.push(Promise.resolve().then(() => dev.engine.handleBookmarkRemoved()));
      } else {
        this.pending.push(
          Promise.resolve().then(() =>
            dev.engine.handleBookmarkEvent(event.title, event.url)
          )
        );
      }
    }
  }

  // Drains every scheduled cross-device reaction (and anything THOSE
  // reactions themselves schedule), so the world reaches a fixed point
  // before a test asserts anything.
  async flush() {
    let guard = 0;
    while (this.pending.length) {
      const batch = this.pending;
      this.pending = [];
      await Promise.all(batch);
      if (++guard > 1000) {
        throw new Error("SimWorld.flush(): possible infinite propagation loop");
      }
    }
  }

  // All (device, url) entries currently in a profile's folder, across
  // every device — for assertions about the shared state directly.
  async allEntries(profile) {
    // Any device's engine can resolve the folder; use the first one.
    if (!this.devices.length) return [];
    const engine = this.devices[0].engine;
    const folder = await engine.getOrCreateProfileFolder(profile);
    const tree = await engine.readProfileEntries(folder.id);
    const out = [];
    for (const [url, folderEntry] of tree) {
      for (const [device, list] of folderEntry.devices) {
        for (const entry of list) out.push({ real: url, device, ...entry });
      }
    }
    return out;
  }
}

module.exports = { SimWorld, SimDevice };
