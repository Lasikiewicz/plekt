// Per-server synchronization direction and authority (M4).
//
// Each media server participates as a source, destination, both, or neither
// for each state type (watched / unwatched / progress). Defaults preserve the
// historical fully-bidirectional behavior, so existing installs are unchanged
// until an administrator picks another role.

export const SYNC_STATE_TYPES = ["watched", "unwatched", "progress"];
export const STATE_MODES = ["send_receive", "send", "receive", "off"];
export const ROLE_PRESETS = ["bidirectional", "source_only", "destination_only", "monitor", "custom"];

const PRESET_MODES = {
  bidirectional: "send_receive",
  source_only: "send",
  destination_only: "receive",
  monitor: "off",
};

export function normalizeSyncRoles(section = {}) {
  const preset = ROLE_PRESETS.includes(String(section.preset || "").trim()) ? String(section.preset).trim() : "bidirectional";
  const presetMode = PRESET_MODES[preset];
  const roles = { preset };
  for (const stateType of SYNC_STATE_TYPES) {
    const value = String(section[stateType] || "").trim();
    if (preset !== "custom" && presetMode) {
      roles[stateType] = presetMode;
    } else {
      roles[stateType] = STATE_MODES.includes(value) ? value : "send_receive";
    }
  }
  return roles;
}

export function serverSyncRoles(config = {}, server = "") {
  return normalizeSyncRoles(config?.[server]?.sync || {});
}

export function canSendState(config, server, stateType) {
  const mode = serverSyncRoles(config, server)[stateType] || "send_receive";
  return mode === "send_receive" || mode === "send";
}

export function canReceiveState(config, server, stateType) {
  const mode = serverSyncRoles(config, server)[stateType] || "send_receive";
  return mode === "send_receive" || mode === "receive";
}

export function normalizeAuthority(section = {}) {
  const conflictPolicy = String(section.conflictPolicy || "").trim() === "server" ? "server" : "newest_timestamp";
  const server = ["plex", "emby", "jellyfin"].includes(String(section.server || "").trim())
    ? String(section.server).trim()
    : "";
  return { conflictPolicy: conflictPolicy === "server" && !server ? "newest_timestamp" : conflictPolicy, server };
}

export function conflictAuthority(config = {}) {
  return normalizeAuthority(config?.authority || {});
}

// Human-readable effective role for settings cards.
export function describeSyncRole(section = {}) {
  const roles = normalizeSyncRoles(section);
  if (roles.preset === "bidirectional") return "Source + Destination";
  if (roles.preset === "source_only") return "Source only";
  if (roles.preset === "destination_only") return "Destination only";
  if (roles.preset === "monitor") return "Monitor only";
  const parts = SYNC_STATE_TYPES.map((stateType) => {
    const mode = roles[stateType];
    const label = { send_receive: "send + receive", send: "send", receive: "receive", off: "off" }[mode];
    return `${stateType}: ${label}`;
  });
  return `Custom (${parts.join(", ")})`;
}

// A stable revision string over everything that changes routing decisions:
// enabled servers, per-server roles, and the authority policy. Stored in plan
// fingerprints so a settings change automatically invalidates draft plans.
export function syncRolesRevision(config = {}) {
  const parts = [];
  for (const server of ["plex", "emby", "jellyfin"]) {
    const roles = serverSyncRoles(config, server);
    const enabled = !config?.[server]?.disabled;
    const lib = config?.libraryMonitoring?.[server];
    const libPart = lib
      ? `:lib=${String(lib.serverId || "")}@${Number(lib.revision || 0)}[${(Array.isArray(lib.selectedIds) ? lib.selectedIds : []).map(String).sort().join(",")}]`
      : "";
    parts.push(`${server}=${enabled ? 1 : 0}:${roles.preset}:${roles.watched}:${roles.unwatched}:${roles.progress}${libPart}`);
  }
  const authority = conflictAuthority(config);
  parts.push(`authority=${authority.conflictPolicy}:${authority.server}`);
  return parts.join("|");
}

export function validateSyncRolesSection(section = {}, label = "sync") {
  const errors = [];
  if (section.preset !== undefined && !ROLE_PRESETS.includes(String(section.preset))) {
    errors.push(`${label}.preset must be one of ${ROLE_PRESETS.join(", ")}`);
  }
  for (const stateType of SYNC_STATE_TYPES) {
    if (section[stateType] !== undefined && String(section[stateType]).trim() && !STATE_MODES.includes(String(section[stateType]))) {
      errors.push(`${label}.${stateType} must be one of ${STATE_MODES.join(", ")}`);
    }
  }
  return errors;
}
