// main.js
const { app, BrowserWindow, ipcMain, shell} = require('electron');
const path = require('path');
const fs = require('fs');
const { WSManager } = require('./src/wsManager');

let mainWin;
let wsMgr;
let lastCpuSample = process.cpuUsage();
let lastCpuSampleAt = process.hrtime.bigint();

function safeSendToRenderer(channel, payload) {
  try {
    if (!mainWin || mainWin.isDestroyed()) return;
    if (!mainWin.webContents || mainWin.webContents.isDestroyed()) return;
    mainWin.webContents.send(channel, payload);
  } catch (e) {
    console.warn(`[main] safeSendToRenderer failed on ${channel}:`, e && e.message ? e.message : e);
  }
}

function getRuntimeStats() {
  const now = process.hrtime.bigint();
  const cpu = process.cpuUsage();
  const elapsedMicros = Number(now - lastCpuSampleAt) / 1000;
  const usedMicros = (cpu.user - lastCpuSample.user) + (cpu.system - lastCpuSample.system);
  const cpuPercent = elapsedMicros > 0 ? (usedMicros / elapsedMicros) * 100 : 0;

  lastCpuSample = cpu;
  lastCpuSampleAt = now;

  const mem = process.memoryUsage();
  return {
    memory: {
      rss: mem.rss,
      heapTotal: mem.heapTotal,
      heapUsed: mem.heapUsed,
      external: mem.external,
    },
    cpu: {
      percent: cpuPercent,
    },
  };
}

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
  // Menu.setApplicationMenu(null);
  // mainWin.webContents.openDevTools();
}

app.whenReady().then(() => {
  wsMgr = new WSManager();

  wsMgr.on('scan-progress', (data) => {
    safeSendToRenderer('ws-scan-progress', data);
  });
  wsMgr.on('scan-result', (data) => {
    safeSendToRenderer('ws-scan-result', data);
  });

  // forward ws messages (IMU / device info) to renderer
  wsMgr.on('ws-message', (data) => {
    safeSendToRenderer('ws-message', data);
  });


  // IPCs
  ipcMain.handle('getSubnets', async () => {
    return wsMgr.getLocalSubnets();
  });

  ipcMain.handle('list-serial-ports', async () => {
    return await wsMgr.listSerialPorts();
  });

  ipcMain.handle('probe-serial-port', async (event, args) => {
    return await wsMgr.probeSerialPort(args || {});
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

  ipcMain.handle('get-runtime-stats', () => {
    return getRuntimeStats();
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
  
  ipcMain.on('send-ws-command', (event, args) => {
    try {
      const { ip, cmd } = args;
      wsMgr.sendToDevice(ip, cmd);
    } catch (e) {
      console.error('send-ws-command error:', e);
    }
  });
  
  ipcMain.on('open-url', (event, url) => {
    shell.openExternal(url);
  });
  
  // Save recording files
  ipcMain.handle('save-recording-files', async (event, { files }) => {
    try {
      const dataLoggerPath = path.join(__dirname, 'dataLogger');
      if (!fs.existsSync(dataLoggerPath)) {
        fs.mkdirSync(dataLoggerPath, { recursive: true });
      }
      
      const savedFiles = [];
      for (const file of files) {
        const filePath = path.join(dataLoggerPath, file.name);
        fs.writeFileSync(filePath, file.content, 'utf8');
        savedFiles.push({
          name: file.name,
          path: filePath,
          folder: dataLoggerPath
        });
      }
      return { success: true, files: savedFiles };
    } catch (e) {
      console.error('save-recording-files error:', e);
      return { success: false, error: e.message };
    }
  });
  
  // Open file in default application
  ipcMain.on('open-file', (event, filePath) => {
    shell.openPath(filePath);
  });
  
  // Open folder in file explorer
  ipcMain.on('open-folder', (event, folderPath) => {
    shell.showItemInFolder(folderPath);
  });
  
  createWindow();
});

app.on('window-all-closed', function () {
  if (process.platform !== 'darwin') app.quit();
});

