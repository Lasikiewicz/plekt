// Settings navigation shell: hierarchical section groups and route parsing with
// legacy redirects, the Sonarr-style landing page, the settings sidebar, and the
// panel show/hide engine. Pure route logic lives at the top so it stays
// testable under Node without a DOM.

// Flat section definitions (each maps to a route + panel/subPanel combo)
const SECTIONS = {
  // Parent groups show all their child sections on one page
  general: {
    label: "General",
    description: "Account configuration, system integrity diagnostics, and image cache",
    panel: "general",
    subPanels: ["general-login", "tools-diagnostics", "cache"],
  },
  "media-servers": {
    label: "Media servers",
    description: "Connect Plex, Emby, and Jellyfin",
    panel: "apps",
    subPanels: ["media-servers-plex", "media-servers-emby", "media-servers-jellyfin"],
  },
  plex: {
    label: "Plex",
    description: "Sync watch history with a Plex server",
    panel: "apps",
    subPanels: ["media-servers-plex"],
    isDisplayOnly: true,
  },
  emby: {
    label: "Emby",
    description: "Sync watch history with an Emby server",
    panel: "apps",
    subPanels: ["media-servers-emby"],
    isDisplayOnly: true,
  },
  jellyfin: {
    label: "Jellyfin",
    description: "Sync watch history with a Jellyfin server",
    panel: "apps",
    subPanels: ["media-servers-jellyfin"],
    isDisplayOnly: true,
  },
  sync: {
    label: "Sync",
    description: "Sync tuning, sync tools, and history",
    panel: "sync",
    subPanels: ["sync-tuning", "sync-tools", "sync-history"],
  },
  backup: {
    label: "Backup",
    description: "Backup schedules and remote destinations",
    panel: "backups",
    backupTab: "settings",
  },
  tools: {
    label: "Tools",
    description: "Database repairs, library rebuilds, and wiping data",
    panel: "tools",
    subPanels: ["tools-repairs", "tools-sync", "tools-wipe-data"],
  },
  advanced: {
    label: "Advanced",
    description: "Advanced settings",
    panel: "general",
    subPanels: ["tools-diagnostics", "cache"],
    isDisplayOnly: true,
  },
  // Account section on the General page
  account: {
    label: "Account",
    description: "Administrator username, password, and sessions",
    panel: "general",
    subPanels: ["general-login"],
    isDisplayOnly: true, // Not a navigable route
  },
  "sync-tuning": {
    label: "Sync tuning",
    description: "Control watched flags, historical Plex syncing, sync thresholds, and whether Up Next updates connected apps",
    panel: "sync",
    subPanels: ["sync-tuning"],
    subSections: [
      { id: "sync-field-watch_import_mode", label: "Watched Flag Policy", description: "Choose now, release day, episode timing, or manual review for app-marked watches" },
      { id: "sync-field-plex_historical_watched_sync", label: "Sync historical watched items to Plex", description: "Whether imports, restores, backdated marks, and library-wide pushes send historical watched state to Plex; Emby, Jellyfin, and Trakt always keep the original date" },
      { id: "sync-field-watched_threshold", label: "Watched Threshold (%)", description: "Playback progress percentage at which a play counts as watched" },
      { id: "sync-field-min_resume_position", label: "Minimum Resume Position (sec)", description: "Minimum playback position before a stopped play is saved as a resume point" },
      { id: "sync-field-active_session_ttl", label: "Active Session TTL (min)", description: "How long a now playing session is kept without an update before it's considered stale" },
      { id: "sync-field-request_timeout", label: "Outbound Request Timeout (sec)", description: "How long Plekt waits for a response from Plex, Emby, or Jellyfin before giving up" },
      { id: "sync-field-up_next_sync", label: "Up Next Sync", description: "Allow Up Next sync to push Plekt's queue to connected media apps without removing anything already there" },
    ],
    isDisplayOnly: true, // Not a navigable route
  },
  "sync-tools": {
    label: "Sync Tools",
    description: "Repair recent items and force sync",
    panel: "sync",
    subPanels: ["sync-tools"],
    subSections: [
      { id: "sync-tools-repair", label: "Repair Recent Items", description: "Check recent watched items for missing records" },
      { id: "sync-tools-push", label: "Set Plekt as Source of Truth", description: "Send Plekt's currently recorded watched status and resume positions to one server or all connected servers, overwriting what they show" },
      { id: "sync-tools-pull", label: "Import Watched Status", description: "Add watched status Plekt doesn't already have from one server or all connected servers; never sends anything out or removes anything" },
    ],
    isDisplayOnly: true,
  },
  seerr: {
    label: "Seerr",
    description: "Optional movie and TV request integration",
    panel: "tools",
    subPanels: ["seerr"],
    isDisplayOnly: true,
  },
  webhooks: {
    label: "Webhooks",
    description: "Webhook listener and background scheduler endpoints",
    panel: "general",
    subPanels: ["general-endpoints-guides", "general-endpoints"],
  },
  "setup-guides": {
    label: "Setup Guides",
    description: "Platform setup guides",
    panel: "general",
    subPanels: ["general-endpoints-guides"],
    isDisplayOnly: true,
  },
  "webhook-secret": {
    label: "Webhook Secret",
    description: "Secret token used by Plex, Emby, and Jellyfin webhooks",
    panel: "general",
    subPanels: ["general-endpoints"],
    isDisplayOnly: true,
  },
  metadata: {
    label: "Metadata",
    description: "TMDB, TVDB, Fanart.tv, OMDb, YouTube providers, and TMDB/TVDB refresh",
    panel: "api-keys",
    subPanels: ["metadata-providers", "refresh-metadata"],
  },
  "refresh-metadata": {
    label: "Refresh Metadata",
    description: "Pre-cache metadata from TMDB and TVDB",
    panel: "api-keys",
    subPanels: ["refresh-metadata"],
    subSections: [
      { id: "refresh-tmdb-metadata", label: "TMDB", description: "Pre-cache trailers, posters, cast, and summaries locally" },
      { id: "refresh-tvdb-metadata", label: "TVDB", description: "Fetch season episode schedules, series details, and artwork from TVDB" },
    ],
    isDisplayOnly: true,
  },
  "metadata-providers": {
    label: "Metadata Providers",
    description: "TMDB, TVDB, Fanart.tv, OMDb, and YouTube providers",
    panel: "api-keys",
    subPanels: ["metadata-providers"],
    isDisplayOnly: true,
  },
  "refresh-tmdb-metadata": {
    label: "TMDB",
    description: "Pre-cache trailers, posters, cast, and summaries locally",
    panel: "api-keys",
    subPanels: ["refresh-metadata"],
    isDisplayOnly: true,
  },
  "refresh-tvdb-metadata": {
    label: "TVDB",
    description: "Fetch season episode schedules, series details, and artwork from TVDB",
    panel: "api-keys",
    subPanels: ["refresh-metadata"],
    isDisplayOnly: true,
  },
  "sync-history": {
    label: "Sync history",
    description: "View the history of sync operations",
    panel: "sync",
    subPanels: ["sync-history"],
    isDisplayOnly: true,
  },
  restore: {
    label: "Restore",
    description: "Recover watch history or a full encrypted backup",
    panel: "backups",
    backupTab: "restore",
  },
  "backup-local": {
    label: "Local",
    description: "Local backup schedules and files",
    panel: "backups",
    backupTab: "settings",
    subSections: [
      { id: "local-watch-history-backups", label: "Watch History", description: "Local watch-history backup schedule and files" },
      { id: "local-plembfin-backups", label: "Plekt", description: "Local encrypted full Plekt backup schedule and files" },
    ],
    isDisplayOnly: true,
  },
  "backup-remote": {
    label: "Remote",
    description: "Remote backup destinations and mirroring",
    panel: "backups",
    backupTab: "settings",
    subSections: [
      { id: "remote-watch-history-backups", label: "Watch History", description: "Watch-history backups mirrored to a remote destination" },
      { id: "remote-plembfin-backups", label: "Plekt", description: "Encrypted full Plekt backups mirrored to a remote destination" },
    ],
    isDisplayOnly: true,
  },
  "restore-local": {
    label: "Local",
    description: "Restore from files on this server or your computer",
    panel: "backups",
    backupTab: "restore",
    subSections: [
      { id: "local-watch-history-restore", label: "Watch History", description: "Restore watch history from a local file" },
      { id: "local-plembfin-restore", label: "Plekt", description: "Restore a full Plekt backup from a local file" },
    ],
    isDisplayOnly: true,
  },
  "restore-remote": {
    label: "Remote",
    description: "Restore from configured remote storage",
    panel: "backups",
    backupTab: "restore",
    subSections: [
      { id: "remote-watch-history-restore", label: "Watch History", description: "Restore watch history from a remote destination" },
      { id: "remote-plembfin-restore", label: "Plekt", description: "Restore a full Plekt backup from a remote destination" },
    ],
    isDisplayOnly: true,
  },
  connections: {
    label: "Connections",
    description: "Connect Trakt or Seerr, or import watch history",
    panel: "tools",
    subPanels: ["tools-migration", "tools-tautulli", "seerr"],
  },
  trakt: {
    label: "Trakt",
    description: "Connect live two-way watched sync or import Trakt exports",
    panel: "tools",
    subPanels: ["tools-migration"],
    isDisplayOnly: true,
  },
  tautulli: {
    label: "Tautulli",
    description: "Import one user's completed Tautulli watch history with an identity-aware preview",
    panel: "tools",
    subPanels: ["tools-tautulli"],
    isDisplayOnly: true,
  },
  "system-integrity": {
    label: "System integrity check",
    description: "Connection diagnostics and system integrity checks",
    panel: "general",
    subPanels: ["tools-diagnostics"],
    subSections: [
      { id: "sync-health-box", label: "Refresh Sync Health", description: "Loads a fast snapshot of database row counts, disk storage usage, and outbound media server request pressure." },
      { id: "system-diagnostic-box", label: "Run System Diagnostic", description: "Runs nine live diagnostic checks in sequence and provides actionable fix recommendations for any warnings or errors." },
    ],
    isDisplayOnly: true,
  },
  logs: {
    label: "Logs",
    description: "Live server and browser diagnostic output",
    panel: "logs",
    isDisplayOnly: true,
  },
  changelog: {
    label: "Changelog",
    description: "Version history and release notes",
    panel: "changelog",
  },
  storage: {
    label: "Storage & cache",
    description: "Artwork and metadata cache usage",
    panel: "general",
    subPanels: ["cache"],
    isDisplayOnly: true,
  },
  "database-repairs": {
    label: "Database repairs",
    description: "Correct damaged or duplicated local history records",
    panel: "tools",
    subPanels: ["tools-repairs"],
    subSections: [
      { id: "repair-history-rows", label: "Repair History Rows", description: "Fill in missing media types and backfill missing posters" },
      { id: "phantom-watch-audit", label: "Audit Phantom Watches", description: "Finds suspicious duplicates and malformed imported episode rows" },
      { id: "remove-duplicate-watches", label: "Remove Duplicate Watches", description: "Keeps the oldest watch date for each TV episode or movie library-wide" },
      { id: "episode-title-gap-fix", label: "Restore Missing Episode Names", description: "Backfill real episode names onto watch rows that only stored a coordinate" },
      { id: "playstate-aliases", label: "Watch-State Aliases", description: "Decide which show unplaced episode watch states belong to" },
    ],
    isDisplayOnly: true,
  },
  "library-rebuilds": {
    label: "Library rebuilds and backfills",
    description: "Reprocess local metadata or push the complete archive to connected services",
    panel: "tools",
    subPanels: ["tools-sync"],
    subSections: [
      { id: "rematch-tv-shows", label: "Rematch All TV Shows", description: "Resolve show titles against TVDB and update episode IDs" },
      { id: "backfill-trakt-imports", label: "Backfill Trakt Imports", description: "Fetch missing posters for imported Trakt events" },
    ],
    isDisplayOnly: true,
  },
  "wipe-data": {
    label: "Wipe data",
    description: "Permanently delete tracked watch history, sync history, or reset Plekt entirely",
    panel: "tools",
    subPanels: ["tools-wipe-data"],
    subSections: [
      { id: "wipe-watch-history", label: "Watch History", description: "Deletes local watch history, playstate, resume progress, and live sessions" },
      { id: "wipe-sync-logs", label: "Sync History & Logs", description: "Deletes sync history, watch audit events, and diagnostic logs" },
      { id: "wipe-everything-tracked", label: "Everything Tracked", description: "Deletes all of the above in one action" },
      { id: "wipe-fresh-start", label: "Wipe All / Fresh Start", description: "Full factory reset - also clears settings, connections, cached artwork, and the admin login" },
    ],
    isDisplayOnly: true,
  },
  "force-sync": {
    label: "Force Sync",
    description: "Preview, confirm, and run a safe synchronization plan",
    panel: "sync",
    subPanels: ["sync-tools"],
    isDisplayOnly: true,
  },
};

// Hierarchical grouping: parent menu item with child sections
// ALL children are display-only (navigate to parent, not separate pages)
const SECTION_GROUPS = [
  {
    id: "general",
    label: "General",
    sections: ["account", "system-integrity", "storage"],
    displayOnly: ["account", "system-integrity", "storage"],
  },
  {
    id: "media-servers",
    label: "Media servers",
    sections: ["plex", "emby", "jellyfin"],
    displayOnly: ["plex", "emby", "jellyfin"],
  },
  {
    id: "webhooks",
    label: "Webhooks",
    sections: ["setup-guides", "webhook-secret"],
    displayOnly: ["setup-guides", "webhook-secret"],
  },
  {
    id: "connections",
    label: "Connections",
    sections: ["trakt", "tautulli", "seerr"],
    displayOnly: ["trakt", "tautulli", "seerr"],
  },
  {
    id: "metadata",
    label: "Metadata",
    sections: ["metadata-providers", "refresh-metadata"],
    displayOnly: ["metadata-providers", "refresh-metadata"],
  },
  {
    id: "sync",
    label: "Sync",
    sections: ["sync-tuning", "sync-tools", "sync-history"],
    displayOnly: ["sync-tuning", "sync-tools", "sync-history"],
  },
  {
    id: "backup",
    label: "Backup",
    sections: ["backup-local", "backup-remote"],
    displayOnly: ["backup-local", "backup-remote"],
  },
  {
    id: "restore",
    label: "Restore",
    sections: ["restore-local", "restore-remote"],
    displayOnly: ["restore-local", "restore-remote"],
  },
  {
    id: "tools",
    label: "Tools",
    sections: ["database-repairs", "library-rebuilds", "wipe-data"],
    displayOnly: ["database-repairs", "library-rebuilds", "wipe-data"],
  },
  {
    id: "logs",
    label: "Logs",
    sections: [],
    displayOnly: [],
  },
  {
    id: "changelog",
    label: "Changelog",
    sections: [],
    displayOnly: [],
  },
];

// One-line summaries for the group boxes on the settings landing page.
const GROUP_DESCRIPTIONS = {
  general: "Account, diagnostics, and cache settings.",
  "media-servers": "Connect Plex, Emby, and Jellyfin.",
  webhooks: "Webhook listener and background scheduler endpoints.",
  connections: "Connect Trakt or Seerr, or import watch history.",
  metadata: "Configure TMDB, TVDB, Fanart.tv, and OMDb, and refresh cached metadata.",
  sync: "Tune sync behavior, run sync tools, and inspect history.",
  backup: "Schedule local and remote backups of watch history and full Plekt data.",
  restore: "Restore watch history or a full backup from local files or a remote destination.",
  tools: "Reopen guided setup, repair the database, rebuild the library, and wipe data.",
  logs: "Live server and browser diagnostic output.",
  changelog: "Version history and release notes.",
};

const LEGACY_PATHS = {
  "/settings/media-servers-group": "/settings/media-servers",
  "/settings/sync-group": "/settings/sync",
  "/settings/sync-issues": "/sync-activity",
  "/settings/sync-match-report": "/sync-activity",
  "/settings/backup-restore-group": "/settings/backup",
  "/settings/backup-restore": "/settings/backup",
  "/settings/backup-settings": "/settings/backup",
  "/settings/tools-group": "/settings/tools",
  "/settings/advanced-group": "/settings/general",
  "/settings/advanced": "/settings/general",
  "/sync": "/settings/sync",
  "/logs": "/settings/logs",
  "/settings/apps": "/settings/media-servers",
  "/settings/api-keys": "/settings/metadata",
  "/settings/cache": "/settings/storage",
  "/settings/about": "/about",
  "/settings/account/login": "/settings/account",
  "/settings/connections/plex": "/settings/media-servers",
  "/settings/connections/emby": "/settings/media-servers",
  "/settings/connections/jellyfin": "/settings/media-servers",
  "/settings/connections/seerr": "/settings/seerr",
  "/settings/connections/webhooks": "/settings/webhooks",
  "/settings/metadata/tmdb": "/settings/metadata",
  "/settings/metadata/youtube": "/settings/metadata",
  "/settings/metadata/fanart": "/settings/metadata",
  "/settings/metadata/tvdb": "/settings/metadata",
  "/settings/metadata/omdb": "/settings/metadata",
  "/settings/data": "/settings/backup",
  "/settings/data/backups": "/settings/backup",
  "/settings/data/restore": "/settings/restore",
  "/settings/data/import": "/settings/trakt",
  "/settings/import": "/settings/trakt",
  "/settings/health": "/settings/system-integrity",
  "/settings/system": "/settings/system-integrity",
  "/settings/system/health": "/settings/system-integrity",
  "/settings/backups": "/settings/backup",
  "/settings/webhook-guides": "/settings/setup-guides",
  "/settings/system/sync": "/sync-activity",
  "/settings/system/logs": "/settings/logs",
  "/settings/system/storage": "/settings/storage",
  "/settings/system/about": "/about",
  "/settings/system/advanced": "/settings/database-repairs",
  "/settings/sync/issues": "/sync-activity",
  "/settings/sync/history": "/settings/sync-history",
  "/settings/sync/tuning": "/settings/sync-tuning",
};

const LEGACY_TABS = {
  apps: "/settings/media-servers",
  "api-keys": "/settings/metadata",
  backups: "/settings/backup",
  tools: "/settings/database-repairs",
  sync: "/settings/sync",
  logs: "/settings/logs",
  cache: "/settings/storage",
  about: "/about",
  changelog: "/settings/changelog",
};

export const SETTINGS_SECTIONS = Object.freeze(SECTIONS);

function cleanPath(value = "") {
  const path = String(value || "/settings").split(/[?#]/, 1)[0] || "/settings";
  return path.length > 1 ? path.replace(/\/+$/, "") : path;
}

export function settingsPathForLegacy(value = "") {
  const key = String(value || "").trim();
  if (key.startsWith("/")) return LEGACY_PATHS[cleanPath(key)] || cleanPath(key);
  return LEGACY_TABS[key] || (SECTIONS[key] ? `/settings/${key}` : "/settings");
}

function sectionRoute(section, requestedPath) {
  const definition = SECTIONS[section];
  const groupObj = SECTION_GROUPS.find((g) => g.sections.includes(section));
  const group = groupObj?.id || section;

  let subPanels = definition.subPanels;
  if (groupObj && groupObj.displayOnly && section === group) {
    const allGroupSubPanels = groupObj.sections.flatMap((s) => SECTIONS[s]?.subPanels || []);
    if (allGroupSubPanels.length) subPanels = [...new Set(allGroupSubPanels)];
  }

  const views = definition.views || [{ panel: definition.panel, subPanels, backupTab: definition.backupTab }];
  const primary = views[0] || {};
  return {
    kind: "task",
    group,
    groupLabel: section !== group ? groupObj?.label : undefined,
    section,
    task: "",
    path: `/settings/${section}`,
    requestedPath,
    title: definition.label,
    panel: primary.panel,
    subPanels: primary.subPanels,
    backupTab: primary.backupTab,
    views,
  };
}

export function parseSettingsRoute(value = "/settings", { mustChangePassword = false } = {}) {
  const requestedPath = cleanPath(value);
  if (mustChangePassword) return sectionRoute("account", requestedPath);

  const canonicalPath = LEGACY_PATHS[requestedPath] || requestedPath;
  if (canonicalPath === "/settings") {
    return { kind: "overview", group: "overview", task: "", path: "/settings", requestedPath, title: "Settings overview" };
  }

  const parts = canonicalPath.split("/").filter(Boolean);
  if (parts[0] !== "settings" || !SECTIONS[parts[1]]) {
    return { kind: "overview", group: "overview", task: "", path: "/settings", requestedPath, title: "Settings overview" };
  }
  const route = sectionRoute(parts[1], requestedPath);
  const hash = String(value || "").split("#")[1]?.split(/[?&]/, 1)[0] || "";
  if (hash) {
    const matchedGroup = SECTION_GROUPS.find((group) => group.id === route.group);
    if (SECTIONS[hash]) {
      // The hash names a real section directly (e.g. a sidebar child link
      // like /settings/media-servers#emby). The page should keep showing
      // every sibling in the group (all three servers, all three tools rows,
      // etc.) with this one scrolled to and highlighted - not narrow down to
      // just the clicked section - so merge the target's view in rather than
      // replacing the route outright. A merge is only needed when the target
      // lives in a panel the primary route doesn't already aggregate (e.g.
      // Seerr's "apps" panel vs. Trakt/import's "tools" panel); same-panel
      // siblings (Plex/Emby/Jellyfin) are already covered by the primary
      // "media-servers" route's aggregated views.
      if (matchedGroup?.sections.includes(hash)) {
        const targetRoute = sectionRoute(hash, requestedPath);
        const alreadyCovered = (route.views || []).some((view) => view.panel === targetRoute.panel);
        if (!alreadyCovered) route.views = [...(route.views || []), ...targetRoute.views];
        route.section = hash;
        route.title = SECTIONS[hash].label || route.title;
        route.groupLabel = hash !== route.group ? matchedGroup.label : undefined;
      }
    } else {
      // The hash names a subsection anchor within the primary section (used
      // to scroll to a specific field/tool, not to switch pages) - keep the
      // primary route's panel/views, just reflect the subsection in the title.
      for (const [secId, secDef] of Object.entries(SECTIONS)) {
        if (secDef.subSections?.some((sub) => sub.id === hash) && matchedGroup?.sections.includes(secId)) {
          route.section = secId;
          route.title = secDef.label || route.title;
          route.groupLabel = secId !== route.group ? matchedGroup.label : undefined;
          break;
        }
      }
    }
  }
  return route;
}

function renderSettingsSidebar() {
  const menu = document.querySelector("#sidebarSettingsMenu");
  if (!menu) return;
  menu.querySelectorAll("[data-settings-group], [data-settings-group-parent], [data-settings-subsection]").forEach((el) => el.remove());
  const lockButton = menu.querySelector("#lockButton");
  const fragment = document.createDocumentFragment();

  for (const group of SECTION_GROUPS) {
    const parentPath = SECTIONS[group.id] ? `/settings/${group.id}` : `/settings/${group.sections[0]}`;
    const parentButton = document.createElement("button");
    parentButton.type = "button";
    parentButton.className = "settings-tab settings-group-parent";
    parentButton.dataset.settingsGroupParent = group.id;
    parentButton.dataset.settingsPath = parentPath;
    parentButton.textContent = group.label;
    fragment.append(parentButton);

    for (const sectionId of group.sections) {
      const definition = SECTIONS[sectionId];
      const childButton = document.createElement("button");
      childButton.type = "button";
      childButton.className = "settings-tab settings-group-child hidden";
      childButton.dataset.settingsGroup = sectionId;
      childButton.dataset.settingsPath = `${parentPath}#${sectionId}`;
      childButton.dataset.settingsGroupParent = group.id;
      childButton.textContent = definition.label;
      fragment.append(childButton);

    }
  }
  menu.insertBefore(fragment, lockButton || null);
}

function renderSettingsSectionSelect() {
  const select = document.querySelector("#settingsSectionSelect");
  if (!select) return;
  select.replaceChildren();
  const overview = document.createElement("option");
  overview.value = "/settings";
  overview.textContent = "Overview";
  select.append(overview);

  for (const group of SECTION_GROUPS) {
    const groupOptgroup = document.createElement("optgroup");
    groupOptgroup.label = group.label;
    if (!group.sections.length) {
      const option = document.createElement("option");
      option.value = `/settings/${group.id}`;
      option.textContent = group.label;
      groupOptgroup.append(option);
    }
    for (const sectionId of group.sections) {
      const definition = SECTIONS[sectionId];
      const option = document.createElement("option");
      option.value = `/settings/${sectionId}`;
      option.textContent = definition.label;
      groupOptgroup.append(option);
      for (const subSection of definition.subSections || []) {
        const subOption = document.createElement("option");
        subOption.value = `/settings/${sectionId}#${subSection.id}`;
        subOption.textContent = `- ${definition.label}: ${subSection.label}`;
        groupOptgroup.append(subOption);
      }
    }
    select.append(groupOptgroup);
  }
}

function renderSettingsOverview() {
  const list = document.querySelector("#settingsOverviewList");
  if (!list) return;
  list.replaceChildren();

  for (const group of SECTION_GROUPS) {
    const firstSectionId = group.sections[0];
    const targetSectionId = SECTIONS[group.id] ? group.id : firstSectionId;
    const parentPath = SECTIONS[group.id] ? `/settings/${group.id}` : `/settings/${firstSectionId}`;

    const box = document.createElement("button");
    box.type = "button";
    box.className = "settings-group-section";
    box.dataset.settingsPath = `${parentPath}#${targetSectionId}`;

    const groupHeading = document.createElement("h3");
    groupHeading.className = "settings-group-heading";
    groupHeading.textContent = group.label;

    const description = document.createElement("p");
    description.className = "settings-group-description";
    description.textContent = GROUP_DESCRIPTIONS[group.id] || "";

    box.append(groupHeading, description);
    list.append(box);
  }
}

function prepareToolsDisclosures() {
  // Legacy disclosure wrapper disabled - panels now use standalone glass-panel settings-cards and sync-tool-details accordions.
  return;
}

let helpResizeObserver = null;

export function prepareHelpReadMore() {
  document.querySelectorAll(".settings-row-help > article, .settings-row-help > section").forEach((article) => {
    const row = article.closest(".settings-row");
    const main = row?.querySelector(".settings-row-main");
    if (!main || row.classList.contains("hidden")) return;

    const targetHeight = main.offsetHeight || main.scrollHeight;
    if (!targetHeight || targetHeight < 20) return;

    let content = article.querySelector(":scope > .help-content");
    if (!content) {
      content = document.createElement("div");
      content.className = "help-content";
      const heading = article.querySelector(":scope > .section-heading");
      [...article.children].forEach((child) => {
        if (!child.matches(".help-read-more") && child !== heading) content.append(child);
      });
      if (heading) heading.after(content);
      else article.prepend(content);
    }

    let button = article.querySelector(":scope > .help-read-more");
    if (!button) {
      button = document.createElement("button");
      button.type = "button";
      button.className = "help-read-more button-primary sync-action-btn sync-tool-button";
      button.textContent = "Read more";
      button.addEventListener("click", () => {
        const isExpanded = article.classList.contains("help-expanded");
        if (isExpanded) {
          article.classList.remove("help-expanded");
          article.classList.add("help-collapsed");
          article.style.maxHeight = `${main.offsetHeight || main.scrollHeight}px`;
          button.textContent = "Read more";
        } else {
          article.classList.add("help-expanded");
          article.classList.remove("help-collapsed");
          article.style.maxHeight = "";
          button.textContent = "Read less";
        }
      });
      article.append(button);
    }

    if (article.dataset.helpStatic === "true") {
      button.remove();
      article.classList.remove("help-collapsed", "help-expanded");
      article.style.maxHeight = "";
      return;
    }

    if (article.classList.contains("help-expanded")) {
      button.classList.remove("hidden");
      button.textContent = "Read less";
      article.style.maxHeight = "";
      return;
    }

    const compStyle = getComputedStyle(article);
    const paddingTop = parseFloat(compStyle.paddingTop) || 0;
    const paddingBottom = parseFloat(compStyle.paddingBottom) || 0;
    const headingHeight = article.querySelector(":scope > .section-heading")?.offsetHeight || 0;
    const fullHelpHeight = content.scrollHeight + headingHeight + paddingTop + paddingBottom;

    if (fullHelpHeight > targetHeight + 2) {
      button.classList.remove("hidden");
      article.classList.add("help-collapsed");
      article.classList.remove("help-expanded");
      article.style.maxHeight = `${targetHeight}px`;
      button.textContent = "Read more";
    } else {
      button.classList.add("hidden");
      article.classList.remove("help-collapsed", "help-expanded");
      article.style.maxHeight = "";
    }
  });

  if (typeof ResizeObserver !== "undefined" && !helpResizeObserver) {
    helpResizeObserver = new ResizeObserver(() => {
      prepareHelpReadMore();
    });
    document.querySelectorAll(".settings-row-main").forEach((main) => {
      helpResizeObserver.observe(main);
    });
  }
}

export function prepareSettingsShell() {
  renderSettingsSidebar();
  renderSettingsSectionSelect();
  renderSettingsOverview();
  prepareToolsDisclosures();
}

export function applySettingsRoute(route) {
  document.querySelector("#settingsOverview")?.classList.toggle("hidden", route.kind !== "overview");
  document.querySelectorAll("[data-settings-panel]").forEach((panel) => panel.classList.add("hidden"));
  document.querySelectorAll("[data-sub-panel]").forEach((panel) => panel.classList.add("hidden"));
  document.querySelectorAll("[data-settings-disclosure]").forEach((panel) => {
    panel.classList.add("hidden");
    panel.open = false;
  });

  if (route.kind === "task") {
    // A route may aggregate multiple views (a parent group's page shows every
    // child section's panel together), so reveal each one in turn.
    const views = route.views?.length ? route.views : [{ panel: route.panel, subPanels: route.subPanels, backupTab: route.backupTab }];
    const requestedBackupTabs = new Set();
    for (const view of views) {
      if (!view.panel) continue;
      const requestedSubPanels = view.subPanels || [];
      // Some parent routes aggregate multiple panes that share a panel name
      // (for example Account and Webhooks both use "general"). Reveal only
      // the pane containing this view's subsection so an empty sibling cannot
      // add an unexplained gap above the first visible card.
      const panels = [...document.querySelectorAll(`[data-settings-panel="${view.panel}"]`)].filter((panel) =>
        !requestedSubPanels.length
        || requestedSubPanels.some((name) => panel.querySelector(`[data-sub-panel="${name}"]`)),
      );
      for (const panel of panels) panel.classList.remove("hidden");
      for (const name of requestedSubPanels) {
        document.querySelector(`[data-sub-panel="${name}"]`)?.classList.remove("hidden");
        const disclosure = document.querySelector(`[data-settings-disclosure="${name}"]`);
        if (disclosure) {
          disclosure.classList.remove("hidden");
          disclosure.open = true;
        }
      }
      if (view.panel === "backups" && view.backupTab) requestedBackupTabs.add(view.backupTab);
    }
    if (requestedBackupTabs.size) {
      document.querySelectorAll('[data-settings-panel="backups"]').forEach((panel) => {
        panel.classList.toggle("hidden", !requestedBackupTabs.has(panel.dataset.backupsPanel));
      });
    }
    // The onboarding wizard's "Restore from backup" flow borrows #restore-local
    // /#restore-remote (see onboarding.js) rather than duplicating their
    // upload/list/restore logic - reclaim them here whenever this Restore tab
    // is actually opened, so a user who left the wizard mid-flow (browser
    // back, a different tab) never finds this tab empty.
    if (requestedBackupTabs.has("restore")) {
      const home = document.getElementById("restoreSectionsHome");
      if (home) {
        const local = document.getElementById("restore-local");
        const remote = document.getElementById("restore-remote");
        if (local && local.parentElement !== home) home.appendChild(local);
        if (remote && remote.parentElement !== home) home.appendChild(remote);
      }
    }
  }

  // Handle parent/child active and visibility states
  document.querySelectorAll("[data-settings-group-parent]").forEach((button) => {
    const active = route.group === button.dataset.settingsGroupParent;
    button.classList.toggle("active", active);
  });

  document.querySelectorAll("[data-settings-group]").forEach((button) => {
    const parentGroupId = button.dataset.settingsGroupParent;
    const isParentActive = route.kind === "task" && route.group === parentGroupId;
    button.classList.toggle("hidden", !isParentActive);

    const active = route.section === button.dataset.settingsGroup;
    button.classList.toggle("active", active);
    if (active) button.setAttribute("aria-current", "page");
    else button.removeAttribute("aria-current");
  });

  document.querySelectorAll("[data-settings-subsection]").forEach((button) => {
    const parentSection = button.dataset.settingsParentSection;
    const parentGroup = SECTION_GROUPS.find((g) => g.sections.includes(parentSection));
    const isParentActive = route.kind === "task" && route.group === parentGroup?.id;
    button.classList.toggle("hidden", !isParentActive);

    const hash = window.location.hash.slice(1);
    const active = hash ? button.dataset.settingsSubsection === hash : false;
    button.classList.toggle("active", active);
    if (active) button.setAttribute("aria-current", "location");
    else button.removeAttribute("aria-current");
  });

  const select = document.querySelector("#settingsSectionSelect");
  if (select) select.value = route.kind === "overview" ? "/settings" : route.path;
  prepareHelpReadMore();
  return route;
}

export function focusSettingsRoute(route) {
  // The settings section is inside the app's scrolling shell; it is not the
  // scroll container itself. Reset the shell so repeated clicks on the active
  // parent route cannot preserve a child-section offset.
  const container = document.querySelector(".page-shell");
  if (container) {
    if (typeof container.scrollTo === "function") {
      container.scrollTo({ top: 0, left: 0, behavior: "instant" });
    }
  }
  window.scrollTo(0, 0);
}

// Resolves a section id to the DOM element that represents it on an
// aggregated parent page, so the sidebar can scroll a specific child section
// into view instead of only landing at the top of the group's page.
function settingsSectionElement(sectionId) {
  if (!sectionId) return null;
  const exact = document.getElementById(sectionId);
  if (exact) return exact;

  const group = SECTION_GROUPS.find((g) => g.id === sectionId);
  const effectiveSection = group ? group.sections[0] : sectionId;

  const definition = SECTIONS[effectiveSection];
  if (!definition) return document.querySelector(`[data-sub-panel="${effectiveSection}"]`) || document.querySelector(`[data-settings-panel="${effectiveSection}"]`);

  const view = definition.views?.[0] || { panel: definition.panel, subPanels: definition.subPanels, backupTab: definition.backupTab };
  if (!view.panel) return null;
  if (view.subPanels?.length) {
    const name = view.subPanels[0];
    return document.querySelector(`[data-settings-disclosure="${name}"]`) || document.querySelector(`[data-sub-panel="${name}"]`);
  }
  if (view.backupTab) return document.querySelector(`[data-settings-panel="${view.panel}"][data-backups-panel="${view.backupTab}"]`);
  return document.querySelector(`[data-settings-panel="${view.panel}"]`);
}

let _highlightTimer = null;

export function scrollToSettingsSection(sectionId) {
  const target = settingsSectionElement(sectionId);
  if (!target) return;

  const detailsTarget = target.closest("details") || (target.tagName === "DETAILS" ? target : null);
  if (detailsTarget) {
    if (!detailsTarget.open) {
      detailsTarget.open = true;
      detailsTarget.dispatchEvent(new Event("toggle"));
    }
  }

  let parent = target.parentElement;
  while (parent && parent !== document.body) {
    if (parent.tagName === "DETAILS" && !parent.open) {
      parent.open = true;
      parent.dispatchEvent(new Event("toggle"));
    }
    parent = parent.parentElement;
  }

  const scrollContainer = document.querySelector(".page-shell") || document.scrollingElement || document.documentElement;
  const topbar = document.querySelector(".page-topbar, .right-topbar");
  const topbarHeight = topbar ? topbar.offsetHeight : 0;
  
  const containerRect = scrollContainer.getBoundingClientRect();
  const targetRect = target.getBoundingClientRect();
  const targetTop = targetRect.top - containerRect.top + (scrollContainer.scrollTop || 0) - topbarHeight - 16;

  if (typeof scrollContainer.scrollTo === "function") {
    scrollContainer.scrollTo({ top: Math.max(0, targetTop), behavior: "smooth" });
  } else {
    target.scrollIntoView({ behavior: "smooth", block: "start" });
  }

  if (!target.matches("button, a, input, select, textarea")) target.setAttribute("tabindex", "-1");
  target.focus({ preventScroll: true });

  // `target` is often the whole `.settings-row` (main card + help card side by
  // side) so scrolling lands on the full row - but only the main settings box
  // should get the highlight glow, not the help column beside it.
  const highlightTarget = target.classList.contains("settings-row")
    ? target.querySelector(".settings-row-main > article, .settings-row-main > .settings-card") || target
    : target;

  document.querySelectorAll(".settings-target-highlight").forEach((el) => {
    el.classList.remove("settings-target-highlight");
  });
  if (_highlightTimer) clearTimeout(_highlightTimer);

  highlightTarget.classList.add("settings-target-highlight");
  _highlightTimer = setTimeout(() => {
    highlightTarget.classList.remove("settings-target-highlight");
  }, 2500);
}
