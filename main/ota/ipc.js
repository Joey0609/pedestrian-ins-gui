'use strict';

// Preserve the renderer/preload OTA contract while keeping Electron out of the service.
function registerOtaIpc({ ipcMain, dialog, getWindow, ota }) {
  const { inspectFirmwareBin, startOtaForTargets, requestOtaInterrupt, queryOtaDeviceVersions, handleOtaDeviceAction } = ota;

  ipcMain.handle('ota-select-bin', async () => {
    const result = await dialog.showOpenDialog(getWindow(), {
      title: '选择固件文件',
      properties: ['openFile'],
      filters: [{ name: 'ESP Firmware', extensions: ['bin'] }],
    });

    if (result.canceled || !result.filePaths || result.filePaths.length === 0) {
      return { canceled: true };
    }

    return { canceled: false, filePath: result.filePaths[0] };
  });

  ipcMain.handle('ota-inspect-bin', async (event, args) => {
    const info = inspectFirmwareBin(args && args.filePath ? args.filePath : '');
    if (!info.ok) return info;
    const { buffer, ...publicInfo } = info;
    return publicInfo;
  });

  ipcMain.handle('ota-start', async (event, args) => {
    try {
      return await startOtaForTargets(args || {});
    } catch (e) {
      return {
        ok: false,
        error: e && e.message ? e.message : String(e),
      };
    }
  });

  ipcMain.handle('ota-interrupt', async () => {
    return requestOtaInterrupt('user');
  });

  ipcMain.handle('ota-query-device-versions', async (event, args) => {
    try {
      return await queryOtaDeviceVersions(args || {});
    } catch (e) {
      return {
        ok: false,
        error: e && e.message ? e.message : String(e),
        versions: {},
      };
    }
  });

  ipcMain.handle('ota-device-action', async (event, args) => {
    try {
      return await handleOtaDeviceAction(args || {});
    } catch (e) {
      return {
        ok: false,
        target: args && args.target ? args.target : '',
        action: args && args.action ? args.action : '',
        error: e && e.message ? e.message : String(e),
      };
    }
  });
}

module.exports = { registerOtaIpc };
