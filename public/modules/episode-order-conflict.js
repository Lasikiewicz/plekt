import { buildAuthHeaders } from "./auth.js?v=2.2.4.2.8";
import { escapeHtml, escapeAttribute } from "./utils.js?v=2.2.4.2.8";
import { state } from "./state.js?v=2.2.4.2.8";

const code = e => `S${String(e.season).padStart(2,"0")}E${String(e.episode).padStart(2,"0")}`;
const label = e => `${code(e)} · ${e.name || "Untitled episode"}`;

export function renderEpisodeOrderConflict(review) {
  const incoming = review.media?.incoming || {};
  return `<article class="manual-watch-review-card source-mismatch-review-card"><div class="manual-watch-review-main"><h3>${escapeHtml(review.title)}</h3><p>Earlier watch history conflicts with ${escapeHtml(incoming.name || "an incoming episode")}. No watched state was changed.</p><button class="button-primary" type="button" data-order-conflict="${escapeAttribute(review.id)}">Review episode identity</button></div></article>`;
}

async function request(id, action, body = {}) {
  const response = await fetch(`/api/manual-watch-review/${encodeURIComponent(id)}/${action}`, { method:"POST", headers:{...buildAuthHeaders(state.token),"Content-Type":"application/json"}, body:JSON.stringify(body), cache:"no-store" });
  const result = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(result.error || "Could not review this conflict.");
  return result;
}

if (typeof document !== "undefined") document.addEventListener("click", async event => {
  const button = event.target.closest?.("[data-order-conflict]");
  if (!button) return;
  button.disabled = true;
  const id = button.dataset.orderConflict;
  try {
    const preview = await request(id, "episode-order-preview");
    const dialog = document.createElement("dialog");
    dialog.className = "edit-dialog glass-panel";
    dialog.setAttribute("aria-labelledby", "episode-order-conflict-title");
    dialog.innerHTML = `<h3 id="episode-order-conflict-title">Review episode identity</h3><p>Earlier watch: ${escapeHtml(preview.row.title)} (${escapeHtml(preview.row.watchedAt || "date unknown")}, ${escapeHtml(preview.row.source)}).</p><p>Incoming episode: ${escapeHtml(label(preview.incoming))}. Choose which episode the earlier watch represents. Its watched or progress state may move with it. A backup is saved before repair.</p><div>${preview.options.map((option,index) => `<label><input type="radio" name="episode-order-choice" value="${index}"> ${escapeHtml(label(option.displayed))} in ${escapeHtml(preview.order)} → ${escapeHtml(label(option.aired))} aired</label><br>`).join("") || "No verified candidates are available."}</div><p role="status"></p><div class="edit-dialog-actions"><button type="button" data-cancel>Cancel</button><button class="button-primary" type="button" data-confirm>Confirm and repair</button></div>`;
    document.body.append(dialog);
    dialog.addEventListener("close", () => { dialog.remove(); if (button.isConnected) button.focus(); });
    dialog.querySelector("[data-cancel]").onclick = () => dialog.close();
    dialog.querySelector("[data-confirm]").onclick = async () => {
      const choice = dialog.querySelector('input[name="episode-order-choice"]:checked');
      if (!choice) { dialog.querySelector('[role="status"]').textContent = "Choose the episode first."; return; }
      const option = preview.options[Number(choice.value)];
      dialog.querySelector("[data-confirm]").disabled = true;
      try { await request(id, "episode-order-repair", { revision:preview.revision, airedId:option.airedId, dvdId:option.dvdId, confirm:true }); dialog.close(); window.location.reload(); }
      catch (error) { dialog.querySelector('[role="status"]').textContent = error.message; dialog.querySelector("[data-confirm]").disabled = false; }
    };
    button.disabled = false;
    dialog.showModal();
  } catch (error) { window.alert(error.message); }
  finally { button.disabled = false; }
});
