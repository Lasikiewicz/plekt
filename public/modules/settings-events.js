// Settings-page event wiring: diagnostic logs, admin login and webhook secret,
// import, backups and restore, maintenance tools, and the sync controls.
//
// Split from app-events.js, which every page loads, so these handlers are only
// parsed when Settings is opened. app-events.js wires this module through
// onRouteModuleLoaded() with the same callbacks object it received, so each
// wrapper below reads the app.js implementation at call time.
import { rotateWebhookSecret } from "./auth.js?v=2.0.0.1.0";
import { clearDebugLogs, fetchDiagnosticLogs, clearDiagnosticLogs as clearBackendDiagnosticLogs } from "./logs.js?v=2.0.0.1.0";
import { state, elements } from "./state.js?v=2.0.0.1.0";
import { loadSyncHistory, loadSyncJobs, triggerCronSync, triggerStopSync } from "./sync.js?v=2.0.0.1.0";
import { ifLoaded, lazyExport } from "./route-modules.js?v=2.0.0.1.0";

const lazyTools = (name) => lazyExport("tools", name);
const lazyBackups = (name) => lazyExport("tools-backups", name);
const renderSettingsInlineHelp = ifLoaded("help-content", "renderSettingsInlineHelp");
const renderImportPreview = ifLoaded("tools", "renderImportPreview"), appendImportLog = ifLoaded("tools", "appendImportLog");
const loadCacheStats = lazyTools("loadCacheStats"), parseSelectedFiles = lazyTools("parseSelectedFiles"), startImport = lazyTools("startImport"), runRepairWorkflow = lazyTools("runRepairWorkflow"), runTraktBackfill = lazyTools("runTraktBackfill"), runEpisodeTitleAudit = lazyTools("runEpisodeTitleAudit"), runEpisodeTitleBackfill = lazyTools("runEpisodeTitleBackfill"), runRematchTvShows = lazyTools("runRematchTvShows"), runSystemIntegrityCheck = lazyTools("runSystemIntegrityCheck"), triggerClearMissingTelemetry = lazyTools("triggerClearMissingTelemetry"), triggerRetryAllCategory = lazyTools("triggerRetryAllCategory");
const selectPlektBackupFile = lazyBackups("selectPlektBackupFile"), importPlektBackup = lazyBackups("importPlektBackup");
const restoreRemoteBackupFromCard = lazyBackups("restoreRemoteBackupFromCard"), loadWatchBackups = lazyBackups("loadWatchBackups"), postWatchBackupAction = lazyBackups("postWatchBackupAction");
const saveWatchBackupSettings = lazyBackups("saveWatchBackupSettings"), createWatchBackupNow = lazyBackups("createWatchBackupNow"), downloadWatchBackup = lazyBackups("downloadWatchBackup");
const uploadWatchBackupFile = lazyBackups("uploadWatchBackupFile"), restoreWatchBackup = lazyBackups("restoreWatchBackup");
const savePlektBackupSettings = lazyBackups("savePlektBackupSettings"), createPlektBackupNow = lazyBackups("createPlektBackupNow"), downloadPlektBackup = lazyBackups("downloadPlektBackup");
const deletePlektBackupFile = lazyBackups("deletePlektBackupFile"), restorePlektBackupFromServer = lazyBackups("restorePlektBackupFromServer"), restoreRemotePlektBackup = lazyBackups("restoreRemotePlektBackup");
const updatePlektButtonsState = lazyBackups("updatePlektButtonsState"), savePlektBackupRemoteSettings = lazyBackups("savePlektBackupRemoteSettings");
const createPlektBackupRemoteNow = lazyBackups("createPlektBackupRemoteNow"), createRemoteWatchBackupNow = lazyBackups("createRemoteWatchBackupNow"), saveRemoteWatchBackupSettings = lazyBackups("saveRemoteWatchBackupSettings");

let _cb = {};
const authHeaders = (...args) => _cb.authHeaders?.(...args), setMessage = (...args) => _cb.setMessage?.(...args), renderLogs = (...args) => _cb.renderLogs?.(...args), logsText = (...args) => _cb.logsText?.(...args), copyToClipboard = (...args) => _cb.copyToClipboard?.(...args), showConfirmModal = (...args) => _cb.showConfirmModal?.(...args), saveAdminCredentials = (...args) => _cb.saveAdminCredentials?.(...args), renderAdminCredentialsStatus = (...args) => _cb.renderAdminCredentialsStatus?.(...args), renderSettingsStatus = (...args) => _cb.renderSettingsStatus?.(...args), runRefreshMetadataWorkflow = (...args) => _cb.runRefreshMetadataWorkflow?.(...args), runRefreshTvdbMetadataWorkflow = (...args) => _cb.runRefreshTvdbMetadataWorkflow?.(...args);

let bound = false;
export function initSettingsEvents(callbacks = {}) {
  _cb = callbacks;
  if (bound) return;
  bound = true;
  elements.clearLogsButton.addEventListener("click", () => {
    state.debugLogs = clearDebugLogs();
    clearBackendDiagnosticLogs(authHeaders())
      .catch((error) => setMessage(error.message, "error"))
      .finally(() => renderLogs().catch(() => { }));
  });

  elements.copyLogsButton.addEventListener("click", () => {
    copyToClipboard(state.renderedLogsText || logsText() || "[no diagnostic logs captured yet]", elements.copyLogsButton);
  });

  elements.downloadLogsButton?.addEventListener("click", async () => {
    try {
      const backendLogs = await fetchDiagnosticLogs(authHeaders(), "all");
      const localLogs = logsText();
      const content = [
        `=== PLEKT DIAGNOSTIC LOGS EXPORT (${new Date().toISOString()}) ===`,
        ...backendLogs,
        "",
        "=== FRONTEND DEBUG LOGS ===",
        localLogs || "[no frontend logs]"
      ].join("\n");

      const blob = new Blob([content], { type: "text/plain;charset=utf-8" });
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      const dateStr = new Date().toISOString().slice(0, 10);
      link.href = url;
      link.download = `plekt-logs-${dateStr}.log`;
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);
      URL.revokeObjectURL(url);
      setMessage("Logs downloaded successfully", "success");
    } catch (error) {
      setMessage(`Download logs failed: ${error.message || String(error)}`, "error");
    }
  });

  document.querySelector("#logsCategoryFilter")?.addEventListener("click", (event) => {
    const btn = event.target.closest(".logs-cat-btn");
    if (!btn) return;
    const category = btn.dataset.category || "all";
    state.activeLogCategory = category;
    document.querySelectorAll("#logsCategoryFilter .logs-cat-btn").forEach((b) => {
      b.classList.toggle("active", b === btn);
    });
    renderLogs(true).catch(() => {});
  });

  elements.saveWatchBackupConfigButton?.addEventListener("click", () => {
    saveWatchBackupSettings().catch((error) => setMessage(error.message, "error"));
  });
  elements.createWatchBackupButton?.addEventListener("click", () => {
    createWatchBackupNow().catch((error) => setMessage(error.message, "error"));
  });
  elements.chooseWatchBackupFileButton?.addEventListener("click", () => {
    elements.watchBackupUploadFile?.click();
  });
  elements.watchBackupUploadFile?.addEventListener("change", () => {
    const file = elements.watchBackupUploadFile.files?.[0];
    uploadWatchBackupFile(file)
      .catch((error) => {
        if (elements.watchBackupUploadStatus) elements.watchBackupUploadStatus.textContent = "Upload failed";
        setMessage(error.message, "error");
      })
      .finally(() => {
        if (elements.watchBackupUploadFile) elements.watchBackupUploadFile.value = "";
      });
  });
  elements.refreshWatchBackupsButton?.addEventListener("click", () => {
    state.watchBackups = null;
    loadWatchBackups({ force: true }).catch((error) => setMessage(error.message, "error"));
  });
  const handleWatchBackupListClick = (event) => {
    const download = event.target.closest("[data-watch-backup-download]");
    if (download) {
      downloadWatchBackup(download.dataset.watchBackupDownload).catch((error) => setMessage(error.message, "error"));
      return;
    }
    const dryRun = event.target.closest("[data-watch-backup-dry-run]");
    if (dryRun) {
      restoreWatchBackup(dryRun.dataset.watchBackupDryRun, "reconcile", true).catch((error) => setMessage(error.message, "error"));
      return;
    }
    const restore = event.target.closest("[data-watch-backup-restore]");
    if (restore) {
      const clearMode = state.restoreClearMode || "wipe";
      const destId = restore.dataset.restoreDestId;
      if (destId) {
        restoreRemoteBackupFromCard({ dataset: { destId } }, restore.dataset.watchBackupRestore, clearMode).catch((error) => setMessage(error.message, "error"));
      } else {
        restoreWatchBackup(restore.dataset.watchBackupRestore, clearMode).catch((error) => setMessage(error.message, "error"));
      }
    }
  };
  elements.watchBackupList?.addEventListener("click", handleWatchBackupListClick);
  elements.remoteWatchBackupList?.addEventListener("click", handleWatchBackupListClick);

  const handleWatchBackupListChange = (event) => {
    const clearModeInput = event.target.closest("[data-restore-clear-mode]");
    if (clearModeInput) {
      state.restoreClearMode = clearModeInput.value === "wipe" ? "wipe" : "reconcile";
    }
  };
  elements.watchBackupList?.addEventListener("change", handleWatchBackupListChange);
  elements.remoteWatchBackupList?.addEventListener("change", handleWatchBackupListChange);

  elements.watchBackupRuntime?.addEventListener("click", (event) => {
    const clearBtn = event.target.closest("[data-clear-restore-status]");
    if (clearBtn) {
      postWatchBackupAction({ action: "clear-restore-status" })
        .then(() => loadWatchBackups({ force: true }))
        .catch((error) => setMessage(error.message, "error"));
    }
  });

  elements.adminCredentialsForm.addEventListener("submit", (event) => {
    event.preventDefault();
    saveAdminCredentials().catch((error) => {
      renderAdminCredentialsStatus(error.message, "error");
      setMessage(error.message, "error");
    });
  });

  elements.rotateWebhookButton?.addEventListener("click", () => {
    showConfirmModal(
      "Rotating your webhook secret will immediately invalidate your current webhook token.\n\nAll incoming webhook events sent using the old secret will fail with an HTTP 401 Unauthorized error until you update the URL in every configured service.",
      () => {
        showConfirmModal(
          "Are you 100% sure you want to rotate your webhook secret right now?\n\nRemember: Your media servers (Plex, Emby, Jellyfin) and automation scripts will stop syncing watchstates until you paste the new URL into their settings.",
          async () => {
            try {
              await rotateWebhookSecret();
              renderSettingsInlineHelp();
              setMessage("Webhook secret rotated successfully. Remember to update the URL in Plex, Emby, Jellyfin, and your automation clients.", "success");
            } catch (error) {
              setMessage(`Failed to rotate webhook secret: ${error.message}`, "error");
            }
          },
          {
            title: "Final Confirmation: Rotate Webhook Secret",
            approveLabel: "Yes, Rotate Secret Now",
          }
        );
      },
      {
        title: "Rotate Webhook Secret - Step 1 of 2",
        approveLabel: "Proceed to Final Step",
        mediaHtml: `
          <div style="background: rgba(239, 68, 68, 0.08); border: 1px solid rgba(239, 68, 68, 0.25); border-radius: 8px; padding: 12px; margin-bottom: 12px; font-size: 0.82rem; line-height: 1.5; color: var(--text);">
            <b style="color: #ef4444; display: block; margin-bottom: 6px; font-size: 0.88rem;">⚠️ Required Updates After Rotation:</b>
            <ol style="margin: 0; padding-left: 1.2rem; display: grid; gap: 4px;">
              <li><b>Plex Media Server:</b> Update the Webhook URL in Plex Web Settings ➔ Webhooks.</li>
              <li><b>Emby Server:</b> Update the Webhook URL in Emby Server Settings ➔ Webhooks.</li>
              <li><b>Jellyfin Server:</b> Update the generic webhook URL in Jellyfin Dashboard ➔ Plugins ➔ Webhooks.</li>
              <li><b>Automation Clients:</b> Update any scripts, daemons, or tools passing <code>X-Plekt-Webhook-Secret</code> or <code>Authorization: Bearer</code> headers.</li>
            </ol>
          </div>
        `,
      }
    );
  });

  elements.importFile.addEventListener("change", async () => {
    const files = elements.importFile.files;
    if (!files?.length) return;
    try {
      await parseSelectedFiles(files);
      setMessage(`Parsed ${state.importRecords.length} records from ${files.length} file${files.length === 1 ? "" : "s"}.`, "success");
    } catch (error) {
      state.importRecords = [];
      state.importFileNames = [];
      appendImportLog(`Parse failed: ${error.message}`);
      renderImportPreview();
      setMessage(`Import parse failed: ${error.message}`, "error");
    }
  });

  elements.startImportButton.addEventListener("click", () => {
    startImport().catch((error) => setMessage(error.message, "error"));
  });

  elements.clearImportButton.addEventListener("click", () => {
    state.importRecords = [];
    state.importFileNames = [];
    state.importLogs = ["[idle] Waiting for files."];
    state.importProgressValue = 0;
    elements.importFile.value = "";
    renderImportPreview();
    setMessage("Import selection cleared.");
  });

  elements.backupExportPassphrase?.addEventListener("input", () => {
    updatePlektButtonsState();
  });
  elements.backupExportRememberPassphrase?.addEventListener("change", () => {
    updatePlektButtonsState();
  });
  elements.plektBackupEnabled?.addEventListener("change", () => {
    updatePlektButtonsState();
  });

  elements.plektBackupRemotePassphrase?.addEventListener("input", () => {
    updatePlektButtonsState();
  });
  elements.plektBackupRemoteRememberPassphrase?.addEventListener("change", () => {
    updatePlektButtonsState();
  });
  elements.plektBackupRemoteEnabled?.addEventListener("change", () => {
    updatePlektButtonsState();
  });

  elements.savePlektBackupRemoteButton?.addEventListener("click", () => {
    savePlektBackupRemoteSettings().catch((error) => setMessage(error.message, "error"));
  });

  elements.createPlektBackupRemoteButton?.addEventListener("click", () => {
    createPlektBackupRemoteNow().catch((error) => setMessage(error.message, "error"));
  });

  elements.createRemoteWatchBackupButton?.addEventListener("click", () => {
    createRemoteWatchBackupNow().catch((error) => setMessage(error.message, "error"));
  });

  elements.saveRemoteWatchBackupConfigButton?.addEventListener("click", () => {
    saveRemoteWatchBackupSettings().catch((error) => setMessage(error.message, "error"));
  });

  elements.savePlektBackupConfigButton?.addEventListener("click", () => {
    savePlektBackupSettings().catch((error) => setMessage(error.message, "error"));
  });

  elements.createPlektBackupButton?.addEventListener("click", () => {
    createPlektBackupNow().catch((error) => setMessage(error.message, "error"));
  });

  elements.plektBackupList?.addEventListener("click", (event) => {
    const downloadBtn = event.target.closest("[data-plekt-backup-download]");
    if (downloadBtn) {
      const filename = downloadBtn.dataset.plektBackupDownload;
      downloadPlektBackup(filename).catch((error) => setMessage(error.message, "error"));
    }
    const restoreBtn = event.target.closest("[data-plekt-backup-restore]");
    if (restoreBtn) {
      const filename = restoreBtn.dataset.plektBackupRestore;
      restorePlektBackupFromServer(filename).catch((error) => setMessage(error.message, "error"));
    }
    const deleteBtn = event.target.closest("[data-plekt-backup-delete]");
    if (deleteBtn) {
      const filename = deleteBtn.dataset.plektBackupDelete;
      deletePlektBackupFile(filename).catch((error) => setMessage(error.message, "error"));
    }
  });

  elements.remotePlektBackupList?.addEventListener("click", (event) => {
    const restoreBtn = event.target.closest("[data-plekt-remote-backup-restore]");
    if (restoreBtn) {
      const filename = restoreBtn.dataset.plektRemoteBackupRestore;
      const destinationId = restoreBtn.dataset.restoreDestId;
      restoreRemotePlektBackup(destinationId, filename).catch((error) => setMessage(error.message, "error"));
    }
  });

  elements.backupRestorePassphrase?.addEventListener("input", () => {
    const disabled = elements.backupRestorePassphrase.value.trim().length < 12;
    if (elements.backupImportFile) {
      elements.backupImportFile.disabled = disabled;
    }
    const fileLabel = document.querySelector(".backup-file-button");
    if (fileLabel) {
      if (disabled) {
        fileLabel.classList.add("disabled");
        fileLabel.style.opacity = "0.5";
        fileLabel.style.pointerEvents = "none";
      } else {
        fileLabel.classList.remove("disabled");
        fileLabel.style.opacity = "";
        fileLabel.style.pointerEvents = "";
      }
    }
  });

  elements.backupImportFile?.addEventListener("change", async () => {
    const file = elements.backupImportFile.files?.[0] || null;
    await selectPlektBackupFile(file);
    elements.backupImportButton.disabled = !file;
  });

  elements.backupImportButton?.addEventListener("click", () => {
    importPlektBackup().catch((error) => setMessage(error.message, "error"));
  });

  if (elements.runCompleteCheckButton) {
    elements.runCompleteCheckButton.addEventListener("click", () => {
      runSystemIntegrityCheck().catch((error) => {
        setMessage(`Integrity check exception: ${error.message}`, "error");
      });
    });
  }

  if (elements.refreshCacheStatsButton) {
    elements.refreshCacheStatsButton.addEventListener("click", () => {
      loadCacheStats({ force: true }).catch((error) => setMessage(error.message, "error"));
    });
  }

  if (elements.runRepairButton) {
    elements.runRepairButton.addEventListener("click", () => {
      runRepairWorkflow().catch((error) => {
        renderSettingsStatus(error.message, "error");
        setMessage(error.message, "error");
      });
    });
  }

  if (elements.traktBackfillButton) {
    elements.traktBackfillButton.addEventListener("click", () => {
      runTraktBackfill().catch((error) => {
        elements.traktBackfillStatus.textContent = `Error: ${error?.message || String(error)}`;
      });
    });
  }

  if (elements.phantomAuditButton) {
    elements.phantomAuditButton.addEventListener("click", () => {
      _cb.runPhantomWatchAudit?.().catch((error) => {
        if (elements.phantomAuditStatus) elements.phantomAuditStatus.textContent = `Error: ${error?.message || String(error)}`;
      });
    });
  }

  if (elements.phantomRepairButton) {
    elements.phantomRepairButton.addEventListener("click", () => {
      _cb.runPhantomWatchRepair?.().catch((error) => {
        if (elements.phantomAuditStatus) elements.phantomAuditStatus.textContent = `Error: ${error?.message || String(error)}`;
      });
    });
  }

  if (elements.duplicateWatchTvButton) {
    elements.duplicateWatchTvButton.addEventListener("click", () => {
      _cb.runDuplicateWatchCleanup?.("episode").catch((error) => {
        if (elements.duplicateWatchStatus) elements.duplicateWatchStatus.textContent = `Error: ${error?.message || String(error)}`;
      });
    });
  }

  if (elements.duplicateWatchMovieButton) {
    elements.duplicateWatchMovieButton.addEventListener("click", () => {
      _cb.runDuplicateWatchCleanup?.("movie").catch((error) => {
        if (elements.duplicateWatchStatus) elements.duplicateWatchStatus.textContent = `Error: ${error?.message || String(error)}`;
      });
    });
  }

  if (elements.episodeTitleAuditButton) {
    elements.episodeTitleAuditButton.addEventListener("click", () => {
      runEpisodeTitleAudit().catch((error) => {
        if (elements.episodeTitleStatus) elements.episodeTitleStatus.textContent = `Error: ${error?.message || String(error)}`;
      });
    });
  }

  if (elements.episodeTitleBackfillButton) {
    elements.episodeTitleBackfillButton.addEventListener("click", () => {
      runEpisodeTitleBackfill().catch((error) => {
        if (elements.episodeTitleStatus) elements.episodeTitleStatus.textContent = `Error: ${error?.message || String(error)}`;
      });
    });
  }

  if (elements.wipeDataContent) {
    elements.wipeDataContent.addEventListener("click", (event) => {
      const button = event.target.closest("[data-wipe-scope]");
      if (!button) return;
      _cb.runWipeData?.(button.dataset.wipeScope)?.catch?.(() => {});
    });
  }

  if (elements.refreshMetadataButton) {
    elements.refreshMetadataButton.addEventListener("click", () => {
      runRefreshMetadataWorkflow().catch((error) => {
        if (elements.refreshMetadataStatus) elements.refreshMetadataStatus.textContent = `Error: ${error?.message || String(error)}`;
      });
    });
  }

  if (elements.refreshTvdbButton) {
    elements.refreshTvdbButton.addEventListener("click", () => {
      runRefreshTvdbMetadataWorkflow().catch((error) => {
        if (elements.refreshTvdbStatus) elements.refreshTvdbStatus.textContent = `Error: ${error?.message || String(error)}`;
      });
    });
  }

  if (elements.rematchTvButton) {
    elements.rematchTvButton.addEventListener("click", () => {
      runRematchTvShows().catch((error) => {
        if (elements.rematchTvStatus) elements.rematchTvStatus.textContent = `Error: ${error?.message || String(error)}`;
      });
    });
  }

  if (elements.runCronSyncButton) {
    elements.runCronSyncButton.addEventListener("click", () => {
      triggerCronSync().catch(() => { });
    });
  }

  if (elements.refreshSyncButton) {
    elements.refreshSyncButton.addEventListener("click", () => {
      loadSyncJobs({ force: true }).catch((error) => setMessage(error.message, "error"));
      loadSyncHistory({ force: true }).catch((error) => setMessage(error.message, "error"));
    });
  }

  if (elements.stopSyncButton) {
    elements.stopSyncButton.addEventListener("click", () => {
      triggerStopSync().catch(() => { });
    });
  }

  // Sync issues toggle
  if (elements.syncIssuesToggle) {
    elements.syncIssuesToggle.addEventListener("click", () => {
      const isHidden = elements.syncIssuesContent.classList.contains("hidden");
      if (isHidden) {
        elements.syncIssuesContent.classList.remove("hidden");
        elements.syncIssuesToggleIcon.textContent = "▼";
      } else {
        elements.syncIssuesContent.classList.add("hidden");
        elements.syncIssuesToggleIcon.textContent = "▶";
      }
    });
  }

  // Event delegation for action buttons in sync issues
  document.addEventListener("click", (e) => {
    if (e.target.dataset.action === "clearMissingTelemetry") {
      triggerClearMissingTelemetry(e.target).catch(() => { });
    }
    if (e.target.dataset.action === "retryAllCategory") {
      triggerRetryAllCategory(e.target.dataset.category, e.target).catch(() => { });
    }
    if (e.target.classList.contains("dismiss-issue-btn")) {
      const issueCard = e.target.closest(".sync-issue-card");
      if (issueCard) {
        issueCard.style.animation = "fadeOut 0.3s ease forwards";
        setTimeout(() => {
          issueCard.remove();
          const container = document.getElementById("syncIssuesContainer");
          if (container && container.querySelectorAll(".sync-issue-card").length === 0) {
            loadSyncJobs({ force: true }).catch(() => { });
          }
        }, 300);
      }
    }
  });
}
