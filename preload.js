// preload.js
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
  getSubnets: () => ipcRenderer.invoke('getSubnets'),
  // scanPorts removed per requirement (not exposed)
  startUDPListen: (opts) => ipcRenderer.invoke('start-udp-listen', opts).catch(() => { }), // kept safe though not used
  stopUDPListen: (opts) => ipcRenderer.invoke('stop-udp-listen', opts).catch(() => { }),
  scanIPs: (opts) => ipcRenderer.invoke('scan-ips', opts),
  connectWS: (opts) => ipcRenderer.invoke('connect-ws', opts),
  disconnectWS: (opts) => ipcRenderer.invoke('disconnect-ws', opts),
  detectAndMatch: (opts) => ipcRenderer.invoke('detect-and-match', opts),
  updateConfig: (opts) => ipcRenderer.invoke('update-config', opts),
  broadcastCmd: (cmdObj) => ipcRenderer.send('broadcast-cmd', JSON.stringify(cmdObj)),
  listConnections: () => ipcRenderer.invoke('list-connections'),
  getHostIPForSubnet: (args) => ipcRenderer.invoke('getHostIPForSubnet', args),
  cancelScan: () => ipcRenderer.invoke('cancel-scan'),
  onUDPPosition: (cb) => ipcRenderer.on('udp-position', (e, d) => cb(d)),
  onWSScanProgress: (cb) => ipcRenderer.on('ws-scan-progress', (e, d) => cb(d)),
  onWSScanResult: (cb) => ipcRenderer.on('ws-scan-result', (e, d) => cb(d)),
  onPortScanUpdate: (cb) => ipcRenderer.on('port-scan-update', (e, d) => cb(d)), // kept but unused
  onWSMessage: (cb) => ipcRenderer.on('ws-message', (e, d) => cb(d)),
  onMatchedStartedUDP: (cb) => ipcRenderer.on('matched-started-udp', (e, d) => cb(d))
});
