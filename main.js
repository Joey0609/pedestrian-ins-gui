// main.js
const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('path');
const { UDPManager } = require('./src/udpManager');
const { WSManager } = require('./src/wsManager');

let mainWin;
let udpMgr;
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
  // mainWin.webContents.openDevTools();
}

app.whenReady().then(() => {
  udpMgr = new UDPManager();
  wsMgr = new WSManager();

  udpMgr.on('position', (data) => {
    if (mainWin && mainWin.webContents) mainWin.webContents.send('udp-position', data);
  });

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

  // when a device has matched (udp settings pointing to our host and in-range port), start UDP listen
  wsMgr.on('matched', (data) => {
    // data = { ip, port }
    if (data && data.port) {
      try {
        udpMgr.startListening(Number(data.port));
        if (mainWin && mainWin.webContents) mainWin.webContents.send('matched-started-udp', data);
      } catch (e) {
        console.warn('failed to start udp listen for matched device', e);
      }
    }
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

  ipcMain.handle('detect-and-match', async (event, args) => {
    const hostIp = args.hostIp;
    const portRange = args.portRange || { start: 9001, end: 9100 };
    return await wsMgr.detectAndMatch(hostIp, portRange);
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
