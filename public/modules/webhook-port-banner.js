// Dashboard banner for the startup webhook port check (server/src/utils/webhookPortCheck.js).
// Shown while a webhook still points at an old port. Dismissal is remembered per
// findings text, so a new or changed finding shows the banner again.
import { state } from "./state.js?v=1.3.1.2.2";
import { escapeHtml, isDemoMode } from "./utils.js?v=1.3.1.2.2";
import { buildAuthHeaders } from "./auth.js?v=1.3.1.2.2";

const DISMISS_KEY = "plekt.webhookPortBannerDismissed";
let checkedThisLoad = false;

function dismissedText() {
  try {
    return localStorage.getItem(DISMISS_KEY) || "";
  } catch {
    return "";
  }
}

function findingsText(findings) {
  return findings.map((finding) => finding.message).join("\n");
}

function hideBanner(container) {
  container.innerHTML = "";
  container.classList.add("hidden");
}

function renderFindings(container, findings) {
  const text = findingsText(findings);
  if (!text || dismissedText() === text) {
    hideBanner(container);
    return;
  }
  container.classList.remove("hidden");
  container.innerHTML = `
    <section class="glass-panel dashboard-setup-checklist webhook-port-banner" aria-labelledby="webhookPortBannerTitle">
      <div class="dashboard-setup-checklist-head">
        <div class="dashboard-setup-checklist-title">
          <h2 id="webhookPortBannerTitle">Check your webhook ports</h2>
          <p class="webhook-port-intro">Plekt moved from port 5055 to 5056. A webhook still set to 5055 will not reach Plekt. Fix each item below, then press Dismiss.</p>
        </div>
        <button type="button" class="button-ghost" data-webhook-port-dismiss="1" aria-label="Dismiss webhook port notice">Dismiss</button>
      </div>
      <ul class="webhook-port-findings">
        ${findings.map((finding) => `<li>${escapeHtml(finding.message)}</li>`).join("")}
      </ul>
    </section>`;
  container.querySelector("[data-webhook-port-dismiss]")?.addEventListener("click", () => {
    try {
      localStorage.setItem(DISMISS_KEY, text);
    } catch {
      // Storage can be blocked; the banner then returns on the next page load.
    }
    hideBanner(container);
  });
}

// Called from dashboard.js renderDashboard(). Checks once per page load; a failed
// or forbidden request (non-admin, demo) simply leaves the banner hidden.
export async function renderWebhookPortBanner() {
  const container = document.getElementById("webhookPortBanner");
  if (!container || checkedThisLoad || isDemoMode()) return;
  checkedThisLoad = true;
  try {
    const response = await fetch("/api/webhook-port/status", {
      credentials: "same-origin",
      headers: buildAuthHeaders(state.token),
    });
    if (!response.ok) return hideBanner(container);
    const status = await response.json();
    renderFindings(container, Array.isArray(status.findings) ? status.findings : []);
  } catch {
    hideBanner(container);
  }
}
