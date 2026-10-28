import { escapeHtml, fetchDiagnosticLogs, formatLogLineToHtml, replaceLogContent } from "./logs.js?v=2.2.0.0.2";

export function filterLogLines(lines, query = "") {
  const needle = query.trim().toLowerCase();
  return needle ? lines.filter((line) => String(line).toLowerCase().includes(needle)) : lines;
}

// App orchestration supplies auth and browser logs; this module owns the viewer.
export function createLogsViewer({ state, elements, authHeaders, logsText,
  fetchLogs = fetchDiagnosticLogs, root = globalThis.document }) {
  let snapshot = null;
  let pending = null;
  let generation = 0;
  let bound = false;
  let painting = false;
  let paused = false;
  let following = true;
  let query = "";
  const control = (id) => root?.getElementById(id);

  function updateControls() {
    const pause = control("logsPauseButton");
    if (pause) {
      pause.textContent = paused ? "Resume updates" : "Pause updates";
      pause.setAttribute("aria-pressed", String(paused));
    }
    const follow = control("logsFollowButton");
    follow?.setAttribute("aria-pressed", String(following));
    const status = control("logsLiveStatus");
    if (status) status.textContent = paused ? "Updates paused" : "Live output · refreshes every 3 seconds";
    root?.querySelectorAll("#logsCategoryFilter button").forEach((button) => { button.disabled = paused; });
    if (elements.clearLogsButton) elements.clearLogsButton.disabled = paused;
    elements.logsTerminal?.setAttribute("aria-live", paused || !following ? "off" : "polite");
  }

  function paint(forceBottom = false) {
    if (!snapshot || !elements.logsTerminal) return;
    const terminal = elements.logsTerminal;
    const oldTop = terminal.scrollTop;
    const terminalTop = terminal.getBoundingClientRect?.().top || 0;
    const anchor = following ? null : [...(terminal.children || [])].find((row) =>
      row.dataset?.logEntry && row.getBoundingClientRect().bottom > terminalTop);
    const anchorKey = anchor?.dataset.logEntry;
    const anchorTop = anchor?.getBoundingClientRect().top;
    const backend = filterLogLines(snapshot.backend, query);
    const frontend = filterLogLines(snapshot.frontend, query);
    const sections = [
      { title: `BACKEND DIAGNOSTIC LOGS (${snapshot.category.toUpperCase()})`, lines: backend, limit: 250 },
      ...(snapshot.includeFrontend ? [{ title: "FRONTEND DEBUG LOGS", lines: frontend, limit: 50 }] : []),
    ];
    state.renderedLogsText = sections.map(({ title, lines }) =>
      [`=== ${title} ===`, ...lines, ...(lines.length ? [] : ["[no matching logs]"])].join("\n")).join("\n\n");
    const html = sections.map(({ title, lines, limit }) => [
      `<div class="log-section-header">=== ${escapeHtml(title)} · showing latest ${Math.min(limit, lines.length)} of ${lines.length} ===</div>`,
      ...lines.slice(-limit).map((line) => `<div data-log-entry="${escapeHtml(line)}">${formatLogLineToHtml(line)}</div>`),
      ...(lines.length ? [] : ['<div class="log-row"><span class="log-msg">[no matching logs]</span></div>']),
    ].join("")).join("");
    painting = true;
    replaceLogContent(terminal, html, forceBottom || following);
    if (!forceBottom && !following) {
      terminal.scrollTop = oldTop;
      const replacement = anchorKey && [...(terminal.children || [])].find((row) => row.dataset?.logEntry === anchorKey);
      if (replacement) terminal.scrollTop += replacement.getBoundingClientRect().top - anchorTop;
    }
    painting = false;
    updateControls();
  }

  function bind() {
    if (bound) return;
    bound = true;
    control("logsPauseButton")?.addEventListener("click", () => {
      paused = !paused;
      generation += 1; // A response already in flight must not replace the paused snapshot.
      pending = null;
      updateControls();
      if (!paused) renderLogs().catch(() => {});
    });
    control("logsFollowButton")?.addEventListener("click", () => {
      following = !following;
      paint(following);
      updateControls();
    });
    control("logsTextFilter")?.addEventListener("input", (event) => {
      query = event.target.value;
      paint();
    });
    elements.logsTerminal?.addEventListener("scroll", () => {
      if (painting) return;
      const terminal = elements.logsTerminal;
      if (following && terminal.scrollHeight - terminal.scrollTop - terminal.clientHeight >= 120) {
        following = false;
        updateControls();
      }
    });
    updateControls();
  }

  async function renderLogs(forceBottom = false) {
    if (!elements.logsTerminal) return;
    bind();
    if (paused) return;
    const category = state.activeLogCategory || "all";
    if (pending?.category === category) return pending.promise;
    const ticket = ++generation;
    const token = state.token;
    const initial = !state.hasLoadedLogsOnce;
    const promise = (async () => {
      const backend = await fetchLogs(authHeaders(), category);
      if (paused || ticket !== generation || token !== state.token) return;
      const includeFrontend = category === "all" || category === "system";
      snapshot = { category, backend, includeFrontend, frontend: includeFrontend ? logsText().split("\n").filter(Boolean) : [] };
      state.hasLoadedLogsOnce = true;
      paint(forceBottom || initial);
    })();
    pending = { category, promise };
    try { await promise; }
    finally { if (ticket === generation) pending = null; }
  }

  function syncLogsRefresh() {
    const visible = state.activeView === "settings" && state.activeSettingsRoute?.panel === "logs" && state.token;
    if (visible && !state.logsRefreshInterval) {
      if (!state.hasLoadedLogsOnce) renderLogs(true).catch(() => {});
      state.logsRefreshInterval = globalThis.setInterval(() => { renderLogs().catch(() => {}); }, 3000);
    } else if (!visible) {
      globalThis.clearInterval(state.logsRefreshInterval);
      state.logsRefreshInterval = undefined;
      state.hasLoadedLogsOnce = false;
      generation += 1;
      pending = null;
      snapshot = null;
      paused = false;
      updateControls();
    }
  }

  return { renderLogs, syncLogsRefresh };
}
