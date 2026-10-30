// Webhook delivery test dialog. A "Test" button beside each "I have configured the ..."
// option opens a pop-up that walks the person through marking one item played in their
// app, counts down live, lists the events Plekt receives as they arrive, and shows the
// result without a page refresh. The server (server/src/utils/webhookTest.js) captures
// the first played-flag event without recording or syncing it.
import { buildAuthHeaders } from "./auth.js?v=2.2.1.0.2";
import { state } from "./state.js?v=2.2.1.0.2";
import { escapeAttribute, escapeHtml } from "./utils.js?v=2.2.1.0.2";

const POLL_MS = 1000;
const TICK_MS = 250;
export const WEBHOOK_TEST_PROVIDERS = ["emby", "jellyfin"];
const PROVIDER_LABELS = { emby: "Emby", jellyfin: "Jellyfin" };
const providerLabel = (provider) => PROVIDER_LABELS[provider] || "your media server";

async function testApi(path, method = "GET", body = null) {
  const response = await fetch(`/api/webhook-test/${path}`, {
    method,
    headers: buildAuthHeaders(state.token),
    credentials: "same-origin",
    cache: "no-store",
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || `Request failed (${response.status})`);
  return data;
}

// The button placed next to a "Plugin configured" or "Webhook configured" option. Other providers get nothing.
export function webhookTestButton(provider) {
  if (!WEBHOOK_TEST_PROVIDERS.includes(provider)) return "";
  return `<button class="button-ghost sync-action-btn sync-tool-button" type="button" data-webhook-test-open="${escapeAttribute(provider)}">Test</button>`;
}

function formatClock(ms) {
  const total = Math.max(0, Math.ceil(ms / 1000));
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, "0")}`;
}

// Turns what the server saw into the most likely cause. Order matters: a rejected
// token explains everything else, and an event that arrived but was dropped is
// different from an event that never arrived.
export function webhookTestFailureAdvice(view = {}, provider = view.source || "emby") {
  const seen = Array.isArray(view.seen) ? view.seen : [];
  const name = providerLabel(provider);
  const jellyfin = provider === "jellyfin";
  if (view.rejectedCount) {
    return `Something reached Plekt, but its webhook token was rejected. Copy the address from the ${name} setup guide again (it includes the token), paste it into the ${jellyfin ? "plugin" : "plugin or the webhook"}, and save.`;
  }
  if (seen.some((entry) => entry.markPlayed)) {
    return `Plekt received the mark-played event but ignored it. The usual cause is a mark made as a different ${name} user than the one Plekt is connected to; a sync or restore running at that moment can also cause it. Mark an item as the connected ${name} user and try again.`;
  }
  if (seen.length) {
    const names = seen.map((entry) => entry.event).join(", ");
    const fix = jellyfin
      ? "With the Jellyfin Webhooks plugin, tick the User Data Saved notification type on the webhook and save. With the Plekt plugin, update to the latest release and restart Jellyfin."
      : "With the built-in Emby webhook, tick Mark Played under Events > Users and save. With the Plekt plugin, update to the latest release and restart Emby.";
    return `Plekt is receiving events from ${name} (${names}) but no mark-played event. ${fix}`;
  }
  const check = view.embyCheck || {};
  if (check.checked && check.marked) {
    return `${name} shows ${check.title || "an item"} was marked played, but nothing reached Plekt. Check the address in the ${jellyfin ? "plugin" : "plugin or webhook"}, that ${name} can reach Plekt at that address (inside Docker, localhost means ${name}'s own container), and that only one sender is configured. ${jellyfin ? "With the Jellyfin Webhooks plugin, also check User Data Saved is ticked on the webhook." : "With the built-in Emby webhook, also check Mark Played is ticked under Events > Users."}`;
  }
  if (check.checked) {
    return `Plekt could not see a new mark in ${name} either. Mark an item that is currently unwatched, signed in as the ${name} account Plekt is connected to, then try again.`;
  }
  return `Nothing arrived from ${name}. Check the webhook address in the plugin${jellyfin ? "" : " or the built-in webhook"}, and that ${name} can reach Plekt at that address.`;
}

const instructions = (provider, startButton) => {
  const name = providerLabel(provider);
  const works = provider === "jellyfin" ? "the Plekt plugin and the Jellyfin Webhooks plugin" : "the Plekt plugin and the built-in Emby webhook";
  const steps = [
    ["Start the test", "Press <b>Start test</b> below. You have 5 minutes."],
    [`Mark something as played in ${name}`, `Open any episode or movie that is <b>not watched yet</b>, signed in as the account Plekt is connected to, and mark it played.`],
    ["See the result here", "It appears in this window within a few seconds. No refresh needed."],
  ];
  return `
  <div class="webhook-test-callout">
    <span class="webhook-test-callout-title">Safe to try</span>
    <p>The test mark is never added to your history or sent to your other connected services, and Plekt can put it back as it was when the test finishes.</p>
  </div>
  <ol class="webhook-test-steps">
    ${steps.map(([title, text]) => `<li><span class="webhook-test-step-title">${title}</span><span class="webhook-test-step-text">${text}</span></li>`).join("")}
  </ol>
  <div class="webhook-test-footer"><p class="webhook-test-note">Works with ${works}.</p>${startButton}</div>`;
};

function eventFeed(view, provider) {
  const seen = Array.isArray(view.seen) ? view.seen : [];
  const rows = seen.length
    ? seen.map((entry) => `<li><code>${escapeHtml(entry.event)}</code> <span>x${entry.count}</span></li>`).join("")
    : `<li style="color: var(--muted);">${view.rejectedCount ? "Only rejected requests reached Plekt." : `Nothing received from ${providerLabel(provider)} yet.`}</li>`;
  return `
    <div>
      <b style="font-size: 0.82rem;">Events received from ${providerLabel(provider)}</b>
      <ul data-webhook-test-feed style="margin: var(--space-1) 0 0; padding-left: 1.1rem; display: grid; gap: 2px; font-size: 0.82rem;">${rows}</ul>
    </div>`;
}

// Green success box shown for a passed test.
function passedBanner(view, name, title, text) {
  return `
    <div class="webhook-test-success" role="status">
      <span class="webhook-test-success-icon" aria-hidden="true">&#10003;</span>
      <div><b>${escapeHtml(title)}</b><p>${escapeHtml(text)}</p></div>
    </div>`;
}

// The item Plekt detected: its poster when one is known, the title and the event name.
function capturedItemCard(view) {
  const capture = view.capture || {};
  const poster = capture.posterUrl
    ? `<img class="webhook-test-poster" data-webhook-test-poster src="/api/webhook-test/poster?t=${escapeAttribute(String(capture.capturedAt || ""))}" alt="" loading="lazy" />`
    : "";
  const kind = capture.type === "episode" ? "Episode" : (capture.type === "movie" ? "Movie" : "Item");
  return `
    <div class="webhook-test-item">
      ${poster}
      <div>
        <span class="webhook-test-item-kind">${kind} detected</span>
        <b class="webhook-test-item-title">${escapeHtml(capture.title || "the item")}</b>
        <span class="webhook-test-note">Event received: <code>${escapeHtml(capture.event || "played")}</code></span>
      </div>
    </div>`;
}

// The short headline above the failure advice, matching the cause that advice names.
export function webhookTestFailureLabel(view = {}) {
  const seen = Array.isArray(view.seen) ? view.seen : [];
  if (view.rejectedCount) return "Token rejected";
  if (seen.some((entry) => entry.markPlayed)) return "Mark received but ignored";
  if (seen.length) return "No mark-played event";
  return "No mark received";
}

const BUSY_LABELS ={ start: "Starting test", unmark: "Removing test watch", cancel: "Cancelling" };

function renderBody(view, { busy = "", error = "", provider = "emby" } = {}) {
  const name = providerLabel(provider);
  const disabled = busy ? "disabled" : "";
  const button = (action, label, kind = "ghost") => {
    const working = busy === action;
    const text = working ? `<span class="webhook-test-spinner" aria-hidden="true"></span>${BUSY_LABELS[action] || "Working"}` : label;
    return `<button class="button-${kind} sync-action-btn sync-tool-button" type="button" data-webhook-test="${action}" ${disabled}${working ? ' aria-busy="true"' : ""}>${text}</button>`;
  };
  const errorLine = error ? `<p class="status-pill status-error" role="alert" style="margin: 0;">${escapeHtml(error)}</p>` : "";
  let html;
  if (view.status === "waiting") {
    html = `
      <p style="margin: 0;"><b>Waiting for your mark in ${name}.</b> Mark an unwatched episode or movie as played now.</p>
      <p style="margin: 0; font-size: 1.6rem; font-variant-numeric: tabular-nums;" data-webhook-test-clock aria-live="off">${formatClock(view.expiresAt - Date.now())}</p>
      ${eventFeed(view, provider)}
      <div>${button("cancel", "Cancel")}</div>`;
  } else if (view.status === "passed" && !view.unmarkedAt) {
    html = `
      ${passedBanner(view, name, "Everything is working", `Plekt received your mark from ${name} within seconds, so the ${name} connection, the address and the token are all correct.`)}
      ${capturedItemCard(view)}
      <div class="webhook-test-question">
        <p><b>Would you like Plekt to remove this test watch from ${name}?</b></p>
        <p class="webhook-test-note">If you leave it marked, the next scheduled scan treats it as a normal manual watch.</p>
        <div class="webhook-test-actions">${button("unmark", `Yes, remove it from ${name}`, "primary")}${button("cancel", "No, leave it marked")}</div>
      </div>`;
  } else if (view.status === "passed") {
    html = `
      ${passedBanner(view, name, "Test watch removed", `${view.capture?.title || "The item"} is unmarked in ${name} again. Your watch history was not changed and nothing was sent to your other services.`)}
      ${capturedItemCard(view)}
      <div class="webhook-test-actions">${button("start", "Run again")}${button("close", "Close")}</div>`;
  } else if (view.status === "timeout") {
    html = `
      <p class="status-pill status-error" style="margin: 0; justify-self: start;">${escapeHtml(webhookTestFailureLabel(view))}</p>
      <p style="margin: 0;">${escapeHtml(webhookTestFailureAdvice(view, provider))}</p>
      ${eventFeed(view, provider)}
      <div style="display: flex; gap: var(--space-2);">${button("start", "Try again", "primary")}${button("close", "Close")}</div>`;
  } else {
    html = instructions(provider, button("start", "Start test", "primary"));
  }
  return `${html}${errorLine}`;
}

function openWebhookTestDialog(provider) {
  const name = providerLabel(provider);
  document.querySelector(".webhook-test-overlay")?.remove();
  const overlay = document.createElement("div");
  overlay.className = "edit-dialog-overlay settings-modal-overlay webhook-test-overlay";
  overlay.innerHTML = `
    <div class="edit-dialog settings-modal webhook-test-modal" role="dialog" aria-modal="true" aria-label="Test ${name} webhook or plugin">
      <header class="settings-modal-head">
        <h3>Test ${name} webhook or plugin</h3>
        <button class="settings-modal-close" type="button" aria-label="Close">&times;</button>
      </header>
      <div class="settings-modal-body"><div data-webhook-test-body style="display: grid; gap: var(--space-2);"></div></div>
    </div>`;
  document.body.appendChild(overlay);
  const body = overlay.querySelector("[data-webhook-test-body]");

  let view = { status: "idle" };
  let busy = "";
  let lastShape = "";
  let pollTimer = null;
  let tickTimer = null;

  // Re-render only when something visible changed, so the live clock and the buttons
  // are not rebuilt (and clicks not lost) on every poll.
  const render = (error = "") => {
    const shape = JSON.stringify([view.status, view.unmarkedAt, view.capture, view.seen, view.rejectedCount, view.embyCheck, busy, error]);
    if (shape === lastShape) return;
    lastShape = shape;
    body.innerHTML = renderBody(view, { busy, error, provider });
  };
  const stopTimers = () => {
    clearInterval(pollTimer);
    clearInterval(tickTimer);
    pollTimer = tickTimer = null;
  };
  const close = async () => {
    stopTimers();
    overlay.remove();
    document.removeEventListener("keydown", onKey);
    // Closing mid-test, with the item still marked, or after the removed screen ends the session, same as Cancel, so reopening starts from the instructions.
    if (view.status === "waiting" || view.status === "passed") {
      await testApi("cancel", "POST").catch(() => null);
    }
  };
  const onKey = (event) => { if (event.key === "Escape") close(); };
  document.addEventListener("keydown", onKey);

  const apply = (next, error = "") => {
    // The server keeps one test at a time; one started for the other provider is not this pop-up's.
    view = next?.source && next.source !== provider ? { status: "idle" } : next;
    render(error);
    if (view.status === "waiting" && !pollTimer) {
      pollTimer = setInterval(async () => {
        if (!overlay.isConnected) return stopTimers();
        try { apply(await testApi("status")); } catch (err) { render(err.message); }
      }, POLL_MS);
      tickTimer = setInterval(() => {
        const clock = body.querySelector("[data-webhook-test-clock]");
        if (clock && view.expiresAt) clock.textContent = formatClock(view.expiresAt - Date.now());
      }, TICK_MS);
    }
    if (view.status !== "waiting") stopTimers();
  };

  overlay.addEventListener("error", (event) => {
    if (event.target?.matches?.("[data-webhook-test-poster]")) event.target.remove();
  }, true);

  overlay.addEventListener("click", async (event) => {
    if (event.target === overlay || event.target.closest(".settings-modal-close")) return close();
    const button = event.target.closest("[data-webhook-test]");
    if (!button) return;
    const action = button.dataset.webhookTest;
    if (action === "close") return close();
    busy = action;
    render();
    try {
      if (action === "start") apply(await testApi("start", "POST", { source: provider }));
      else if (action === "unmark") apply(await testApi("unmark", "POST"));
      else if (action === "cancel") {
        await testApi("cancel", "POST");
        apply({ status: "idle" });
      }
      busy = "";
      render();
    } catch (error) {
      busy = "";
      render(error.message);
    }
  });

  render();
  // Pick up a test that is already running (for example after a page reload).
  testApi("status").then((current) => { if (overlay.isConnected) apply(current); }).catch(() => null);
}

if (typeof document !== "undefined") {
  document.addEventListener("click", (event) => {
    const opener = event.target.closest?.("[data-webhook-test-open]");
    if (opener) openWebhookTestDialog(opener.dataset.webhookTestOpen);
  });
}
