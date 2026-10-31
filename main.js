// Electron composition root: services own their state; IPC modules own their contracts.
const { app, BrowserWindow, ipcMain, shell, dialog } = require('electron');
const { autoUpdater } = require('electron-updater');
const { WSManager } = require('./src/wsManager');
const { createWindowService } = require('./main/window');
const { createUpdateService } = require('./main/updates');
const { createRuntimeStats } = require('./main/runtime-stats');
const { createOtaService } = require('./main/ota/service');
const { forwardDeviceEvents, registerDeviceIpc } = require('./main/device-ipc');
const { registerCalibrationIpc } = require('./main/calibration');
const { registerOtaIpc } = require('./main/ota/ipc');
const { registerFileIpc } = require('./main/files');

const rootDir = __dirname;
const windowService = createWindowService({ BrowserWindow, rootDir });
const { safeSendToRenderer, getWindow } = windowService;
const getRuntimeStats = createRuntimeStats();

app.whenReady().then(() => {
  // Match electron-builder's appId so Windows groups the branded app correctly.
  if (process.platform === 'win32') app.setAppUserModelId('com.walkingjourney.app');
  const wsMgr = new WSManager();
  const updates = createUpdateService({ app, autoUpdater, safeSendToRenderer });
  updates.setupApplicationUpdates();
  forwardDeviceEvents({ wsMgr, safeSendToRenderer });

  const ota = createOtaService({ wsMgr, safeSendToRenderer });
  updates.registerIpc(ipcMain);
  registerCalibrationIpc({ ipcMain });
  registerDeviceIpc({ ipcMain, wsMgr });
  registerOtaIpc({ ipcMain, dialog, getWindow, ota });
  ipcMain.handle('get-runtime-stats', () => {
    return getRuntimeStats();
  });
  registerFileIpc({ ipcMain, shell, rootDir });

  windowService.createWindow();
});

app.on('window-all-closed', function () {
  if (process.platform !== 'darwin') app.quit();
});
