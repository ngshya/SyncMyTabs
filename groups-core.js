// ============================================================
// SyncMyTabs - groups-core.js
//
// Independent module: tab-group "leashing" (a link clicked inside a
// titled browser tab group either navigates in place / opens alongside
// in the SAME group if it matches that tab's configured pattern, or
// always opens in a fresh UNGROUPED tab otherwise) plus startup
// reconciliation (reopen a group's missing "essential" tabs, close
// duplicates, optionally close undeclared ones). Ported from the
// standalone TabGroupsLeash extension, but — per the request that
// motivated this module — using SyncMyTabs' own bookmark mechanism as
// the cross-device transport for group RULES instead of
// chrome.storage.sync, and scoped by the SAME profile concept as the
// rest of the extension: each profile has its own independent set of
// group definitions. See CLAUDE.md's "Tab-group leashing" section.
//
// Parameterized the same way as sync-core.js: takes `env` (the
// WebExtension-shaped bookmarks/tabs/tabGroups/windows/storage object)
// PLUS the already-created sync engine instance (`syncEngine`, i.e.
// createSyncEngine(env)'s return value), reused here for
// getActiveProfile/getOrCreateProfileFolder/mergeFolderInto/
// isSyncEnabled rather than re-implementing them. Plain script, no
// import/export syntax — loaded via importScripts/background.scripts
// like sync-core.js; module.exports at the bottom is a Node-only no-op
// elsewhere.
//
// Cross-browser note: `tabGroups` is a Chrome/Brave-only API (Firefox
// exposes no tab-group API to extensions at all, matching sync-core.js's
// isInTabGroup/CLAUDE.md note). Every function here feature-detects
// `env.tabGroups` and no-ops when it's absent, so this module is a
// silent no-op on Firefox — never assumed to exist.
// ============================================================

// Bookmark tree shape (see CLAUDE.md), under each profile folder,
// SIBLING to the per-URL folders (and ignored by sync-core.js's
// readProfileEntries, which only ever recognizes a folder that has its
// own `_url` marker child — a "_groups" folder never does):
//   SyncMyTabs/<profile>/_groups/<group title>/<one bookmark per rule>
// A rule bookmark's title is its own "pattern" (or, for an openUrl-only
// rule, its openUrl — human-readable in a plain bookmark manager); the
// actual rule data is packed into the bookmark's url
// (buildGroupRuleUrl/parseGroupRuleUrl) — same URLSearchParams-based
// encoding style as sync-core.js's device status bookmarks. Group
// titles are the stable cross-device key (a browser's own tabGroups id
// is local-only and meaningless on another device) — an UNTITLED group
// has no such key and is deliberately unsupported here, exactly as the
// original TabGroupsLeash documents for its own "no reliable sync key"
// reason.
//
// A rule has just two fields: `pattern` (what a clicked link must match
// to stay in-group — see resolvePatternForTab — AND, doubling as the
// "which page is this rule for" check, what decides which rule covers
// the tab's CURRENT page in the first place) and `openUrl` (the exact
// URL the startup reconcile reopens if nothing matching is currently
// open). The original TabGroupsLeash (and this module's own first
// version) had a THIRD field, "match", separate from "pattern" —
// letting a rule apply to a narrower or broader set of pages than the
// links it leashes to. That split turned out to be a real footgun in
// practice (a rule silently failing to resolve for a page because
// "match" and "pattern" had drifted out of sync) with no correspondingly
// strong use case, so it's gone: one field does both jobs. An
// openUrl-only rule (no pattern at all) still works exactly as before —
// it just never resolves for ANY tab (nothing to leash), existing purely
// as a startup "make sure this exact URL is open somewhere" declaration.
const GROUPS_ROOT_TITLE = "_groups";
const GROUP_RULE_URL_BASE = "https://syncmytabs.local/group-rule";
const DEFAULT_STARTUP_DELAY_SECONDS = 15;

function buildGroupRuleUrl({ pattern, openUrl }) {
  const params = new URLSearchParams();
  if (pattern) params.set("p", pattern);
  if (openUrl) params.set("o", openUrl);
  return `${GROUP_RULE_URL_BASE}?${params.toString()}`;
}

function parseGroupRuleUrl(url) {
  if (!url || !url.startsWith(GROUP_RULE_URL_BASE)) return null;
  try {
    const p = new URL(url).searchParams;
    const rule = {
      pattern: p.get("p") || "",
      openUrl: p.get("o") || "",
    };
    if (!rule.pattern && !rule.openUrl) return null;
    return rule;
  } catch (e) {
    return null;
  }
}

// ------------------------------------------------------------
// Pattern matching — pure, no env needed. Ported verbatim in behavior
// from TabGroupsLeash's common.js.
// ------------------------------------------------------------

// Converts a "glob" pattern (with *) into a RegExp. A "regex:" prefix
// switches to an advanced, raw regex pattern instead.
function globToRegExp(glob) {
  const escaped = glob.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*");
  return new RegExp("^" + escaped + "$");
}

function matchesPattern(url, pattern) {
  if (!pattern) return false;
  try {
    if (pattern.startsWith("regex:")) {
      return new RegExp(pattern.slice(6)).test(url);
    }
    return globToRegExp(pattern).test(url);
  } catch (e) {
    return false;
  }
}

// Suggested pattern for a specific page: domain + full path (every path
// segment kept, query string and fragment dropped).
function defaultPatternForUrl(url) {
  try {
    const u = new URL(url);
    return `*://${u.hostname}${u.pathname}*`;
  } catch (e) {
    return "*";
  }
}

// Finds the most specific rule (longest "pattern" wins) whose "pattern"
// covers the given tab URL. `groupSettings` is the {rules: [...]} shape
// readGroupSettings returns. An openUrl-only rule (no pattern at all)
// never participates here — see the file header comment.
function findRuleForTabUrl(groupSettings, tabUrl) {
  if (!groupSettings || !Array.isArray(groupSettings.rules)) return null;
  let best = null;
  for (const rule of groupSettings.rules) {
    if (rule.pattern && matchesPattern(tabUrl, rule.pattern)) {
      if (!best || rule.pattern.length > best.pattern.length) best = rule;
    }
  }
  return best;
}

// The pattern clicked links in this tab must match, or null when no
// rule covers this tab's current page yet (an unleashed tab) — callers
// should treat null as "leave it alone", not "block".
function resolvePatternForTab(groupSettings, tabUrl) {
  const rule = findRuleForTabUrl(groupSettings, tabUrl);
  return rule ? rule.pattern : null;
}

// Whether a tab's URL satisfies a rule for presence-checking purposes
// (used by reconcileGroup's missing/duplicate detection, and the
// closeUndeclaredTabs check): matches its pattern if it has one, else
// falls back to an exact match against openUrl (an openUrl-only rule
// has nothing else to check presence against).
function tabSatisfiesRule(tabUrl, rule) {
  if (!tabUrl || !rule) return false;
  if (rule.pattern) return matchesPattern(tabUrl, rule.pattern);
  if (rule.openUrl) return tabUrl === rule.openUrl;
  return false;
}

// ------------------------------------------------------------
// The engine: bookmark-backed group settings, link leashing, and
// startup reconciliation.
// ------------------------------------------------------------
function createGroupsEngine(env, syncEngine) {
  const TAB_GROUP_ID_NONE = -1;

  function isGrouped(tab) {
    return typeof tab.groupId === "number" && tab.groupId !== TAB_GROUP_ID_NONE;
  }

  // ---- bookmark-backed group settings storage ----
  // Mirrors sync-core.js's own root/profile-folder find-or-create +
  // duplicate-merge pattern (mergeFolderInto, reused from syncEngine),
  // just one level scoped further down (profile -> "_groups" -> title).

  async function findGroupsRootFolder(profileFolderId) {
    const children = await env.bookmarks.getChildren(profileFolderId);
    const matches = children.filter((c) => !c.url && c.title === GROUPS_ROOT_TITLE);
    if (matches.length === 0) return null;
    if (matches.length === 1) return matches[0];
    matches.sort((a, b) => (a.dateAdded || 0) - (b.dateAdded || 0));
    const [canonical, ...dups] = matches;
    for (const d of dups) await syncEngine.mergeFolderInto(d.id, canonical.id);
    return canonical;
  }

  async function getOrCreateGroupsRootFolder(profileFolderId) {
    const found = await findGroupsRootFolder(profileFolderId);
    if (found) return found;
    return env.bookmarks.create({ parentId: profileFolderId, title: GROUPS_ROOT_TITLE });
  }

  async function findGroupFolder(groupsRootId, title) {
    const children = await env.bookmarks.getChildren(groupsRootId);
    const matches = children.filter((c) => !c.url && c.title === title);
    if (matches.length === 0) return null;
    if (matches.length === 1) return matches[0];
    matches.sort((a, b) => (a.dateAdded || 0) - (b.dateAdded || 0));
    const [canonical, ...dups] = matches;
    for (const d of dups) await syncEngine.mergeFolderInto(d.id, canonical.id);
    return canonical;
  }

  // Every known group title for a profile — a title only exists here
  // while it has at least one saved rule (see setGroupSettings).
  // Self-heals duplicate same-titled folders (a third-party sync race)
  // as a side effect, same spirit as sync-core.js's readProfileEntries.
  async function getAllGroupTitles(profileFolderId) {
    const root = await findGroupsRootFolder(profileFolderId);
    if (!root) return [];
    const children = await env.bookmarks.getChildren(root.id);
    const rawTitles = children.filter((c) => !c.url).map((c) => c.title);
    const uniqueTitles = Array.from(new Set(rawTitles)).sort((a, b) => a.localeCompare(b));
    for (const t of uniqueTitles) await findGroupFolder(root.id, t); // triggers merge if duplicated
    return uniqueTitles;
  }

  // Read-only — deliberately never creates anything (this is called on
  // every leashed link click, so it must stay cheap and side-effect-free
  // for the overwhelmingly common case of an unconfigured/absent group).
  async function readGroupSettings(profileFolderId, title) {
    const root = await findGroupsRootFolder(profileFolderId);
    if (!root) return { rules: [] };
    const folder = await findGroupFolder(root.id, title);
    if (!folder) return { rules: [] };
    const kids = await env.bookmarks.getChildren(folder.id);
    const rules = [];
    for (const k of kids) {
      const rule = parseGroupRuleUrl(k.url);
      if (rule) rules.push(rule);
    }
    return { rules };
  }

  // Replaces a group's whole rule set. A rule needs at least a "pattern"
  // or an "openUrl" to mean anything — anything without either is
  // dropped defensively. An empty (or now-empty) rule set deletes the
  // group folder outright rather than leaving a ruleless orphan behind,
  // mirroring the original extension's own "nothing left to identify it
  // by" cleanup.
  async function setGroupSettings(profileFolderId, title, rules) {
    const clean = (rules || []).filter((r) => r && (r.pattern || r.openUrl));
    if (clean.length === 0) {
      await deleteGroupSettings(profileFolderId, title);
      return;
    }
    const root = await getOrCreateGroupsRootFolder(profileFolderId);
    const existing = await findGroupFolder(root.id, title);
    if (existing) {
      try {
        await env.bookmarks.removeTree(existing.id);
      } catch (e) {}
    }
    const folder = await env.bookmarks.create({ parentId: root.id, title });
    for (const rule of clean) {
      try {
        await env.bookmarks.create({
          parentId: folder.id,
          title: rule.pattern || rule.openUrl,
          url: buildGroupRuleUrl(rule),
        });
      } catch (e) {}
    }
  }

  async function deleteGroupSettings(profileFolderId, title) {
    const root = await findGroupsRootFolder(profileFolderId);
    if (!root) return;
    const folder = await findGroupFolder(root.id, title);
    if (!folder) return;
    try {
      await env.bookmarks.removeTree(folder.id);
    } catch (e) {}
  }

  // ---- convenience wrappers scoped to the device's ACTIVE profile,
  // for the popup UI's message handlers (background.js) ----

  async function activeProfileFolderId() {
    const profile = await syncEngine.getActiveProfile();
    const folder = await syncEngine.getOrCreateProfileFolder(profile);
    return folder.id;
  }

  async function listGroupsForActiveProfile() {
    const profileFolderId = await activeProfileFolderId();
    const titles = await getAllGroupTitles(profileFolderId);
    const rulesCounts = {};
    for (const t of titles) {
      const settings = await readGroupSettings(profileFolderId, t);
      rulesCounts[t] = settings.rules.length;
    }
    let openTitles = [];
    if (env.tabGroups) {
      try {
        const groups = await env.tabGroups.query({});
        openTitles = groups.filter((g) => g.title).map((g) => g.title);
      } catch (e) {}
    }
    return { titles, rulesCounts, openTitles };
  }

  // A group's rules plus (if it's open in this window right now) its
  // live tabs — for the editor panel's quick-add suggestions.
  async function getGroupForEditing(title) {
    const profileFolderId = await activeProfileFolderId();
    const settings = await readGroupSettings(profileFolderId, title);
    let openTabs = [];
    if (env.tabGroups) {
      try {
        const groups = await env.tabGroups.query({});
        const group = groups.find((g) => g.title === title);
        if (group) {
          const tabs = await env.tabs.query({ groupId: group.id });
          openTabs = tabs.filter((t) => t.url).map((t) => ({ url: t.url, title: t.title || t.url }));
        }
      } catch (e) {}
    }
    return { rules: settings.rules, openTabs };
  }

  async function setGroupSettingsForActiveProfile(title, rules) {
    const profileFolderId = await activeProfileFolderId();
    await setGroupSettings(profileFolderId, title, rules);
  }

  async function deleteGroupSettingsForActiveProfile(title) {
    const profileFolderId = await activeProfileFolderId();
    await deleteGroupSettings(profileFolderId, title);
  }

  // ---- per-device local preferences (NOT synced via bookmarks — same
  // convention as syncEnabled/ttlDays/openRestoredLazy: a per-device
  // operational toggle, not shared config; only the RULES themselves
  // are cross-device data) ----

  async function isLeashEnabled() {
    const { groupsLeashEnabled } = await env.storage.local.get("groupsLeashEnabled");
    return groupsLeashEnabled !== false; // default ON
  }

  async function closeUndeclaredTabsEnabled() {
    const { groupsCloseUndeclaredTabs } = await env.storage.local.get(
      "groupsCloseUndeclaredTabs"
    );
    return groupsCloseUndeclaredTabs === true; // default OFF (destructive)
  }

  async function groupsStartupDelaySeconds() {
    const { groupsStartupDelaySeconds: v } = await env.storage.local.get(
      "groupsStartupDelaySeconds"
    );
    return v || DEFAULT_STARTUP_DELAY_SECONDS;
  }

  async function pinGroupsToStartEnabled() {
    const { groupsPinToStart } = await env.storage.local.get("groupsPinToStart");
    return groupsPinToStart === true; // default OFF (repositioning tabs is surprising)
  }

  // ---- link leashing ----

  // The pattern clicked links in `tab` must match, or null if this tab
  // isn't in a titled group, or no rule covers its current page yet.
  async function resolvePatternFor(tab) {
    if (!env.tabGroups || !isGrouped(tab)) return null;
    let group;
    try {
      group = await env.tabGroups.get(tab.groupId);
    } catch (e) {
      return null;
    }
    if (!group || !group.title) return null; // untitled: no stable cross-device key
    const profileFolderId = await activeProfileFolderId();
    const settings = await readGroupSettings(profileFolderId, group.title);
    return resolvePatternForTab(settings, tab.url);
  }

  // For link-leash-content.js's initial handshake: whether this tab is
  // grouped/leashed at all, and its currently-resolved pattern (if any)
  // — so the content script can decide SYNCHRONOUSLY, per click, whether
  // to intercept at all, instead of an async round-trip on every click.
  // See handleLinkClick's own comment on why a plain, matching click
  // must NOT be intercepted.
  async function getLeashInfoFor(tab) {
    if (!(await isLeashEnabled())) return { grouped: false, pattern: null };
    const grouped = !!env.tabGroups && isGrouped(tab);
    const pattern = grouped ? await resolvePatternFor(tab) : null;
    return { grouped, pattern };
  }

  async function fallbackOpen(href, tab, modifiers) {
    if (modifiers.newTab) {
      try {
        const created = await env.tabs.create({
          url: href,
          active: !modifiers.background,
          index: tab.index + 1,
          openerTabId: tab.id,
        });
        // `index: tab.index + 1` places the new tab adjacent to `tab` —
        // if `tab` is grouped, the browser can auto-join the new tab
        // into that SAME group purely from that adjacency, with no
        // leashing decision involved at all. This path is reached
        // whenever there's no pattern to leash against (leashing off,
        // tab ungrouped, or no rule resolves for `tab`'s current page —
        // see handleLinkClick's `!pattern` case), so a link opened from
        // here must never end up grouped by that side effect; undo it
        // if it happened. Same guard as handleLinkClick's own
        // known-non-matching branch below.
        if (created.groupId !== TAB_GROUP_ID_NONE && env.tabs.ungroup) {
          try {
            await env.tabs.ungroup(created.id);
          } catch (e) {}
        }
      } catch (e) {}
    } else {
      try {
        await env.tabs.update(tab.id, { url: href });
      } catch (e) {}
    }
  }

  async function handleLinkClick(href, tab, modifiers = {}) {
    if (!(await isLeashEnabled()) || !env.tabGroups || !isGrouped(tab)) {
      return fallbackOpen(href, tab, modifiers);
    }

    const pattern = await resolvePatternFor(tab);
    if (!pattern) return fallbackOpen(href, tab, modifiers);

    const matches = matchesPattern(href, pattern);
    const groupId = tab.groupId;

    if (matches) {
      if (modifiers.newTab) {
        const created = await env.tabs.create({
          url: href,
          index: tab.index + 1,
          active: !modifiers.background,
          openerTabId: tab.id,
        });
        if (created.groupId !== groupId && env.tabs.group) {
          try {
            await env.tabs.group({ tabIds: [created.id], groupId });
          } catch (e) {}
        }
      } else {
        await env.tabs.update(tab.id, { url: href });
      }
    } else {
      const created = await env.tabs.create({
        url: href,
        index: tab.index + 1,
        active: !modifiers.background,
        openerTabId: tab.id,
      });
      if (created.groupId !== TAB_GROUP_ID_NONE && env.tabs.ungroup) {
        try {
          await env.tabs.ungroup(created.id);
        } catch (e) {}
      }
    }
  }

  // ---- startup reconciliation: reopen missing "essential" (openUrl)
  // tabs, close duplicates, optionally close undeclared tabs ----
  //
  // Scoped to the ACTIVE PROFILE's group definitions only, same as the
  // rest of the extension's sync — a device on a different profile
  // never touches another profile's groups. Only titled groups that
  // have at least one saved rule are touched at all.

  async function reconcileGroups() {
    if (!env.tabGroups) return; // Firefox: no tab-group API, nothing to do
    if (!(await isLeashEnabled())) return;
    if (!(await syncEngine.isSyncEnabled())) return; // master pause covers this too

    const profileFolderId = await activeProfileFolderId();
    const titles = await getAllGroupTitles(profileFolderId);
    if (titles.length === 0) return;

    const closeUndeclared = await closeUndeclaredTabsEnabled();
    const pinToStart = await pinGroupsToStartEnabled();
    let allGroups = [];
    try {
      allGroups = await env.tabGroups.query({});
    } catch (e) {}

    // Groups pinned to the start stack in title order (getAllGroupTitles
    // is already sorted) — each successive one gets the next index, so
    // e.g. "Chats" then "Work" ends up [Chats][Work][...everything else],
    // a stable, predictable order rather than fighting over index 0.
    let nextPinIndex = 0;
    for (const title of titles) {
      const settings = await readGroupSettings(profileFolderId, title);
      const rules = settings.rules || [];
      if (rules.length === 0) continue; // nothing declared for this group
      const pinIndex = pinToStart ? nextPinIndex++ : null;
      await reconcileGroup(title, rules, allGroups, closeUndeclared, pinIndex);
    }
  }

  async function reconcileGroup(title, rules, allGroups, closeUndeclared, pinIndex) {
    const targetGroup = allGroups.find((g) => g.title === title) || null;
    const openTabs = targetGroup ? await env.tabs.query({ groupId: targetGroup.id }) : [];
    let groupIdForPin = targetGroup && targetGroup.id;

    const essentialRules = rules.filter((r) => r.openUrl);
    const missingRules = [];
    const idsToClose = [];

    for (const rule of essentialRules) {
      const matchingTabs = openTabs.filter((t) => tabSatisfiesRule(t.url, rule));
      if (matchingTabs.length === 0) {
        missingRules.push(rule);
      } else if (matchingTabs.length > 1) {
        // More than one open tab covers the same rule: keep the
        // leftmost, close the rest.
        matchingTabs.sort((a, b) => a.index - b.index);
        idsToClose.push(...matchingTabs.slice(1).map((t) => t.id));
      }
    }

    if (closeUndeclared) {
      for (const tab of openTabs) {
        if (idsToClose.includes(tab.id)) continue;
        const isDeclared = rules.some((r) => tabSatisfiesRule(tab.url, r));
        if (!isDeclared) idsToClose.push(tab.id);
      }
    }

    if (idsToClose.length > 0) {
      try {
        await env.tabs.remove(idsToClose);
      } catch (e) {}
    }

    if (missingRules.length > 0) {
      let windowId = targetGroup && targetGroup.windowId;
      if (windowId === undefined) {
        try {
          const w = await env.windows.getLastFocused({ windowTypes: ["normal"] });
          windowId = w && w.id;
        } catch (e) {}
      }
      if (windowId === undefined) {
        try {
          const created = await env.windows.create({});
          windowId = created.id;
        } catch (e) {
          windowId = undefined;
        }
      }

      if (windowId !== undefined) {
        const newTabIds = [];
        for (const rule of missingRules) {
          try {
            const created = await env.tabs.create({ url: rule.openUrl, windowId, active: false });
            newTabIds.push(created.id);
          } catch (e) {}
        }

        if (newTabIds.length > 0) {
          if (targetGroup) {
            try {
              await env.tabs.group({ tabIds: newTabIds, groupId: targetGroup.id });
            } catch (e) {}
          } else {
            // The group doesn't exist anywhere right now: recreate it
            // from the tabs we just opened. Its color isn't stored, so
            // the browser assigns a default one.
            try {
              const newGroupId = await env.tabs.group({
                tabIds: newTabIds,
                createProperties: { windowId },
              });
              await env.tabGroups.update(newGroupId, { title });
              groupIdForPin = newGroupId;
            } catch (e) {}
          }
        }
      }
    }

    // Pin to the start of its window's tab strip, if the preference is
    // on — checked on EVERY reconcile (not just when something was
    // reopened), so the group stays put even if the user's own browser
    // drags it elsewhere between reconciles.
    if (pinIndex !== null && groupIdForPin !== undefined && groupIdForPin !== null && env.tabGroups.move) {
      try {
        await env.tabGroups.move(groupIdForPin, { index: pinIndex });
      } catch (e) {}
    }
  }

  async function handleGroupsAlarm() {
    await reconcileGroups();
  }

  return {
    GROUPS_ROOT_TITLE,
    getAllGroupTitles,
    readGroupSettings,
    setGroupSettings,
    deleteGroupSettings,
    listGroupsForActiveProfile,
    getGroupForEditing,
    setGroupSettingsForActiveProfile,
    deleteGroupSettingsForActiveProfile,
    isLeashEnabled,
    closeUndeclaredTabsEnabled,
    groupsStartupDelaySeconds,
    pinGroupsToStartEnabled,
    resolvePatternFor,
    getLeashInfoFor,
    handleLinkClick,
    reconcileGroups,
    reconcileGroup,
    handleGroupsAlarm,
  };
}

if (typeof module !== "undefined" && module.exports) {
  module.exports = {
    GROUPS_ROOT_TITLE,
    GROUP_RULE_URL_BASE,
    DEFAULT_STARTUP_DELAY_SECONDS,
    globToRegExp,
    matchesPattern,
    defaultPatternForUrl,
    findRuleForTabUrl,
    resolvePatternForTab,
    tabSatisfiesRule,
    buildGroupRuleUrl,
    parseGroupRuleUrl,
    createGroupsEngine,
  };
}
