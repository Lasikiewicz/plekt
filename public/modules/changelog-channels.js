// Settings -> Changelog: the entry renderer, the Main / Alpha channel toggle,
// and the build-version helpers the changelog needs.
//
// This is a Settings route module (see route-modules.js). The pieces every
// page needs - formatBuildVersion(), versionDisplayLabel(), and the sidebar
// version badge - live in core utils.js and app.js, so the badge never waits
// for this module.
//
// The toggle is available on every channel: /api/changelog returns the alpha
// branch's live manifest regardless of what is installed, so a stable user can
// read alpha notes. Selecting the Alpha tab never changes the reported installed
// version and never raises an update prompt - the server forces
// alphaBuild.newerBuildAvailable false off the alpha channel for exactly that
// reason.
import { state, elements } from "./state.js?v=2.1.1.0.9";
import { escapeAttribute, escapeHtml, formatBuildVersion, formatListDate, versionDisplayLabel } from "./utils.js?v=2.1.1.0.9";

export { formatBuildVersion };

let _cb = {};
export function initChangelog(callbacks = {}) {
  _cb = callbacks;
}

// Which tab is showing. Held here rather than in state.js because it is purely
// local view state for one panel and is not persisted. Null until the first
// render or a tab click, so the panel opens on the tab matching the install.
let selectedChannel = null;

// Alpha and develop installs open on the Alpha tab, which holds their own
// build notes; a release install opens on Main. Opening every install on Main
// showed the previous release's text first on alpha (loose-ends step 14).
export function defaultChangelogChannel(installChannel) {
  return installChannel === "alpha" || installChannel === "develop" ? "alpha" : "main";
}

export function selectedChangelogChannel(installChannel) {
  return selectedChannel || defaultChangelogChannel(installChannel);
}

export function setSelectedChangelogChannel(channel) {
  selectedChannel = channel === "alpha" ? "alpha" : "main";
  return selectedChannel;
}

export function renderChangelogChannelTabs({ selected = "main", alphaCount = 0 } = {}) {
  const tab = (channel, label, count) => `
    <button
      class="changelog-channel-tab${selected === channel ? " is-selected" : ""}"
      type="button"
      role="tab"
      aria-selected="${selected === channel ? "true" : "false"}"
      data-changelog-channel="${channel}"
    >${label}${count ? ` <span class="changelog-channel-count">${count}</span>` : ""}</button>`;

  return `
    <div class="changelog-channel-tabs" role="tablist" aria-label="Changelog channel">
      ${tab("main", "Main")}
      ${tab("alpha", "Alpha", alphaCount)}
    </div>`;
}

// Wires the tab buttons inside `root`. `onSelect` is called with the new
// channel only when it actually changed, so a repeat click does not re-render.
export function bindChangelogChannelTabs(root, onSelect) {
  if (!root) return;
  root.querySelectorAll("[data-changelog-channel]").forEach((button) => {
    button.addEventListener("click", () => {
      const channel = button.getAttribute("data-changelog-channel");
      if (!channel || channel === selectedChannel) return;
      setSelectedChangelogChannel(channel);
      onSelect?.(selectedChannel);
    });
  });
}

// The develop build version for a given build number, derived from the local
// build's own version by replacing the dev segment.
//
// A develop changelog entry carries only its build number, not a version, and
// the remote "not pulled yet" entries carry build numbers other than the local
// one - so reusing the local version string verbatim would label build 3 with
// build 1's version.
export function developVersionForBuild(developVersion, build) {
  const base = formatBuildVersion(developVersion);
  const parts = base.split(".");
  if (parts.length < 3 || !parts.every((part) => /^\d+$/.test(part))) return base;
  const segments = parts.map(Number);
  while (segments.length < 5) segments.push(0);
  segments[4] = Number(build) || 0;
  return formatBuildVersion(segments.join("."));
}

// The released base a pre-release build sits on: the first three segments.
export function baseVersionOf(version) {
  const parts = String(version ?? "").trim().replace(/^v/i, "").split(".");
  if (parts.length < 3 || !parts.slice(0, 3).every((part) => /^\d+$/.test(part))) return "";
  return parts.slice(0, 3).join(".");
}

function renderWebsiteLink(entry) {
  const websiteUrl = String(entry?.websiteUrl || "").trim();
  if (!/^https:\/\/(?:plekt\.net|plembfin\.com)(?:\/|$)/i.test(websiteUrl)) return "";
  return `<p class="changelog-entry-website"><a href="${escapeAttribute(websiteUrl)}" target="_blank" rel="noopener noreferrer">Visit the Plekt website</a></p>`;
}

// Splits alpha build entries into the ones built on the installed release and
// the ones left over from earlier cycles.
//
// "Force to main" resets the bundled manifest but never touches the `alpha`
// branch, so origin/alpha legitimately still holds the previous cycle's builds
// after a release. Showing them unlabelled under "Alpha releases" reads as if
// they were current. They are real history and worth keeping, so they are
// separated and labelled with the release they were built on rather than hidden.
export function partitionAlphaEntriesByBase(entries = [], currentBaseVersion = "") {
  const current = baseVersionOf(currentBaseVersion);
  const currentCycle = [];
  const olderByBase = new Map();

  for (const entry of Array.isArray(entries) ? entries : []) {
    if (!entry) continue;
    const base = baseVersionOf(entry.version) || baseVersionOf(entry.baseVersion);
    if (!current || !base || base === current) {
      currentCycle.push(entry);
      continue;
    }
    if (!olderByBase.has(base)) olderByBase.set(base, []);
    olderByBase.get(base).push(entry);
  }

  // Newest base first, so the most recent history sits nearest the current cycle.
  const older = [...olderByBase.entries()].sort((a, b) => {
    const pa = a[0].split(".").map(Number);
    const pb = b[0].split(".").map(Number);
    for (let i = 0; i < 3; i++) {
      if ((pb[i] || 0) !== (pa[i] || 0)) return (pb[i] || 0) - (pa[i] || 0);
    }
    return 0;
  });

  return { currentCycle, older };
}

function compareChangelogVersions(a, b) {
  const parse = (value) => {
    const match = String(value || "").trim().match(/^(\d+)\.(\d+)\.(\d+)/);
    return match ? [Number(match[1]), Number(match[2]), Number(match[3])] : null;
  };
  const pa = parse(a);
  const pb = parse(b);
  if (!pa || !pb) return 0;
  for (let i = 0; i < 3; i++) {
    if (pa[i] > pb[i]) return 1;
    if (pa[i] < pb[i]) return -1;
  }
  return 0;
}

// Pulls the published changelog from GitHub (proxied by the server) so we can show
// the user's current build version alongside any newer releases.
export async function loadChangelogData(force = false) {
  if (!force && state.changelog) return state.changelog;
  const response = await fetch(`/api/changelog${force ? "?refresh=1" : ""}`, {
    cache: "no-store",
    headers: _cb.authHeaders?.() || {},
  });
  const data = await response.json();
  if (!response.ok) throw new Error(data?.error || `Changelog unavailable (${response.status})`);
  state.changelog = data;
  _cb.updateVersionBadge?.(data);
  return data;
}

let changelogExpanded = false;

// The Main / Alpha tabs live in the card heading, on the title row, not in the
// panel body. Cleared on every path that has no tabs to show.
function setChannelTabs(html = "") {
  if (elements.changelogChannelTabs) elements.changelogChannelTabs.innerHTML = html;
}

export async function renderChangelog(force = false) {
  if (!elements.changelogPanel) return;
  setChannelTabs();
  elements.changelogPanel.innerHTML = `<div class="idle-state"><b>Loading changelog...</b></div>`;
  try {
    const data = await loadChangelogData(force);
    const entries = Array.isArray(data.entries) ? data.entries : [];
    const current = data.current || null;
    const currentLabel = versionDisplayLabel(current, data.channel, data.alphaBuild, data.developBuild) || "?";
    const latest = data.latest || current;
    const newerCount = Array.isArray(data.newer) ? data.newer.length : 0;

    const developBuildEntries = data.channel === "develop" && Array.isArray(data.developBuild?.entries)
      ? data.developBuild.entries
      : [];
    const pendingDevelopEntries = data.channel === "develop" && Array.isArray(data.developBuild?.pendingEntries)
      ? data.developBuild.pendingEntries
      : [];
    const newerDevelopBuild = data.channel === "develop" && Boolean(data.developBuild?.newerBuildAvailable);

    // allEntries is the alpha branch's full cycle history, local and remote
    // merged server-side, and is returned on every channel so the Alpha tab
    // works on a stable install too.
    const alphaBuildEntries = Array.isArray(data.alphaBuild?.allEntries)
      ? data.alphaBuild.allEntries
      : Array.isArray(data.alphaBuild?.entries)
        ? data.alphaBuild.entries
        : [];
    const pendingAlphaEntries = data.channel === "alpha" && Array.isArray(data.alphaBuild?.pendingEntries)
      ? data.alphaBuild.pendingEntries
      : [];
    const newerAlphaBuild = data.channel === "alpha" && Boolean(data.alphaBuild?.newerBuildAvailable);

    // Every channel is told about a newer build of its own kind AND about a
    // newer published release, and both can be true at once - an alpha tester
    // wants to know that a new alpha build exists and that main has moved on.
    // So these compose into a list rather than falling through one if/else.
    //
    // A release install is never notified about alpha or develop builds: the
    // server forces alphaBuild.newerBuildAvailable false off the alpha channel
    // for exactly that reason, and developBuild is only read on develop.
    const notices = [];
    const pullHint = (tag) => `then pull the latest ghcr.io/lasikiewicz/plekt:${tag} image to update.`;

    if (!data.remoteAvailable) {
      notices.push({
        kind: "muted",
        title: "Couldn't reach GitHub",
        body: `Newer releases can't be checked right now${data.remoteError ? ` (${escapeHtml(data.remoteError)})` : ""}. What's shown below is this build's bundled changelog.`,
      });
    }

    if (newerDevelopBuild) {
      notices.push({
        kind: "update",
        title: `Newer develop build available - build ${escapeHtml(String(data.developBuild.latestBuild))}`,
        body: `You're running ${escapeHtml(currentLabel)}. See what's new below, ${pullHint("develop")}`,
      });
    }

    if (newerAlphaBuild) {
      notices.push({
        kind: "update",
        title: `Newer alpha build available - build ${escapeHtml(String(data.alphaBuild.latestBuild))}`,
        body: `You're running build ${escapeHtml(String(data.alphaBuild.build))}. See what's new below, ${pullHint("alpha")}`,
      });
    }

    // Shown on every channel. On alpha and develop `current` is the release the
    // build is based on, so this fires when main moves ahead of that base.
    if (data.updateAvailable) {
      notices.push({
        kind: "update",
        title: `New release available - v${escapeHtml(latest)}`,
        body: data.channel === "release"
          ? `You're running v${escapeHtml(currentLabel)}. ${newerCount} newer release${newerCount === 1 ? "" : "s"} listed under Main.`
          : `Your build is based on v${escapeHtml(current || "")}. ${newerCount} newer release${newerCount === 1 ? "" : "s"} listed under Main, ${pullHint("latest")}`,
      });
    }

    // The status line the card heading shows, alongside "Changelog". The most
    // actionable signal wins: a build on your own channel first, then a
    // release, then the reassuring case.
    const headingStatus = !data.remoteAvailable
      ? `Can't check for updates - ${data.channel === "develop" ? "" : "v"}${currentLabel}`
      : newerDevelopBuild
        ? `Newer develop build available`
        : newerAlphaBuild
          ? `Newer alpha build available`
          : data.updateAvailable
            ? `New release available - v${latest}`
            : `You're up to date - ${data.channel === "develop" ? "" : "v"}${currentLabel}`;
    if (elements.changelogHeadingStatus) {
      // The separator is a CSS ::before, so it can be dropped on mobile where
      // the status wraps onto its own line and a leading dash would read wrong.
      elements.changelogHeadingStatus.textContent = headingStatus;
    }

    // No banner at all when there is nothing to act on; the heading already
    // says so, and a green box repeating it was pure duplication.
    const banner = notices.map((notice) => `
        <div class="changelog-status changelog-status-${notice.kind}">
          <b>${notice.title}</b>
          <span>${notice.body}</span>
        </div>`).join("");

    if (!entries.length && !developBuildEntries.length && !alphaBuildEntries.length && !pendingDevelopEntries.length && !pendingAlphaEntries.length) {
      // Nothing on either channel: no point rendering a toggle over two empty panels.
      setChannelTabs();
      elements.changelogPanel.innerHTML = `${banner}<div class="idle-state"><b>No changelog entries found.</b></div>`;
      return;
    }

    const renderChangelogDetails = (entry) => {
      const sectionDefinitions = [
        ["newFeatures", "New Features"],
        ["majorBugFixes", "Bug Fixes"],
        ["tweaks", "Tweaks"],
      ];
      const configuredGroups = entry.sectionGroups && typeof entry.sectionGroups === "object"
        ? entry.sectionGroups
        : {};
      const sections = entry.sections && typeof entry.sections === "object"
        ? sectionDefinitions.map(([key, heading]) => {
          const groups = Array.isArray(configuredGroups[key])
            ? configuredGroups[key]
              .map((group) => ({
                title: String(group?.title || "").trim(),
                details: Array.isArray(group?.details) ? group.details.filter(Boolean) : [],
              }))
              .filter((group) => group.details.length)
            : [];
          const details = Array.isArray(entry.sections[key]) ? entry.sections[key].filter(Boolean) : [];
          return { heading, groups: groups.length ? groups : (details.length ? [{ title: "", details }] : []) };
        })
        : [];
      const populated = sections.filter((section) => section.groups.length);
      if (populated.length) {
        return `<div class="changelog-detail-groups">${populated.map(({ heading, groups }) => `
          <section class="changelog-detail-group">
            <h5>${heading}</h5>
            ${groups.length === 1 && !groups[0].title
              ? `<ul>${groups[0].details.map((detail) => `<li>${escapeHtml(detail)}</li>`).join("")}</ul>`
              : `<div class="changelog-detail-subgroups">${groups.map((group) => `
                <div class="changelog-detail-subgroup">
                  ${group.title ? `<h6>${escapeHtml(group.title)}</h6>` : ""}
                  <ul>${group.details.map((detail) => `<li>${escapeHtml(detail)}</li>`).join("")}</ul>
                </div>`).join("")}</div>`}
          </section>`).join("")}</div>`;
      }
      const details = Array.isArray(entry.details) ? entry.details.filter(Boolean) : [];
      return details.length ? `<ul>${details.map((detail) => `<li>${escapeHtml(detail)}</li>`).join("")}</ul>` : "";
    };

    const renderEntry = (entry) => {
      const isCurrent = current && entry.version === current;
      const isNewer = current && compareChangelogVersions(entry.version, current) > 0;
      const tag = isNewer
        ? `<span class="changelog-tag changelog-tag-new">New</span>`
        : isCurrent
          ? `<span class="changelog-tag changelog-tag-current">Current</span>`
          : "";
      const cls = `changelog-entry${isNewer ? " changelog-entry-new" : ""}${isCurrent ? " changelog-entry-current" : ""}`;
      return `
        <article class="${cls}">
          <div class="changelog-entry-head">
            <b>v${escapeHtml(entry.version || "")}${tag}</b>
            <time>${escapeHtml(formatListDate(entry.date) || entry.date || "")}</time>
          </div>
          <p>${escapeHtml(entry.message || "Release update")}</p>
          ${renderWebsiteLink(entry)}
          ${renderChangelogDetails(entry)}
        </article>
      `;
    };

    const renderDevelopBuildEntry = (entry, { pending = false } = {}) => {
      const isCurrent = !pending && Number(entry.build) === Number(data.developBuild?.build);
      const tag = pending
        ? `<span class="changelog-tag changelog-tag-new">Not pulled yet</span>`
        : isCurrent ? `<span class="changelog-tag changelog-tag-current">Current</span>` : "";
      // Derived per entry: a develop changelog entry carries only its build
      // number, and the "not pulled yet" entries carry builds other than the
      // local one, so the local version string cannot be reused verbatim.
      const entryVersion = entry.version
        ? formatBuildVersion(entry.version)
        : developVersionForBuild(data.developBuild?.version, entry.build);
      const versionTitle = entryVersion
        ? `v${escapeHtml(entryVersion)} (Develop)`
        : `Develop Build ${escapeHtml(String(entry.build ?? ""))}`;
      return `
        <article class="changelog-entry${isCurrent ? " changelog-entry-current" : ""}${pending ? " changelog-entry-new" : ""}">
          <div class="changelog-entry-head">
            <b>${versionTitle}${tag}</b>
            <time>${escapeHtml(formatListDate(entry.date) || entry.date || "")}</time>
          </div>
          <p>${escapeHtml(entry.message || "Develop build update")}</p>
          ${renderWebsiteLink(entry)}
          ${renderChangelogDetails(entry)}
        </article>
      `;
    };

    const renderAlphaBuildEntry = (entry, { pending = false } = {}) => {
      // Build numbers restart every cycle, so an earlier cycle's build 1 must not
      // be tagged Current just because the running build is also build 1.
      const entryBase = baseVersionOf(entry.version);
      const sameCycle = !entryBase || entryBase === baseVersionOf(data.alphaBuild?.baseVersion);
      const isCurrent = !pending && sameCycle && Number(entry.build) === Number(data.alphaBuild?.build) && data.channel === "alpha";
      const tag = pending
        ? `<span class="changelog-tag changelog-tag-new">Not pulled yet</span>`
        : isCurrent ? `<span class="changelog-tag changelog-tag-current">Current</span>` : "";
      const versionTitle = entry.version
        ? `v${escapeHtml(formatBuildVersion(entry.version))} (Alpha)`
        : `Alpha Build ${escapeHtml(String(entry.build ?? ""))}`;
      return `
        <article class="changelog-entry${isCurrent ? " changelog-entry-current" : ""}${pending ? " changelog-entry-new" : ""}">
          <div class="changelog-entry-head">
            <b>${versionTitle}${tag}</b>
            <time>${escapeHtml(formatListDate(entry.date) || entry.date || "")}</time>
          </div>
          <p>${escapeHtml(entry.message || "Alpha build update")}</p>
          ${renderWebsiteLink(entry)}
          ${renderChangelogDetails(entry)}
        </article>
      `;
    };

    const pendingDevelopSection = pendingDevelopEntries.length
      ? `<h4 class="changelog-section-heading">New since your develop build - not pulled yet</h4>${pendingDevelopEntries.map((entry) => renderDevelopBuildEntry(entry, { pending: true })).join("")}`
      : "";
    const developSection = developBuildEntries.length
      ? developBuildEntries.map((entry) => renderDevelopBuildEntry(entry)).join("")
      : "";

    const pendingAlphaSection = pendingAlphaEntries.length
      ? `<h4 class="changelog-section-heading">New since your alpha build - not pulled yet</h4>${pendingAlphaEntries.map((entry) => renderAlphaBuildEntry(entry, { pending: true })).join("")}`
      : "";
    // origin/alpha keeps the previous cycle's builds after a release, because
    // "Force to main" resets the bundled manifest but never touches the branch.
    // Those are real history, so they are kept after the current cycle without
    // a heading, rather than listed as if they were current.
    const { currentCycle: currentAlphaEntries, older: olderAlphaCycles } =
      partitionAlphaEntriesByBase(alphaBuildEntries, data.current);

    const alphaSection = currentAlphaEntries.length
      ? `<h4 class="changelog-section-heading">${data.channel === "develop" ? "Alpha builds for this release" : "Current alpha build"}</h4>${currentAlphaEntries.map((entry) => renderAlphaBuildEntry(entry)).join("")}`
      : "";

    const olderAlphaSection = olderAlphaCycles.map(([, cycleEntries]) => `
      ${cycleEntries.map((entry) => renderAlphaBuildEntry(entry)).join("")}`).join("");

    const visibleEntries = changelogExpanded ? entries : entries.slice(0, 20);
    const olderCount = entries.length - visibleEntries.length;
    const channel = selectedChangelogChannel(data.channel);
    const mainPanel = visibleEntries.map(renderEntry).join("") + (
        olderCount > 0
          ? `<button id="changelogShowAll" class="button-ghost" type="button">Show ${olderCount} older releases</button>`
          : ""
      );
    // Develop builds belong with alpha: both are pre-release, and grouping them
    // keeps the Main tab to published releases only.
    const alphaPanel = pendingDevelopSection +
      developSection +
      pendingAlphaSection +
      alphaSection +
      olderAlphaSection ||
      `<div class="idle-state"><b>No alpha builds published for this release yet.</b></div>`;

    setChannelTabs(renderChangelogChannelTabs({
      selected: channel,
      // Everything the Alpha panel shows, not just the alpha entries: the
      // panel also carries develop builds, so counting alpha alone read as a
      // mismatch against the visible list.
      alphaCount: pendingDevelopEntries.length + developBuildEntries.length
        + pendingAlphaEntries.length + alphaBuildEntries.length,
    }));
    elements.changelogPanel.innerHTML = banner +
      `<div class="changelog-channel-panel" data-changelog-panel="main"${channel === "main" ? "" : " hidden"}>${mainPanel}</div>` +
      `<div class="changelog-channel-panel" data-changelog-panel="alpha"${channel === "alpha" ? "" : " hidden"}>${alphaPanel}</div>`;

    bindChangelogChannelTabs(elements.changelogChannelTabs, () => {
      renderChangelog(false).catch(() => { });
    });
    elements.changelogPanel.querySelector("#changelogShowAll")?.addEventListener("click", () => {
      changelogExpanded = true;
      renderChangelog(false).catch(() => { });
    });
  } catch (error) {
    setChannelTabs();
    elements.changelogPanel.innerHTML = `<div class="idle-state"><b>${escapeHtml(error.message || "Unable to load changelog.")}</b></div>`;
  }
}
