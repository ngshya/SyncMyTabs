// Shared one-liner for groups-core.js tests. Deliberately NOT part of
// sim-env.js: groups-core.js is a separate module from sync-core.js's
// own engine (see CLAUDE.md's Testing section), and sim-env.js stays
// decoupled from it — this file is the shared exception for tests that
// need both, so the three groups-*.test.js files that used to each
// define this identically don't have to anymore.

const { createGroupsEngine } = require("../groups-core.js");

function groupsEngineFor(device) {
  return createGroupsEngine(device.env, device.engine);
}

module.exports = { groupsEngineFor };
