import { escapeHtml, toDateInputValue } from "./utils.js?v=2.0.0.3.6";

// Shared calendar + time picker used everywhere the app lets you pick a watch
// date (the edit-date dialogs, and the "mark watched" date prompts). Every
// call to mountCalendarPicker owns its own independent pickerState object -
// there is no global singleton - so multiple instances never collide and
// every picker in the app stays visually and behaviorally identical.

const WD_WEEKDAYS = ["Mo", "Tu", "We", "Th", "Fr", "Sa", "Su"];
const WD_MONTH_NAMES = Array.from({ length: 12 }, (_, m) =>
  new Intl.DateTimeFormat(undefined, { month: "long" }).format(new Date(2000, m, 1)));

// Fixed at 6 rows (42 cells) regardless of month length/weekday alignment, so
// the calendar's overall height - and the position of controls around it -
// never shifts when moving between months.
const WD_GRID_CELLS = 42;

export function calendarStateFromIso(iso) {
  const date = iso ? new Date(iso) : new Date();
  const selected = Number.isNaN(date.getTime()) ? new Date() : date;
  selected.setSeconds(0, 0);
  return { year: selected.getFullYear(), month: selected.getMonth(), selected, pickingMonth: true };
}

export function formatCalendarDisplay(date) {
  return new Intl.DateTimeFormat(undefined, {
    weekday: "short", day: "numeric", month: "short", year: "numeric",
    hour: "2-digit", minute: "2-digit",
  }).format(date);
}

export function renderCalendarPickerHtml(pickerState, { showConfirm = true, showCancel = true, confirmLabel = "Use this date & time" } = {}) {
  const { year, month, selected, pickingMonth } = pickerState;
  const now = new Date();
  const todayStr = toDateInputValue(now);
  const selStr = toDateInputValue(selected);
  const viewDate = new Date(year, month, 1);
  const monthLabel = new Intl.DateTimeFormat(undefined, { month: "long", year: "numeric" }).format(viewDate);
  const firstDow = (viewDate.getDay() + 6) % 7;
  const daysInMonth = new Date(year, month + 1, 0).getDate();

  const cells = [];
  for (let i = 0; i < firstDow; i += 1) cells.push(`<span class="wd-cell wd-empty"></span>`);
  for (let d = 1; d <= daysInMonth; d += 1) {
    const dateStr = `${year}-${String(month + 1).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
    const classes = ["wd-cell", "wd-day"];
    if (dateStr === selStr) classes.push("is-selected");
    if (dateStr === todayStr) classes.push("is-today");
    const future = dateStr > todayStr;
    cells.push(`<button type="button" class="${classes.join(" ")}" data-wd-day="${dateStr}"${future ? " disabled" : ""}>${d}</button>`);
  }
  while (cells.length < WD_GRID_CELLS) cells.push(`<span class="wd-cell wd-empty"></span>`);

  const atCurrentMonth = year > now.getFullYear() || (year === now.getFullYear() && month >= now.getMonth());
  const dowHtml = WD_WEEKDAYS.map((d) => `<span class="wd-dow">${d}</span>`).join("");
  const hoursHtml = Array.from({ length: 24 }, (_, h) =>
    `<option value="${h}"${h === selected.getHours() ? " selected" : ""}>${String(h).padStart(2, "0")}</option>`).join("");
  const minutesHtml = Array.from({ length: 60 }, (_, m) =>
    `<option value="${m}"${m === selected.getMinutes() ? " selected" : ""}>${String(m).padStart(2, "0")}</option>`).join("");

  const currentYear = now.getFullYear();
  const monthOptionsHtml = WD_MONTH_NAMES.map((name, m) =>
    `<option value="${m}"${m === month ? " selected" : ""}>${escapeHtml(name)}</option>`).join("");
  const yearOptionsHtml = Array.from({ length: 101 }, (_, i) => currentYear - i).map((y) =>
    `<option value="${y}"${y === year ? " selected" : ""}>${y}</option>`).join("");

  const monthHeaderHtml = pickingMonth
    ? `
      <span class="wd-month-select-group">
        <select class="wd-select wd-month-select" data-wd-month-select aria-label="Month">${monthOptionsHtml}</select>
        <select class="wd-select wd-month-select" data-wd-year-select aria-label="Year">${yearOptionsHtml}</select>
      </span>
    `
    : `<button type="button" class="wd-month" data-wd-month-toggle>${escapeHtml(monthLabel)}</button>`;

  return `
    <div class="wd-display">${escapeHtml(formatCalendarDisplay(selected))}</div>
    <div class="wd-body">
      <div class="wd-calendar">
        <div class="wd-cal-head">
          <button type="button" class="wd-nav" data-wd-nav="prev" aria-label="Previous month">&#8249;</button>
          ${monthHeaderHtml}
          <button type="button" class="wd-nav" data-wd-nav="next" aria-label="Next month"${atCurrentMonth ? " disabled" : ""}>&#8250;</button>
        </div>
        <div class="wd-grid wd-dow-row">${dowHtml}</div>
        <div class="wd-grid wd-day-grid">${cells.join("")}</div>
      </div>
      <div class="wd-time">
        <span class="wd-time-label">Time</span>
        <div class="wd-time-selects">
          <select class="wd-select" data-wd-hour aria-label="Hour">${hoursHtml}</select>
          <span class="wd-colon">:</span>
          <select class="wd-select" data-wd-minute aria-label="Minute">${minutesHtml}</select>
        </div>
      </div>
    </div>
    ${showConfirm ? `
    <div class="watch-date-calendar-actions">
      <button class="button-primary wd-use" type="button">${escapeHtml(confirmLabel)}</button>
      ${showCancel ? `<button class="button-ghost wd-cancel" type="button">Cancel</button>` : ""}
    </div>
    ` : ""}
  `;
}

// Renders a fresh, independent calendar+time picker into `container` and wires
// its own nav/day/month/year/time interactions (re-rendering itself on each
// change), so multiple instances never share state. Pass `showCancel: false`
// when the picker is permanently visible inside a dialog that already has its
// own close/cancel control (e.g. the "mark watched" date prompt).
export function mountCalendarPicker(container, pickerState, { onConfirm, onCancel, showConfirm = true, showCancel = true, confirmLabel } = {}) {
  const syncTimeFromSelects = () => {
    const hourEl = container.querySelector("[data-wd-hour]");
    const minuteEl = container.querySelector("[data-wd-minute]");
    if (hourEl) pickerState.selected.setHours(Number(hourEl.value));
    if (minuteEl) pickerState.selected.setMinutes(Number(minuteEl.value));
    pickerState.selected.setSeconds(0, 0);
  };

  const render = () => {
    container.innerHTML = renderCalendarPickerHtml(pickerState, { showConfirm, showCancel, confirmLabel });

    const useBtn = container.querySelector(".wd-use");
    if (useBtn) {
      useBtn.addEventListener("click", () => {
        syncTimeFromSelects();
        onConfirm?.(pickerState.selected);
      });
    }
    const cancelBtn = container.querySelector(".wd-cancel");
    if (cancelBtn) cancelBtn.addEventListener("click", () => onCancel?.());
    container.querySelectorAll("[data-wd-nav]").forEach((btn) => {
      btn.addEventListener("click", () => {
        syncTimeFromSelects();
        const dir = btn.dataset.wdNav === "next" ? 1 : -1;
        let month = pickerState.month + dir;
        let year = pickerState.year;
        if (month < 0) { month = 11; year -= 1; }
        if (month > 11) { month = 0; year += 1; }
        pickerState.year = year;
        pickerState.month = month;
        render();
      });
    });
    container.querySelectorAll("[data-wd-day]").forEach((btn) => {
      btn.addEventListener("click", () => {
        syncTimeFromSelects();
        const [y, m, d] = btn.dataset.wdDay.split("-").map(Number);
        pickerState.selected.setFullYear(y, m - 1, d);
        pickerState.year = y;
        pickerState.month = m - 1;
        render();
      });
    });
    const monthToggle = container.querySelector("[data-wd-month-toggle]");
    if (monthToggle) {
      monthToggle.addEventListener("click", () => {
        syncTimeFromSelects();
        pickerState.pickingMonth = true;
        render();
      });
    }
    const monthSelect = container.querySelector("[data-wd-month-select]");
    const yearSelect = container.querySelector("[data-wd-year-select]");
    if (monthSelect && yearSelect) {
      const applyMonthYearChoice = () => {
        syncTimeFromSelects();
        pickerState.month = Number(monthSelect.value);
        pickerState.year = Number(yearSelect.value);
        pickerState.pickingMonth = false;
        render();
      };
      monthSelect.addEventListener("change", applyMonthYearChoice);
      yearSelect.addEventListener("change", applyMonthYearChoice);
    }
    container.querySelectorAll("[data-wd-hour], [data-wd-minute]").forEach((sel) => {
      sel.addEventListener("change", () => {
        syncTimeFromSelects();
        const display = container.querySelector(".wd-display");
        if (display) display.textContent = formatCalendarDisplay(pickerState.selected);
      });
    });
  };

  render();
}
