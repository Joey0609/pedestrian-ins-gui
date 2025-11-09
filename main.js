// main.js
const { app, BrowserWindow, ipcMain, Menu } = require('electron');
const path = require('path');
const { WSManager } = require('./src/wsManager');

let mainWin;
let wsMgr;
function createWindow() {
  mainWin = new BrowserWindow({
    width: 1280,
    height: 860,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      nodeIntegration: false,
      contextIsolation: true
    }
  });

  mainWin.loadFile('renderer/index.html');
  Menu.setApplicationMenu(null);
  mainWin.webContents.openDevTools();
}

app.whenReady().then(() => {
  wsMgr = new WSManager();

  wsMgr.on('scan-progress', (data) => {
    if (mainWin && mainWin.webContents) mainWin.webContents.send('ws-scan-progress', data);
  });
  wsMgr.on('scan-result', (data) => {
    if (mainWin && mainWin.webContents) mainWin.webContents.send('ws-scan-result', data);
  });

  // forward ws messages (IMU / device info) to renderer
  wsMgr.on('ws-message', (data) => {
    if (mainWin && mainWin.webContents) mainWin.webContents.send('ws-message', data);
  });


  // IPCs
  ipcMain.handle('getSubnets', async () => {
    return wsMgr.getLocalSubnets();
  });

  ipcMain.handle('scan-ips', async (event, args) => {
    return await wsMgr.scanIPs(args.ips, args.timeout || 800, args.concurrency || 40);
  });

  ipcMain.handle('connect-ws', async (event, args) => {
    return await wsMgr.connect(args.ip);
  });

  ipcMain.handle('disconnect-ws', async (event, args) => {
    return await wsMgr.disconnect(args.ip);
  });

  ipcMain.handle('update-config', async (event, args) => {
    return await wsMgr.updateDevicesConfig(args.ips, args.hostIp, args.portMap || {});
  });

  ipcMain.handle('list-connections', () => {
    return wsMgr.listConnections();
  });

  ipcMain.handle('getHostIPForSubnet', async (event, args) => {
    // args = { base, cidr, ifname? }
    return await wsMgr.getHostIPForSubnet(args);
  });

  ipcMain.handle('cancel-scan', (event, args) => {
    wsMgr.cancelScan();
    return true;
  });

  ipcMain.on('broadcast-cmd', (event, args) => {
    try {
      wsMgr.broadcast(JSON.parse(args));
    } catch (e) { }
  });

  createWindow();
});

app.on('window-all-closed', function () {
  if (process.platform !== 'darwin') app.quit();
});
