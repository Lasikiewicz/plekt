// Opt-in anonymous daily install check: the Settings -> General panel (switch,
// last send, the exact payload) and the one-time question for an install that
// has not answered yet. The server decides what is sent; this module only shows
// it and records the answer. Nothing is sent until the user turns it on.

let callbacks = {};
let bound = false;
let status = null;
let promptChecked = false;

function headers(extra = {}) {
  return { ...(callbacks.authHeaders?.() || {}), ...extra };
}

async function request(method, body) {
  const response = await fetch("/api/install-check", {
    method,
    credentials: "same-origin",
    headers: headers(body ? { "Content-Type": "application/json" } : {}),
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!response.ok) {
    const error = new Error(`Install check request failed (${response.status})`);
    error.status = response.status;
    throw error;
  }
  return (await response.json()).installCheck;
}

function lastSentText(value) {
  if (!value) return "Not sent yet.";
  return `Last sent ${new Date(value).toLocaleString()}.`;
}

function statusText(info) {
  if (info.demo) return "Not available in the demo.";
  if (!info.enabled) return info.asked ? "Off. Nothing is sent." : "Off until you choose. Nothing is sent.";
  if (!info.collectorConfigured) return "On, but no collector address is set on this server yet, so nothing is sent.";
  return `On. ${lastSentText(info.lastSentAt)}`;
}

function renderPanel() {
  const toggle = document.querySelector("#installCheckEnabled");
  const text = document.querySelector("#installCheckStatus");
  const payload = document.querySelector("#installCheckPayload");
  if (!toggle || !text || !payload || !status) return;
  toggle.checked = status.enabled === true;
  toggle.disabled = status.demo === true;
  text.textContent = statusText(status);
  payload.textContent = JSON.stringify(status.payload, null, 2);
}

function removePrompt() {
  document.querySelector("#installCheckPrompt")?.remove();
}

function showPrompt() {
  if (document.querySelector("#installCheckPrompt")) return;
  const card = document.createElement("section");
  card.id = "installCheckPrompt";
  card.className = "install-check-prompt glass-panel";
  card.setAttribute("role", "dialog");
  card.setAttribute("aria-label", "Help count Plekt installs");
  card.innerHTML = `
    <strong>Help count Plekt installs?</strong>
    <p><b>Sent:</b> once a day, a tiny anonymous message saying Plekt is running, with its version and CPU type.</p>
    <p><b>Never sent:</b> your name, server address, library, watch history, connected services or any ID.</p>
    <p>It stays off unless you turn it on.</p>
    <p class="install-check-prompt-note">You can see exactly what is sent, or change your mind, in Settings &rarr; General &rarr; Privacy.</p>
    <div class="install-check-prompt-actions">
      <button type="button" class="button-primary" data-install-check-answer="on">Turn it on</button>
      <button type="button" class="button-ghost" data-install-check-answer="off">Keep it off</button>
    </div>`;
  card.addEventListener("click", async (event) => {
    const button = event.target.closest("[data-install-check-answer]");
    if (!button) return;
    const enabled = button.dataset.installCheckAnswer === "on";
    card.querySelectorAll("button").forEach((item) => { item.disabled = true; });
    try {
      status = await request("POST", { enabled });
      removePrompt();
      renderPanel();
    } catch (error) {
      card.querySelectorAll("button").forEach((item) => { item.disabled = false; });
      callbacks.setMessage?.(`Could not save the choice: ${error.message}`, "error");
    }
  });
  document.body.append(card);
}

// Loads the status once the app is unlocked and asks the one-time question for
// an admin whose install has not answered. A 401 or 403 (locked, or not an
// admin) leaves it for the next page entry; closing without choosing asks again.
async function refresh() {
  if (document.body.classList.contains("auth-locked")) return;
  try {
    status = await request("GET");
  } catch (error) {
    if (error.status !== 401 && error.status !== 403) promptChecked = true;
    return;
  }
  renderPanel();
  if (promptChecked) return;
  promptChecked = true;
  if (status.needsAnswer && !status.demo) showPrompt();
}

export function initInstallCheck(initCallbacks = {}) {
  callbacks = initCallbacks;
  if (bound) return;
  bound = true;
  document.querySelector("#installCheckEnabled")?.addEventListener("change", async (event) => {
    const toggle = event.currentTarget;
    toggle.disabled = true;
    try {
      status = await request("POST", { enabled: toggle.checked });
      removePrompt();
    } catch (error) {
      toggle.checked = !toggle.checked;
      callbacks.setMessage?.(`Could not save the choice: ${error.message}`, "error");
    } finally {
      toggle.disabled = false;
      renderPanel();
    }
  });
  // The panel lives in the Settings page, which is shown and hidden without a
  // page entry, so load the status whenever the panel scrolls into view.
  const row = document.querySelector('[data-sub-panel="install-check"]');
  if (row && "IntersectionObserver" in window) {
    new IntersectionObserver((entries) => {
      if (entries.some((entry) => entry.isIntersecting)) refresh();
    }).observe(row);
  }
  // One request until the question is settled, then only when Settings opens.
  document.addEventListener("plembfin:page-entry", () => {
    if (!promptChecked || location.pathname.startsWith("/settings")) refresh();
  });
  refresh();
}
