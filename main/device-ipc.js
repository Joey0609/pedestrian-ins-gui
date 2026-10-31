'use strict';

// WSManager is injected: registrations never create connections on their own.
function forwardDeviceEvents({ wsMgr, safeSendToRenderer }) {
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
}

function registerDeviceIpc({ ipcMain, wsMgr }) {
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
}

module.exports = { forwardDeviceEvents, registerDeviceIpc };
