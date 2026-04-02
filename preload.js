// preload.js
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
  getSubnets: () => ipcRenderer.invoke('getSubnets'),
  listSerialPorts: () => ipcRenderer.invoke('list-serial-ports'),
  probeSerialPort: (opts) => ipcRenderer.invoke('probe-serial-port', opts),
  // scanPorts removed per requirement (not exposed)
  scanIPs: (opts) => ipcRenderer.invoke('scan-ips', opts),
  connectWS: (opts) => ipcRenderer.invoke('connect-ws', opts),
  disconnectWS: (opts) => ipcRenderer.invoke('disconnect-ws', opts),
  updateConfig: (opts) => ipcRenderer.invoke('update-config', opts),
  broadcastCmd: (cmdObj) => ipcRenderer.send('broadcast-cmd', JSON.stringify(cmdObj)),
  sendWSCommand: (opts) => ipcRenderer.send('send-ws-command', opts),
  saveRecordingFiles: (opts) => ipcRenderer.invoke('save-recording-files', opts),
  openFile: (filePath) => ipcRenderer.send('open-file', filePath),
  openFolder: (folderPath) => ipcRenderer.send('open-folder', folderPath),
  listConnections: () => ipcRenderer.invoke('list-connections'),
  getHostIPForSubnet: (args) => ipcRenderer.invoke('getHostIPForSubnet', args),
  cancelScan: () => ipcRenderer.invoke('cancel-scan'),
  onWSScanProgress: (cb) => ipcRenderer.on('ws-scan-progress', (e, d) => cb(d)),
  onWSScanResult: (cb) => ipcRenderer.on('ws-scan-result', (e, d) => cb(d)),
  onPortScanUpdate: (cb) => ipcRenderer.on('port-scan-update', (e, d) => cb(d)), // kept but unused
  onWSMessage: (cb) => ipcRenderer.on('ws-message', (e, d) => cb(d)),
  openUrl: (url) => ipcRenderer.send('open-url', url),
  getRuntimeStats: () => ipcRenderer.invoke('get-runtime-stats'),
});
