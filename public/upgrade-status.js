(function () {
  var logo = document.getElementById("upgradeLogo");
  if (document.documentElement.classList.contains("light-mode") && logo) {
    logo.src = "/plekt_header_logo_light.png?v=2.3.0.0.8";
  }
  var fill = document.getElementById("upgradeFill");
  var label = document.getElementById("upgradeLabel");
  var pct = document.getElementById("upgradePercent");
  var stats = document.getElementById("upgradeStats");
  var track = document.querySelector(".track");

  function fmtMB(bytes) {
    return (Number(bytes || 0) / (1024 * 1024)).toFixed(1) + " MB";
  }

  async function poll() {
    try {
      var res = await fetch("/api/upgrade-status", { cache: "no-store" });
      if (res.ok) {
        var data = await res.json();
        var p = Math.max(0, Math.min(100, Number(data.percent) || 0));
        if (fill) fill.style.width = p + "%";
        if (pct) pct.textContent = p + "%";
        if (track) track.setAttribute("aria-valuenow", String(p));
        if (label && data.label) label.textContent = data.label;
        if (stats && data.savedBytes > 0) {
          stats.textContent = fmtMB(data.savedBytes) + " reclaimed so far — opening automatically when done.";
        }
        if (!data.active) {
          window.location.reload();
          return;
        }
      }
    } catch { /* retry on transient connection error */ }
    setTimeout(poll, 1000);
  }

  setTimeout(poll, 800);
})();
