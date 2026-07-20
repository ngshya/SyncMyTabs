const nameInput = document.getElementById("deviceName");
const intervalInput = document.getElementById("intervalMinutes");
const timeoutInput = document.getElementById("notificationTimeoutSeconds");
const defaultActionSelect = document.getElementById("defaultTimeoutAction");
const lazyInput = document.getElementById("openRestoredLazy");
const mirrorInput = document.getElementById("mirrorRemoteCloses");
const status = document.getElementById("status");
const lastSeenEl = document.getElementById("lastSeen");
const profileListEl = document.getElementById("profileList");
const newProfileInput = document.getElementById("newProfileName");

const DEFAULT_PROFILE = "default";

async function getKnownProfiles() {
  // Union of profiles that exist anywhere in the synced bookmark
  // tree (any device) plus this device's own locally-added ones.
  const { profiles } = await chrome.runtime.sendMessage({
    type: "GET_ALL_KNOWN_PROFILES",
  });
  return profiles && profiles.length ? profiles : [DEFAULT_PROFILE];
}

async function getActiveProfile() {
  const { activeProfile } = await chrome.storage.local.get("activeProfile");
  return activeProfile || DEFAULT_PROFILE;
}

async function renderProfiles() {
  const [profiles, activeProfile] = await Promise.all([
    getKnownProfiles(),
    getActiveProfile(),
  ]);
  profileListEl.innerHTML = "";

  for (const name of profiles) {
    const row = document.createElement("div");
    row.className = "profile-row";

    const nameEl = document.createElement("span");
    nameEl.className = "name";
    nameEl.textContent = name;
    row.appendChild(nameEl);

    if (name === activeProfile) {
      const badge = document.createElement("span");
      badge.className = "badge";
      badge.textContent = "Active";
      row.appendChild(badge);
    } else {
      const activateBtn = document.createElement("button");
      activateBtn.className = "secondary";
      activateBtn.style.marginTop = "0";
      activateBtn.textContent = "Set active";
      activateBtn.addEventListener("click", () => setActiveProfile(name));
      row.appendChild(activateBtn);
    }

    const deleteBtn = document.createElement("button");
    deleteBtn.className = "danger";
    deleteBtn.style.marginTop = "0";
    deleteBtn.textContent = "Remove from list";
    deleteBtn.disabled = name === activeProfile || profiles.length <= 1;
    deleteBtn.title =
      name === activeProfile
        ? "Switch to another profile before removing this one"
        : profiles.length <= 1
        ? "At least one profile must remain"
        : "Removes it from this device's picker only — data already saved for it on any device is kept and still restorable";
    deleteBtn.addEventListener("click", () => removeProfileFromLocalList(name));
    row.appendChild(deleteBtn);

    profileListEl.appendChild(row);
  }
}

async function setActiveProfile(name) {
  await chrome.storage.local.set({ activeProfile: name });
  // Immediately save tabs under the newly active profile, instead of
  // waiting for the next alarm cycle.
  await chrome.runtime.sendMessage({ type: "SWITCH_PROFILE_AND_SAVE" });
  await renderProfiles();
}

async function removeProfileFromLocalList(name) {
  // Only removes it from THIS device's local "profiles" list (the
  // picker). It does not delete any bookmark data — a profile that
  // still exists as a folder on any device (this one or another)
  // will keep showing up here too, since the picker is the union of
  // local + synced names.
  const { profiles } = await chrome.storage.local.get("profiles");
  const list = profiles && profiles.length ? profiles : [DEFAULT_PROFILE];
  const remaining = list.filter((p) => p !== name);
  await chrome.storage.local.set({
    profiles: remaining.length ? remaining : [DEFAULT_PROFILE],
  });
  await renderProfiles();
}

document.getElementById("addProfile").addEventListener("click", async () => {
  const raw = newProfileInput.value.trim();
  if (!raw) return;

  await chrome.runtime.sendMessage({ type: "ADD_PROFILE", name: raw });
  newProfileInput.value = "";
  await renderProfiles();
});

newProfileInput.addEventListener("keydown", (e) => {
  if (e.key === "Enter") document.getElementById("addProfile").click();
});

// Preload existing values, if any
chrome.storage.local.get(
  [
    "deviceName",
    "syncIntervalMinutes",
    "notificationTimeoutSeconds",
    "defaultTimeoutAction",
    "openRestoredLazy",
    "mirrorRemoteCloses",
    "lastSeenTimestamp",
  ],
  ({
    deviceName,
    syncIntervalMinutes,
    notificationTimeoutSeconds,
    defaultTimeoutAction,
    openRestoredLazy,
    mirrorRemoteCloses,
    lastSeenTimestamp,
  }) => {
    if (deviceName) nameInput.value = deviceName;
    if (syncIntervalMinutes) intervalInput.value = syncIntervalMinutes;
    if (notificationTimeoutSeconds)
      timeoutInput.value = notificationTimeoutSeconds;
    defaultActionSelect.value = defaultTimeoutAction || "add";
    lazyInput.checked = openRestoredLazy !== false; // default ON
    mirrorInput.checked = mirrorRemoteCloses !== false; // default ON
    lastSeenEl.textContent = lastSeenTimestamp
      ? new Date(lastSeenTimestamp).toLocaleString()
      : "none";
  }
);

renderProfiles();

document.getElementById("save").addEventListener("click", async () => {
  const name = nameInput.value.trim();
  const interval = Number(intervalInput.value);
  const notificationTimeout = Number(timeoutInput.value);
  const defaultAction = defaultActionSelect.value;

  if (!name) {
    status.textContent = "Please enter a valid name.";
    status.style.color = "#dc2626";
    return;
  }
  if (!interval || interval < 1) {
    status.textContent = "The interval must be at least 1 minute.";
    status.style.color = "#dc2626";
    return;
  }
  if (!notificationTimeout || notificationTimeout < 1) {
    status.textContent = "The notification timeout must be at least 1 second.";
    status.style.color = "#dc2626";
    return;
  }

  await chrome.storage.local.set({
    deviceName: name,
    syncIntervalMinutes: interval,
    notificationTimeoutSeconds: notificationTimeout,
    defaultTimeoutAction: defaultAction,
    openRestoredLazy: lazyInput.checked,
    mirrorRemoteCloses: mirrorInput.checked,
  });

  status.textContent = `Saved: "${name}", checking every ${interval} min, notification timeout ${notificationTimeout}s, default action "${defaultAction}", lazy restore ${
    lazyInput.checked ? "on" : "off"
  }. Closing this tab...`;
  status.style.color = "#16a34a";

  setTimeout(() => {
    chrome.tabs.getCurrent((tab) => {
      if (tab && tab.id !== undefined) {
        chrome.tabs.remove(tab.id);
      }
    });
  }, 900);
});
