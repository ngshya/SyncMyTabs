// Regression test for a real, browser-only bug the simulator can't
// catch (same class as no-name-collision.test.js): GROUPS_RECONCILE_ALARM
// was only ever (re-)armed from background.js's onStartup listener and
// from ensureGroupsAlarmPeriod() (called on a syncIntervalMinutes
// change) — never from onInstalled. onInstalled fires on a fresh
// install AND on every extension update/reload, none of which
// necessarily involve a real browser restart (only onStartup does) — so
// a user who installs/updates without also restarting their browser
// never got the alarm created at all: the automatic periodic tab-groups
// reconcile silently never ran on its configured check interval, even
// though the settings said it should (only the popup's manual
// "Reconcile groups now" button worked). saveTabsAlarm doesn't have
// this gap (ensureAlarm() is called from onInstalled already) — this
// test asserts groups' alarm gets the same treatment.
//
// This can't be exercised through sim-env.js (browser.alarms isn't
// modeled there), so — like no-name-collision.test.js — this does the
// next best thing: statically checks that onInstalled's handler body
// actually arms GROUPS_RECONCILE_ALARM (via ensureGroupsAlarmPeriod()),
// not just saveTabsAlarm.

const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const src = fs.readFileSync(path.join(__dirname, "..", "background.js"), "utf8");

function extractListenerBody(eventName) {
  const start = src.indexOf(`${eventName}.addListener`);
  assert.ok(start !== -1, `${eventName}.addListener not found in background.js`);
  // The next top-level `browser.` listener registration marks the end
  // of this one's body — good enough for this file's consistent style.
  const nextListener = src.indexOf("\nbrowser.", start + 1);
  return src.slice(start, nextListener === -1 ? undefined : nextListener);
}

test("onInstalled arms GROUPS_RECONCILE_ALARM, not just saveTabsAlarm", () => {
  const body = extractListenerBody("browser.runtime.onInstalled");
  assert.match(
    body,
    /ensureGroupsAlarmPeriod\(\)/,
    "onInstalled must also call ensureGroupsAlarmPeriod() so the tab-groups " +
      "reconcile alarm exists after an install/update that isn't followed " +
      "by a real browser restart, exactly like ensureAlarm() already does " +
      "for saveTabsAlarm"
  );
  assert.match(body, /ensureAlarm\(\)/, "onInstalled must still arm saveTabsAlarm too");
});

test("onStartup still (re-)arms GROUPS_RECONCILE_ALARM on a real browser restart", () => {
  const body = extractListenerBody("browser.runtime.onStartup");
  assert.match(body, /GROUPS_RECONCILE_ALARM/);
});
