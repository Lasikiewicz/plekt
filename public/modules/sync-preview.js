import { buildAuthHeaders } from "./auth.js?v=2.2.1.0.2";

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const esc = (value) => String(value ?? "").replace(/[&<>\"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[char]));

export function initSyncPreview({ button, panel, token, onToast = () => {}, onExecute = null } = {}) {
  if (!button || !panel) return;
  const headers = () => buildAuthHeaders(token?.() || "");
  const setPanel = (html) => { panel.innerHTML = html; panel.classList.remove("hidden"); };

  async function pollJob(jobId) {
    for (let attempt = 0; attempt < 240; attempt += 1) {
      const response = await fetch(`/api/sync-jobs?status=all&limit=200`, { headers: headers(), cache: "no-store" });
      const data = await response.json().catch(() => ({}));
      const job = (data.jobs || []).find((item) => item.id === jobId);
      if (job && ["succeeded", "failed", "cancelled"].includes(job.status)) return job;
      await wait(500);
    }
    throw new Error("Preview timed out while waiting for the background worker.");
  }

  button.addEventListener("click", async () => {
    button.disabled = true;
    setPanel('<div class="sync-preview-state">Preparing a read-only Force Sync preview…</div>');
    try {
      const start = await fetch("/api/force-sync/plan", { method: "POST", headers: { ...headers(), "Content-Type": "application/json" }, body: JSON.stringify({ scope: {} }) });
      const startBody = await start.json().catch(() => ({}));
      if (!start.ok) throw new Error(startBody.error || "Could not start preview");
      const job = await pollJob(startBody.jobId);
      const planId = job?.result?.planId;
      if (!planId) throw new Error(job?.error || "Preview did not produce a plan");
      const planResponse = await fetch(`/api/force-sync/plan/${encodeURIComponent(planId)}?pageSize=20`, { headers: headers(), cache: "no-store" });
      const planBody = await planResponse.json().catch(() => ({}));
      if (!planResponse.ok) throw new Error(planBody.error || "Could not load preview");
      const { plan, actions } = planBody;
      setPanel(`<div class="sync-preview-heading"><div><strong>Force Sync preview</strong><span>${esc(plan.summary.scopeDescription || "All configured servers")}</span></div><button type="button" class="button-ghost sync-preview-close">Hide</button></div>
        <div class="sync-preview-metrics"><span><b>${plan.summary.totalActions}</b> planned changes</span><span><b>${plan.summary.additive}</b> additive</span><span><b>${plan.summary.destructive}</b> destructive</span><span><b>${plan.summary.outboundWrites}</b> outbound writes</span></div>
        ${plan.summary.scopeErrors?.length ? `<p class="sync-preview-warning">Scope review required: ${esc(plan.summary.scopeErrors.map((item) => item.server).join(", "))}</p>` : ""}
        <details open><summary>First actions</summary><div class="sync-preview-actions">${(actions.actions || []).map((action) => `<div class="sync-preview-action"><span class="sync-preview-risk ${action.risk}">${esc(action.risk)}</span><span>${esc(action.kind.replaceAll("_", " "))}</span><span>${esc(action.media?.title || "Unknown title")}</span><small>${esc(action.target || action.reason || "")}</small></div>`).join("") || "<p>No writes are planned.</p>"}</div></details>
        <div class="sync-preview-footer"><span>Plan expires ${new Date(plan.expiresAt).toLocaleTimeString()}</span><button type="button" class="button-primary sync-preview-confirm" ${["blocked_over_limit", "blocked_scan_error"].includes(plan.status) ? "disabled" : ""}>Confirm plan</button></div>`);
      panel.querySelector(".sync-preview-close")?.addEventListener("click", () => panel.classList.add("hidden"));
      panel.querySelector(".sync-preview-confirm")?.addEventListener("click", async () => {
        const confirm = await fetch(`/api/force-sync/plan/${encodeURIComponent(planId)}`, { method: "POST", headers: headers() });
        const body = await confirm.json().catch(() => ({}));
        if (!confirm.ok) throw new Error(body.error || "Could not confirm plan");
        panel.classList.add("hidden");
        if (typeof onExecute === "function") {
          void onExecute(planId);
        } else {
          const execute = await fetch("/api/force-sync", { method: "POST", headers: { ...headers(), "Content-Type": "application/json" }, body: JSON.stringify({ planId }) });
          if (!execute.ok) throw new Error((await execute.json().catch(() => ({}))).error || "Could not execute plan");
          onToast("Force Sync plan confirmed and queued.", "success");
        }
      });
    } catch (error) {
      setPanel(`<div class="sync-preview-state error">${esc(error.message)}</div>`);
      onToast(error.message, "error");
    } finally { button.disabled = false; }
  });
}
