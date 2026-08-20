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
class SimTabsApi {
  constructor() {
    this.tabs = new Map();
  }

  async query() {
    return Array.from(this.tabs.values()).map((t) => ({ ...t }));
  }

  async create({ url, title, active, windowId, status, groupId, pinned }) {
    const id = nextId();
    const tab = {
      id,
      url,
      pendingUrl: undefined,
      title: title || url,
      status: status || "complete",
      active: !!active,
      windowId: windowId || "1",
      groupId: groupId === undefined ? -1 : groupId,
      pinned: !!pinned,
    };
    this.tabs.set(id, tab);
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
      if (!this.tabs.has(id)) continue;
      this.tabs.delete(id);
      if (this.onRemoved) this.onRemoved(id, removeInfo);
    }
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

  // chrome.tabGroups.move()-alike. The simulator doesn't model full tab-
  // strip adjacency/reordering (no other test needs that level of
  // fidelity) — it just records the requested position on the group
  // itself, which tests read back directly to verify pinning behavior.
  async move(id, { index, windowId } = {}) {
    const g = this.groups.get(id);
    if (!g) throw new Error(`no such group ${id}`);
    g.position = index;
    if (windowId !== undefined) g.windowId = windowId;
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
  constructor(world, { deviceName, activeProfile = "default", storage = {} }) {
    this.world = world;
    this.deviceName = deviceName;
    this.tabsApi = new SimTabsApi();
    this.tabGroupsApi = new SimTabGroupsApi(this.tabsApi);
    this.tabsApi.tabGroupsApi = this.tabGroupsApi;
    this.windowsApi = new SimWindowsApi(this.tabsApi);
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
