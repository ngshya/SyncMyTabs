// Group RULES sync across devices via the SAME bookmark mechanism as
// everything else (SimWorld's one shared in-memory tree) — scoped by
// the same active-profile concept the rest of the extension uses.

const { test } = require("node:test");
const assert = require("node:assert/strict");
const { SimWorld } = require("./sim-env.js");
const { createGroupsEngine } = require("../groups-core.js");

function groupsEngineFor(device) {
  return createGroupsEngine(device.env, device.engine);
}

test("group rules set on one device are readable on another (same profile)", async () => {
  const world = new SimWorld();
  const a = world.addDevice({ deviceName: "A" });
  const b = world.addDevice({ deviceName: "B" });
  const ga = groupsEngineFor(a);
  const gb = groupsEngineFor(b);

  const rules = [
    { match: "*://example.com/*", pattern: "*://example.com/*", openUrl: "" },
    { match: "*://docs.example.com/*", pattern: "", openUrl: "https://docs.example.com/" },
  ];
  await ga.setGroupSettingsForActiveProfile("Work", rules);

  const seenOnB = await gb.getGroupForEditing("Work");
  assert.deepEqual(seenOnB.rules, rules);

  const titles = await gb.listGroupsForActiveProfile();
  assert.deepEqual(titles.titles, ["Work"]);
});

test("group rules are scoped to a profile: a device on a different profile doesn't see them", async () => {
  const world = new SimWorld();
  const a = world.addDevice({ deviceName: "A", activeProfile: "default" });
  const b = world.addDevice({ deviceName: "B", activeProfile: "work" });
  const ga = groupsEngineFor(a);
  const gb = groupsEngineFor(b);

  await ga.setGroupSettingsForActiveProfile("Research", [
    { match: "*://example.com/*", pattern: "*://example.com/*" },
  ]);

  const seenOnB = await gb.listGroupsForActiveProfile();
  assert.deepEqual(seenOnB.titles, []);
});

test("setGroupSettingsForActiveProfile with an empty rule list deletes the group", async () => {
  const world = new SimWorld();
  const a = world.addDevice({ deviceName: "A" });
  const ga = groupsEngineFor(a);

  await ga.setGroupSettingsForActiveProfile("Work", [
    { match: "*://example.com/*", pattern: "*://example.com/*" },
  ]);
  assert.deepEqual((await ga.listGroupsForActiveProfile()).titles, ["Work"]);

  await ga.setGroupSettingsForActiveProfile("Work", []);
  assert.deepEqual((await ga.listGroupsForActiveProfile()).titles, []);
});

test("deleteGroupSettingsForActiveProfile removes a group outright", async () => {
  const world = new SimWorld();
  const a = world.addDevice({ deviceName: "A" });
  const ga = groupsEngineFor(a);

  await ga.setGroupSettingsForActiveProfile("Work", [
    { match: "*://example.com/*", pattern: "*://example.com/*" },
  ]);
  await ga.deleteGroupSettingsForActiveProfile("Work");
  assert.deepEqual((await ga.listGroupsForActiveProfile()).titles, []);
});

test("a rule with no match is dropped defensively", async () => {
  const world = new SimWorld();
  const a = world.addDevice({ deviceName: "A" });
  const ga = groupsEngineFor(a);

  await ga.setGroupSettingsForActiveProfile("Work", [
    { match: "", pattern: "*://example.com/*" },
    { match: "*://example.com/*", pattern: "*://example.com/*" },
  ]);
  const settings = await ga.getGroupForEditing("Work");
  assert.deepEqual(settings.rules, [
    { match: "*://example.com/*", pattern: "*://example.com/*", openUrl: "" },
  ]);
});

test("a duplicate group folder (third-party sync race) is merged on read", async () => {
  const world = new SimWorld();
  const a = world.addDevice({ deviceName: "A" });
  const ga = groupsEngineFor(a);

  const profileFolderId = (await a.engine.getOrCreateProfileFolder("default")).id;
  const root = await a.env.bookmarks.create({ parentId: profileFolderId, title: "_groups" });
  const dup1 = await a.env.bookmarks.create({ parentId: root.id, title: "Work" });
  await a.env.bookmarks.create({
    parentId: dup1.id,
    title: "*://a.example/*",
    url: require("../groups-core.js").buildGroupRuleUrl({ match: "*://a.example/*", pattern: "*://a.example/*" }),
  });
  const dup2 = await a.env.bookmarks.create({ parentId: root.id, title: "Work" });
  await a.env.bookmarks.create({
    parentId: dup2.id,
    title: "*://b.example/*",
    url: require("../groups-core.js").buildGroupRuleUrl({ match: "*://b.example/*", pattern: "*://b.example/*" }),
  });

  const titles = await ga.getAllGroupTitles(profileFolderId);
  assert.deepEqual(titles, ["Work"], "duplicate group folders must be merged, not listed twice");
  const settings = await ga.readGroupSettings(profileFolderId, "Work");
  assert.equal(settings.rules.length, 2);
});

test("groups_root folder doesn't interfere with sync-core's own URL-folder reconcile", async () => {
  const world = new SimWorld();
  const a = world.addDevice({ deviceName: "A" });
  const b = world.addDevice({ deviceName: "B" });
  const ga = groupsEngineFor(a);

  await ga.setGroupSettingsForActiveProfile("Work", [
    { match: "*://example.com/*", pattern: "*://example.com/*" },
  ]);

  // Ordinary tab sync must still work fine with a "_groups" sibling
  // folder present under the same profile.
  await a.openTab("https://real-tab.example/");
  assert.deepEqual(b.openUrls(), ["https://real-tab.example/"]);
});
