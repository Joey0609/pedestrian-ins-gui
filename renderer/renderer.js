// renderer.js

// Relative URLs remain resolvable when the renderer is loaded via file:// in
// the packaged Electron application.
import * as THREE from '../node_modules/three/build/three.module.js';
import { OrbitControls } from '../node_modules/three/examples/jsm/controls/OrbitControls.js';
import { OBJLoader } from '../node_modules/three/examples/jsm/loaders/OBJLoader.js';
import { MTLLoader } from '../node_modules/three/examples/jsm/loaders/MTLLoader.js';

const electronAPI = window.electronAPI;

// Load shared IMU data processor
const imuProcessorScript = document.createElement('script');
imuProcessorScript.src = '../src/imuDataProcessor.js';
document.head.appendChild(imuProcessorScript);

let PCBModelGlobal = null; // cached loaded model/group

let rendererMap = new Map();

async function loadPCBModelOnce() {
  if (PCBModelGlobal) return PCBModelGlobal;
  try {
    console.log('Loading PCB model...');
    // compute a URL relative to the current index.html
    const modelUrl = new URL('../assets/models/PCBmodel.obj', window.location.href).href;
    const objAbsUrl = modelUrl;
    const basePathAbs = objAbsUrl.substring(0, objAbsUrl.lastIndexOf('/') + 1);
    const mtlFilename = modelUrl.substring(modelUrl.lastIndexOf('/') + 1).replace(/\.obj$/i, '.mtl');

    const mtlLoader = new MTLLoader();
    mtlLoader.setPath(basePathAbs);
    mtlLoader.setResourcePath(basePathAbs);

    try {
      const materials = await new Promise((resolve, reject) => {
        mtlLoader.load(mtlFilename, resolve, undefined, () => reject(new Error('MTL not found')));
      });
      materials.preload();
      const objLoader = new OBJLoader();
      objLoader.setMaterials(materials);
      const obj = await new Promise((resolve, reject) => {
        objLoader.load(modelUrl, resolve, undefined, reject);
      });
      // traverse to compute normals if missing
      obj.traverse((c) => {
        if (c.isMesh && c.geometry && !c.geometry.attributes.normal && typeof c.geometry.computeVertexNormals === 'function') {
          c.geometry.computeVertexNormals();
        }
      });
      PCBModelGlobal = obj;
      return PCBModelGlobal;
    } catch (err) {
      console.info('MTL load failed or not present, falling back to plain OBJ. tried=', basePathAbs + mtlFilename);
    }

    // fallback to plain OBJ
    const objLoader = new OBJLoader();
    const obj = await new Promise((resolve, reject) => {
      objLoader.load(modelUrl, resolve, undefined, reject);
    });
    applyDefaultMaterial(obj);
    PCBModelGlobal = obj;
    return PCBModelGlobal;
  } catch (e) {
    console.warn('loadPCBModelOnce error:', e);
    return null;
  }
}

function applyDefaultMaterial(obj) {
  obj.traverse((child) => {
    if (child.isMesh) {
      if (!child.material || (Array.isArray(child.material) && child.material.length === 0)) {
        child.material = new THREE.MeshStandardMaterial({ color: 0x8fbcd4, metalness: 0.3, roughness: 0.4 });
      } else {
        // ensure material has color if applicable
        if (child.material && child.material.color) child.material.color.set(0x8fbcd4);
      }
      if (child.geometry && !child.geometry.attributes.normal && typeof child.geometry.computeVertexNormals === 'function') {
        child.geometry.computeVertexNormals();
      }
    }
  });
}


let recording = false;
let ins_writing = false;
let connections = [];
let tracks = {};
let trackColors = {};
let trackVisible = {};
let replaying = false;
let scanState = null;
let drawGrid = null;
let modalContent = null;
let hostIp = null;
let scanAbortRequested = false;
let currentPage = 'attitude'; // 'attitude', 'track', or device IP
const SERIAL_SCAN_MAX_CONCURRENCY = 8;

let otaUiState = {
  modalOpen: false,
  running: false,
  filePath: '',
  firmware: null,
  progressMap: {},
  versionMap: {},
};

// Recording data storage
let recordingData = {}; // { ip: { sensorIndex: [rows...] } }
let recordingCount = 0;
let recordingStartTime = null;

// IMU sensor configuration
const BMI088_NUM = 4; // 0..3 actual sensors, 4 is combined/average

// Performance optimization constants
const MAX_TRACK_POINTS = 12000; // Maximum points per track to prevent memory issues
const MIN_TRACK_POINT_DISTANCE = 0.03; // Only store new point if distance to previous point is greater than 3cm
const DRAW_THROTTLE_MS = 50; // Throttle canvas redraw
const LEGEND_THROTTLE_MS = 500; // Throttle legend updates

// Throttle helper
function throttle(func, limit) {
  let inThrottle;
  return function(...args) {
    if (!inThrottle) {
      func.apply(this, args);
      inThrottle = true;
      setTimeout(() => inThrottle = false, limit);
    }
  };
}

// Throttled versions of expensive functions
let throttledDrawTracks = null;
let throttledUpdateLegend = null;

const runtimeMemoryEl = document.getElementById('runtime-memory');
const runtimeCpuEl = document.getElementById('runtime-cpu');
const runtimeCacheEl = document.getElementById('runtime-cache');

function formatBytes(bytes) {
  if (!Number.isFinite(bytes)) return '--';
  const mb = bytes / (1024 * 1024);
  return `${mb.toFixed(mb >= 100 ? 0 : 1)} MB`;
}

function formatBytesSmart(bytes) {
  if (!Number.isFinite(bytes) || bytes < 0) return '--';
  if (bytes < 1024) return `${Math.round(bytes)} B`;
  const kb = bytes / 1024;
  if (kb < 1024) return `${kb.toFixed(kb >= 100 ? 0 : 1)} KB`;
  const mb = kb / 1024;
  if (mb < 1024) return `${mb.toFixed(mb >= 100 ? 0 : 1)} MB`;
  const gb = mb / 1024;
  return `${gb.toFixed(gb >= 100 ? 0 : 1)} GB`;
}

function formatBytesForOta(bytes) {
  if (!Number.isFinite(bytes) || bytes < 0) return '--';
  const kb = bytes / 1024;
  if (kb < 1024) return `${kb.toFixed(1)} KB`;
  return `${(kb / 1024).toFixed(2)} MB`;
}

function escapeHtml(text) {
  return String(text || '').replace(/[&<>"']/g, (ch) => {
    const map = {
      '&': '&amp;',
      '<': '&lt;',
      '>': '&gt;',
      '"': '&quot;',
      "'": '&#39;',
    };
    return map[ch] || ch;
  });
}

function otaRowKey(target) {
  return encodeURIComponent(String(target || ''));
}

function estimateValueBytes(value, seen, state) {
  if (value === null || value === undefined) return 0;

  const valueType = typeof value;
  if (valueType === 'string') return value.length * 2;
  if (valueType === 'number') return 8;
  if (valueType === 'boolean') return 4;
  if (valueType === 'bigint') return 8;
  if (valueType === 'function' || valueType === 'symbol') return 0;

  if (seen.has(value)) return 0;
  seen.add(value);

  state.nodes += 1;
  if (state.nodes > state.maxNodes) {
    state.truncated = true;
    return 0;
  }

  if (ArrayBuffer.isView(value)) {
    return value.byteLength || 0;
  }
  if (value instanceof ArrayBuffer) {
    return value.byteLength || 0;
  }
  if (value instanceof Date) {
    return 8;
  }

  let total = 0;

  if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i++) {
      total += estimateValueBytes(value[i], seen, state);
      if (state.truncated) break;
    }
    return total;
  }

  if (value instanceof Map) {
    for (const [k, v] of value.entries()) {
      total += estimateValueBytes(k, seen, state);
      total += estimateValueBytes(v, seen, state);
      if (state.truncated) break;
    }
    return total;
  }

  if (value instanceof Set) {
    for (const item of value.values()) {
      total += estimateValueBytes(item, seen, state);
      if (state.truncated) break;
    }
    return total;
  }

  const keys = Object.keys(value);
  for (let i = 0; i < keys.length; i++) {
    const key = keys[i];
    total += key.length * 2;
    total += estimateValueBytes(value[key], seen, state);
    if (state.truncated) break;
  }
  return total;
}

function estimateThreeObjectBytes(root) {
  if (!root || typeof root.traverse !== 'function') return 0;

  let total = 0;
  const seenGeometry = new Set();
  const seenTextures = new Set();

  root.traverse((obj) => {
    if (!obj || !obj.isMesh) return;

    const geometry = obj.geometry;
    if (geometry && !seenGeometry.has(geometry)) {
      seenGeometry.add(geometry);
      const attrs = geometry.attributes || {};
      for (const attrName of Object.keys(attrs)) {
        const attr = attrs[attrName];
        if (attr && attr.array && Number.isFinite(attr.array.byteLength)) {
          total += attr.array.byteLength;
        }
      }

      if (geometry.index && geometry.index.array && Number.isFinite(geometry.index.array.byteLength)) {
        total += geometry.index.array.byteLength;
      }

      const morph = geometry.morphAttributes || {};
      for (const morphName of Object.keys(morph)) {
        const list = morph[morphName] || [];
        for (let i = 0; i < list.length; i++) {
          const attr = list[i];
          if (attr && attr.array && Number.isFinite(attr.array.byteLength)) {
            total += attr.array.byteLength;
          }
        }
      }
    }

    const materials = Array.isArray(obj.material) ? obj.material : [obj.material];
    for (let i = 0; i < materials.length; i++) {
      const mat = materials[i];
      if (!mat) continue;
      const textureKeys = ['map', 'normalMap', 'roughnessMap', 'metalnessMap', 'emissiveMap', 'alphaMap', 'aoMap', 'displacementMap', 'lightMap', 'specularMap'];
      for (let k = 0; k < textureKeys.length; k++) {
        const tex = mat[textureKeys[k]];
        if (!tex || seenTextures.has(tex)) continue;
        seenTextures.add(tex);
        const image = tex.image || (tex.source && tex.source.data);
        if (image && Number.isFinite(image.width) && Number.isFinite(image.height)) {
          total += image.width * image.height * 4;
        }
      }
    }
  });

  return total;
}

function getRuntimeCacheStats() {
  const state = { nodes: 0, maxNodes: 80000, truncated: false };
  const seen = new WeakSet();
  let total = 0;

  // Data-heavy runtime caches in renderer process.
  total += estimateValueBytes(tracks, seen, state);
  total += estimateValueBytes(trackColors, seen, state);
  total += estimateValueBytes(trackVisible, seen, state);
  total += estimateValueBytes(recordingData, seen, state);
  total += estimateValueBytes(connections, seen, state);
  total += estimateValueBytes(scanState, seen, state);
  total += estimateValueBytes(Array.from(usedColors), seen, state);

  // Explicit model cache (loaded once and reused by cloned instances).
  total += estimateThreeObjectBytes(PCBModelGlobal);

  return {
    bytes: total,
    truncated: state.truncated,
  };
}

async function updateRuntimeStats() {
  if (!window.electronAPI || typeof window.electronAPI.getRuntimeStats !== 'function') return;
  try {
    const stats = await window.electronAPI.getRuntimeStats();
    if (runtimeCacheEl) {
      const cacheStats = getRuntimeCacheStats();
      runtimeCacheEl.textContent = `${formatBytesSmart(cacheStats.bytes)}${cacheStats.truncated ? '+' : ''}`;
    }
    if (runtimeMemoryEl && stats && stats.memory) {
      runtimeMemoryEl.textContent = formatBytes(stats.memory.rss);
    }
    if (runtimeCpuEl && stats && stats.cpu) {
      const cpu = Math.max(0, stats.cpu.percent || 0);
      runtimeCpuEl.textContent = `${cpu.toFixed(cpu >= 10 ? 0 : 1)}%`;
    }
  } catch (e) {
    console.warn('updateRuntimeStats error', e);
  }
}

updateRuntimeStats();
setInterval(updateRuntimeStats, 1000);

// Listen for commands from imupage iframe
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

// Color map
const COLORS = {
  offline: 'red',
  ping: '#FFC107',       // ping ok (橙黄色)
  green: '#00FF00',
  black: '#444444'
};

function isIPv4Address(text) {
  if (typeof text !== 'string') return false;
  return /^(25[0-5]|2[0-4]\d|1?\d?\d)(\.(25[0-5]|2[0-4]\d|1?\d?\d)){3}$/.test(text.trim());
}

function getTransportTypeById(id) {
  const conn = connections.find((c) => c.ip === id);
  if (conn && conn.type) return conn.type;
  return isIPv4Address(id) ? 'ws' : 'serial';
}

// ---------------- Tab Slider Animation ----------------
function updateTabSlider() {
  const container = document.querySelector('.tab-container');
  const slider = document.querySelector('.tab-slider');
  const activeTab = document.querySelector('.page-tab.active');
  
  if (!container || !slider || !activeTab) return;
  
  const containerRect = container.getBoundingClientRect();
  const tabRect = activeTab.getBoundingClientRect();
  
  slider.style.left = (tabRect.left - containerRect.left) + 'px';
  slider.style.width = tabRect.width + 'px';
}

// Initialize tab slider
setTimeout(updateTabSlider, 100);
window.addEventListener('resize', updateTabSlider);

// ---------------- Notification helper ----------------
function showNotification(message, type = 'info') {
  const container = document.getElementById('notificationContainer');
  const notification = document.createElement('div');
  notification.className = `notification ${type}`;
  notification.textContent = message;
  container.appendChild(notification);
  setTimeout(() => {
    notification.classList.add('show');
  }, 10);
  setTimeout(() => {
    notification.classList.remove('show');
    setTimeout(() => {
      container.removeChild(notification);
    }, 400);
  }, 3000);
}

// ---------------- Application update modal ----------------
const appUpdateUi = { open: false, version: '', currentVersion: '', notes: '', stage: 'idle', percent: 0, error: '' };

function updateNotesText(notes) {
  if (Array.isArray(notes)) return notes.map((item) => item && (item.note || item)).join('\n');
  return typeof notes === 'string' ? notes : '';
}

function renderAppUpdateModal() {
  const isDownloading = appUpdateUi.stage === 'downloading';
  const isDownloaded = appUpdateUi.stage === 'downloaded';
  const notes = escapeHtml(appUpdateUi.notes || '本次版本包含功能优化与问题修复。').replace(/\n/g, '<br>');
  const body = isDownloading
    ? `<div style="margin:18px 0 8px;color:#4b5563">正在下载 v${escapeHtml(appUpdateUi.version)}，请勿关闭程序。</div>
       <div style="height:10px;background:#e5e7eb;border-radius:999px;overflow:hidden"><div style="height:100%;width:${Math.max(0, Math.min(100, appUpdateUi.percent))}%;background:linear-gradient(90deg,#2563eb,#06b6d4);transition:width .25s ease"></div></div>
       <div style="margin-top:8px;text-align:right;font-variant-numeric:tabular-nums;color:#2563eb;font-weight:600">${appUpdateUi.percent}%</div>
       ${appUpdateUi.error ? `<div style="margin-top:10px;color:#dc2626">下载失败：${escapeHtml(appUpdateUi.error)}</div>` : ''}`
    : isDownloaded
      ? `<div style="margin:18px 0;color:#166534;line-height:1.7">v${escapeHtml(appUpdateUi.version)} 已下载完成。重启程序后将自动完成安装。</div>`
      : `<div style="margin:12px 0;color:#4b5563">当前版本：<strong>v${escapeHtml(appUpdateUi.currentVersion)}</strong><br>最新版本：<strong style="color:#2563eb">v${escapeHtml(appUpdateUi.version)}</strong></div>
         <div style="margin-top:12px;padding:12px;background:#f5f7fb;border-radius:8px;line-height:1.65;max-height:190px;overflow-y:auto"><div style="font-weight:600;margin-bottom:6px">更新内容</div>${notes}</div>`;
  const actions = isDownloading
    ? ''
    : isDownloaded
      ? `<button id="update-later" class="secondary" style="flex:1">稍后重启</button><button id="update-install" class="primary" style="flex:1">立即重启安装</button>`
      : `<button id="update-later" class="secondary" style="flex:1">暂不更新</button><button id="update-download" class="primary" style="flex:1">下载更新</button>`;
  showModal(`<div style="width:min(500px,88vw)"><div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:8px"><h3 style="margin:0">发现新版本</h3>${isDownloading ? '' : '<button id="update-close" style="background:transparent;color:#666;padding:4px 8px" title="关闭">×</button>'}</div>${body}<div style="display:flex;gap:8px;margin-top:18px">${actions}</div></div>`);
  const close = () => { appUpdateUi.open = false; hideModal(); };
  modalContent.querySelector('#update-close')?.addEventListener('click', close);
  modalContent.querySelector('#update-later')?.addEventListener('click', close);
  modalContent.querySelector('#update-download')?.addEventListener('click', async () => {
    appUpdateUi.stage = 'downloading'; appUpdateUi.percent = 0; appUpdateUi.error = ''; renderAppUpdateModal();
    const result = await electronAPI.downloadAppUpdate();
    if (!result || !result.ok) { appUpdateUi.error = (result && result.error) || '未知错误'; renderAppUpdateModal(); }
  });
  modalContent.querySelector('#update-install')?.addEventListener('click', () => electronAPI.installAppUpdate());
}

// ---------------- Topbar bindings ----------------
document.getElementById('btn-check-update').addEventListener('click', async () => {
  showNotification('正在检查更新…', 'info');
  await electronAPI.checkAppUpdate();
});

electronAPI.onAppUpdateStatus((status) => {
  if (!status) return;
  if (status.state === 'available') {
    Object.assign(appUpdateUi, { open: true, version: status.version || '', currentVersion: status.currentVersion || '', notes: updateNotesText(status.releaseNotes), stage: 'available', percent: 0, error: '' });
    renderAppUpdateModal();
  } else if (status.state === 'latest' && status.manual) {
    showNotification('当前已是最新版本', 'success');
  } else if (status.state === 'downloading' && appUpdateUi.open) {
    appUpdateUi.stage = 'downloading'; appUpdateUi.percent = status.percent || 0; renderAppUpdateModal();
  } else if (status.state === 'downloaded' && appUpdateUi.open) {
    appUpdateUi.stage = 'downloaded'; appUpdateUi.percent = 100; renderAppUpdateModal();
  } else if (status.state === 'error' && appUpdateUi.open && appUpdateUi.stage === 'downloading') {
    appUpdateUi.error = status.message || '未知错误'; renderAppUpdateModal();
  } else if (status.state === 'error' && status.manual) {
    showNotification(`检查更新失败：${status.message || '未知错误'}`, 'warning');
  }
});

document.getElementById('btn-scan-ips').addEventListener('click', async () => {
  try {
    const subnets = await electronAPI.getSubnets();
    // sort: prefer smaller host count -> larger cidr first (e.g., /24 before /23)
    subnets.sort((a, b) => b.cidr - a.cidr);
    showSubnetSelectModalWithMemory(subnets, async (selected) => {
      // get host IP for that subnet using ipconfig
      try {
        scanState.completed = 0;
        hostIp = await electronAPI.getHostIPForSubnet({ base: selected.base, cidr: selected.cidr, ifname: selected.ifname });
      } catch (e) {
        hostIp = selected.addr; // fallback
      }
      const ips = buildScanRangeFromSubnet(selected);
      showModalScanIPs(ips, selected.base + '/' + selected.cidr);
      try {
        if (scanState && scanState.type === 'ips') scanState.running = true;
        scanAbortRequested = false;
        const res = await electronAPI.scanIPs({ ips, timeout: 800, concurrency: 80 });
        finalizeScan('ips', res);
      } catch (e) {
        console.error('scanIPs error', e);
        showNotification('扫描出错: ' + (e && e.message), 'error');
      } finally {
        if (scanState && scanState.type === 'ips') scanState.running = false;
      }
    });
  } catch (e) {
    console.error('getSubnets failed', e);
    alert('获取子网失败: ' + e.message);
  }
});

document.getElementById('btn-scan-serial').addEventListener('click', async () => {
  showSerialScanModal();
});

document.getElementById('btn-ota').addEventListener('click', async () => {
  showOtaModal();
});

// other topbar buttons (unchanged behaviour)
document.getElementById('btn-disconnect').addEventListener('click', async () => {
  // Show disconnect modal with device list
  if (connections.length === 0) {
    showNotification('没有已连接的设备', 'warning');
    return;
  }
  showDisconnectModal();
});

function showDisconnectModal() {
  const html = `
    <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:16px">
      <h3 style="margin:0">断开设备连接</h3>
      <button id="closeDisconnectX" style="background:transparent;color:#666;padding:4px 8px" title="关闭">×</button>
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
  showModal(html);
  
  // Close button
  modalContent.querySelector('#closeDisconnectX').addEventListener('click', hideModal);
  modalContent.querySelector('#close-disconnect').addEventListener('click', hideModal);
  
  // Disconnect single device
  modalContent.querySelectorAll('.disconnect-single').forEach(btn => {
    btn.addEventListener('click', async (e) => {
      e.stopPropagation();
      const ip = btn.dataset.ip;
      await disconnectDevice(ip);
      // Refresh modal
      if (connections.length > 0) {
        showDisconnectModal();
      } else {
        hideModal();
      }
    });
  });
  
  // Disconnect all
  modalContent.querySelector('#disconnect-all').addEventListener('click', async () => {
    const ips = [...connections.map(c => c.ip)];
    for (const ip of ips) {
      await disconnectDevice(ip);
    }
    hideModal();
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
    const rendererEntry = rendererMap.get(ip);
    if (rendererEntry) {
      // Dispose of Three.js resources
      if (rendererEntry.renderer) {
        rendererEntry.renderer.dispose();
      }
      if (rendererEntry.scene) {
        rendererEntry.scene.traverse((obj) => {
          if (obj.geometry) obj.geometry.dispose();
          if (obj.material) {
            if (Array.isArray(obj.material)) {
              obj.material.forEach(mat => mat.dispose());
            } else {
              obj.material.dispose();
            }
          }
        });
      }
      rendererMap.delete(ip);
    }
    
    // Remove from tracks
    if (tracks[ip]) {
      const oldColor = trackColors[ip];
      if (oldColor) usedColors.delete(oldColor);
      delete tracks[ip];
      delete trackColors[ip];
      delete trackVisible[ip];
      if (throttledUpdateLegend) throttledUpdateLegend();
      if (typeof window.drawTracks === 'function') window.drawTracks();
    }
    
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
    }
    
    // Update connection count
    updateConnectionCount();
    
    // Rebuild grid
    layoutGrid(true);
    
    showNotification(`已断开 ${ip}`, 'success');
  } catch (e) {
    console.error('Disconnect error:', e);
    showNotification(`断开 ${ip} 失败`, 'error');
  }
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
    layoutGrid(true);
  }
}

// Create and show device detail page with embedded imupage
function showDevicePage(ip) {
  const container = document.getElementById('device-pages-container');
  if (!container) return;
  const isWebDevice = isIPv4Address(ip);
  
  // Check if page already exists
  let devicePage = container.querySelector(`[data-device-ip="${ip}"]`);
  
  if (!devicePage) {
    // Create new device page
    devicePage = document.createElement('div');
    devicePage.className = 'device-page';
    devicePage.dataset.deviceIp = ip;
    devicePage.innerHTML = `
      <div class="device-page-header">
        <div class="device-page-title">
          <h3>设备详情 - ${ip}</h3>
          <span class="device-status">${isWebDevice ? 'WebSocket 已连接' : '串口已连接'}</span>
        </div>
        <div class="device-page-actions">
          <button class="btn-open-external" title="在浏览器中打开" ${isWebDevice ? '' : 'style="display:none"'}>
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/>
              <polyline points="15 3 21 3 21 9"/>
              <line x1="10" y1="14" x2="21" y2="3"/>
            </svg>
          </button>
          <button class="btn-back secondary">返回姿态页</button>
        </div>
      </div>
      <div class="device-page-content">
        <iframe class="device-iframe" data-ip="${ip}" src="../src/imupage.html" sandbox="allow-scripts allow-same-origin allow-forms"></iframe>
      </div>
    `;
    
    // Add event listeners
    devicePage.querySelector('.btn-back').addEventListener('click', () => {
      switchToPage('attitude');
    });

    if (isWebDevice) {
      devicePage.querySelector('.btn-open-external').addEventListener('click', () => {
        electronAPI.openUrl(`http://${ip}/`);
      });
    }
    
    container.appendChild(devicePage);
    const iframe = devicePage.querySelector('.device-iframe');
    iframe.addEventListener('load', () => {
      iframe.contentWindow.postMessage({ type: 'imu-device-context', ip }, '*');
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

document.getElementById('btn-record').addEventListener('click', () => {
  if (!recording) {
    // Start recording
    startRecording();
  } else {
    // Stop recording and save
    stopRecording();
  }
});

document.getElementById('btn-zero').addEventListener('click', () => {
  electronAPI.broadcastCmd({ cmd: 'setZero' });
  showNotification('Send Zero Heading to All', 'success');
});
document.getElementById('btn-inertial').addEventListener('click', () => {
  const btn = document.getElementById('btn-inertial');
  electronAPI.broadcastCmd({ cmd: 'insZero' });
  showNotification('Send Inertial Reset to All', 'success');
});
document.getElementById('btn-shutdown').addEventListener('click', () => {
  if (confirm('确定要关闭所有设备吗？')) {
    electronAPI.broadcastCmd({ cmd: 'shutdown' });
    showNotification('Send Shutdown Command to All', 'success');
  }

});

// Page tab switching with animation
document.querySelectorAll('.page-tab').forEach(btn => {
  btn.addEventListener('click', () => {
    const page = btn.dataset.page;
    switchToPage(page);
  });
});

// ---------------- Electron event listeners ----------------
electronAPI.onWSScanProgress((data) => {
  if (scanState && scanState.type === 'ips') {
    // updateProgress(data.progress * 100);
  }
});

electronAPI.onWSScanResult((data) => {
  if (scanState && scanState.type === 'ips') {
    const index = scanState.ips.indexOf(data.ip);
    if (index >= 0) {
      let color = COLORS.offline;
      // wsManager now emits status strings: 'offline' (or 'red'), 'ping', 'ws', 'green'
      if (data.status === 'offline' || data.status === 'red') color = COLORS.offline;
      else if (data.status === 'ping') color = COLORS.ping;
      else if (data.status === 'ws' || data.status === 'connectable' || data.status === 'yellowgreen') color = COLORS.ws;
      else if (data.status === 'green' || data.status === 'matched') color = COLORS.green;
      scanState.cells[index].color = color;
      scanState.cells[index].ip = data.ip;
      scanState.completed++;
      const cellElement = scanState.cells[index].elem;
      if (cellElement) {
        cellElement.style.background = color;
      }
      updateProgress(((scanState.completed / scanState.ips.length) * 100)>100?100:((scanState.completed / scanState.ips.length) * 100));
      if (scanState.completed === scanState.ips.length) {
        updateProgress(100);
        addScanButtonsToModal();
      }
    }
  }
});

// WS real-time messages (IMU, configs, etc.)
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
    connections.push({ ip: msg.ip, lastMsg: msg.msg, connSettings: msg.connSettings || null, type: sourceType });
    isNew = true;
    // Add device tab for new connection
    addDeviceTab(msg.ip, sourceType);
    updateConnectionCount();
  }
  // if IMU normal data, push to connection and will be used for attitude rendering
  let ip = msg.ip;
  let data = msg.msg;

  
  // Process Base64 encoded IMU data (similar to imupage.html)
  if (data && data.data && typeof data.data === 'string') {
    try {
      // Decode Base64 data
      const binaryString = atob(data.data);
      const bytes = new Uint8Array(binaryString.length);

      for (let i = 0; i < binaryString.length; i++) {
        bytes[i] = binaryString.charCodeAt(i);
      }

      // Parse binary data using DataView
      const view = new DataView(bytes.buffer);
      let offset = 0;

      // Parse timestamp (8 bytes)
      const timestamp = view.getBigUint64(offset, true); // Little-endian
      offset += 8;

      // Helper: Parse sensor array
      const parseSensorArray = (count, dimensions) => {
        const result = [];
        for (let s = 0; s < count; s++) {
          const sensorData = [];
          for (let d = 0; d < dimensions; d++) {
            sensorData.push(view.getFloat32(offset, true)); // Little-endian
            offset += 4;
          }
          result.push(sensorData);
        }
        return result;
      };

      // Helper: Parse scalar array
      const parseScalarArray = (count) => {
        const result = [];
        for (let i = 0; i < count; i++) {
          result.push(view.getFloat32(offset, true));
          offset += 4;
        }
        return result;
      };

      // Helper: Parse boolean array
      const parseBoolArray = (count) => {
        const result = [];
        for (let i = 0; i < count; i++) {
          result.push(view.getUint8(offset) !== 0);
          offset += 1;
        }
        return result;
      };

      // Parse all IMU data fields
      const imuData = {
        timestamp: Number(timestamp),
        raw_accel: parseSensorArray(BMI088_NUM + 1, 3),
        raw_gyro: parseSensorArray(BMI088_NUM + 1, 3),
        raw_temp: parseScalarArray(BMI088_NUM + 1),
        quat: parseSensorArray(BMI088_NUM + 1, 4),
        rotation_matrix: parseSensorArray(BMI088_NUM + 1, 9),
        eular: parseSensorArray(BMI088_NUM + 1, 3),
        linear_accel: parseSensorArray(BMI088_NUM + 1, 3),
        earth_accel: parseSensorArray(BMI088_NUM + 1, 3),
        kf_accel: parseSensorArray(BMI088_NUM + 1, 3),
        kf_velocity: parseSensorArray(BMI088_NUM + 1, 3),
        displacement: parseSensorArray(BMI088_NUM + 1, 3),
        stationary: parseBoolArray(BMI088_NUM + 1)
      };

      // Merge parsed data into data object
      Object.assign(data, imuData);
    } catch (error) {
      console.error("Base64 decoding failed:", error);
    }
  }

  // 在数据解码/合并之后再更新网格，确保姿态模型读取到最新 quat
  layoutGrid(isNew);
  
  // Record data if recording is active
  if (recording && data.timestamp) {
    recordIMUData(ip, data);
  }
  
  // Forward data to device page iframe if exists
  const deviceIframe = document.querySelector(`.device-iframe[data-ip="${ip}"]`);
  if (deviceIframe && deviceIframe.contentWindow) {
    try {
      deviceIframe.contentWindow.postMessage({
        type: 'imu-data',
        ip: ip,
        data: data
      }, '*');
    } catch (e) {
      console.warn('Failed to post message to iframe:', e);
    }
  }
  
  // Use displacement[0][0:2] (first sensor's x and y) for track data
  // This follows the imupage.html logic where displacement is parsed from Base64 data
  if (data.displacement && Array.isArray(data.displacement) && data.displacement[0]) {
    const displacement = data.displacement[0]; // First sensor
    const x = displacement[0]; // x coordinate
    const y = displacement[1]; // y coordinate
    
    if (typeof x === 'number' && typeof y === 'number' && !isNaN(x) && !isNaN(y)) {
      if (!tracks[ip]) {
        tracks[ip] = [];
        trackColors[ip] = getUniqueRandomColor(ip);
        trackVisible[ip] = true;
        if (throttledUpdateLegend) throttledUpdateLegend();
      }
      const prev = tracks[ip].length > 0 ? tracks[ip][tracks[ip].length - 1] : null;
      const shouldStore = !prev || !isFinite(prev.x) || !isFinite(prev.y)
        || Math.hypot(x - prev.x, y - prev.y) > MIN_TRACK_POINT_DISTANCE;

      if (shouldStore) {
        tracks[ip].push({ x, y, t: Date.now() });
        // Limit track array size to prevent memory issues
        if (tracks[ip].length > MAX_TRACK_POINTS) {
          tracks[ip] = tracks[ip].slice(-MAX_TRACK_POINTS);
        }
        if (throttledDrawTracks) throttledDrawTracks();
      }
    }
  }
  
});

electronAPI.onOtaProgress((event) => {
  if (!event || !event.target) return;
  const prev = otaUiState.progressMap[event.target] || {};
  otaUiState.progressMap[event.target] = { ...prev, ...event };

  if (!otaUiState.modalOpen || !modalContent) return;
  upsertOtaProgressRow(event.target);
  applyOtaProgressToRow(event.target, otaUiState.progressMap[event.target]);
});

// Add device tab to bottom bar
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
    });
  }

  updateConnectionCount();
  if (oldLength !== connections.length) {
    oldLength = connections.length;
    layoutGrid(true);
  } else {
    oldLength = connections.length;
    layoutGrid(false);
  }
}

function layoutGrid(forceRebuild = false) {
  const grid = document.getElementById('grid');
  if (!grid) return;
  const count = connections.length;
  if (count === 0) {
    grid.innerHTML = `
      <div class="card" style="grid-column:1 / -1;display:flex;align-items:center;justify-content:center;min-height:220px;color:#667085;background:#fff;border-radius:8px;box-shadow:0 2px 6px rgba(0,0,0,0.06)">
        当前没有已连接设备
      </div>
    `;
    rendererMap.clear();
    return;
  }
  const rows = Math.ceil(Math.sqrt(count));
  const cols = Math.ceil(count / rows);
  grid.style.gridTemplateColumns = `repeat(${cols}, 1fr)`;
  grid.style.gridTemplateRows = `repeat(${rows}, 1fr)`;
  if (forceRebuild) {
    grid.innerHTML = '';
    rendererMap.clear();
    for (let i = 0; i < count; i++) {
      const conn = connections[i];
      const card = document.createElement('div'); card.className = 'card'; card.style.background = '#fff'; card.style.borderRadius = '8px'; card.style.padding = '8px'; card.style.boxShadow = '0 2px 6px rgba(0,0,0,0.06)'; card.style.height = '100%';
      const title = document.createElement('div'); title.textContent = conn ? conn.ip : ('设备 ' + (i + 1)); title.style.fontWeight = '700'; 
      if (conn && isIPv4Address(conn.ip)) {
        title.style.cursor = 'pointer';
        title.style.color = '#2b6ef6';
        title.addEventListener('click', (e) => {
          const url = `http://${conn.ip}`;
          e.preventDefault();
          electronAPI.openUrl(url);
        });
      } else {
        title.style.color = '#334155';
      }
      card.appendChild(title);
      const threeDiv = document.createElement('div'); threeDiv.style.flex = '1'; threeDiv.style.minHeight = '0'; card.appendChild(threeDiv);
      grid.appendChild(card);
      const entry = createAttitudeRenderer(threeDiv, conn);
      if (conn) {
        rendererMap.set(conn.ip, entry);
      } else {
        rendererMap.set('placeholder_' + i, entry);
      }
    }
  } else {
    connections.forEach((conn, i) => {
      const key = conn ? conn.ip : 'placeholder_' + i;
      const entry = rendererMap.get(key);
      if (entry && entry.model) {
        updateModelFromConn(entry.model, conn);
      }
    });
  }
}
function updateModelFromConn(model, conn) {
  if (conn && conn.lastMsg && conn.lastMsg.quat) {
    try {
      let q = conn.lastMsg.quat[0];           // 设置为第一个传感器的数据
      if (Array.isArray(q) && Array.isArray(q[0])) q = q[0];
      const w = q[0], x = q[1], y = q[2], z = q[3];
      const threeQ = new THREE.Quaternion(-y, x, z, w);
      if (model.quaternion && typeof model.quaternion.copy === 'function') 
        model.quaternion.copy(threeQ);
      else 
        model.quaternion = threeQ;
    } catch (e) { console.error('updateModelFromConn quat error', e);}
  }
}

// create per-card three.js renderer, load model if any
function createAttitudeRenderer(container, conn) {
  const W = container.clientWidth || 320, H = container.clientHeight || 200;
  if (!THREE || !THREE.WebGLRenderer) {
    container.innerHTML = '<div style="padding:12px;color:#444">three.js 未加载，显示占位信息<br/>' + (conn ? JSON.stringify(conn.lastMsg || {}) : '无数据') + '</div>';
    return;
  }
  if (!conn) {
    container.innerHTML = '<div style="height:100%;display:flex;align-items:center;justify-content:center;color:#667085;background:rgba(255,255,255,0.6);border-radius:8px">暂无设备</div>';
    return { renderer: null, scene: null, camera: null, model: null, controls: null };
  }
  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(45, W / H, 0.1, 100);
  camera.position.set(0, -1.5, 1);

  const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
  renderer.setSize(W, H,false);
  renderer.domElement.style.display = 'block';
  renderer.domElement.style.width = '100%';
  renderer.domElement.style.height = '100%';
  container.innerHTML = '';
  container.appendChild(renderer.domElement);

  

  const controls = new OrbitControls(camera, renderer.domElement);
  controls.enableDamping = true;
  controls.dampingFactor = 0.07;
  controls.enablePan = false;
  // const grid = THREE.GridHelper ? new THREE.GridHelper(2, 8) : new THREE.Object3D(); scene.add(grid);
  const axes = THREE.AxesHelper ? new THREE.AxesHelper(1.2) : new THREE.Object3D(); scene.add(axes);

  let model = null;

  // add simple lighting so standard materials are visible
  try {
    if (!scene.getObjectByName('__ambient_light')) {
      const amb = new THREE.AmbientLight(0xffffff, 0.6);
      amb.name = '__ambient_light';
      scene.add(amb);
    }
    if (!scene.getObjectByName('__dir_light')) {
      const dir = new THREE.DirectionalLight(0xffffff, 0.6);
      dir.position.set(5, 10, 7.5);
      dir.name = '__dir_light';
      scene.add(dir);
    }
  } catch (e) { /* ignore */ }

  // create a safe material factory (fallback to Basic if Standard not available)
  function createSafeMaterial(opts) {
    opts = opts || {};
    try {
      if (THREE && typeof THREE.MeshStandardMaterial === 'function') return new THREE.MeshStandardMaterial(opts);
    } catch (e) { /* ignore */ }
    if (THREE && typeof THREE.MeshBasicMaterial === 'function') return new THREE.MeshBasicMaterial(opts);
    return { color: opts.color || 0x8fb3ff };
  }

  // try to use cached loaded PCB model; if present, clone & add; otherwise fallback to a box
  (async () => {
    const loaded = await loadPCBModelOnce();
    if (loaded) {
      // clone the object/group so each card has its own transform
      let inst;
      try {
        inst = loaded.clone(true);
      } catch (e) {
        // some loader returns Mesh directly
        inst = loaded;
      }

      // auto-scale & center to fit view: compute bounding box and scale to target ~1 unit
      try {
        const box = new THREE.Box3().setFromObject(inst);
        const size = new THREE.Vector3(); box.getSize(size);
        const maxDim = Math.max(size.x, size.y, size.z);
        if (maxDim > 0) {
          const target = 1.0;
          const s = target / maxDim;
          if (inst.scale && typeof inst.scale.set === 'function') inst.scale.set(s, s, s);
          else { inst.scale = inst.scale || {}; inst.scale.x = inst.scale.y = inst.scale.z = s; }
        }
        const center = new THREE.Vector3(); box.getCenter(center);
        if (inst.position && typeof inst.position.set === 'function') {
          inst.position.set(0,0,0);
          // inst.position.set(-center.x, -center.y, -center.z);
        } else {
          inst.position = { x: -center.x, y: -center.y, z: -center.z };
        }
      } catch (e) { /* ignore bounding box errors */ }

      scene.add(inst);
      model = inst;

      const key = conn ? conn.ip : 'placeholder_' + i;
      const entry = rendererMap.get(key);
      entry.model = model;
    } else {
      // fallback box if load failed or no loader available
      const geom = THREE.BoxGeometry ? new THREE.BoxGeometry(0.8, 0.02, 0.8) : new THREE.BufferGeometry();
      const mat = createSafeMaterial({ color: 0x8fb3ff });
      model = new THREE.Mesh(geom, mat);
      scene.add(model);
    }
  })();

  function animate() {
    requestAnimationFrame(animate);
    controls.update();
    renderer.render(scene, camera);
  }
  animate();

  new ResizeObserver(() => {
    const w = container.clientWidth || 320;
    const h = container.clientHeight-20 || 500;
    renderer.setSize(w, h,false); 
    camera.aspect = w / h; if (typeof camera.updateProjectionMatrix === 'function') camera.updateProjectionMatrix();
  }).observe(container);

  return { renderer, scene, camera, model, controls };
}

// ---------------- Modal helpers ----------------
function showModal(contentHtml) {
  const modal = document.getElementById('modal');
  modal.innerHTML = `<div class="modalCard">${contentHtml}</div>`;
  modal.classList.remove('hidden');
  modalContent = modal.querySelector('.modalCard');
}

function hideModal() {
  const modal = document.getElementById('modal');
  modal.classList.add('hidden');
  modal.innerHTML = '';
  scanState = null;
  modalContent = null;
  scanAbortRequested = false;
}

function getOtaDeviceCandidates() {
  const seen = new Set();
  return (connections || []).filter((conn) => {
    if (!conn || !conn.ip) return false;
    if (seen.has(conn.ip)) return false;
    seen.add(conn.ip);
    return true;
  }).map((conn) => {
    const transport = conn.type || getTransportTypeById(conn.ip);
    const version = conn.lastMsg && (conn.lastMsg.version || conn.lastMsg.project_ver)
      ? (conn.lastMsg.version || conn.lastMsg.project_ver)
      : '未知';
    return {
      id: conn.ip,
      transport,
      version,
    };
  });
}

function renderOtaFileInfo() {
  if (!modalContent) return;
  const infoEl = modalContent.querySelector('#ota-file-info');
  const pathEl = modalContent.querySelector('#ota-file-path');
  const dropzone = modalContent.querySelector('#ota-dropzone');
  if (!infoEl || !pathEl) return;

  if (!otaUiState.firmware) {
    pathEl.textContent = '未选择固件文件';
    if (dropzone) {
      dropzone.textContent = '拖拽 .bin 到此区域，或点击此区域选择固件';
      dropzone.classList.remove('loaded');
    }
    infoEl.innerHTML = `
      <div class="ota-file-item"><strong>版本:</strong> --</div>
      <div class="ota-file-item"><strong>大小:</strong> --</div>
      <div class="ota-file-item"><strong>项目:</strong> --</div>
      <div class="ota-file-item"><strong>SHA256:</strong> --</div>
    `;
    return;
  }

  const fw = otaUiState.firmware;
  pathEl.textContent = fw.filePath;
  if (dropzone) {
    const shownName = fw.fileName || 'firmware.bin';
    const shownVer = fw.version || 'unknown';
    dropzone.textContent = `已选择固件: ${shownName} (v${shownVer})`;
    dropzone.classList.add('loaded');
  }
  infoEl.innerHTML = `
    <div class="ota-file-item"><strong>版本:</strong> ${escapeHtml(fw.version || 'unknown')}</div>
    <div class="ota-file-item"><strong>大小:</strong> ${formatBytesForOta(fw.size)}</div>
    <div class="ota-file-item"><strong>项目:</strong> ${escapeHtml(fw.projectName || 'unknown')}</div>
    <div class="ota-file-item"><strong>SHA256:</strong> ${escapeHtml((fw.sha256 || '').slice(0, 32))}...</div>
  `;
}

async function setOtaFirmwareFile(filePath) {
  if (!filePath || typeof filePath !== 'string') return false;
  if (!filePath.toLowerCase().endsWith('.bin')) {
    showNotification('仅支持 .bin 固件文件', 'warning');
    return false;
  }

  const info = await electronAPI.inspectOtaBin({ filePath });
  if (!info || !info.ok) {
    showNotification(`固件解析失败: ${info && info.error ? info.error : 'unknown'}`, 'error');
    return false;
  }

  otaUiState.filePath = filePath;
  otaUiState.firmware = info;
  renderOtaFileInfo();
  showNotification(`已加载固件: ${info.fileName} (v${info.version || 'unknown'})`, 'success');
  return true;
}

function getCheckedOtaTargets() {
  if (!modalContent) return [];
  return Array.from(modalContent.querySelectorAll('.ota-device-check:checked')).map((el) => el.dataset.target);
}

function upsertOtaProgressRow(target) {
  if (!modalContent) return null;
  const list = modalContent.querySelector('#ota-progress-list');
  if (!list) return null;

  const key = otaRowKey(target);
  let row = list.querySelector(`.ota-progress-row[data-key="${key}"]`);
  if (row) return row;

  row = document.createElement('div');
  row.className = 'ota-progress-row';
  row.dataset.key = key;
  row.innerHTML = `
    <div class="ota-progress-head">
      <span class="ota-progress-device">${escapeHtml(target)}</span>
      <span class="ota-progress-status">等待中</span>
    </div>
    <div class="ota-progress-track">
      <span class="ota-progress-label">发送</span>
      <div class="ota-progress-bar ota-progress-bar-send"><div class="ota-progress-fill ota-progress-fill-send"></div></div>
    </div>
    <div class="ota-progress-track">
      <span class="ota-progress-label">回执</span>
      <div class="ota-progress-bar ota-progress-bar-ack"><div class="ota-progress-fill ota-progress-fill-ack"></div></div>
    </div>
    <div class="ota-device-meta ota-progress-meta">--</div>
  `;
  list.appendChild(row);
  return row;
}

function applyOtaProgressToRow(target, payload) {
  if (!modalContent) return;
  const row = upsertOtaProgressRow(target);
  if (!row) return;

  const stageMap = {
    queued: '排队中',
    prepare: '准备中',
    transfer: '传输中',
    retransmit: '重传中',
    rebooting: '重启中',
    interrupting: '中断中',
    interrupted: '已中断',
    done: '已完成',
    failed: '失败',
  };

  const sendPercent = Math.max(0, Math.min(100, Number(payload.sendPercent ?? payload.percent ?? 0)));
  const ackPercent = Math.max(0, Math.min(100, Number(payload.ackPercent ?? payload.percent ?? 0)));
  const sendFill = row.querySelector('.ota-progress-fill-send');
  const ackFill = row.querySelector('.ota-progress-fill-ack');
  const statusEl = row.querySelector('.ota-progress-status');
  const metaEl = row.querySelector('.ota-progress-meta');

  if (sendFill) {
    sendFill.style.width = `${sendPercent}%`;
  }

  if (ackFill) {
    ackFill.style.width = `${ackPercent}%`;
  }

  if (statusEl) {
    const stage = stageMap[payload.stage] || payload.stage || '处理中';
    const msg = payload.message || '';
    statusEl.textContent = `${stage} ${msg}`.trim();
  }

  if (metaEl) {
    const oldV = payload.oldVersion ? `旧版本: ${payload.oldVersion}` : '';
    const newV = payload.newVersion ? `新版本: ${payload.newVersion}` : '';
    const transport = payload.transport ? `链路: ${payload.transport}` : '';
    const progressText = `发送 ${sendPercent}% / 回执 ${ackPercent}%`;
    metaEl.textContent = [transport, progressText, oldV, newV].filter(Boolean).join(' | ') || '--';
  }

  row.classList.remove('success', 'error');
  if (payload.status === 'success') row.classList.add('success');
  if (payload.status === 'error') row.classList.add('error');
}

function setOtaControlsDisabled(disabled) {
  if (!modalContent) return;
  const ids = [
    '#ota-select-all',
    '#ota-clear-all',
    '#ota-start-btn',
    '#ota-close-btn',
    '#ota-close-x',
  ];
  ids.forEach((selector) => {
    const el = modalContent.querySelector(selector);
    if (el) el.disabled = !!disabled;
  });

  modalContent.querySelectorAll('.ota-device-check').forEach((el) => {
    el.disabled = !!disabled;
  });

  modalContent.querySelectorAll('.ota-device-action-btn').forEach((el) => {
    el.disabled = !!disabled;
  });
}

function updateOtaDeviceVersionHint(target, text) {
  if (!modalContent || !target) return;
  const row = Array.from(modalContent.querySelectorAll('.ota-device-row')).find((el) => el.dataset.target === String(target));
  if (!row) return;
  const meta = row.querySelector('.ota-device-meta');
  if (!meta) return;
  meta.textContent = `当前版本: ${text}`;
}

function replaceOtaTargetInModal(oldTarget, newTarget) {
  if (!modalContent) return;
  const oldKeyText = String(oldTarget || '');
  const newKeyText = String(newTarget || '');
  if (!oldKeyText || !newKeyText || oldKeyText === newKeyText) return;

  const row = Array.from(modalContent.querySelectorAll('.ota-device-row')).find((el) => el.dataset.target === oldKeyText);
  if (row) {
    row.dataset.target = newKeyText;
    const check = row.querySelector('.ota-device-check');
    if (check) check.dataset.target = newKeyText;
    const idEl = row.querySelector('.ota-device-id');
    if (idEl) idEl.textContent = newKeyText;
    row.querySelectorAll('.ota-device-action-btn').forEach((btn) => {
      btn.dataset.target = newKeyText;
    });
  }

  const oldProgressKey = otaRowKey(oldKeyText);
  const newProgressKey = otaRowKey(newKeyText);
  const progressRow = modalContent.querySelector(`.ota-progress-row[data-key="${oldProgressKey}"]`);
  if (progressRow) {
    progressRow.dataset.key = newProgressKey;
    const deviceEl = progressRow.querySelector('.ota-progress-device');
    if (deviceEl) deviceEl.textContent = newKeyText;
  }

  if (Object.prototype.hasOwnProperty.call(otaUiState.versionMap, oldKeyText)) {
    const prev = otaUiState.versionMap[oldKeyText];
    delete otaUiState.versionMap[oldKeyText];
    otaUiState.versionMap[newKeyText] = prev;
  }

  if (Object.prototype.hasOwnProperty.call(otaUiState.progressMap, oldKeyText)) {
    const prev = otaUiState.progressMap[oldKeyText];
    delete otaUiState.progressMap[oldKeyText];
    otaUiState.progressMap[newKeyText] = prev;
  }
}

async function fetchAndApplyOtaVersions(targets) {
  if (!modalContent || !Array.isArray(targets) || targets.length === 0) return;

  const response = await electronAPI.queryOtaDeviceVersions({ targets });
  if (!response || !response.ok || !response.versions) {
    targets.forEach((target) => {
      updateOtaDeviceVersionHint(target, '未知（获取失败）');
    });
    return;
  }

  Object.entries(response.versions).forEach(([target, info]) => {
    const versionText = info && info.ok && info.version
      ? info.version
      : '未知（获取失败）';
    otaUiState.versionMap[target] = versionText;
    updateOtaDeviceVersionHint(target, versionText);
  });
}

function showOtaModal() {
  const candidates = getOtaDeviceCandidates();
  if (candidates.length === 0) {
    showNotification('当前没有可升级的已连接设备', 'warning');
    return;
  }

  const rowsHtml = candidates.map((item) => `
    <div class="ota-device-row" data-target="${escapeHtml(item.id)}">
      <input class="ota-device-check" type="checkbox" data-target="${escapeHtml(item.id)}" checked />
      <div class="ota-device-main">
        <div class="ota-device-id">${escapeHtml(item.id)}</div>
        <div class="ota-device-meta">当前版本: 获取中...</div>
      </div>
      <div class="ota-device-tail">
        <span class="ota-transport-tag">${item.transport === 'serial' ? 'USB/串口' : '网络WS'}</span>
        <div class="ota-device-actions">
          <button type="button" class="secondary ota-device-action-btn" data-action="refresh-version" data-target="${escapeHtml(item.id)}">刷新版本</button>
          <button type="button" class="secondary ota-device-action-btn" data-action="reconnect" data-target="${escapeHtml(item.id)}">重连</button>
        </div>
      </div>
    </div>
  `).join('');

  const html = `
    <div class="ota-modal">
      <div class="ota-header">
        <h3>在线升级 OTA</h3>
        <button id="ota-close-x" class="secondary">关闭</button>
      </div>
      <div class="ota-subtitle">选择目标设备和固件后开始升级。升级期间会自动校验传输、等待设备重启并验证新版本。</div>
      <div class="ota-device-toolbar">
        <button id="ota-select-all">全选</button>
        <button id="ota-clear-all" class="secondary">取消全选</button>
      </div>
      <div id="ota-device-list" class="ota-device-list">${rowsHtml}</div>
      <div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap">
        <span id="ota-file-path" class="ota-subtitle">未选择固件文件</span>
      </div>
      <div id="ota-dropzone" class="ota-dropzone">拖拽 .bin 到此区域，或点击此区域选择固件</div>
      <div id="ota-file-info" class="ota-file-info"></div>
      <div id="ota-progress-list" class="ota-progress-list"></div>
      <div class="ota-footer">
        <div id="ota-footer-hint" class="ota-subtitle">等待开始升级</div>
        <div class="ota-footer-actions">
          <button id="ota-start-btn">开始升级</button>
          <button id="ota-interrupt-btn" class="secondary">中断升级</button>
          <button id="ota-close-btn" class="secondary">关闭</button>
        </div>
      </div>
    </div>
  `;

  showModal(html);
  otaUiState.modalOpen = true;

  const closeModalSafely = () => {
    if (otaUiState.running) {
      showNotification('升级进行中，请等待完成后关闭弹窗', 'warning');
      return;
    }
    otaUiState.modalOpen = false;
    hideModal();
  };

  modalContent.querySelector('#ota-close-x').addEventListener('click', closeModalSafely);
  modalContent.querySelector('#ota-close-btn').addEventListener('click', closeModalSafely);
  const interruptBtn = modalContent.querySelector('#ota-interrupt-btn');
  if (interruptBtn) {
    interruptBtn.disabled = true;
    interruptBtn.addEventListener('click', async () => {
      if (!otaUiState.running) return;
      try {
        await electronAPI.interruptOta();
        showNotification('已请求中断升级，等待设备返回...', 'warning');
        const hint = modalContent.querySelector('#ota-footer-hint');
        if (hint) hint.textContent = '正在中断升级任务...';
      } catch (e) {
        showNotification(`中断请求失败: ${(e && e.message) || e}`, 'error');
      }
    });
  }

  modalContent.querySelector('#ota-select-all').addEventListener('click', () => {
    modalContent.querySelectorAll('.ota-device-check').forEach((el) => {
      el.checked = true;
    });
  });

  modalContent.querySelector('#ota-clear-all').addEventListener('click', () => {
    modalContent.querySelectorAll('.ota-device-check').forEach((el) => {
      el.checked = false;
    });
  });

  const deviceList = modalContent.querySelector('#ota-device-list');
  if (deviceList) {
    deviceList.addEventListener('click', async (e) => {
      const btn = e.target.closest('.ota-device-action-btn');
      if (!btn || !modalContent.contains(btn)) return;
      e.preventDefault();
      e.stopPropagation();

      if (otaUiState.running) {
        showNotification('升级进行中，暂不支持单设备操作', 'warning');
        return;
      }

      const action = btn.dataset.action;
      const target = btn.dataset.target;
      if (!action || !target) return;

      const oldText = btn.textContent;
      btn.disabled = true;

      try {
        if (action === 'refresh-version') {
          btn.textContent = '刷新中...';
        } else if (action === 'reconnect') {
          btn.textContent = '重连中...';
        }

        const result = await electronAPI.otaDeviceAction({ action, target });
        if (!result || !result.ok) {
          const errText = result && result.error ? result.error : 'unknown';
          showNotification(`设备 ${target} 操作失败: ${errText}`, 'error');
          if (action === 'refresh-version') {
            updateOtaDeviceVersionHint(target, '未知（刷新失败）');
          }
          return;
        }

        const resolvedTarget = result.resolvedTarget && typeof result.resolvedTarget === 'string'
          ? result.resolvedTarget
          : target;
        if (resolvedTarget !== target) {
          replaceOtaTargetInModal(target, resolvedTarget);
        }

        const versionText = result.version && typeof result.version === 'string'
          ? result.version
          : '未知';
        otaUiState.versionMap[resolvedTarget] = versionText;
        updateOtaDeviceVersionHint(resolvedTarget, versionText);

        if (action === 'refresh-version') {
          showNotification(`设备 ${resolvedTarget} 版本已刷新: ${versionText}`, 'success');
        } else {
          showNotification(`设备 ${resolvedTarget} 重连成功`, 'success');
        }

        listConns();
      } catch (err) {
        const errText = err && err.message ? err.message : String(err);
        showNotification(`设备 ${target} 操作异常: ${errText}`, 'error');
      } finally {
        btn.disabled = false;
        btn.textContent = oldText;
      }
    });
  }

  const dropzone = modalContent.querySelector('#ota-dropzone');
  dropzone.addEventListener('click', async () => {
    const selected = await electronAPI.selectOtaBin();
    if (!selected || selected.canceled) return;
    await setOtaFirmwareFile(selected.filePath);
  });
  dropzone.addEventListener('dragover', (e) => {
    e.preventDefault();
    dropzone.classList.add('dragover');
  });
  dropzone.addEventListener('dragleave', () => {
    dropzone.classList.remove('dragover');
  });
  dropzone.addEventListener('drop', async (e) => {
    e.preventDefault();
    dropzone.classList.remove('dragover');
    const file = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0];
    if (!file || !file.path) return;
    await setOtaFirmwareFile(file.path);
  });

  renderOtaFileInfo();

  Object.keys(otaUiState.progressMap).forEach((target) => {
    upsertOtaProgressRow(target);
    applyOtaProgressToRow(target, otaUiState.progressMap[target]);
  });

  fetchAndApplyOtaVersions(candidates.map((item) => item.id));

  modalContent.querySelector('#ota-start-btn').addEventListener('click', async () => {
    const targets = getCheckedOtaTargets();
    if (targets.length === 0) {
      showNotification('请至少勾选一个设备', 'warning');
      return;
    }
    if (!otaUiState.filePath) {
      showNotification('请先选择 .bin 固件文件', 'warning');
      return;
    }

    otaUiState.running = true;
    document.getElementById('btn-ota').classList.add('running');
    setOtaControlsDisabled(true);
    if (interruptBtn) interruptBtn.disabled = false;
    const hint = modalContent.querySelector('#ota-footer-hint');
    if (hint) hint.textContent = 'OTA 执行中，请保持设备供电与链路稳定...';

    targets.forEach((target) => {
      upsertOtaProgressRow(target);
      applyOtaProgressToRow(target, {
        stage: 'queued',
        status: 'running',
        percent: 0,
        message: '等待升级任务开始',
      });
    });

    try {
      const result = await electronAPI.startOta({
        targets,
        filePath: otaUiState.filePath,
      });

      if (!result || !result.ok) {
        showNotification(`升级任务启动失败: ${result && result.error ? result.error : 'unknown'}`, 'error');
      } else {
        const okCount = (result.results || []).filter((x) => x.ok).length;
        const failCount = (result.results || []).length - okCount;
        if (failCount === 0) {
          showNotification(`升级完成，${okCount} 台设备成功`, 'success');
        } else {
          showNotification(`升级完成，成功 ${okCount} 台，失败 ${failCount} 台`, 'warning');
        }
      }
    } catch (e) {
      showNotification(`升级执行异常: ${(e && e.message) || e}`, 'error');
    } finally {
      otaUiState.running = false;
      document.getElementById('btn-ota').classList.remove('running');
      setOtaControlsDisabled(false);
      if (interruptBtn) interruptBtn.disabled = true;
      if (hint) hint.textContent = '升级任务已结束';
    }
  });
}

function updateProgress(percent) {
  if (modalContent) {
    let prog = modalContent.querySelector('#scanProgress');
    if (!prog) {
      prog = document.createElement('div'); prog.id = 'scanProgress'; modalContent.appendChild(prog);
    }
    prog.style.marginTop = '32px';
    prog.textContent = `进度: ${percent.toFixed(1)}%`;
    let bar = modalContent.querySelector('#scanProgressBar');
    if (!bar) {
      bar = document.createElement('div'); bar.id = 'scanProgressBar'; bar.style.height = '4px'; bar.style.marginTop = '8px';
      modalContent.appendChild(bar);
    }
    bar.style.width = `${percent}%`; bar.style.background = '#2b6ef6';
  }
}

// scan IP modal building
function showModalScanIPs(ips, subnet) {
  const N = ips.length;
  const cols = Math.ceil(Math.sqrt(N));
  const size = Math.min(320 / cols, 32);
  const html = `<div style="display:flex;justify-content:space-between;align-items:center"><h3>扫描子网 ${subnet}</h3><div><button id="modalCloseX" title="停止并关闭">×</button></div></div>
  <div id="gridContainer" style="display:grid; grid-template-columns:repeat(${cols},1fr); gap:2px; width:${cols * size + 30}px; height:${Math.ceil(N / cols) * size}px;"></div><div id="scanProgress" style="margin-top: 32px;">扫描中...</div>
  <div id="tooltip" style="display:none; position:absolute; background-color:rgba(0,0,0,0.8); color:white; padding:4px 8px; border-radius:4px; font-size:12px; pointer-events:none; z-index:1000;"></div>
 `;
  showModal(html);
  // allow X to stop
  modalContent.querySelector('#modalCloseX').addEventListener('click', async () => {
    scanAbortRequested = true;
    await electronAPI.cancelScan();
    hideModal();
  });

  scanState = {
    type: 'ips',
    ips,
    cells: Array.from({ length: N }, () => ({ color: COLORS.black })), // default black until updated
    completed: 0,
    running: false
  };
  const gridCont = modalContent.querySelector('#gridContainer');
  const tooltip = modalContent.querySelector('#tooltip');
  const modalCard = modalContent; // Reference to modal card for position calculation
  
  scanState.cells.forEach((cell, i) => {
    const div = document.createElement('div');
    div.style.background = cell.color;
    div.style.width = `${size - 4}px`; div.style.height = `${size - 4}px`; div.style.margin = '2px';
    div.addEventListener('mouseenter', (e) => {
      tooltip.textContent = `IP: ${ips[i]}`;
      tooltip.style.display = 'block';
      // Position tooltip relative to the hovered element
      const rect = div.getBoundingClientRect();
      const modalRect = modalCard.getBoundingClientRect();
      tooltip.style.left = `${rect.left - modalRect.left + rect.width + 5}px`;
      tooltip.style.top = `${rect.top - modalRect.top}px`;
    });

    div.addEventListener('mousemove', (e) => {
      // Update position on move for smoother experience
      const rect = div.getBoundingClientRect();
      const modalRect = modalCard.getBoundingClientRect();
      tooltip.style.left = `${rect.left - modalRect.left + rect.width + 5}px`;
      tooltip.style.top = `${rect.top - modalRect.top}px`;
    });

    div.addEventListener('mouseleave', () => {
      tooltip.style.display = 'none';
    });

    // // allow clicking a non-green cell to mark for re-scan (turn black)
    // div.addEventListener('click', () => {
    //   if (scanState.cells[i].color !== COLORS.green) {
    //     scanState.cells[i].color = COLORS.black;
    //     div.style.background = COLORS.black;
    //   }
    // });

    gridCont.appendChild(div);
    cell.elem = div;
  });
}

// finalize scan: for IPs show buttons
function finalizeScan(type, res) {
  if (type === 'ips') {
    addScanButtonsToModal();
    listConns();
    showNotification('IP 扫描完成', 'success');
  }
}

// add scan control buttons (does not close modal)
function addScanButtonsToModal() {
  if (!modalContent) return;
  // remove existing control area
  const existing = modalContent.querySelector('#scanControlArea');
  if (existing) existing.remove();

  const btnsWrap = document.createElement('div');
  btnsWrap.id = 'scanControlArea';
  btnsWrap.style.marginTop = '12px';
  btnsWrap.style.display = 'flex';
  btnsWrap.style.gap = '8px';
  btnsWrap.style.alignItems = 'center';

  const btnRescan = document.createElement('button'); btnRescan.textContent = '重新扫描（跳过绿色）';
  btnRescan.addEventListener('click', async () => {
    if (!scanState || scanState.type !== 'ips') return;
    if (scanState.running) {
      showNotification('IP 正在扫描中，请稍候...', 'warning');
      return;
    }

    // build ip list excluding green ones
    scanState.completed = 0;
    const toRescan = scanState.ips.filter((ip, idx) => scanState.cells[idx].color !== COLORS.green);
    if (toRescan.length === 0) {
      showNotification('当前无需重新扫描，全部已连接', 'info');
      return;
    }

    // set non-green to black visually first
    scanState.ips.forEach((ip, idx) => {
      if (scanState.cells[idx].color !== COLORS.green) {
        scanState.cells[idx].color = COLORS.black;
        if (scanState.cells[idx].elem) scanState.cells[idx].elem.style.background = COLORS.black;
      }
    });
    // keep modal open
    showNotification(`重新扫描 ${toRescan.length} 个 IP...`, 'info');
    try {
      scanState.running = true;
      scanAbortRequested = false;
      const res = await electronAPI.scanIPs({ ips: toRescan, timeout: 800, concurrency: 80 });
      // res updates come via ws-scan-result events; after scan, we can update list
      showNotification('重新扫描完成', 'success');
    } catch (e) {
      console.error('rescan failed', e);
      showNotification('重新扫描失败', 'error');
    } finally {
      if (scanState && scanState.type === 'ips') scanState.running = false;
    }
  });


  btnsWrap.appendChild(btnRescan);
  modalContent.appendChild(btnsWrap);
}

function updateSerialScanProgress() {
  if (!scanState || scanState.type !== 'serial' || !modalContent) return;
  const prog = modalContent.querySelector('#serialScanProgress');
  if (!prog) return;
  const total = scanState.total || 0;
  const done = scanState.completed || 0;
  prog.textContent = total > 0 ? `已扫描 ${done}/${total}` : '未发现串口设备';
}

function setSerialRowStatus(path, status, detail, result) {
  if (!scanState || scanState.type !== 'serial') return;
  const row = scanState.rows[path];
  if (!row) return;

  row.statusBadge.textContent = status;
  row.detail.textContent = detail || '';
  row.element.classList.remove('status-scanning', 'status-connected', 'status-failed', 'status-non-esp');

  if (result && result.status === 'connected') {
    row.element.classList.add('status-connected');
    row.actions.innerHTML = '<span class="serial-row-ok">已连接</span>';
    return;
  }

  if (result && result.status === 'open-failed') {
    row.element.classList.add('status-failed');
    row.actions.innerHTML = '';
    const retryBtn = document.createElement('button');
    retryBtn.className = 'serial-retry-btn';
    retryBtn.textContent = '重试';
    retryBtn.addEventListener('click', async () => {
      await scanSingleSerialPort(path, true);
    });
    row.actions.appendChild(retryBtn);
    return;
  }

  if (result && result.status === 'non-esp') {
    row.element.classList.add('status-non-esp');
    row.actions.innerHTML = '<span class="serial-row-muted">非ESP设备</span>';
    return;
  }

  if (result && result.status === 'scanning') {
    row.element.classList.add('status-scanning');
    row.actions.innerHTML = '<span class="serial-row-spinner"></span>';
  }
}

function buildSerialRow(port) {
  const row = document.createElement('div');
  row.className = 'serial-row status-scanning';
  row.dataset.path = port.path;
  row.innerHTML = `
    <div class="serial-row-main">
      <div class="serial-row-path">${port.path}</div>
      <div class="serial-row-meta">${port.manufacturer || '未知厂商'} ${port.friendlyName || ''}</div>
    </div>
    <div class="serial-row-status">扫描中</div>
    <div class="serial-row-actions"><span class="serial-row-spinner"></span></div>
    <div class="serial-row-detail">准备打开串口...</div>
  `;

  const statusBadge = row.querySelector('.serial-row-status');
  const actions = row.querySelector('.serial-row-actions');
  const detail = row.querySelector('.serial-row-detail');

  return { element: row, statusBadge, actions, detail };
}

async function scanSingleSerialPort(path, manualRetry = false) {
  if (!scanState || scanState.type !== 'serial') return;
  const row = scanState.rows[path];
  if (!row) return;

  setSerialRowStatus(path, '扫描中', '正在打开串口并请求 getDeviceInfos...', { status: 'scanning' });
  try {
    const res = await electronAPI.probeSerialPort({ path, timeoutMs: 500, cmd: { cmd: 'getDeviceInfos' } });
    if (!scanState || scanState.type !== 'serial') return;

    if (res && res.status === 'connected') {
      const info = res.deviceInfo || {};
      const detail = `识别成功 | deviceid: ${info.deviceid || '未知'} | ip: ${info.ip_addr || '--'}`;
      setSerialRowStatus(path, 'ESP设备', detail, res);
      if (manualRetry) showNotification(`串口 ${path} 识别成功`, 'success');
    } else if (res && res.status === 'open-failed') {
      setSerialRowStatus(path, '打开失败', `错误: ${res.error || '无法打开串口'}`, res);
      if (manualRetry) showNotification(`串口 ${path} 打开失败`, 'error');
    } else {
      const detail = res && res.error === 'timeout' ? '500ms 内未收到有效 getDeviceInfos 响应' : '收到数据但未识别为 ESP 设备';
      setSerialRowStatus(path, '非ESP', detail, { status: 'non-esp' });
      if (manualRetry) showNotification(`串口 ${path} 不是 ESP 设备`, 'warning');
    }
  } catch (e) {
    setSerialRowStatus(path, '打开失败', `错误: ${(e && e.message) || '扫描异常'}`, { status: 'open-failed' });
    if (manualRetry) showNotification(`串口 ${path} 重试失败`, 'error');
  } finally {
    if (!manualRetry) {
      scanState.completed = Math.min(scanState.total, scanState.completed + 1);
      updateSerialScanProgress();
    }
    listConns();
  }
}

async function runSerialScanAll() {
  if (!scanState || scanState.type !== 'serial' || !modalContent) return;
  if (scanState.running) return;
  scanState.running = true;
  scanState.completed = 0;
  updateSerialScanProgress();

  const paths = Object.keys(scanState.rows);
  const maxParallel = SERIAL_SCAN_MAX_CONCURRENCY;
  let cursor = 0;

  const workers = Array.from({ length: Math.min(maxParallel, paths.length) }, async () => {
    while (cursor < paths.length) {
      const index = cursor;
      cursor += 1;
      const path = paths[index];
      if (!scanState || scanState.type !== 'serial') return;
      try {
        await scanSingleSerialPort(path, false);
      } catch (e) {
        console.warn('scanSingleSerialPort error', path, e);
      }
    }
  });

  await Promise.all(workers);
  if (scanState && scanState.type === 'serial') {
    scanState.running = false;
  }
  showNotification('串口扫描完成', 'success');
}

async function showSerialScanModal() {
  const html = `
    <div class="serial-modal">
      <div class="serial-modal-header">
        <h3>串口设备扫描</h3>
        <button id="closeSerialScanX" class="secondary">关闭</button>
      </div>
      <div class="serial-modal-sub">自动扫描全部串口，最多同时并发 ${SERIAL_SCAN_MAX_CONCURRENCY} 个；发送 getDeviceInfos，500ms 内返回有效信息则识别为设备</div>
      <div id="serialScanList" class="serial-list"></div>
      <div class="serial-modal-footer">
        <div id="serialScanProgress" class="serial-progress">正在获取串口列表...</div>
        <div class="serial-modal-actions">
          <button id="serialRescanBtn">重新扫描</button>
          <button id="serialCloseBtn" class="secondary">确认</button>
        </div>
      </div>
    </div>
  `;

  showModal(html);
  scanState = {
    type: 'serial',
    rows: {},
    total: 0,
    completed: 0,
    running: false,
  };

  modalContent.querySelector('#closeSerialScanX').addEventListener('click', () => {
    hideModal();
  });

  modalContent.querySelector('#serialRescanBtn').addEventListener('click', async () => {
    if (scanState && scanState.type === 'serial' && scanState.running) {
      showNotification('正在扫描中，请稍候...', 'warning');
      return;
    }
    showNotification('重新获取串口列表并扫描中...', 'info');
    await showSerialScanModal();
  });

  modalContent.querySelector('#serialCloseBtn').addEventListener('click', () => {
    hideModal();
  });

  try {
    const ports = await electronAPI.listSerialPorts();
    if (!scanState || scanState.type !== 'serial') return;

    const listEl = modalContent.querySelector('#serialScanList');
    listEl.innerHTML = '';

    if (!ports || ports.length === 0) {
      listEl.innerHTML = '<div class="serial-empty">未发现可用串口</div>';
      scanState.total = 0;
      scanState.completed = 0;
      updateSerialScanProgress();
      return;
    }

    scanState.total = ports.length;
    scanState.completed = 0;

    ports.forEach((port) => {
      const row = buildSerialRow(port);
      scanState.rows[port.path] = row;
      listEl.appendChild(row.element);
    });

    updateSerialScanProgress();
    await runSerialScanAll();
  } catch (e) {
    const listEl = modalContent.querySelector('#serialScanList');
    listEl.innerHTML = `<div class="serial-empty">获取串口失败: ${(e && e.message) || 'unknown error'}</div>`;
    updateSerialScanProgress();
  }
}

// show subnet select modal with memory + prioritize /24
function showSubnetSelectModalWithMemory(subnets, callback) {
  const key = 'xj_last_subnet_choice';
  const last = localStorage.getItem(key);
  // build options sorted: subnets already sorted by cidr desc at caller
  const html = `<div style="display:flex;flex-direction:column;gap:8px"><div style="display:flex;justify-content:space-between;align-items:center"><strong>选择子网</strong><button id="closeSubnetX" title="关闭">×</button></div>
  <select id="subnetSelect">${subnets.map(s => `<option value="${encodeURIComponent(JSON.stringify(s))}">${s.base}/${s.cidr} (${s.ifname || 'if'})</option>`).join('')}</select>
  <div style="display:flex;gap:8px"><button id="confirmSubnet">确认</button><button id="refreshSubnets">刷新</button></div>
  </div>`;
  showModal(html);
  // close X
  modalContent.querySelector('#closeSubnetX').addEventListener('click', () => { hideModal(); });

  const sel = modalContent.querySelector('#subnetSelect');
  // if last exists, try to set it
  if (last) {
    try {
      const obj = JSON.parse(last);
      for (let i = 0; i < sel.options.length; i++) {
        if (sel.options[i].textContent.startsWith(`${obj.base}/${obj.cidr}`)) {
          sel.selectedIndex = i; break;
        }
      }
    } catch (e) { }
  }

  modalContent.querySelector('#confirmSubnet').addEventListener('click', () => {
    const raw = sel.value;
    const decoded = decodeURIComponent(raw);
    const selected = JSON.parse(decoded);
    try { localStorage.setItem(key, JSON.stringify(selected)); } catch (e) { }
    hideModal();
    callback(selected);
  });

  modalContent.querySelector('#refreshSubnets').addEventListener('click', async () => {
    // refresh list by re-fetching from main
    try {
      const subs = await electronAPI.getSubnets();
      subs.sort((a, b) => b.cidr - a.cidr);
      hideModal();
      showSubnetSelectModalWithMemory(subs, callback);
    } catch (e) {
      showNotification('刷新子网失败', 'error');
    }
  });
}

// ----------------- scan helpers -----------------
function buildScanRangeFromSubnet(sn) {
  console.log('buildScanRangeFromSubnet', sn);
  if (!sn || !sn.base || !sn.cidr) return [];
  const parts = sn.base.split('.').map(Number);
  const hostBits = 32 - sn.cidr;
  const total = 2 ** hostBits;
  const baseInt = (parts[0] << 24) + (parts[1] << 16) + (parts[2] << 8) + parts[3];
  const ips = [];
  for (let i = 1; i < Math.max(2, total - 1); i++) {
    const ipInt = baseInt + i;
    ips.push(((ipInt >> 24) & 255) + '.' + ((ipInt >> 16) & 255) + '.' + ((ipInt >> 8) & 255) + '.' + (ipInt & 255));
  }
  return ips;
}

// ---------------- UDP position & tracks ----------------
// electronAPI.onUDPPosition((data) => {
//   console.log('UDP position data', data);
//   const port = data.port;
//   if (!tracks[port]) tracks[port] = [];
//   tracks[port].push({ x: data.x, y: data.y, t: Date.now() });
//   if (!trackColors[port]) trackColors[port] = randomColorForPort(port);
//   trackVisible[port] = true;
//   if (typeof window.drawTracks === 'function') window.drawTracks();
//   updateLegend();
// });

// also respond to ws-message event to immediately update attitude if IMU comes over ws (handled in listConns update)

// helpers for tracks
function randomColorForPort(port) {
  const seed = (parseInt(port) || 1);
  const r = (seed * 97) % 255; const g = (seed * 57) % 255; const b = (seed * 31) % 255;
  return `rgb(${r},${g},${b})`;
}

let usedColors = new Set();
function getUniqueRandomColor(ip) {
  let seed = 0;
  const text = String(ip || '');
  for (let i = 0; i < text.length; i++) {
    seed = (seed * 131 + text.charCodeAt(i)) >>> 0;
  }

  let color = null;
  for (let attempt = 0; attempt < 128; attempt++) {
    const s = (seed + attempt * 1103515245) >>> 0;
    const r = (s * 97) % 255;
    const g = (s * 57) % 255;
    const b = (s * 31) % 255;
    const candidate = `rgb(${r},${g},${b})`;
    if (!usedColors.has(candidate)) {
      color = candidate;
      break;
    }
    if (attempt === 127) {
      console.warn('Failed to generate unique color for', ip);
    }
  }

  if (!color) {
    color = `rgb(${Math.floor(Math.random() * 255)},${Math.floor(Math.random() * 255)},${Math.floor(Math.random() * 255)})`;
  }

  usedColors.add(color);
  console.log('Assigned color for', ip, ':', color);
  return color;
}

// Track canvas state (global for replay/fit functions)
let trackOffsetX = 0, trackOffsetY = 0, trackScale = 50;

// track canvas setup unchanged, except exposure of drawTracks
(function setupTrackCanvas() {
  const canvas = document.getElementById('track-canvas');
  if (!canvas) return;
  const ctx = canvas.getContext('2d');
  function fit() { canvas.width = canvas.clientWidth; canvas.height = canvas.clientHeight; drawTracks(); }
  window.addEventListener('resize', fit);
  let dragging = false, last = [0, 0];
  canvas.addEventListener('wheel', (e) => {
    e.preventDefault();
    const rect = canvas.getBoundingClientRect();
    const mouseX = e.clientX - rect.left - canvas.clientWidth / 2;
    const mouseY = e.clientY - rect.top - canvas.clientHeight / 2;
    const worldXBefore = (mouseX - trackOffsetX) / trackScale;
    const worldYBefore = -(mouseY - trackOffsetY) / trackScale; // y inverted
    const factor = Math.exp(-e.deltaY * 0.0008);
    let newScale = Math.max(0.1, Math.min(800, trackScale * factor));
    trackScale = newScale;
    trackOffsetX = mouseX - worldXBefore * trackScale;
    trackOffsetY = mouseY + worldYBefore * trackScale;
    drawTracks();
  });
  canvas.addEventListener('mousedown', (e) => { dragging = true; last = [e.clientX, e.clientY]; });
  window.addEventListener('mouseup', () => dragging = false);
  window.addEventListener('mousemove', (e) => {
    const rect = canvas.getBoundingClientRect();
    const mouseX = e.clientX - rect.left;
    const mouseY = e.clientY - rect.top;
    if (!dragging) return; trackOffsetX += (e.clientX - last[0]); 
    trackOffsetY += (e.clientY - last[1]); last = [e.clientX, e.clientY]; 
    drawTracks();
  });

  document.getElementById('clear-tracks').addEventListener('click', () => { tracks = {}; usedColors.clear(); updateLegend(); drawTracks(); });
  document.getElementById('replay-tracks').addEventListener('click', () => { replayTracks(); });
  document.getElementById('fit-window').addEventListener('click', () => { fitToWindow(); });
  function niceStep(pxPerUnit, targetPx = 80) {
    const raw = targetPx / Math.max(1e-9, pxPerUnit);
    const pow10 = Math.pow(10, Math.floor(Math.log10(raw)));
    const cand = [1, 2, 5].map(m => m * pow10);
    let best = cand[0];
    let bestDiff = Math.abs(cand[0] - raw);
    for (let i = 1; i < cand.length; i++) {
      const diff = Math.abs(cand[i] - raw);
      if (diff < bestDiff) { best = cand[i]; bestDiff = diff; }
    }
    return best;
  }
  function drawTracks() {
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    // Draw axes
    ctx.strokeStyle = '#ddd';
    ctx.lineWidth = 1;
    ctx.beginPath();
    // Horizontal axis
    ctx.moveTo(0, canvas.height / 2 + trackOffsetY);
    ctx.lineTo(canvas.width, canvas.height / 2 + trackOffsetY);
    // Vertical axis
    ctx.moveTo(canvas.width / 2 + trackOffsetX, 0);
    ctx.lineTo(canvas.width / 2 + trackOffsetX, canvas.height);
    ctx.stroke();

    // Draw ticks and labels
    ctx.font = '12px Arial';
    ctx.fillStyle = '#666';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';

    // Determine tick interval based on scale
    let tickInterval = niceStep(trackScale);
    
    // X axis ticks
    const centerX = canvas.width / 2 + trackOffsetX;
    const centerY = canvas.height / 2 + trackOffsetY;
    const minX = -(canvas.width / 2  + trackOffsetX) / trackScale;
    const maxX = (canvas.width / 2 - trackOffsetX) / trackScale;
    
    for (let x = Math.ceil(minX / tickInterval) * tickInterval; x <= maxX; x += tickInterval) {
      const px = centerX + x * trackScale;
      ctx.beginPath();
      ctx.moveTo(px, centerY - 5);
      ctx.lineTo(px, centerY + 5);
      ctx.stroke();
      ctx.fillText(x.toFixed(1), px, centerY + 15);
    }

    // Y axis ticks (inverted)
    const minY = (trackOffsetY - canvas.height / 2) / trackScale;
    const maxY = (trackOffsetY  + canvas.height / 2) / trackScale;
    for (let y = Math.ceil(minY / tickInterval) * tickInterval; y <= maxY; y += tickInterval) {
      const py = centerY - y * trackScale; // inverted
      ctx.beginPath();
      ctx.moveTo(centerX - 5, py);
      ctx.lineTo(centerX + 5, py);
      ctx.stroke();
      ctx.fillText(y.toFixed(1), centerX - 15, py);
    }

    // Draw tracks
    Object.keys(tracks).forEach(ip => {
      if (!trackVisible[ip]) return;
      const pts = tracks[ip];
      ctx.beginPath(); ctx.lineWidth = 2; ctx.strokeStyle = trackColors[ip] || 'black';
      for (let i = 0; i < pts.length; i++) {
        const px = centerX + pts[i].x * trackScale;
        const py = centerY - pts[i].y * trackScale; // inverted y
        if (i === 0) ctx.moveTo(px, py); else ctx.lineTo(px, py);
      }
      ctx.stroke();
      const lastp = pts[pts.length - 1]; if (lastp) {
        ctx.fillStyle = trackColors[ip] || 'black';
        ctx.beginPath();
        ctx.arc(centerX + lastp.x * trackScale, centerY - lastp.y * trackScale, 4, 0, Math.PI * 2);
        ctx.fill();
      }
    });
  }
  window.drawTracks = drawTracks;

  fit();
})();

// Initialize throttled functions after all functions are defined
throttledDrawTracks = throttle(function() { if (typeof window.drawTracks === 'function') window.drawTracks(); }, DRAW_THROTTLE_MS);
throttledUpdateLegend = throttle(updateLegend, LEGEND_THROTTLE_MS);

function updateLegend() {
  const container = document.getElementById('track-legend'); if (!container) return; container.innerHTML = '';
  Object.keys(tracks).forEach(ip => {
    const item = document.createElement('div'); item.className = 'track-item';
    const header = document.createElement('div'); header.className = 'track-item-header';
    const ipLabel = document.createElement('span'); ipLabel.className = 'track-item-ip'; ipLabel.textContent = ip;
    const lastPos = tracks[ip][tracks[ip].length - 1];
    const posLabel = document.createElement('span'); posLabel.className = 'track-item-pos'; posLabel.textContent = lastPos ? `(${lastPos.x.toFixed(2)}, ${lastPos.y.toFixed(2)})` : '(No pos)';
    const colorBox = document.createElement('div'); colorBox.className = 'track-item-color'; colorBox.style.background = trackColors[ip];
    const colorInput = document.createElement('input'); colorInput.type = 'color'; colorInput.value = rgbToHex(trackColors[ip]); colorInput.style.display = 'none';
    colorBox.addEventListener('click', () => colorInput.click());
    colorInput.addEventListener('input', (e) => { trackColors[ip] = e.target.value; colorBox.style.background = e.target.value; drawTracks(); });
    const toggle = document.createElement('input'); toggle.className = 'track-item-visible'; toggle.type = 'checkbox'; toggle.checked = trackVisible[ip] !== false;
    toggle.addEventListener('change', () => { trackVisible[ip] = toggle.checked; drawTracks(); });
    header.appendChild(ipLabel);
    header.appendChild(colorBox);
    header.appendChild(toggle);
    item.appendChild(header);
    item.appendChild(posLabel);
    container.appendChild(item);
  });
}

function rgbToHex(rgb) {
  const [r, g, b] = rgb.match(/\d+/g).map(Number);
  return `#${((1 << 24) + (r << 16) + (g << 8) + b).toString(16).slice(1)}`;
}

function replayTracks() {
  if (replaying) return; replaying = true;
  const allT = Object.values(tracks).flatMap(a => a.map(p => p.t)); if (!allT.length) { replaying = false; return; }
  const maxT = Math.max(...allT); const minT = Math.min(...allT); const dur = maxT - minT || 1000; const start = Date.now();
  const canvas = document.getElementById('track-canvas'); if (!canvas) { replaying = false; return; }
  const ctx = canvas.getContext('2d');
  const centerX = canvas.width / 2 + trackOffsetX;
  const centerY = canvas.height / 2 + trackOffsetY;
  (function step() {
    const el = Date.now() - start;
    const nowT = minT + (el / dur) * (maxT - minT);
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    // Redraw axes and ticks as in drawTracks
    ctx.strokeStyle = '#ddd';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(0, centerY);
    ctx.lineTo(canvas.width, centerY);
    ctx.moveTo(centerX, 0);
    ctx.lineTo(centerX, canvas.height);
    ctx.stroke();

    // Ticks and labels similarly...

    Object.keys(tracks).forEach(ip => {
      if (!trackVisible[ip]) return;
      const pts = tracks[ip].filter(p => p.t <= nowT);
      ctx.beginPath(); ctx.lineWidth = 2; ctx.strokeStyle = trackColors[ip];
      for (let i = 0; i < pts.length; i++) {
        const px = centerX + pts[i].x * trackScale;
        const py = centerY - pts[i].y * trackScale;
        if (i === 0) ctx.moveTo(px, py); else ctx.lineTo(px, py);
      }
      ctx.stroke();
    });
    if (el < dur) requestAnimationFrame(step); else { replaying = false; drawTracks(); }
  })();
}

function fitToWindow() {
  const allPoints = Object.values(tracks).flat();
  if (!allPoints.length) return;
  const minX = Math.min(...allPoints.map(p => p.x));
  const maxX = Math.max(...allPoints.map(p => p.x));
  const minY = Math.min(...allPoints.map(p => p.y));
  const maxY = Math.max(...allPoints.map(p => p.y));
  const width = maxX - minX || 1;
  const height = maxY - minY || 1;
  const canvas = document.getElementById('track-canvas');
  trackScale = Math.min(canvas.width / (width * 1.1), canvas.height / (height * 1.1));
  trackOffsetX = canvas.width / 2 - (minX + width / 2) * trackScale;
  trackOffsetY = canvas.height / 2 + (minY + height / 2) * trackScale; // inverted y
  drawTracks();
}

// Recording functions
function startRecording() {
  recording = true;
  recordingData = {};
  recordingCount = 0;
  recordingStartTime = new Date();
  
  const btn = document.getElementById('btn-record');
  btn.classList.add('recording');
  btn.innerHTML = `<span class="record-dot"></span><span class="record-text">0 条</span>`;
  
  showNotification('开始录制数据', 'success');
}

function updateRecordingCount() {
  if (!recording) return;
  const btn = document.getElementById('btn-record');
  const textEl = btn.querySelector('.record-text');
  if (textEl) {
    textEl.textContent = `${recordingCount} 条`;
  }
}

function recordIMUData(ip, data) {
  if (!recording || !data) return;
  
  // Initialize storage for this IP if not exists
  if (!recordingData[ip]) {
    recordingData[ip] = {};
    for (let s = 0; s < BMI088_NUM + 1; s++) {
      recordingData[ip][s] = [];
    }
  }
  
  // For each sensor, create a row
  for (let s = 0; s < BMI088_NUM + 1; s++) {
    const row = {
      timestamp: data.timestamp,
      // raw_accel (3)
      raw_accel_x: data.raw_accel?.[s]?.[0] ?? '',
      raw_accel_y: data.raw_accel?.[s]?.[1] ?? '',
      raw_accel_z: data.raw_accel?.[s]?.[2] ?? '',
      // raw_gyro (3)
      raw_gyro_x: data.raw_gyro?.[s]?.[0] ?? '',
      raw_gyro_y: data.raw_gyro?.[s]?.[1] ?? '',
      raw_gyro_z: data.raw_gyro?.[s]?.[2] ?? '',
      // quat (4)
      quat_w: data.quat?.[s]?.[0] ?? '',
      quat_x: data.quat?.[s]?.[1] ?? '',
      quat_y: data.quat?.[s]?.[2] ?? '',
      quat_z: data.quat?.[s]?.[3] ?? '',
      // rotation_matrix (9)
      rotation_matrix_0: data.rotation_matrix?.[s]?.[0] ?? '',
      rotation_matrix_1: data.rotation_matrix?.[s]?.[1] ?? '',
      rotation_matrix_2: data.rotation_matrix?.[s]?.[2] ?? '',
      rotation_matrix_3: data.rotation_matrix?.[s]?.[3] ?? '',
      rotation_matrix_4: data.rotation_matrix?.[s]?.[4] ?? '',
      rotation_matrix_5: data.rotation_matrix?.[s]?.[5] ?? '',
      rotation_matrix_6: data.rotation_matrix?.[s]?.[6] ?? '',
      rotation_matrix_7: data.rotation_matrix?.[s]?.[7] ?? '',
      rotation_matrix_8: data.rotation_matrix?.[s]?.[8] ?? '',
      // eular (3)
      roll: data.eular?.[s]?.[0] ?? '',
      pitch: data.eular?.[s]?.[1] ?? '',
      yaw: data.eular?.[s]?.[2] ?? '',
      // linear_accel (3)
      linear_accel_x: data.linear_accel?.[s]?.[0] ?? '',
      linear_accel_y: data.linear_accel?.[s]?.[1] ?? '',
      linear_accel_z: data.linear_accel?.[s]?.[2] ?? '',
      // earth_accel (3)
      earth_accel_x: data.earth_accel?.[s]?.[0] ?? '',
      earth_accel_y: data.earth_accel?.[s]?.[1] ?? '',
      earth_accel_z: data.earth_accel?.[s]?.[2] ?? '',
      // kf_accel (3)
      kf_accel_x: data.kf_accel?.[s]?.[0] ?? '',
      kf_accel_y: data.kf_accel?.[s]?.[1] ?? '',
      kf_accel_z: data.kf_accel?.[s]?.[2] ?? '',
      // kf_velocity (3)
      kf_velocity_x: data.kf_velocity?.[s]?.[0] ?? '',
      kf_velocity_y: data.kf_velocity?.[s]?.[1] ?? '',
      kf_velocity_z: data.kf_velocity?.[s]?.[2] ?? '',
      // displacement (3)
      displacement_x: data.displacement?.[s]?.[0] ?? '',
      displacement_y: data.displacement?.[s]?.[1] ?? '',
      displacement_z: data.displacement?.[s]?.[2] ?? '',
      // stationary (1)
      stationary: data.stationary?.[s] ? 1 : 0
    };
    recordingData[ip][s].push(row);
  }
  
  recordingCount++;
  // Throttle UI update
  if (recordingCount % 10 === 0) {
    updateRecordingCount();
  }
}

function generateCSVContent(rows) {
  if (!rows || rows.length === 0) return '';
  
  // Header
  const headers = Object.keys(rows[0]);
  let csv = headers.join(',') + '\n';
  
  // Data rows
  for (const row of rows) {
    const values = headers.map(h => row[h]);
    csv += values.join(',') + '\n';
  }
  
  return csv;
}

function formatTimeForFilename(date) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  const h = String(date.getHours()).padStart(2, '0');
  const min = String(date.getMinutes()).padStart(2, '0');
  return `${y}${m}${d}${h}${min}`;
}

async function stopRecording() {
  recording = false;
  
  const btn = document.getElementById('btn-record');
  btn.classList.remove('recording');
  btn.innerHTML = '录制';
  
  // Prepare files
  const files = [];
  const timeStr = formatTimeForFilename(recordingStartTime);
  
  for (const ip of Object.keys(recordingData)) {
    const ipForFilename = ip.replace(/\./g, '');
    
    for (let s = 0; s < BMI088_NUM + 1; s++) {
      const rows = recordingData[ip][s];
      if (rows && rows.length > 0) {
        const filename = `imudata_${timeStr}_${ipForFilename}_sensor${s}.csv`;
        const content = generateCSVContent(rows);
        files.push({ name: filename, content });
      }
    }
  }
  
  if (files.length === 0) {
    showNotification('没有录制到数据', 'warning');
    return;
  }
  
  // Save files
  try {
    const result = await electronAPI.saveRecordingFiles({ files });
    
    if (result.success) {
      showRecordingSavedModal(result.files);
    } else {
      showNotification('保存失败: ' + result.error, 'error');
    }
  } catch (e) {
    console.error('Save recording error:', e);
    showNotification('保存失败', 'error');
  }
  
  // Reset
  recordingData = {};
  recordingCount = 0;
}

function showRecordingSavedModal(savedFiles) {
  const fileListHtml = savedFiles.map(f => `
    <div class="saved-file-item">
      <div class="saved-file-name" title="${f.path}">${f.name}</div>
      <div class="saved-file-actions">
        <button class="btn-open-file" data-path="${f.path}" title="打开文件">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/>
            <polyline points="14 2 14 8 20 8"/>
            <line x1="16" y1="13" x2="8" y2="13"/>
            <line x1="16" y1="17" x2="8" y2="17"/>
          </svg>
        </button>
        <button class="btn-open-folder" data-folder="${f.path}" title="打开文件夹">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/>
          </svg>
        </button>
      </div>
    </div>
  `).join('');
  
  const html = `
    <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:16px">
      <h3 style="margin:0">录制完成</h3>
      <button id="closeRecordingModal" style="background:transparent;color:#666;padding:4px 8px" title="关闭">×</button>
    </div>
    <div class="recording-stats" style="margin-bottom:16px;padding:12px;background:#f0f7ff;border-radius:8px">
      <div style="display:flex;gap:20px">
        <div><strong>录制条数：</strong>${recordingCount} 条</div>
        <div><strong>文件数量：</strong>${savedFiles.length} 个</div>
      </div>
    </div>
    <div class="saved-files-list" style="max-height:300px;overflow-y:auto">
      ${fileListHtml}
    </div>
    <div style="display:flex;gap:8px;margin-top:16px">
      <button id="openAllFolderBtn" class="primary" style="flex:1">打开文件夹</button>
      <button id="closeRecordingBtn" class="secondary" style="flex:1">关闭</button>
    </div>
  `;
  
  showModal(html);
  
  // Event listeners
  modalContent.querySelector('#closeRecordingModal').addEventListener('click', hideModal);
  modalContent.querySelector('#closeRecordingBtn').addEventListener('click', hideModal);
  
  modalContent.querySelector('#openAllFolderBtn').addEventListener('click', () => {
    if (savedFiles.length > 0) {
      electronAPI.openFolder(savedFiles[0].path);
    }
  });
  
  modalContent.querySelectorAll('.btn-open-file').forEach(btn => {
    btn.addEventListener('click', () => {
      electronAPI.openFile(btn.dataset.path);
    });
  });
  
  modalContent.querySelectorAll('.btn-open-folder').forEach(btn => {
    btn.addEventListener('click', () => {
      electronAPI.openFolder(btn.dataset.folder);
    });
  });
}

setInterval(listConns, 1000);
