// Link-leashing: a click inside a titled tab group either navigates in
// place / opens alongside in the SAME group when it matches the tab's
// resolved pattern, or always opens in a fresh UNGROUPED tab otherwise.
// A non-grouped tab, an untitled group, or leashing turned off all fall
// back to ordinary browser behavior (fallbackOpen).

const { test } = require("node:test");
const assert = require("node:assert/strict");
const { SimWorld } = require("./sim-env.js");
const { createGroupsEngine } = require("../groups-core.js");
const { groupsEngineFor } = require("./groups-test-helpers.js");

test("a link matching the tab's pattern navigates the SAME tab in place", async () => {
  const world = new SimWorld();
  const a = world.addDevice({ deviceName: "A" });
  const ga = groupsEngineFor(a);

  await ga.setGroupSettingsForActiveProfile("Work", [
    { pattern: "*://example.com/*" },
  ]);
  const tab = await a.openGroupedTab("https://example.com/a", "A", "Work");

  await ga.handleLinkClick("https://example.com/b", tab, {});

  const tabs = await a.tabsApi.query();
  assert.equal(tabs.length, 1, "no new tab should have been created");
  assert.equal(tabs[0].url, "https://example.com/b");
});

test("a link NOT matching the tab's pattern always opens a fresh UNGROUPED tab", async () => {
  const world = new SimWorld();
  const a = world.addDevice({ deviceName: "A" });
  const ga = groupsEngineFor(a);

  await ga.setGroupSettingsForActiveProfile("Work", [
    { pattern: "*://example.com/*" },
  ]);
  const tab = await a.openGroupedTab("https://example.com/a", "A", "Work");

  await ga.handleLinkClick("https://outside.example/", tab, {});

  const tabs = await a.tabsApi.query();
  assert.equal(tabs.length, 2);
  const original = tabs.find((t) => t.id === tab.id);
  assert.equal(original.url, "https://example.com/a", "the original tab must be untouched");
  const created = tabs.find((t) => t.id !== tab.id);
  assert.equal(created.url, "https://outside.example/");
  assert.equal(created.groupId, -1, "the new tab must be ungrouped");
});

test("ctrl/cmd-click on a matching link opens alongside, in the SAME group", async () => {
  const world = new SimWorld();
  const a = world.addDevice({ deviceName: "A" });
  const ga = groupsEngineFor(a);

  await ga.setGroupSettingsForActiveProfile("Work", [
    { pattern: "*://example.com/*" },
  ]);
  const tab = await a.openGroupedTab("https://example.com/a", "A", "Work");

  await ga.handleLinkClick("https://example.com/b", tab, { newTab: true, background: true });

  const tabs = await a.tabsApi.query();
  assert.equal(tabs.length, 2);
  const created = tabs.find((t) => t.id !== tab.id);
  assert.equal(created.url, "https://example.com/b");
  assert.equal(created.groupId, tab.groupId, "must land in the same group as the tab it was clicked from");
});

test("a tab NOT in any group is unaffected: normal fallback behavior", async () => {
  const world = new SimWorld();
  const a = world.addDevice({ deviceName: "A" });
  const ga = groupsEngineFor(a);

  const tab = await a.openTab("https://example.com/a");
  await ga.handleLinkClick("https://outside.example/", tab, {});

  const tabs = await a.tabsApi.query();
  assert.equal(tabs.length, 1, "same-tab navigation is the fallback for an ungrouped tab");
  assert.equal(tabs[0].url, "https://outside.example/");
});

test("an untitled group has no stable cross-device key: treated as unleashed", async () => {
  const world = new SimWorld();
  const a = world.addDevice({ deviceName: "A" });
  const ga = groupsEngineFor(a);

  const groupId = a.tabGroupsApi._ensureGroup(99, a.windowsApi.defaultWindowId).id;
  const tab = await a.openTab("https://example.com/a", "A", { groupId });

  await ga.handleLinkClick("https://outside.example/", tab, {});
  const tabs = await a.tabsApi.query();
  assert.equal(tabs.length, 1, "untitled group => fallback (same-tab navigation), no leashing");
  assert.equal(tabs[0].url, "https://outside.example/");
});

test("a group with no rule for the tab's current page falls back too", async () => {
  const world = new SimWorld();
  const a = world.addDevice({ deviceName: "A" });
  const ga = groupsEngineFor(a);
  // "Work" group exists but has no rule covering example.com at all.
  await ga.setGroupSettingsForActiveProfile("Work", [
    { pattern: "*://other.com/*" },
  ]);
  const tab = await a.openGroupedTab("https://example.com/a", "A", "Work");

  await ga.handleLinkClick("https://outside.example/", tab, {});
  const tabs = await a.tabsApi.query();
  assert.equal(tabs.length, 1);
  assert.equal(tabs[0].url, "https://outside.example/");
});

test("ctrl/cmd/middle-click on a link, when no rule covers the tab's current page, opens ungrouped too (fallbackOpen must not inherit the group)", async () => {
  const world = new SimWorld();
  const a = world.addDevice({ deviceName: "A" });
  const ga = groupsEngineFor(a);
  // "Work" group exists but has no rule covering example.com at all, so
  // resolvePatternFor(tab) returns null and handleLinkClick falls back
  // to fallbackOpen — the newTab path there used to create the tab at
  // `index: tab.index + 1`, which the browser can silently auto-join to
  // the SAME group purely from that adjacency, with no leashing decision
  // involved. A link with nothing to leash against must never end up
  // grouped that way; see CLAUDE.md/groups-core.js's fallbackOpen.
  await ga.setGroupSettingsForActiveProfile("Work", [
    { pattern: "*://other.com/*" },
  ]);
  const tab = await a.openGroupedTab("https://example.com/a", "A", "Work");

  await ga.handleLinkClick("https://outside.example/", tab, {
    newTab: true,
    background: true,
  });

  const tabs = await a.tabsApi.query();
  assert.equal(tabs.length, 2, "a new tab must have been created, not a same-tab navigation");
  const original = tabs.find((t) => t.id === tab.id);
  assert.equal(original.url, "https://example.com/a", "the original tab must be untouched");
  const created = tabs.find((t) => t.id !== tab.id);
  assert.equal(created.url, "https://outside.example/");
  assert.equal(created.groupId, -1, "the new tab must NOT have inherited the opener's group");
});

test("leashing disabled (groupsLeashEnabled=false) always falls back, even with a matching rule", async () => {
  const world = new SimWorld();
  const a = world.addDevice({ deviceName: "A", storage: { groupsLeashEnabled: false } });
  const ga = groupsEngineFor(a);

  await ga.setGroupSettingsForActiveProfile("Work", [
    { pattern: "*://example.com/*" },
  ]);
  const tab = await a.openGroupedTab("https://example.com/a", "A", "Work");

  await ga.handleLinkClick("https://outside.example/", tab, {});
  const tabs = await a.tabsApi.query();
  assert.equal(tabs.length, 1, "with leashing off, even an out-of-pattern link just navigates in place");
  assert.equal(tabs[0].url, "https://outside.example/");
});

test("an openUrl-only rule (no pattern) leaves the tab unleashed", async () => {
  const world = new SimWorld();
  const a = world.addDevice({ deviceName: "A" });
  const ga = groupsEngineFor(a);

  await ga.setGroupSettingsForActiveProfile("Work", [
    { openUrl: "https://example.com/" },
  ]);
  const tab = await a.openGroupedTab("https://example.com/a", "A", "Work");

  await ga.handleLinkClick("https://outside.example/", tab, {});
  const tabs = await a.tabsApi.query();
  assert.equal(tabs.length, 1, "openUrl-only rule has no pattern to leash against");
  assert.equal(tabs[0].url, "https://outside.example/");
});

test("getLeashInfoFor reports grouped+pattern for a matching tab (for the content script's sync cache)", async () => {
  const world = new SimWorld();
  const a = world.addDevice({ deviceName: "A" });
  const ga = groupsEngineFor(a);

  await ga.setGroupSettingsForActiveProfile("Work", [{ pattern: "*://example.com/*" }]);
  const tab = await a.openGroupedTab("https://example.com/a", "A", "Work");

  assert.deepEqual(await ga.getLeashInfoFor(tab), {
    grouped: true,
    pattern: "*://example.com/*",
  });
});

test("getLeashInfoFor reports grouped but no pattern when no rule covers the page", async () => {
  const world = new SimWorld();
  const a = world.addDevice({ deviceName: "A" });
  const ga = groupsEngineFor(a);

  const tab = await a.openGroupedTab("https://example.com/a", "A", "Work");
  assert.deepEqual(await ga.getLeashInfoFor(tab), { grouped: true, pattern: null });
});

test("getLeashInfoFor reports not grouped for an ungrouped tab, without touching bookmarks", async () => {
  const world = new SimWorld();
  const a = world.addDevice({ deviceName: "A" });
  const ga = groupsEngineFor(a);

  const tab = await a.openTab("https://example.com/a");
  assert.deepEqual(await ga.getLeashInfoFor(tab), { grouped: false, pattern: null });
});

test("getLeashInfoFor respects the leashing on/off switch", async () => {
  const world = new SimWorld();
  const a = world.addDevice({ deviceName: "A", storage: { groupsLeashEnabled: false } });
  const ga = groupsEngineFor(a);

  await ga.setGroupSettingsForActiveProfile("Work", [{ pattern: "*://example.com/*" }]);
  const tab = await a.openGroupedTab("https://example.com/a", "A", "Work");

  assert.deepEqual(await ga.getLeashInfoFor(tab), { grouped: false, pattern: null });
});

test("on Firefox (no env.tabGroups at all) every click is a plain fallback, no crash", async () => {
  const world = new SimWorld();
  const a = world.addDevice({ deviceName: "A" });
  const firefoxEnv = { ...a.env, tabGroups: undefined };
  const ga = createGroupsEngine(firefoxEnv, a.engine);

  const tab = await a.openTab("https://example.com/a");
  await ga.handleLinkClick("https://outside.example/", tab, {});
  const tabs = await a.tabsApi.query();
  assert.equal(tabs.length, 1);
  assert.equal(tabs[0].url, "https://outside.example/");
});
