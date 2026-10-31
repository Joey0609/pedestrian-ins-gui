'use strict';

// Application update state and its IPC endpoints share this one service instance.
function createUpdateService({ app, autoUpdater, safeSendToRenderer }) {
  let manualUpdateCheckPending = false;

  function setupApplicationUpdates() {
    if (!app.isPackaged) return;

    autoUpdater.autoDownload = false;
    autoUpdater.autoInstallOnAppQuit = true;

    autoUpdater.on('checking-for-update', () => safeSendToRenderer('app-update-status', { state: 'checking', manual: manualUpdateCheckPending }));
    autoUpdater.on('update-available', (info) => safeSendToRenderer('app-update-status', {
      state: 'available',
      version: info.version,
      currentVersion: app.getVersion(),
      releaseNotes: info.releaseNotes || '',
      manual: manualUpdateCheckPending,
    }));
    autoUpdater.on('download-progress', (progress) => safeSendToRenderer('app-update-status', {
      state: 'downloading',
      percent: Math.round(progress.percent || 0),
    }));
    autoUpdater.on('update-not-available', () => {
      safeSendToRenderer('app-update-status', { state: 'latest', manual: manualUpdateCheckPending });
      manualUpdateCheckPending = false;
    });
    autoUpdater.on('error', (error) => {
      console.error('[updater]', error);
      safeSendToRenderer('app-update-status', { state: 'error', message: error.message, manual: manualUpdateCheckPending });
      manualUpdateCheckPending = false;
    });
    autoUpdater.on('update-downloaded', (info) => {
      safeSendToRenderer('app-update-status', { state: 'downloaded', version: info.version });
    });

    setTimeout(() => autoUpdater.checkForUpdates(), 3000);
  }

  function registerIpc(ipcMain) {
    ipcMain.handle('app-check-update', async () => {
      if (!app.isPackaged) return { ok: false, error: 'development-mode' };
      try {
        manualUpdateCheckPending = true;
        await autoUpdater.checkForUpdates();
        return { ok: true };
      } catch (error) {
        console.error('[updater] check failed', error);
        manualUpdateCheckPending = false;
        return { ok: false, error: error.message };
      }
    });

    ipcMain.handle('app-download-update', async () => {
      if (!app.isPackaged) return { ok: false, error: 'development-mode' };
      try {
        await autoUpdater.downloadUpdate();
        return { ok: true };
      } catch (error) {
        console.error('[updater] download failed', error);
        return { ok: false, error: error.message };
      }
    });

    ipcMain.handle('app-install-update', () => {
      if (!app.isPackaged) return { ok: false, error: 'development-mode' };
      autoUpdater.quitAndInstall();
      return { ok: true };
    });
  }

  return { setupApplicationUpdates, registerIpc };
}

module.exports = { createUpdateService };
