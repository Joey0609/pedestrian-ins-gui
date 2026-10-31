import { isIPv4Address } from './utils.js';
import { modalCloseButton } from './dialogs.js';

export function createDevices({ electronAPI, attitude, tracks, recording, dialogs, showNotification }) {
let connections = [];
let currentPage = 'attitude';

function getTransportTypeById(id) {
  const conn = connections.find((c) => c.ip === id);
  if (conn && conn.type) return conn.type;
  return isIPv4Address(id) ? 'ws' : 'serial';
}

// ---------------- Tab Slider Animation ----------------
function updateTabSlider() {
  const container = document.querySelector('.tab-container');
  const slider = document.querySelector('.tab-slider');
  const activeTab = container?.querySelector('.page-tab.active, .device-tab.active');
  
  if (!container || !slider || !activeTab) return;
  
  const containerRect = container.getBoundingClientRect();
  const tabRect = activeTab.getBoundingClientRect();
  
  slider.style.left = (tabRect.left - containerRect.left) + 'px';
  slider.style.top = (tabRect.top - containerRect.top) + 'px';
  slider.style.width = tabRect.width + 'px';
  slider.style.height = tabRect.height + 'px';
}

function showDisconnectModal() {
  const html = `
    <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:16px">
      <h3 style="margin:0">断开设备连接</h3>
      ${modalCloseButton('closeDisconnectX')}
    </div>
    <div id="device-list" style="max-height:300px;overflow-y:auto">
      ${connections.map(conn => `
        <div class="device-disconnect-item" data-ip="${conn.ip}" style="display:flex;align-items:center;justify-content:space-between;padding:12px;margin-bottom:8px;background:#f5f7fb;border-radius:8px;cursor:pointer;transition:all 0.2s">
          <div style="display:flex;align-items:center;gap:10px">
            <div style="width:10px;height:10px;background:#22c55e;border-radius:50%"></div>
            <span style="font-weight:500">${conn.ip}</span>
          </div>
          <button class="disconnect-single danger" data-ip="${conn.ip}" style="padding:6px 12px;font-size:12px">断开</button>
        </div>
      `).join('')}
    </div>
    <div style="display:flex;gap:8px;margin-top:16px">
      <button id="disconnect-all" class="danger" style="flex:1">断开所有设备</button>
      <button id="close-disconnect" class="secondary" style="flex:1">取消</button>
    </div>
  `;
  dialogs.show(html);
  
  // Close button
  dialogs.content.querySelector('#closeDisconnectX').addEventListener('click', dialogs.hide);
  dialogs.content.querySelector('#close-disconnect').addEventListener('click', dialogs.hide);
  
  // Disconnect single device
  dialogs.content.querySelectorAll('.disconnect-single').forEach(btn => {
    btn.addEventListener('click', async (e) => {
      e.stopPropagation();
      const ip = btn.dataset.ip;
      await disconnectDevice(ip);
      // Refresh modal
      if (connections.length > 0) {
        showDisconnectModal();
      } else {
        dialogs.hide();
      }
    });
  });
  
  // Disconnect all
  dialogs.content.querySelector('#disconnect-all').addEventListener('click', async () => {
    const ips = [...connections.map(c => c.ip)];
    for (const ip of ips) {
      await disconnectDevice(ip);
    }
    dialogs.hide();
    showNotification('已断开所有设备', 'success');
  });
}

async function disconnectDevice(ip) {
  try {
    await electronAPI.disconnectWS({ ip });
    
    // Remove from connections array
    const idx = connections.findIndex(c => c.ip === ip);
    if (idx >= 0) {
      connections.splice(idx, 1);
    }
    
    // Clean up 3D renderer for this device
    attitude.disposeDeviceRenderer(ip);
    
    // Remove from tracks
    tracks.removeDevice(ip);
    
    // Remove device tab
    const deviceTab = document.querySelector(`.device-tab[data-ip="${ip}"]`);
    if (deviceTab) {
      deviceTab.remove();
    }
    
    // Remove device page (iframe)
    removeDevicePage(ip);
    
    // If current page is this device, switch to attitude
    if (currentPage === ip) {
      switchToPage('attitude');
    } else {
      updateTabSlider();
    }
    
    // Update connection count
    updateConnectionCount();
    
    // Rebuild grid
    attitude.layoutGrid(true);
    
    showNotification(`已断开 ${ip}`, 'success');
  } catch (e) {
    console.error('Disconnect error:', e);
    showNotification(`断开 ${ip} 失败`, 'error');
  }
}

function isConnectionOpen(conn) {
  return !!conn && conn.state === 'open';
}

function syncDeviceConnection(ip) {
  const conn = connections.find(item => item.ip === ip);
  const connected = isConnectionOpen(conn);
  const tab = [...document.querySelectorAll('.device-tab')].find(item => item.dataset.ip === ip);
  if (tab) {
    tab.classList.toggle('is-disconnected', !connected);
    tab.dataset.connected = String(connected);
    tab.setAttribute('aria-label', `${ip}，${connected ? '已连接' : '未连接'}`);
    const dot = tab.querySelector('.status-dot');
    if (dot) dot.title = connected ? '已连接' : '未连接';
  }
  const iframe = [...document.querySelectorAll('.device-iframe')].find(item => item.dataset.ip === ip);
  const transport = conn?.type || getTransportTypeById(ip);
  iframe?.contentWindow?.postMessage({ type: 'imu-connection-state', ip, connected, transport }, '*');
}

function updateConnectionCount() {
  const countEl = document.getElementById('connection-count');
  if (countEl) {
    countEl.textContent = `${connections.length} 台设备`;
  }
}

function switchToPage(page) {
  const prevPage = currentPage;

  // Reclaim memory: when leaving a device detail page, destroy its iframe page.
  if (prevPage && prevPage !== page && prevPage !== 'attitude' && prevPage !== 'track') {
    removeDevicePage(prevPage);
  }

  currentPage = page;
  
  // Update page-tab active states
  document.querySelectorAll('.page-tab').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.page === page);
  });
  
  // Update device-tab active states
  document.querySelectorAll('.device-tab').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.ip === page);
  });
  
  // Show/hide pages
  document.querySelectorAll('.page').forEach(p => p.classList.remove('active'));
  document.querySelectorAll('.device-page').forEach(p => p.classList.remove('active'));
  
  if (page === 'attitude') {
    document.getElementById('page-device-attitude').classList.add('active');
  } else if (page === 'track') {
    document.getElementById('page-device-track').classList.add('active');
  } else {
    // Device-specific page - show imupage iframe
    showDevicePage(page);
  }
  
  updateTabSlider();
  if (page === 'attitude') {
    attitude.layoutGrid(true);
  }
}

// Create and show device detail page with embedded imupage
function showDevicePage(ip) {
  const container = document.getElementById('device-pages-container');
  if (!container) return;
  // Check if page already exists
  let devicePage = container.querySelector(`[data-device-ip="${ip}"]`);
  
  if (!devicePage) {
    // Create new device page
    devicePage = document.createElement('div');
    devicePage.className = 'device-page';
    devicePage.dataset.deviceIp = ip;
    devicePage.innerHTML = `
      <div class="device-page-content">
        <iframe class="device-iframe" data-ip="${ip}" src="../src/imupage.html" sandbox="allow-scripts allow-same-origin allow-forms"></iframe>
      </div>
    `;
    container.appendChild(devicePage);
    const iframe = devicePage.querySelector('.device-iframe');
    iframe.addEventListener('load', () => {
      const connected = isConnectionOpen(connections.find(conn => conn.ip === ip));
      const transport = getTransportTypeById(ip);
      iframe.contentWindow.postMessage({ type: 'imu-device-context', ip, connected, transport }, '*');
      syncDeviceConnection(ip);
    });
  }
  
  // Show this device page
  devicePage.classList.add('active');
}

// Remove device page when disconnecting
function removeDevicePage(ip) {
  const container = document.getElementById('device-pages-container');
  if (!container) return;
  
  const devicePage = container.querySelector(`[data-device-ip="${ip}"]`);
  if (devicePage) {
    devicePage.remove();
  }
}

function addDeviceTab(ip, type = null) {
  const deviceTabs = document.getElementById('device-tabs');
  if (!deviceTabs) return;
  
  // Check if tab already exists
  if (deviceTabs.querySelector(`[data-ip="${ip}"]`)) return;
  const transport = type || getTransportTypeById(ip);
  const tag = transport === 'serial' ? '串口' : 'IP';
  
  const tab = document.createElement('button');
  tab.className = 'device-tab animate-slide-in';
  tab.dataset.ip = ip;
  tab.innerHTML = `
    <span class="status-dot"></span>
    <span>${ip}</span>
    <span class="device-transport-tag">${tag}</span>
    <span class="close-btn" title="断开连接">×</span>
  `;
  
  tab.addEventListener('click', (e) => {
    if (e.target.classList.contains('close-btn')) {
      e.stopPropagation();
      disconnectDevice(ip);
      return;
    }
    switchToPage(ip);
  });
  
  deviceTabs.appendChild(tab);
  syncDeviceConnection(ip);
}

// ---------------- connection / render grid ----------------
let oldLength = 0;
async function listConns() {
  const list = await electronAPI.listConnections();
  connections = (list || []).map((c) => ({ ...c, type: c.type || getTransportTypeById(c.ip) }));

  const tabsRoot = document.getElementById('device-tabs');
  if (tabsRoot) {
    tabsRoot.querySelectorAll('.device-tab').forEach((tab) => {
      const ip = tab.dataset.ip;
      if (!connections.some((c) => c.ip === ip)) {
        tab.remove();
        removeDevicePage(ip);
      }
    });
    connections.forEach((conn) => {
      if (!tabsRoot.querySelector(`[data-ip="${conn.ip}"]`)) {
        addDeviceTab(conn.ip, conn.type);
      }
      syncDeviceConnection(conn.ip);
    });
  }

  if (currentPage !== 'attitude' && currentPage !== 'track' && !connections.some(conn => conn.ip === currentPage)) {
    switchToPage('attitude');
  } else {
    updateTabSlider();
  }
  updateConnectionCount();
  if (oldLength !== connections.length) {
    oldLength = connections.length;
    attitude.layoutGrid(true);
  } else {
    oldLength = connections.length;
    attitude.layoutGrid(false);
  }
}

function bindFrameMessages() {
window.addEventListener('message', (event) => {
  if (event.data && event.data.type === 'imu-command') {
    const command = event.data.command;
    console.log('Received command from iframe:', command);
    
    // Find which device's iframe sent the command
    // Check currentPage to see if we're on a device-specific page
    if (currentPage !== 'attitude' && currentPage !== 'track') {
      // currentPage is an IP address
      const targetIp = currentPage;
      console.log(`Sending command to specific device: ${targetIp}`, command);
      electronAPI.sendWSCommand({ ip: targetIp, cmd: command });
    } else {
      // Fallback: broadcast to all devices (shouldn't happen with iframe)
      console.log('Broadcasting command to all devices:', command);
      electronAPI.broadcastCmd(command);
    }
  }
  if (event.data && event.data.type === 'imu-confirm-reset-request') {
    const frame = [...document.querySelectorAll('.device-iframe')].find(item => item.contentWindow === event.source && item.dataset.ip === currentPage);
    const sensor = Number(event.data.sensor);
    if (!frame || !Number.isInteger(sensor) || sensor < 0 || sensor > 4) return;
    const requestId = event.data.requestId;
    dialogs.showConfirmation('重置标定参数', `确定将传感器 ${sensor} 的标定参数重置为默认值吗？`, '重置', (confirmed) => {
      event.source?.postMessage({ type: 'imu-confirm-reset-response', requestId, confirmed }, '*');
    });
  }
  if (event.data && event.data.type === 'imu-calibration-request') {
    if (currentPage === 'attitude' || currentPage === 'track') return;
    electronAPI.imuCalibrationRequest({ ...event.data.request, ip: currentPage })
      .then((result) => event.source.postMessage({
        type: 'imu-calibration-response', requestId: event.data.requestId, result,
      }, '*'))
      .catch((error) => event.source.postMessage({
        type: 'imu-calibration-response', requestId: event.data.requestId, result: { ok: false, error: error.message },
      }, '*'));
  }
});
}

function start() {
setTimeout(updateTabSlider, 100);
window.addEventListener('resize', updateTabSlider);
// Device labels (including the hover close control) can resize or shift the active tab.
if (window.ResizeObserver) {
  const observer = new window.ResizeObserver(updateTabSlider);
  const container = document.querySelector('.tab-container');
  const deviceTabs = document.getElementById('device-tabs');
  if (container) observer.observe(container);
  if (deviceTabs) observer.observe(deviceTabs);
}
document.querySelectorAll('.page-tab').forEach(btn => {
  btn.addEventListener('click', () => {
    const page = btn.dataset.page;
    switchToPage(page);
  });
});
electronAPI.onWSMessage((msg) => {
  // msg: { ip, msg }
  // find connection and attach lastMsg so UI grid updates
  const idx = connections.findIndex(c => c.ip === msg.ip);
  let isNew = false;
  const sourceType = msg.source || getTransportTypeById(msg.ip);
  if (idx >= 0) {
    connections[idx].lastMsg = msg.msg;
    if (!connections[idx].type) connections[idx].type = sourceType;
  } else {
    // push if not present
    connections.push({ ip: msg.ip, state: 'open', lastMsg: msg.msg, connSettings: msg.connSettings || null, type: sourceType });
    isNew = true;
    // Add device tab for new connection
    addDeviceTab(msg.ip, sourceType);
    updateConnectionCount();
  }
  // if IMU normal data, push to connection and will be used for attitude rendering
  let ip = msg.ip;
  let data = msg.msg;

  
  if (data && typeof data.data === 'string' && Number(data.ts) > 4) {
    const decoded = window.IMUDataProcessor.decodeIMUData(data);
    if (decoded) Object.assign(data, decoded);
  }

  // 在数据解码/合并之后再更新网格，确保姿态模型读取到最新 quat
  attitude.layoutGrid(isNew);
  
  // Record data if recording is active
  if (recording.isRecording() && data.timestamp) {
    recording.recordIMUData(ip, data);
  }
  
  // Forward data to device page iframe if exists
  const deviceIframe = document.querySelector(`.device-iframe[data-ip="${ip}"]`);
  if (deviceIframe && deviceIframe.contentWindow) {
    try {
      deviceIframe.contentWindow.postMessage({
        type: 'imu-data',
        ip: ip,
        transport: sourceType,
        data: data
      }, '*');
    } catch (e) {
      console.warn('Failed to post message to iframe:', e);
    }
  }
  
  tracks.recordPosition(ip, data);
  
});
}

function startPolling() {
setInterval(listConns, 1000);
}

return { bindFrameMessages, start, startPolling, listConns, disconnectDevice, showDisconnectModal, getTransportTypeById, switchToPage, getConnections: () => connections, getCurrentPage: () => currentPage };
}
