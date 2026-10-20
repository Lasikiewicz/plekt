import { buildAuthHeaders } from "./auth.js?v=2.1.1.0.5";
import { state, elements } from "./state.js?v=2.1.1.0.5";
import { escapeHtml } from "./utils.js?v=2.1.1.0.5";

export function initHealthTools() {
  const button = document.querySelector("#refreshSyncHealthButton");
  const panel = document.querySelector("#syncHealthPanel");
  if (!button || !panel) return;
  button.addEventListener("click", () => loadSyncHealth(panel, button));
}
export async function loadSyncHealth(panel = document.querySelector("#syncHealthPanel"), button = document.querySelector("#refreshSyncHealthButton")) {
  if (!panel) return;
  if (button) button.disabled = true;
  panel.innerHTML = "<p style='color: var(--muted); padding: var(--space-2);'>Loading sync health…</p>";
  try {
    const response = await fetch("/api/health/sync", { headers: buildAuthHeaders(state.token), cache: "no-store" });
    const body = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(body.error || "Health check failed");
    const health = body.health || {};
    const counts = health.counts || {};
    const destinations = health.outbound?.destinations || [];
    panel.innerHTML = `
      <div class="sync-health-grid" style="display: grid; grid-template-columns: repeat(auto-fit, minmax(160px, 1fr)); gap: var(--space-3);">
        ${Object.entries(counts).map(([key, item]) => {
          const value = typeof item === "object" ? item.value : item;
          const status = typeof item === "object" ? item.status : "normal";
          const formattedKey = key.replaceAll(/([A-Z])/g, " $1");
          return `
            <div class="sync-health-metric">
              <div style="display: grid; gap: 2px;">
                <span style="font-size: 0.78rem; color: var(--muted); text-transform: capitalize;">${escapeHtml(formattedKey)}</span>
                <strong style="font-size: 1.15rem; color: var(--text); font-weight: 800;">${Number(value || 0).toLocaleString()}</strong>
                <small style="font-size: 0.75rem; color: var(--muted);">${escapeHtml(status)}</small>
              </div>
            </div>
          `;
        }).join("")}
      </div>
      ${destinations.length ? `
        <div style="margin-top: var(--space-3); display: flex; flex-direction: column; gap: var(--space-2);">
          <b style="font-size: 0.85rem; color: var(--text); font-weight: 700;">Outbound pressure</b>
          <div class="sync-health-destinations" style="display: flex; flex-direction: column; gap: var(--space-2);">
            ${destinations.map((item) => `
              <div class="sync-health-dest-row">
                <b style="color: var(--text); font-weight: 700; font-size: 0.88rem;">${escapeHtml(item.host)}</b>
                <span style="color: var(--muted); font-size: 0.8rem;">${item.requests} requests · ${item.throttled} throttled · ${item.cooldowns} cooldowns</span>
              </div>
            `).join("")}
          </div>
        </div>
      ` : ""}
      ${(health.recommendations || []).length ? `
        <div style="margin-top: var(--space-3); display: flex; flex-direction: column; gap: var(--space-2);">
          ${health.recommendations.map((item) => `
            <div class="sync-preview-warning-card">
              <span style="color: var(--text); font-size: 0.82rem; line-height: 1.45;">${escapeHtml(item)}</span>
            </div>
          `).join("")}
        </div>
      ` : ""}
    `;
  } catch (error) {
    panel.innerHTML = `<p class="sync-preview-state error" style="color: var(--red); padding: var(--space-2);">${escapeHtml(error.message)}</p>`;
  } finally {
    if (button) button.disabled = false;
  }
}
