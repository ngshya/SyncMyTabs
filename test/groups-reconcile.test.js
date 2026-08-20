// Startup reconciliation: reopen a group's missing "essential" (openUrl)
// tabs, close duplicates that cover the same essential rule, and
// (opt-in) close tabs that match none of the group's rules at all.

const { test } = require("node:test");
const assert = require("node:assert/strict");
const { SimWorld } = require("./sim-env.js");
const { createGroupsEngine } = require("../groups-core.js");

function groupsEngineFor(device) {
  return createGroupsEngine(device.env, device.engine);
}

test("a missing essential tab is reopened into the existing open group", async () => {
  const world = new SimWorld();
  const a = world.addDevice({ deviceName: "A" });
  const ga = groupsEngineFor(a);

  await ga.setGroupSettingsForActiveProfile("Work", [
    { pattern: "*://mail.example/*", openUrl: "https://mail.example/inbox" },
  ]);
  const groupId = a.ensureOpenGroup("Work");

  await ga.reconcileGroups();

  const tabs = await a.tabsApi.query();
  const mailTab = tabs.find((t) => t.url === "https://mail.example/inbox");
  assert.ok(mailTab, "the essential tab should have been reopened");
  assert.equal(mailTab.groupId, groupId, "reopened into the SAME already-open group");
});

test("a group not open anywhere is recreated from the reopened essential tabs", async () => {
  const world = new SimWorld();
  const a = world.addDevice({ deviceName: "A" });
  const ga = groupsEngineFor(a);

  await ga.setGroupSettingsForActiveProfile("Work", [
    { pattern: "*://mail.example/*", openUrl: "https://mail.example/inbox" },
  ]);

  await ga.reconcileGroups();

  const groups = await a.tabGroupsApi.query({});
  const workGroup = groups.find((g) => g.title === "Work");
  assert.ok(workGroup, "the group should have been recreated");

  const tabs = await a.tabsApi.query();
  const mailTab = tabs.find((t) => t.url === "https://mail.example/inbox");
  assert.equal(mailTab.groupId, workGroup.id);
});

test("a tab that already satisfies an essential rule is left alone, nothing reopened", async () => {
  const world = new SimWorld();
  const a = world.addDevice({ deviceName: "A" });
  const ga = groupsEngineFor(a);

  await ga.setGroupSettingsForActiveProfile("Work", [
    { pattern: "*://mail.example/*", openUrl: "https://mail.example/inbox" },
  ]);
  await a.openGroupedTab("https://mail.example/inbox?x=1", "Inbox", "Work");

  await ga.reconcileGroups();

  const tabs = await a.tabsApi.query();
  const matching = tabs.filter((t) => t.url && t.url.startsWith("https://mail.example/"));
  assert.equal(matching.length, 1, "the already-open tab satisfies the rule; nothing new should open");
});

test("duplicate tabs covering the same essential rule: keep the leftmost, close the rest", async () => {
  const world = new SimWorld();
  const a = world.addDevice({ deviceName: "A" });
  const ga = groupsEngineFor(a);

  await ga.setGroupSettingsForActiveProfile("Work", [
    { pattern: "*://mail.example/*", openUrl: "https://mail.example/inbox" },
  ]);
  const first = await a.openGroupedTab("https://mail.example/a", "First", "Work");
  await a.openGroupedTab("https://mail.example/b", "Second", "Work");

  await ga.reconcileGroups();

  const tabs = await a.tabsApi.query();
  const matching = tabs.filter((t) => t.url && t.url.startsWith("https://mail.example/"));
  assert.equal(matching.length, 1, "only the leftmost (lowest index) duplicate should survive");
  assert.equal(matching[0].id, first.id);
});

test("closeUndeclaredTabs=false (default) leaves an unrelated tab in the group alone", async () => {
  const world = new SimWorld();
  const a = world.addDevice({ deviceName: "A" });
  const ga = groupsEngineFor(a);

  await ga.setGroupSettingsForActiveProfile("Work", [
    { pattern: "*://mail.example/*", openUrl: "https://mail.example/inbox" },
  ]);
  await a.openGroupedTab("https://mail.example/inbox", "Inbox", "Work");
  await a.openGroupedTab("https://random.example/", "Random", "Work");

  await ga.reconcileGroups();

  const tabs = await a.tabsApi.query();
  assert.ok(tabs.some((t) => t.url === "https://random.example/"), "undeclared tab must survive by default");
});

test("closeUndeclaredTabs=true closes a tab matching NO rule at all in that group", async () => {
  const world = new SimWorld();
  const a = world.addDevice({
    deviceName: "A",
    storage: { groupsCloseUndeclaredTabs: true },
  });
  const ga = groupsEngineFor(a);

  await ga.setGroupSettingsForActiveProfile("Work", [
    { pattern: "*://mail.example/*", openUrl: "https://mail.example/inbox" },
  ]);
  await a.openGroupedTab("https://mail.example/inbox", "Inbox", "Work");
  await a.openGroupedTab("https://random.example/", "Random", "Work");

  await ga.reconcileGroups();

  const tabs = await a.tabsApi.query();
  assert.ok(!tabs.some((t) => t.url === "https://random.example/"), "undeclared tab should be closed");
  assert.ok(tabs.some((t) => t.url === "https://mail.example/inbox"), "the declared tab must survive");
});

test("a group with zero saved rules is completely untouched by reconcile", async () => {
  const world = new SimWorld();
  const a = world.addDevice({ deviceName: "A" });
  const ga = groupsEngineFor(a);

  // No setGroupSettingsForActiveProfile call at all — group has no
  // saved rules; reconcileGroups must not error or touch anything.
  a.ensureOpenGroup("Untouched");
  await ga.reconcileGroups();

  const tabs = await a.tabsApi.query();
  assert.equal(tabs.length, 0);
});

test("reconcileGroups is a silent no-op on Firefox (no env.tabGroups)", async () => {
  const world = new SimWorld();
  const a = world.addDevice({ deviceName: "A" });
  const firefoxEnv = { ...a.env, tabGroups: undefined };
  const gaFirefox = createGroupsEngine(firefoxEnv, a.engine);

  const ga = groupsEngineFor(a);
  await ga.setGroupSettingsForActiveProfile("Work", [
    { pattern: "*://mail.example/*", openUrl: "https://mail.example/inbox" },
  ]);

  await gaFirefox.reconcileGroups(); // must not throw
  const tabs = await a.tabsApi.query();
  assert.equal(tabs.length, 0, "nothing should have been opened without a tabGroups API");
});

test("reconcileGroups is a no-op while the master sync switch is off", async () => {
  const world = new SimWorld();
  const a = world.addDevice({ deviceName: "A", storage: { syncEnabled: false } });
  const ga = groupsEngineFor(a);

  await ga.setGroupSettingsForActiveProfile("Work", [
    { pattern: "*://mail.example/*", openUrl: "https://mail.example/inbox" },
  ]);
  await ga.reconcileGroups();

  const tabs = await a.tabsApi.query();
  assert.equal(tabs.length, 0);
});

test("reconcileGroups only touches the ACTIVE profile's groups", async () => {
  const world = new SimWorld();
  const a = world.addDevice({ deviceName: "A", activeProfile: "default" });
  const ga = groupsEngineFor(a);

  const profileFolderId = (await a.engine.getOrCreateProfileFolder("work")).id;
  await ga.setGroupSettings(profileFolderId, "Work", [
    { pattern: "*://mail.example/*", openUrl: "https://mail.example/inbox" },
  ]);

  await ga.reconcileGroups(); // active profile is "default", not "work"

  const tabs = await a.tabsApi.query();
  assert.equal(tabs.length, 0, "a different profile's essential tab must not be opened");
});

test("pinGroupsToStart=false (default) never repositions a group", async () => {
  const world = new SimWorld();
  const a = world.addDevice({ deviceName: "A" });
  const ga = groupsEngineFor(a);

  await ga.setGroupSettingsForActiveProfile("Work", [
    { pattern: "*://mail.example/*", openUrl: "https://mail.example/inbox" },
  ]);
  const groupId = a.ensureOpenGroup("Work");

  await ga.reconcileGroups();

  const group = await a.tabGroupsApi.get(groupId);
  assert.equal(group.position, undefined, "no move() call should have happened");
});

test("pinGroupsToStart=true moves an already-open group to index 0", async () => {
  const world = new SimWorld();
  const a = world.addDevice({
    deviceName: "A",
    storage: { groupsPinToStart: true },
  });
  const ga = groupsEngineFor(a);

  await ga.setGroupSettingsForActiveProfile("Work", [
    { pattern: "*://mail.example/*", openUrl: "https://mail.example/inbox" },
  ]);
  const groupId = a.ensureOpenGroup("Work");

  await ga.reconcileGroups();

  const group = await a.tabGroupsApi.get(groupId);
  assert.equal(group.position, 0);
});

test("pinGroupsToStart=true also pins a group it just recreated from scratch", async () => {
  const world = new SimWorld();
  const a = world.addDevice({
    deviceName: "A",
    storage: { groupsPinToStart: true },
  });
  const ga = groupsEngineFor(a);

  await ga.setGroupSettingsForActiveProfile("Work", [
    { pattern: "*://mail.example/*", openUrl: "https://mail.example/inbox" },
  ]);

  await ga.reconcileGroups();

  const groups = await a.tabGroupsApi.query({});
  const workGroup = groups.find((g) => g.title === "Work");
  assert.equal(workGroup.position, 0);
});

test("pinGroupsToStart=true stacks multiple pinned groups in title order, not fighting over index 0", async () => {
  const world = new SimWorld();
  const a = world.addDevice({
    deviceName: "A",
    storage: { groupsPinToStart: true },
  });
  const ga = groupsEngineFor(a);

  await ga.setGroupSettingsForActiveProfile("Chats", [
    { pattern: "*://chat.example/*", openUrl: "https://chat.example/inbox" },
  ]);
  await ga.setGroupSettingsForActiveProfile("Work", [
    { pattern: "*://mail.example/*", openUrl: "https://mail.example/inbox" },
  ]);
  a.ensureOpenGroup("Chats");
  a.ensureOpenGroup("Work");

  await ga.reconcileGroups();

  const groups = await a.tabGroupsApi.query({});
  const chats = groups.find((g) => g.title === "Chats");
  const work = groups.find((g) => g.title === "Work");
  assert.equal(chats.position, 0, "alphabetically first");
  assert.equal(work.position, 1, "alphabetically second");
});
