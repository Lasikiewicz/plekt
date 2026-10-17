import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import "./domStubs.js";

// Small core and route helpers split out of app.js, app-events.js, and the
// larger route modules during the application-speed work. These run in Node
// against the real modules with a minimal DOM and a stubbed fetch.
globalThis.document.querySelector = () => null;
globalThis.document.querySelectorAll = () => [];

const read = (file) => fs.readFileSync(path.resolve(import.meta.dirname, "..", file), "utf8");
const appSource = read("public/app.js");
const appEventsSource = read("public/modules/app-events.js");
const indexSource = read("public/index.html");
const upcomingSource = read("public/modules/upcoming.js");
const syncSource = read("public/modules/sync.js");
const stylesSource = read("public/styles.css");
const personalMediaSource = read("public/modules/personal-media.js");
const mediaDetailContextSource = read("public/modules/media-detail-context.js");
const mediaDetailMovieSource = read("public/modules/media-detail-movie.js");
const mediaDetailSharedSource = read("public/modules/media-detail-shared.js");
const showDetailSource = read("public/modules/media-detail-show.js");
const showDetailEventsSource = read("public/modules/media-detail-events.js");
const editDialogsSource = read("public/modules/edit-dialogs.js");
const watchActionSource = read("public/modules/watch-action.js");

const { state } = await import("../public/modules/state.js");
const utils = await import("../public/modules/utils.js");
const { nowPlayingHref } = await import("../public/modules/media-routing.js");
const { dedupeMediaRecords, mediaRecordIdentity } = await import("../public/modules/media-records.js");
const { isShowInUpNext, manualShowMatches, upNextShowActionHtml } = await import("../public/modules/up-next-shared.js");
const { loadManualWatchReviewSummary } = await import("../public/modules/status-indicators.js");
const { hydratePersonalMetadata } = await import("../public/modules/personal-media-metadata.js");
const { refreshRatingSyncStatus } = await import("../public/modules/rating-sync-settings.js");
const { loadSyncHistory } = await import("../public/modules/sync.js");
const { applyLiveHistoryChanges } = await import("../public/modules/media-detail-events.js");

function stubFetch(handler) {
  const calls = [];
  globalThis.fetch = async (url, options = {}) => {
    calls.push({ url: String(url), options });
    const body = await handler(String(url), options);
    return { ok: true, status: 200, json: async () => body };
  };
  return calls;
}

test("build versions format in core utils, so the sidebar badge never waits for Settings", () => {
  assert.equal(utils.formatBuildVersion("1.1.1.0.0"), "1.1.1");
  assert.equal(utils.formatBuildVersion("v1.1.1.2.0"), "1.1.1.2");
  assert.equal(utils.formatBuildVersion("1.1.1.0.3"), "1.1.1.0.3");
  assert.equal(utils.versionDisplayLabel("1.1.1", "release"), "1.1.1");
  assert.equal(utils.versionDisplayLabel("1.1.1", "alpha", { version: "1.1.1.2.0" }), "1.1.1.2 (Alpha)");
  assert.equal(utils.versionDisplayLabel("1.1.1", "develop", null, { version: "1.1.1.0.4" }), "1.1.1.0.4 (Develop)");
  assert.equal(utils.versionDisplayLabel("2.1.0", "develop", null, { version: "2.1.0.0.0" }), "2.1.0.0.0 (Develop)");
  // Regression: app.js once read formatBuildVersion from the Settings-only
  // changelog module, so every other page rendered a bare "v" badge.
  assert.doesNotMatch(appSource, /formatBuildVersion = lazyNoop/);
  assert.match(appSource, /versionDisplayLabel \} from "\.\/modules\/utils\.js/);
});

test("list dates format without the Stats route module", () => {
  assert.match(utils.formatListDate("2026-09-14"), /2026/);
  assert.equal(utils.formatListDate(""), "");
  assert.equal(utils.formatListDate("not a date"), "");
});

test("Now Playing links resolve TV sessions to the show and movies by id or title", () => {
  assert.equal(
    nowPlayingHref({ mediaType: "episode", ids: { tmdb: 1399 }, showTitle: "Game of Thrones" }),
    utils.tvShowTmdbHref(1399, utils.showName("Game of Thrones")),
  );
  assert.equal(nowPlayingHref({ season: 1, episode: 2, showTitle: "Ludwig" }), `/tvshow/${utils.slug("Ludwig")}`);
  assert.equal(nowPlayingHref({ mediaType: "movie", tmdb_id: 447332, title: "A Quiet Place" }), utils.movieTmdbHref(447332, "A Quiet Place"));
  const movie = { id: "hist-7", media_type: "movie", title: "Bad Grandpa" };
  state.history = [movie];
  assert.equal(nowPlayingHref({ mediaType: "movie", id: "hist-7", title: "Bad Grandpa" }), utils.movieHref(movie));
  state.history = [];
});

test("Now Playing TV fallback reuses a loaded local show identity when the provider omits ids", () => {
  state.showsRaw = [{ title: "Ludwig", tmdb_id: 243360 }];
  assert.equal(
    nowPlayingHref({ mediaType: "episode", season: 2, episode: 3, showTitle: "Ludwig (2024)" }),
    utils.tvShowTmdbHref(243360, "Ludwig"),
  );
  state.showsRaw = [];
});

test("media records dedupe by show identity and keep the latest watch", () => {
  const older = { media_type: "episode", show_tmdb_id: 100, show_title: "Reacher", watched_at: "2026-01-01" };
  const newer = { media_type: "episode", show_tmdb_id: 100, show_title: "Reacher", watched_at: "2026-02-01" };
  assert.equal(mediaRecordIdentity(older), "show:tmdb:100");
  assert.deepEqual(dedupeMediaRecords([older, newer]), [newer]);
  const poster = { media_type: "movie", title: "Heat", poster_url: "https://image.tmdb.org/t/p/w342/heat.jpg?x=1" };
  assert.equal(mediaRecordIdentity(poster), "movie:poster:tmdb-poster:heat.jpg");
});

test("Up Next show helpers match across id field spellings and escape markup", () => {
  assert.equal(manualShowMatches({ tvdb_id: 42 }, { show_tvdb_id: "42" }), true);
  assert.equal(manualShowMatches({ title: "Ted Lasso" }, { show_title: "ted lasso" }), true);
  assert.equal(manualShowMatches({ title: "Silo" }, { title: "Slow Horses" }), false);
  state.upNextManualShows = [];
  state.upNextItems = [{ media_type: "movie", tmdb_id: 5, title: "Heat" }, { media_type: "episode", show_tmdb_id: 7, show_title: "Silo" }];
  assert.equal(isShowInUpNext({ tmdb_id: 5, title: "Heat" }), false, "a movie item is never a show in Up Next");
  assert.equal(isShowInUpNext({ tmdb_id: 7, title: "Silo" }), true);
  const html = upNextShowActionHtml({ tmdb_id: 7, title: `Bob's "Show"` });
  assert.match(html, /data-up-next-show-action="remove"/);
  assert.doesNotMatch(html, /"Show""/);
  state.upNextItems = [];
});

test("the Manual Watch review summary shares one in-flight request", async () => {
  state.token = "session";
  const calls = stubFetch(async () => ({ ok: true, count: 3 }));
  const [first, second] = await Promise.all([loadManualWatchReviewSummary(), loadManualWatchReviewSummary()]);
  assert.equal(calls.length, 1);
  assert.equal(first, 3);
  assert.equal(second, 3);
  assert.equal(state.manualWatchReviewCount, 3);
  state.token = "";
  assert.equal(await loadManualWatchReviewSummary(), 0, "signed out: no request, count cleared");
  assert.equal(calls.length, 1);
});

test("personal metadata fill asks only about the page being viewed", async () => {
  state.token = "session";
  state.activeView = "playlists";
  state.personalMediaTab = "lists";
  state.tmdbDetailsCache = new Map();
  state.personalRatings = [{ media_type: "movie", tmdb_id: 1, title: "Rated" }];
  state.personalWatchlist = [{ media_type: "movie", tmdb_id: 2, title: "Saved" }];
  state.personalLists = [{ id: "l1", items: [{ media_type: "movie", tmdb_id: 3, title: "Listed" }] }];
  const requested = [];
  stubFetch(async (url, options) => {
    const items = JSON.parse(options.body || "{}").items || [];
    requested.push(...items.map((item) => item.tmdbId));
    return { results: items.map((item) => ({ details: { id: item.tmdbId, overview: `About ${item.tmdbId}`, release_date: "2020-01-01" } })) };
  });
  const changed = await hydratePersonalMetadata({ normalizeItem: (item) => item });
  assert.equal(changed, true);
  assert.deepEqual(requested, [3], "ratings and watchlist items are not fetched from Playlists");
  assert.equal(state.personalLists[0].items[0].overview, "About 3");
  assert.equal(state.personalRatings[0].overview, undefined);
  state.token = "";
});

test("Settings status reuse: page open and saved-config apply share one request, saves always refetch", async () => {
  state.token = "session";
  const calls = stubFetch(async () => ({ providers: [] }));
  await Promise.all([refreshRatingSyncStatus({ maxAgeMs: 2000 }), refreshRatingSyncStatus({ maxAgeMs: 2000 })]);
  assert.equal(calls.length, 1, "concurrent reuse callers share the request");
  await refreshRatingSyncStatus({ maxAgeMs: 2000 });
  assert.equal(calls.length, 1, "a status fetched moments ago is reused");
  await refreshRatingSyncStatus();
  assert.equal(calls.length, 2, "an explicit refresh (after a save) always fetches");
  state.token = "";
});

test("sync history is reused within one Settings navigation but a forced load refetches", async () => {
  state.token = "session";
  state.syncHistoryLoaded = false;
  const calls = stubFetch(async () => ({ history: [{ id: 1 }] }));
  await loadSyncHistory({ maxAgeMs: 5000 });
  await loadSyncHistory({ maxAgeMs: 5000 });
  assert.equal(calls.length, 1);
  await loadSyncHistory({ force: true });
  assert.equal(calls.length, 2);
  state.token = "";
});

test("provider history changes fall back to the durable record id after identity repair rewrites the key", async () => {
  state.token = "session";
  state.history = [];
  state.partWatchedRaw = [];
  state.showsRaw = [];
  const recordId = "provider-watch-1";
  const calls = stubFetch(async (url) => {
    if (url.includes("/api/history?mediaKey=")) return { items: [{ mediaKey: "episode:2:5:tvdb:11756906", row: null, progress: null }] };
    if (url === `/api/history?id=${recordId}`) {
      return {
        row: {
          id: recordId,
          media_key: "episode:2:5:tvdb:435298",
          media_type: "episode",
          title: "Ludwig - S02E05",
          show_title: "Ludwig",
          season: 2,
          episode: 5,
          watched_at: "2026-09-18T22:33:38.585Z",
          sync_action: "watched",
          source: "emby",
        },
        progress: null,
      };
    }
    throw new Error(`unexpected URL: ${url}`);
  });

  const applied = await applyLiveHistoryChanges([{
    sourceTable: "watch_history",
    changeKind: "upsert",
    mediaKey: "episode:2:5:tvdb:11756906",
    recordId,
    mediaType: "episode",
    season: 2,
    episode: 5,
    showTitle: "Ludwig",
  }]);

  assert.equal(applied, 1);
  assert.equal(state.history[0]?.id, recordId);
  assert.equal(state.history[0]?.media_key, "episode:2:5:tvdb:435298");
  assert.equal(calls.length, 2, "the stale keyed lookup is followed by one durable-id lookup");
  state.token = "";
  state.history = [];
  state.partWatchedRaw = [];
  state.showsRaw = [];
});

test("a finished setup never downloads the onboarding wizard", () => {
  const dashboardSource = read("public/modules/dashboard.js");
  assert.doesNotMatch(dashboardSource, /from "\.\/onboarding\.js/, "the dashboard must not statically import the wizard");
  assert.match(dashboardSource, /ifLoaded\("onboarding", "renderDashboardChecklist"\)/);
  const check = appSource.slice(appSource.indexOf("Keep the large wizard graph out of the first authenticated render"), appSource.indexOf("isConfigSensitiveRoute(fullPath) && !state.mustChangePassword"));
  assert.match(check, /fetch\("\/api\/setup\/status"/);
  assert.match(check, /if \(ok && done && !data\?\.checklist\?\.length\) return;/);
  assert.match(check, /loadRouteModule\("onboarding"\)\.then\(\(\) => loadSetupStatus\(\)\)/);
});

test("refresh-job status is resumed from Settings, not on every page", () => {
  assert.doesNotMatch(appSource, /scheduleDeferredStartupWork\(startDeferredStatusWork\);\s*resumeActiveRefreshJobs\(\);/);
  const lifecycle = appSource.slice(appSource.indexOf("function syncSettingsStatusLifecycle()"), appSource.indexOf("function applyActiveViewNow()"));
  assert.match(lifecycle, /resumeActiveRefreshJobs\(\);/);
});

test("route entry scroll reset survives lazy route rendering", () => {
  assert.match(appSource, /pendingPageEntryScrollResetGeneration/);
  assert.match(appSource, /container\.scrollTo\(\{ top: 0, left: 0, behavior: "auto" \}\)/);
  assert.match(appSource, /finishPageEntryScrollReset\(generation\)/);
  assert.match(appSource, /routePathname\(url\) === "\/upcoming"/);
  assert.match(appSource, /hasExplicitAnchor/);
});

test("Now Playing refreshes suspended mobile pages on resume", () => {
  assert.match(syncSource, /loadActiveSessions\(\{ force = false \} = \{\}\)/);
  assert.match(syncSource, /nowPlayingRequestController/);
  assert.match(syncSource, /nowPlayingRequestGeneration/);
  assert.match(appEventsSource, /startHistoryPolling\(\{ force: true \}\)/);
  assert.match(appEventsSource, /window\.addEventListener\("pageshow", resumeNowPlayingPolling\)/);
  assert.match(appEventsSource, /window\.addEventListener\("focus", resumeNowPlayingPolling\)/);
});

test("mobile show detail episodes stay in a two-column grid", () => {
  assert.match(
    stylesSource,
    /@media \(max-width: 760px\) \{\s+\.media-detail-page \.show-episode-list \{\s+grid-template-columns: repeat\(2, minmax\(0, 1fr\)\);/,
  );
  assert.match(
    stylesSource,
    /@media \(max-width: 760px\) \{\s+\.season-accordion-trigger[\s\S]*?\.season-accordion-panel \.show-episode-list \{\s+grid-template-columns: repeat\(2, minmax\(0, 1fr\)\);/,
  );
});

test("mobile TV show summaries sit below the logo without moving progress", () => {
  assert.match(showDetailSource, /media-detail-page media-detail-show-page/);
  assert.match(
    stylesSource,
    /@media \(max-width: 640px\) \{[\s\S]*?\.media-detail-page\.media-detail-show-page \.immersive-overview \{\s+grid-column: 2;\s+grid-row: 2 \/ 6;/,
  );
  assert.match(
    stylesSource,
    /\.media-detail-page \.progress-section \{\s+grid-column: 1 \/ -1;\s+grid-row: 6;/,
  );
});

test("mobile show detail episodes use a compact title, availability, summary, and watched hierarchy", () => {
  assert.match(showDetailSource, /immersive-episode-availability/);
  assert.match(showDetailSource, /episodeAvailabilityPillsHtml/);
  assert.match(
    stylesSource,
    /\.season-accordion-panel \.immersive-episode-row\.is-watched \.immersive-episode-meta-row \{\s+display: none;/,
  );
  assert.match(
    stylesSource,
    /\.season-accordion-panel \.immersive-episode-row\.is-watched \.episode-watch-history-row:not\(:first-child\)/,
  );
  assert.match(
    stylesSource,
    /\.season-accordion-panel \.immersive-episode-row\.is-watched \.episode-watch-history-row \.source-badge \{\s+display: none;/,
  );
});

test("mobile TV season summary stays on one line without Expand All", () => {
  assert.match(showDetailSource, /season-section-title/);
  assert.match(showDetailSource, /renderSeerrRequestPill\("tv", tvSeerrTmdbId, showIsNowPlaying, \{ compactTvSummary: true \}\)/);
  assert.doesNotMatch(showDetailSource, /data-toggle-all-seasons/);
  assert.match(mediaDetailSharedSource, /tvAvailabilityCompactSummary/);
  assert.match(mediaDetailSharedSource, /data-compact-tv-summary/);
  assert.match(stylesSource, /\.season-section-title[\s\S]*?\.tv-availability-summary/);
});

test("mobile TV detail controls keep navigation and season options compact", () => {
  const headingStart = showDetailSource.indexOf('<b class="immersive-episode-heading">');
  const headingEnd = showDetailSource.indexOf("</b>", headingStart);
  assert.ok(headingStart >= 0 && headingEnd > headingStart);
  const headingMarkup = showDetailSource.slice(headingStart, headingEnd);
  assert.doesNotMatch(headingMarkup, /syncStatusDotHtml/);
  assert.match(showDetailSource, /immersive-episode-availability[\s\S]*syncStatusDotHtml[\s\S]*episodeAvailabilityPillsHtml/);
  assert.match(showDetailSource, /season-mobile-action-menu/);
  assert.match(showDetailSource, /show-season-summary[\s\S]*?show-season-label[\s\S]*?season-mobile-action-menu/);
  assert.match(showDetailSource, /season-row-mobile-summary/);
  assert.doesNotMatch(showDetailSource, /episode-mobile-action-menu|Episode options/);
  assert.match(showDetailSource, /season-mobile-action-trigger">Season options</);
  assert.match(showDetailSource, /data-unwatch-kind="episode"/);
  assert.match(showDetailEventsSource, /event\.target\.closest\("details"\)/);
  assert.match(
    stylesSource,
    /\.brand-block \{[\s\S]*?position: absolute;[\s\S]*?left: 50%;[\s\S]*?transform: translateX\(-50%\);/,
  );
  assert.match(stylesSource, /\.season-row-episodes,[\s\S]*?\.season-row-watched,[\s\S]*?\.season-row-next \{\s+display: none;/);
  assert.match(stylesSource, /\.show-season-summary \{[\s\S]*?display: flex;[\s\S]*?flex: 1 1 auto;/);
  assert.doesNotMatch(stylesSource, /episode-mobile-action/);
});

test("mobile media controls keep watch actions in Options and popup surfaces within the viewport", () => {
  const showActionsStart = showDetailSource.indexOf("setMediaDetailActions(`");
  const showToolsStart = showDetailSource.indexOf("${mediaToolsActionHtml(`", showActionsStart);
  assert.ok(showActionsStart >= 0 && showToolsStart > showActionsStart);
  assert.doesNotMatch(showDetailSource.slice(showActionsStart, showToolsStart), /data-watch-scope="show"/);
  assert.match(showDetailSource.slice(showToolsStart), /data-watch-scope="show"[\s\S]*mediaForceSyncActionHtml/);
  assert.doesNotMatch(showDetailSource, /Mark <br>Watched|Mark <br>Unwatched/);
  assert.doesNotMatch(mediaDetailMovieSource, /Mark <br>Unwatched/);
  assert.match(mediaDetailMovieSource, /mediaToolsActionHtml\([\s\S]*Mark unwatched/);
  assert.doesNotMatch(mediaDetailMovieSource, /Edit <br>Images/);
  assert.doesNotMatch(showDetailSource, /Edit <br>Images/);
  assert.match(watchActionSource, /Mark Unwatched/);
  assert.match(mediaDetailContextSource, /<span>Force Sync<\/span>/);
  assert.doesNotMatch(mediaDetailContextSource, /Force <br>Sync/);
  assert.match(mediaDetailContextSource, /aria-label="Open media options" title="Options"/);
  assert.match(mediaDetailContextSource, /<span>Options<\/span>/);
  assert.doesNotMatch(personalMediaSource, /title="Personal media options"[\s\S]*<span>Options<\/span>/);
  assert.match(stylesSource, /actions-tools-panel \.action-pill span,[\s\S]*white-space: nowrap;/);
  assert.match(stylesSource, /\.watch-date-options \{\s+grid-template-columns: minmax\(0, 1fr\);/);
  assert.match(editDialogsSource, /watch-date-remove-btn[\s\S]*?btn\.disabled = false;[\s\S]*?btn\.title = "Remove this watch date"/);
  assert.doesNotMatch(editDialogsSource, /Use “Mark unwatched” to remove the only watch date/);
  assert.match(stylesSource, /\.wd-body \{\s+flex-direction: column;/);
  assert.match(stylesSource, /\.edit-dialog-overlay \{\s+align-items: center;[\s\S]*overflow-y: auto;/);
  assert.match(stylesSource, /\.modal-panel:not\(\.modal-panel--immersive\) \{\s+width: 100%;[\s\S]*max-height: calc\(100vh - 1rem\);/);
  assert.match(stylesSource, /body \.explorer-controls:not\(\.hidden\) \{\s+width: 100% !important;/);
  assert.match(stylesSource, /body #upcomingTopbarControls:not\(\.hidden\) \{\s+display: grid !important;/);
  assert.match(stylesSource, /body \.page-topbar-actions > \.hidden,[\s\S]*body #upcomingTopbarControls\.hidden,[\s\S]*display: none !important;/);
});

test("mobile page controls share the media action-bar layout without redundant Options menus", () => {
  for (const id of [
    "discoverTopbarControls",
    "historyTopbarControls",
    "statsTopbarControls",
    "upcomingTopbarControls",
    "explorerTopbarControls",
  ]) {
    assert.match(indexSource, new RegExp("id=\"" + id + "\"[^>]*page-action-bar"), id + " should use the shared action bar");
  }
  assert.match(indexSource, /id="discoverMediaType"[\s\S]*id="discoverGenre"[\s\S]*id="discoverRefreshButton"/);
  assert.doesNotMatch(indexSource, /title="Discover filters"/);
  assert.match(indexSource, /id="upcomingSearchInput"[\s\S]*id="upcomingTodayButton"/);
  const upcomingStart = indexSource.indexOf('<section id="upcoming-view"');
  const upcomingEnd = indexSource.indexOf('<section id="sync-activity-view"', upcomingStart);
  const upcomingMarkup = indexSource.slice(upcomingStart, upcomingEnd);
  assert.match(upcomingMarkup, /upcoming-search-dropdown/);
  assert.match(upcomingMarkup, /upcoming-search-dropdown[\s\S]*upcoming-month-controls[\s\S]*upcomingTodayButton/);
  assert.match(upcomingMarkup, /<\/div>\s*<div id="upcomingCalendar"/);
  assert.doesNotMatch(upcomingMarkup, /page-tools-dropdown/);
  assert.match(upcomingSource, /function scrollToToday[\s\S]*window\.matchMedia\("\(max-width: 760px\)"\)/);
  assert.match(upcomingSource, /anchorTo\(`\[data-day="\$\{today\}"\]`/);
  // History has no size control; its cards match the other pages' size.
  assert.doesNotMatch(indexSource, /id="historyPosterSize"|data-target="size"/);
  assert.doesNotMatch(indexSource, /title="History options"/);
  assert.match(indexSource, /id="statsMediaFilter"[\s\S]*id="statsPeriodType"[\s\S]*id="statsPeriodValue"/);
  const statsStart = indexSource.indexOf('<section id="stats-view"');
  const statsEnd = indexSource.indexOf('<section id="upcoming-view"', statsStart);
  assert.doesNotMatch(indexSource.slice(statsStart, statsEnd), /page-tools-dropdown/);
  assert.doesNotMatch(indexSource, /id="explorerPosterSize"|class="compact-field explorer-size-slider"/);
  assert.doesNotMatch(indexSource, /id="settingsTopbarControls"/);
  assert.doesNotMatch(indexSource, /id="settingsSectionSelect"/);
  assert.doesNotMatch(indexSource, /<span>Tools<\/span>/);
  assert.match(indexSource, /title="Search upcoming episodes"/);
  assert.doesNotMatch(indexSource, /title="Library options"/);
  const explorerStart = indexSource.indexOf('<section class="view-panel hidden" data-view-panel="explorer">');
  const explorerEnd = indexSource.indexOf('<section id="settings-view"', explorerStart);
  const explorerMarkup = indexSource.slice(explorerStart, explorerEnd);
  assert.doesNotMatch(explorerMarkup, /data-target="size"|explorer-size-slider/);
  assert.match(personalMediaSource, /page-action-bar personal-media-toolbar-actions/);
  assert.doesNotMatch(personalMediaSource, /title="Personal media options"/);
  assert.match(personalMediaSource, /personal-media-sync-button/);
  assert.match(personalMediaSource, /personal-media-create-list-button/);
  assert.match(stylesSource, /Shared media-style page action bars/);
  assert.match(stylesSource, /page-topbar-actions \.page-action-bar:not\(\.hidden\)/);
  assert.match(stylesSource, /page-tools-dropdown\[open\] > \.page-tools-panel/);
  assert.match(stylesSource, /\.upcoming-week-day\.is-outside \{\s+display: none;/);
  assert.doesNotMatch(stylesSource, /\.upcoming-week-day\.is-outside,\s+\.upcoming-week-day\.is-empty/);
  assert.match(stylesSource, /grid-template-areas: "search month today"/);
});
