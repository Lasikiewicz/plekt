// Sonarr-style settings primitives shared by the settings pages: service card
// grids with an "add" tile, an add-type picker modal, and an edit modal with a
// Test / Cancel / Save footer. Consumers describe fields declaratively; secret
// fields are never prefilled - a "Configured" placeholder stands in for the
// stored credential (redacted-config semantics).
import { escapeHtml, escapeAttribute } from "./utils.js?v=2.2.1.1.0";

const CONFIGURED_PLACEHOLDER = "Configured - enter a new key to replace it";

function closeSettingsModals() {
  document.querySelectorAll(".settings-modal-overlay").forEach((el) => {
    if (typeof el._settingsClose === "function") el._settingsClose();
    else el.remove();
  });
}

function fieldPlaceholder(field) {
  if (field.secret && field.configured) return field.configuredPlaceholder || CONFIGURED_PLACEHOLDER;
  return field.placeholder || "";
}

export function renderFieldRow(field, options = {}) {
  const helpText = field.help ? (field.helpIsHtml ? field.help : escapeHtml(field.help)) : "";
  const defaultText = field.defaultText ? escapeHtml(field.defaultText) : "";
  const help = helpText ? `<span class="settings-field-help">${helpText}</span>` : "";
  const type = field.type || "text";
  const value = field.secret ? "" : (field.value ?? "");
  const optionalTag = field.optional ? ` <em class="settings-field-optional">- optional</em>` : "";
  const useAccordion = options.asAccordion || field.asAccordion;

  if (useAccordion) {
    return `
      <details class="sync-tool-details" id="${field.id || `sync-field-${field.key}`}" data-field-key="${escapeAttribute(field.key)}">
        <summary class="accordion-header">
          <div class="sync-tool-summary-title">
            <svg class="accordion-chevron" width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M6 4l4 4-4 4"/></svg>
            <b>${escapeHtml(field.label)}</b>${optionalTag}
          </div>
          ${help}
        </summary>
        <div class="tool-item-row" style="padding: 0 var(--space-3) var(--space-3); width: 100%;">
          <span class="settings-modal-field-control" style="width: 100%; display: block; margin-top: var(--space-2);">
            <input class="field" type="${escapeAttribute(type)}" data-modal-field="${escapeAttribute(field.key)}"
              value="${escapeAttribute(String(value))}" placeholder="${escapeAttribute(fieldPlaceholder(field))}"
              autocomplete="${escapeAttribute(field.autocomplete || "off")}" data-lpignore="true" data-1p-ignore="true" />
          </span>
        </div>
      </details>
    `;
  }

  if (field.type === "checkbox") {
    return `
      <label id="${escapeAttribute(field.id || `sync-field-${field.key}`)}" class="settings-modal-field settings-modal-field--checkbox" data-field-key="${escapeAttribute(field.key)}">
        <span class="settings-modal-field-label">
          <span class="settings-modal-field-title">${escapeHtml(field.label)}</span>
          ${help}
        </span>
        <span class="settings-modal-field-control">
          <input type="checkbox" data-modal-field="${escapeAttribute(field.key)}" ${field.value ? "checked" : ""} />
        </span>
      </label>
    `;
  }
  if (field.type === "choice") {
    const labelId = `${field.id || `sync-field-${field.key}`}-label`;
    const options = (field.options || []).map((option) => {
      const optionValue = typeof option === "string" ? option : option.value;
      const optionLabel = typeof option === "string" ? option : option.label;
      const optionDescription = typeof option === "string" ? "" : option.description;
      const optionDescriptionLines = typeof option === "string" ? [] : option.descriptionLines;
      const optionInlineDescription = typeof option === "string" ? "" : option.inlineDescription;
      const optionBodyClass = optionInlineDescription ? " settings-choice-option-body--inline" : "";
      const descriptionHtml = optionDescriptionLines?.length
        ? optionDescriptionLines.map((line) => `<span class="settings-choice-option-description settings-choice-option-description--block">${escapeHtml(line)}</span>`).join("")
        : (optionDescription ? `<span class="settings-choice-option-description settings-choice-option-description--block">${escapeHtml(optionDescription)}</span>` : "");
      return `
        <label class="settings-choice-option">
          <input type="radio" name="settings-choice-${escapeAttribute(field.key)}" value="${escapeAttribute(optionValue)}"
            data-modal-field="${escapeAttribute(field.key)}" ${String(value) === String(optionValue) ? "checked" : ""} />
          <span class="settings-choice-option-body${optionBodyClass}">
            <span class="settings-choice-option-title">${escapeHtml(optionLabel)}</span>
            ${optionInlineDescription ? `<span class="settings-choice-option-description settings-choice-option-description--inline">${escapeHtml(optionInlineDescription)}</span>` : ""}
            ${descriptionHtml}
          </span>
        </label>
      `;
    }).join("");
    return `
      <div id="${escapeAttribute(field.id || `sync-field-${field.key}`)}" class="settings-modal-field settings-modal-field--choice" data-field-key="${escapeAttribute(field.key)}">
        <div id="${escapeAttribute(labelId)}" class="settings-modal-field-label">
          <span class="settings-modal-field-title">${escapeHtml(field.label)}${optionalTag}</span>
          ${help}
        </div>
        <div class="settings-choice-grid" role="radiogroup" aria-labelledby="${escapeAttribute(labelId)}">
          ${options}
        </div>
      </div>
    `;
  }
  if (field.type === "select") {
    const options = (field.options || []).map((option) => {
      const optionValue = typeof option === "string" ? option : option.value;
      const optionLabel = typeof option === "string" ? option : option.label;
      return `<option value="${escapeAttribute(optionValue)}" ${String(value) === String(optionValue) ? "selected" : ""}>${escapeHtml(optionLabel)}</option>`;
    }).join("");
    return `
      <label id="${escapeAttribute(field.id || `sync-field-${field.key}`)}" class="settings-modal-field" data-field-key="${escapeAttribute(field.key)}">
        <span class="settings-modal-field-label">
          <span class="settings-modal-field-title">${escapeHtml(field.label)}${optionalTag}</span>
          ${help}
        </span>
        <span class="settings-modal-field-control">
          <select class="field" data-modal-field="${escapeAttribute(field.key)}" autocomplete="${escapeAttribute(field.autocomplete || "off")}">${options}</select>
        </span>
      </label>
    `;
  }
  return `
    <label id="${escapeAttribute(field.id || `sync-field-${field.key}`)}" class="settings-modal-field" data-field-key="${escapeAttribute(field.key)}">
      <span class="settings-modal-field-label">
        <span class="settings-modal-field-title">${escapeHtml(field.label)}${optionalTag}</span>
        ${help}
      </span>
      <span class="settings-modal-field-control">
        <input class="field" type="${escapeAttribute(type)}" data-modal-field="${escapeAttribute(field.key)}"
          value="${escapeAttribute(String(value))}" placeholder="${escapeAttribute(fieldPlaceholder(field))}"
          autocomplete="${escapeAttribute(field.autocomplete || "off")}" data-lpignore="true" data-1p-ignore="true" />
      </span>
      ${defaultText ? `<span class="settings-field-default">${defaultText}</span>` : ""}
    </label>
  `;
}

// Reads every [data-modal-field] input under container (dialog or a plain
// inline form) into a plain {key: value} object.
export function collectFieldValues(container) {
  const values = {};
  container.querySelectorAll("[data-modal-field]").forEach((input) => {
    const key = input.dataset.modalField;
    if (input.type === "radio") {
      if (input.checked) values[key] = input.value.trim();
      return;
    }
    values[key] = input.type === "checkbox" ? input.checked : input.value.trim();
  });
  return values;
}
const collectValues = collectFieldValues;

// Opens a centered edit modal. Options:
//   title, fields          - dialog heading and field specs (see renderFieldRow)
//   onSave(values, ui)     - required; resolve to close, return false to stay open
//   onTest(values, ui)     - optional; resolve to a success message string
//   onDelete(ui)           - optional; shows a red button on the footer's left
//   deleteLabel, saveLabel, testLabel - button captions
//   enabledKey             - key of a checkbox field that gates the other fields;
//                            unchecking disables them and relabels Save
//   helpHtml               - trusted HTML rendered inside a "Setup help" disclosure
export function openSettingsEditModal({
  title = "Edit",
  fields = [],
  onSave,
  onTest,
  onDelete,
  deleteLabel = "Delete",
  saveLabel = "Save",
  saveDisabledLabel = "",
  testLabel = "Test",
  leadingAction,
  enabledKey = "",
  helpHtml = "",
  optionalFieldsLabel = "",
} = {}) {
  closeSettingsModals();

  // The account-connect leading action (e.g. "Connect Plex account") reads as
  // a step in the form, not a footer action - it renders directly under the
  // last always-visible field (after any manual username/password fields)
  // rather than alongside Test/Cancel/Save.
  const leadingActionHtml = leadingAction
    ? `<div class="settings-modal-leading-action-row"><button class="button-primary settings-modal-leading-action" type="button">${escapeHtml(leadingAction.label || "Continue")}</button></div>`
    : "";
  const nonOptionalFields = fields.filter((field) => !field.optionalGroup);
  const nonOptionalFieldsHtml = nonOptionalFields.map(renderFieldRow).join("") + leadingActionHtml;

  const overlay = document.createElement("div");
  overlay.className = "edit-dialog-overlay settings-modal-overlay";
  overlay.innerHTML = `
    <div class="edit-dialog settings-modal${helpHtml ? " settings-modal--with-help" : ""}" role="dialog" aria-modal="true" aria-label="${escapeAttribute(title)}">
      <header class="settings-modal-head">
        <h3>${escapeHtml(title)}</h3>
        <button class="settings-modal-close" type="button" aria-label="Close">&times;</button>
      </header>
      <div class="settings-modal-body">
        <div class="settings-modal-fields">
          ${nonOptionalFieldsHtml}
          ${optionalFieldsLabel ? `<details class="sync-tool-details settings-modal-optional-fields">
            <summary class="accordion-header"><div class="sync-tool-summary-title"><svg class="accordion-chevron" width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d="M6 4l4 4-4 4"/></svg><b>${escapeHtml(optionalFieldsLabel)}</b></div></summary>
            <div class="settings-modal-optional-fields-body">${fields.filter((field) => field.optionalGroup).map(renderFieldRow).join("")}</div>
          </details>` : fields.filter((field) => field.optionalGroup).map(renderFieldRow).join("")}
        </div>
        ${helpHtml ? `
          <aside class="settings-modal-help">
            <div class="section-heading" style="margin-bottom: var(--space-2);">
              <p>Setup Guide</p>
              <span>Configuration Help</span>
            </div>
            <div class="settings-help-body">${helpHtml}</div>
          </aside>
        ` : ""}
      </div>
      <p class="settings-modal-status message" role="status" aria-live="polite" data-tone="muted"></p>
      <footer class="settings-modal-foot">
        ${onDelete ? `<button class="button-danger settings-modal-delete" type="button">${escapeHtml(deleteLabel)}</button>` : ""}
        <div class="settings-modal-actions">
          ${onTest ? `<button class="button-ghost settings-modal-test" type="button">${escapeHtml(testLabel)}</button>` : ""}
          <button class="button-ghost settings-modal-cancel" type="button">Cancel</button>
          <button class="button-primary settings-modal-save" type="button">${escapeHtml(saveLabel)}</button>
        </div>
      </footer>
    </div>
  `;

  const dialog = overlay.querySelector(".settings-modal");
  const statusEl = overlay.querySelector(".settings-modal-status");
  const saveButton = overlay.querySelector(".settings-modal-save");
  const testButton = overlay.querySelector(".settings-modal-test");
  const deleteButton = overlay.querySelector(".settings-modal-delete");
  const leadingButton = overlay.querySelector(".settings-modal-leading-action");

  const onKeydown = (event) => {
    if (event.key === "Escape") close();
  };
  function close() {
    document.removeEventListener("keydown", onKeydown);
    overlay.remove();
  }
  overlay._settingsClose = close;
  const setStatus = (text, tone = "muted") => {
    statusEl.textContent = text || "";
    statusEl.dataset.tone = tone;
    statusEl.className = `settings-modal-status message ${tone}`;
  };
  const setBusy = (busy) => {
    [saveButton, testButton, deleteButton, leadingButton].forEach((button) => {
      if (button) button.disabled = busy;
    });
  };
  const ui = { close, setStatus, setBusy, dialog, collect: () => collectValues(dialog) };

  const syncEnabledState = () => {
    if (!enabledKey) return;
    const master = dialog.querySelector(`[data-modal-field="${enabledKey}"]`);
    if (!master) return;
    const active = master.checked;
    dialog.querySelectorAll("[data-modal-field]").forEach((input) => {
      if (input.dataset.modalField !== enabledKey) input.disabled = !active;
    });
    if (saveDisabledLabel) saveButton.textContent = active ? saveLabel : saveDisabledLabel;
  };

  overlay.addEventListener("click", (event) => { if (event.target === overlay) close(); });
  overlay.querySelector(".settings-modal-close").addEventListener("click", close);
  overlay.querySelector(".settings-modal-cancel").addEventListener("click", close);
  document.addEventListener("keydown", onKeydown);

  if (enabledKey) {
    dialog.querySelector(`[data-modal-field="${enabledKey}"]`)?.addEventListener("change", syncEnabledState);
    syncEnabledState();
  }

  saveButton.addEventListener("click", async () => {
    if (typeof onSave !== "function") return close();
    setBusy(true);
    setStatus("Saving...", "muted");
    try {
      const result = await onSave(collectValues(dialog), ui);
      if (result !== false) close();
    } catch (error) {
      setStatus(error?.message || "Save failed.", "error");
    } finally {
      setBusy(false);
    }
  });

  testButton?.addEventListener("click", async () => {
    setBusy(true);
    setStatus("Testing...", "muted");
    try {
      const message = await onTest(collectValues(dialog), ui);
      setStatus(message || "✔ Connection OK", "success");
    } catch (error) {
      setStatus(`✘ ${error?.message || "Connection failed."}`, "error");
    } finally {
      setBusy(false);
    }
  });

  leadingButton?.addEventListener("click", async () => {
    setBusy(true);
    try {
      await leadingAction.onClick(ui);
    } catch (error) {
      setStatus(error?.message || "Action failed.", "error");
    } finally {
      setBusy(false);
    }
  });

  deleteButton?.addEventListener("click", async () => {
    setBusy(true);
    try {
      const result = await onDelete(ui);
      if (result !== false) close();
    } catch (error) {
      setStatus(error?.message || "Delete failed.", "error");
    } finally {
      setBusy(false);
    }
  });

  document.body.appendChild(overlay);
  const firstInput = dialog.querySelector("[data-modal-field]:not([disabled])");
  firstInput?.focus({ preventScroll: true });
  return ui;
}

// Same field-rendering and save/test/account-flow wiring as
// openSettingsEditModal, but mounted directly into a page container instead
// of an overlay - for connections that should always be visible inline
// rather than behind an "Edit" click. No header/close/cancel; the caller's
// section-heading already supplies a title. Re-render (calling this again on
// the same container) is how a completed save/connect refreshes the panel.
// Consecutive field pairs that read better side by side than stacked.
const INLINE_FIELD_PAIRS = [["accountUsername", "accountPassword"]];

function renderInlineFields(fieldList) {
  let html = "";
  for (let i = 0; i < fieldList.length; i++) {
    const field = fieldList[i];
    const next = fieldList[i + 1];
    const pair = next && INLINE_FIELD_PAIRS.find(([a, b]) => a === field.key && b === next.key);
    if (pair) {
      html += `<div class="settings-inline-field-pair">${renderFieldRow(field)}${renderFieldRow(next)}</div>`;
      i++;
    } else {
      html += renderFieldRow(field);
    }
  }
  return html;
}

export function renderInlineServicePanel(container, {
  fields = [],
  onSave,
  onTest,
  onDelete,
  deleteLabel = "Disconnect account",
  saveLabel = "Save",
  saveDisabledLabel = "",
  testLabel = "Test",
  leadingAction,
  enabledKey = "",
  optionalFieldsLabel = "",
  // Footer checkboxes that are not part of this service's own config payload,
  // e.g. the Plex watchlist toggle, which writes to a different config section.
  // They deliberately avoid `data-modal-field` so they are neither collected
  // into the saved values nor disabled by the enable toggle.
  extraToggles = [],
} = {}) {
  if (!container) return null;

  // The enable toggle reads as a footer option beside Save/Test, not another
  // stacked field row above them.
  const enabledField = enabledKey ? fields.find((field) => field.key === enabledKey) : null;
  const enabledToggleHtml = enabledField
    ? `<label class="checkbox-label settings-inline-enabled"><input type="checkbox" data-modal-field="${escapeAttribute(enabledField.key)}" ${enabledField.value ? "checked" : ""} /> ${escapeHtml(enabledField.label)}</label>`
    : "";

  const leadingActionHtml = leadingAction
    ? `<div class="settings-modal-leading-action-row"><button class="button-primary settings-modal-leading-action" type="button">${escapeHtml(leadingAction.label || "Continue")}</button></div>`
    : "";
  const nonOptionalFields = fields.filter((field) => !field.optionalGroup && field !== enabledField);
  const nonOptionalFieldsHtml = renderInlineFields(nonOptionalFields) + leadingActionHtml;

  container.innerHTML = `
    <div class="settings-modal-fields">
      ${nonOptionalFieldsHtml}
      ${optionalFieldsLabel ? `<details class="sync-tool-details settings-modal-optional-fields">
        <summary class="accordion-header"><div class="sync-tool-summary-title"><svg class="accordion-chevron" width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d="M6 4l4 4-4 4"/></svg><b>${escapeHtml(optionalFieldsLabel)}</b></div></summary>
        <div class="settings-modal-optional-fields-body">${renderInlineFields(fields.filter((field) => field.optionalGroup))}</div>
      </details>` : renderInlineFields(fields.filter((field) => field.optionalGroup))}
    </div>
    <p class="settings-modal-status message" role="status" aria-live="polite" data-tone="muted"></p>
    <div class="settings-inline-footer">
      ${enabledToggleHtml}
      ${extraToggles.map((toggle, index) => `<label class="checkbox-label settings-inline-enabled"><input type="checkbox" data-inline-extra-toggle="${index}" ${toggle.checked ? "checked" : ""} /> ${escapeHtml(toggle.label)}</label>`).join("")}
      <div class="settings-inline-buttons">
        ${onDelete ? `<button class="button-danger settings-inline-delete" type="button">${escapeHtml(deleteLabel)}</button>` : ""}
        ${onTest ? `<button class="button-ghost settings-inline-test" type="button">${escapeHtml(testLabel)}</button>` : ""}
        <button class="button-primary settings-inline-save" type="button">${escapeHtml(saveLabel)}</button>
      </div>
    </div>
  `;

  const dialog = container;
  const statusEl = container.querySelector(".settings-modal-status");
  const saveButton = container.querySelector(".settings-inline-save");
  const testButton = container.querySelector(".settings-inline-test");
  const deleteButton = container.querySelector(".settings-inline-delete");
  const leadingButton = container.querySelector(".settings-modal-leading-action");

  const setStatus = (text, tone = "muted") => {
    statusEl.textContent = text || "";
    statusEl.dataset.tone = tone;
    statusEl.className = `settings-modal-status message ${tone}`;
  };
  const setBusy = (busy) => {
    [saveButton, testButton, deleteButton, leadingButton].forEach((button) => {
      if (button) button.disabled = busy;
    });
  };
  const ui = { close: () => {}, setStatus, setBusy, dialog, collect: () => collectValues(dialog) };

  const syncEnabledState = () => {
    if (!enabledKey) return;
    const master = dialog.querySelector(`[data-modal-field="${enabledKey}"]`);
    if (!master) return;
    const active = master.checked;
    dialog.querySelectorAll("[data-modal-field]").forEach((input) => {
      if (input.dataset.modalField !== enabledKey) input.disabled = !active;
    });
    if (saveDisabledLabel) saveButton.textContent = active ? saveLabel : saveDisabledLabel;
  };

  if (enabledKey) {
    dialog.querySelector(`[data-modal-field="${enabledKey}"]`)?.addEventListener("change", syncEnabledState);
    syncEnabledState();
  }

  dialog.querySelectorAll("[data-inline-extra-toggle]").forEach((input) => {
    const toggle = extraToggles[Number(input.dataset.inlineExtraToggle)];
    if (!toggle?.onChange) return;
    input.addEventListener("change", async () => {
      input.disabled = true;
      try {
        await toggle.onChange(input.checked, ui);
      } catch (error) {
        // Put the box back where it was so it never shows a state that was
        // not actually saved.
        input.checked = !input.checked;
        setStatus(error?.message || "Could not save that option.", "error");
      } finally {
        input.disabled = false;
      }
    });
  });

  saveButton.addEventListener("click", async () => {
    if (typeof onSave !== "function") return;
    setBusy(true);
    setStatus("Saving...", "muted");
    try {
      await onSave(collectValues(dialog), ui);
    } catch (error) {
      setStatus(error?.message || "Save failed.", "error");
      setBusy(false);
    }
  });

  testButton?.addEventListener("click", async () => {
    setBusy(true);
    setStatus("Testing...", "muted");
    try {
      const message = await onTest(collectValues(dialog), ui);
      setStatus(message || "✔ Connection OK", "success");
    } catch (error) {
      setStatus(`✘ ${error?.message || "Connection failed."}`, "error");
    } finally {
      setBusy(false);
    }
  });

  leadingButton?.addEventListener("click", async () => {
    setBusy(true);
    try {
      await leadingAction.onClick(ui);
    } catch (error) {
      setStatus(error?.message || "Action failed.", "error");
      setBusy(false);
    }
  });

  deleteButton?.addEventListener("click", async () => {
    setBusy(true);
    try {
      await onDelete(ui);
    } catch (error) {
      setStatus(error?.message || "Delete failed.", "error");
      setBusy(false);
    }
  });

  return ui;
}

// Opens the "+" picker: a grid of available service types. Picking one closes
// the picker and calls onPick(id).
export function openSettingsPickerModal({ title = "Add", intro = "", items = [], onPick } = {}) {
  closeSettingsModals();
  const overlay = document.createElement("div");
  overlay.className = "edit-dialog-overlay settings-modal-overlay";
  overlay.innerHTML = `
    <div class="edit-dialog settings-modal settings-picker-modal" role="dialog" aria-modal="true" aria-label="${escapeAttribute(title)}">
      <header class="settings-modal-head">
        <h3>${escapeHtml(title)}</h3>
        <button class="settings-modal-close" type="button" aria-label="Close">&times;</button>
      </header>
      <div class="settings-modal-body">
        ${intro ? `<p class="settings-picker-intro">${escapeHtml(intro)}</p>` : ""}
        <div class="settings-card-grid settings-picker-grid">
          ${items.map((item) => `
            <button class="service-card" type="button" data-picker-id="${escapeAttribute(item.id)}">
              <b>${escapeHtml(item.name)}</b>
              ${item.description ? `<span class="service-card-desc">${escapeHtml(item.description)}</span>` : ""}
            </button>
          `).join("")}
        </div>
      </div>
      <footer class="settings-modal-foot">
        <div class="settings-modal-actions">
          <button class="button-ghost settings-modal-cancel" type="button">Close</button>
        </div>
      </footer>
    </div>
  `;
  const onKeydown = (event) => { if (event.key === "Escape") close(); };
  const close = () => {
    document.removeEventListener("keydown", onKeydown);
    overlay.remove();
  };
  overlay._settingsClose = close;
  overlay.addEventListener("click", (event) => { if (event.target === overlay) close(); });
  overlay.querySelector(".settings-modal-close").addEventListener("click", close);
  overlay.querySelector(".settings-modal-cancel").addEventListener("click", close);
  overlay.querySelectorAll("[data-picker-id]").forEach((button) => {
    button.addEventListener("click", () => {
      close();
      onPick?.(button.dataset.pickerId);
    });
  });
  document.addEventListener("keydown", onKeydown);
  document.body.appendChild(overlay);
  overlay.querySelector("[data-picker-id], .settings-modal-close")?.focus({ preventScroll: true });
}

// Renders a Sonarr-style card grid: one card per configured service (name +
// status badges) and a trailing dashed "+" card when onAdd is provided.
export function renderServiceCardGrid(container, { items = [], onSelect, onAdd, addLabel = "Add", addVisibleLabel = "" } = {}) {
  if (!container) return;
  const badgeMarkup = (badges = []) => badges.map((badge) =>
    `<span class="status-pill status-${escapeAttribute(badge.tone || "muted")}">${escapeHtml(badge.label)}</span>`
  ).join("");
  container.innerHTML = `
    ${items.map((item) => `
      <button class="service-card" type="button" data-service-id="${escapeAttribute(item.id)}">
        <b>${escapeHtml(item.name)}</b>
        ${item.description ? `<span class="service-card-desc">${escapeHtml(item.description)}</span>` : ""}
        <span class="service-card-badges">${badgeMarkup(item.badges)}</span>
      </button>
    `).join("")}
    ${onAdd ? `<button class="service-card service-card--add" type="button" aria-label="${escapeAttribute(addLabel)}"><span aria-hidden="true">+</span>${addVisibleLabel ? `<span class="service-card-add-text">${escapeHtml(addVisibleLabel)}</span>` : ""}</button>` : ""}
  `;
  container.querySelectorAll("[data-service-id]").forEach((button) => {
    button.addEventListener("click", () => onSelect?.(button.dataset.serviceId));
  });
  container.querySelector(".service-card--add")?.addEventListener("click", () => onAdd?.());
}
