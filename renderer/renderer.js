// renderer.js

import * as THREE from '../node_modules/three/build/three.module.js';
import { OrbitControls } from '../node_modules/three/examples/jsm/controls/OrbitControls.js';
import { OBJLoader } from '../node_modules/three/examples/jsm/loaders/OBJLoader.js';
import { MTLLoader } from '../node_modules/three/examples/jsm/loaders/MTLLoader.js';

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

// Color map
const COLORS = {
  offline: 'red',
  ping: '#FFC107',       // ping ok (橙黄色)
  green: '#00FF00',
  black: '#444444'
};

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

// ---------------- Topbar bindings ----------------
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
        scanAbortRequested = false;
        const res = await electronAPI.scanIPs({ ips, timeout: 800, concurrency: 80 });
        finalizeScan('ips', res);
      } catch (e) {
        console.error('scanIPs error', e);
        showNotification('扫描出错: ' + (e && e.message), 'error');
      }
    });
  } catch (e) {
    console.error('getSubnets failed', e);
    alert('获取子网失败: ' + e.message);
  }
});

// other topbar buttons (unchanged behaviour)
document.getElementById('btn-disconnect').addEventListener('click', () => {
  // show list and allow disconnect - TODO (kept as stub to not change other logic)
  alert('断开连接功能待实现');
});

document.getElementById('btn-record').addEventListener('click', () => {
  recording = !recording;
  document.getElementById('btn-record').style.background = recording ? 'red' : '#2b6ef6';
  if (recording) startRecording(); else stopRecording();
});

document.getElementById('btn-zero').addEventListener('click', () => {
  electronAPI.broadcastCmd({ cmd: 'setZero' });
  showNotification('Send Zero Heading to All', 'success');
});
document.getElementById('btn-inertial').addEventListener('click', () => {
  const btn = document.getElementById('btn-inertial');
  electronAPI.broadcastCmd({ cmd: 'drawpic' });
  showNotification('Send Inertial Reset to All', 'success');
});
document.getElementById('btn-shutdown').addEventListener('click', () => {
  if (confirm('确定要关闭所有设备吗？')) {
    electronAPI.broadcastCmd({ cmd: 'shutdown' });
    showNotification('Send Shutdown Command to All', 'success');
  }

});
document.querySelectorAll('.page-switch').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.page-switch').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    const page = btn.dataset.page;
    document.querySelectorAll('.page').forEach(p => p.classList.remove('active'));
    if (page === 'attitude') document.getElementById('page-device-attitude').classList.add('active');
    else document.getElementById('page-device-track').classList.add('active');
    layoutGrid(true);
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
  if (idx >= 0) {
    connections[idx].lastMsg = msg.msg;
  } else {
    // push if not present
    connections.push({ ip: msg.ip, lastMsg: msg.msg, connSettings: msg.connSettings || null });
    isNew = true;
  }
  // if IMU normal data, push to connection and will be used for attitude rendering
  // update grid
  layoutGrid(isNew);
  msg = msg.msg;
  if (msg.positions) {
    if (!tracks[ip]) {
      tracks[ip] = [];
      trackColors[ip] = getUniqueRandomColor(ip);
      trackVisible[ip] = true;
      updateLegend();
    }
    msg.positions.forEach(pos => {
      tracks[ip].push({ x: pos[0], y: pos[1], t: Date.now() }); // ignore z, use current time
    });
    if (typeof window.drawTracks === 'function') window.drawTracks();
    updateLegend(); // update position
  }
});

// ---------------- connection / render grid ----------------
let oldLength = 0;
async function listConns() {
  const list = await electronAPI.listConnections();
  connections = list;
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
  const count = connections.length || 1;
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
      let q = conn.lastMsg.quat[4];
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
    completed: 0
  };
  const gridCont = modalContent.querySelector('#gridContainer');
  const tooltip = modalContent.querySelector('#tooltip');
  scanState.cells.forEach((cell, i) => {
    const div = document.createElement('div');
    div.style.background = cell.color;
    div.style.width = `${size - 4}px`; div.style.height = `${size - 4}px`; div.style.margin = '2px';
    div.addEventListener('mouseenter', (e) => {
      tooltip.textContent = `IP: ${ips[i]}`;
      tooltip.style.display = 'block';
    });

    div.addEventListener('mousemove', (e) => {
      tooltip.style.left = `${e.pageX + 10}px`;
      tooltip.style.top = `${e.pageY - 20}px`;
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
    // build ip list excluding green ones
    scanState.completed = 0;
    const toRescan = scanState.ips.filter((ip, idx) => scanState.cells[idx].color !== COLORS.green);
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
      scanAbortRequested = false;
      const res = await electronAPI.scanIPs({ ips: toRescan, timeout: 800, concurrency: 80 });
      // res updates come via ws-scan-result events; after scan, we can update list
      showNotification('重新扫描完成', 'success');
    } catch (e) {
      console.error('rescan failed', e);
      showNotification('重新扫描失败', 'error');
    }
  });


  btnsWrap.appendChild(btnRescan);
  modalContent.appendChild(btnsWrap);
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
  let color;
  do {
    const seed = ip.split('.').reduce((acc, part) => acc + parseInt(part), 0);
    const r = (seed * 97) % 255;
    const g = (seed * 57) % 255;
    const b = (seed * 31) % 255;
    color = `rgb(${r},${g},${b})`;
  } while (usedColors.has(color));
  usedColors.add(color);
  return color;
}

// track canvas setup unchanged, except exposure of drawTracks
(function setupTrackCanvas() {
  const canvas = document.getElementById('track-canvas');
  if (!canvas) return;
  const ctx = canvas.getContext('2d');
  function fit() { canvas.width = canvas.clientWidth; canvas.height = canvas.clientHeight; drawTracks(); }
  window.addEventListener('resize', fit);
  let offsetX = 0, offsetY = 0, scale = 50;
  let dragging = false, last = [0, 0];
  canvas.addEventListener('wheel', (e) => {
    e.preventDefault();
    const rect = canvas.getBoundingClientRect();
    const mouseX = e.clientX - rect.left - canvas.clientWidth / 2;
    const mouseY = e.clientY - rect.top - canvas.clientHeight / 2;
    const worldXBefore = (mouseX - offsetX) / scale;
    const worldYBefore = -(mouseY - offsetY) / scale; // y inverted
    const factor = Math.exp(-e.deltaY * 0.0008);
    let newScale = Math.max(0.1, Math.min(800, scale * factor));
    scale = newScale;
    offsetX = mouseX - worldXBefore * scale;
    offsetY = mouseY + worldYBefore * scale;
    drawTracks();
  });
  canvas.addEventListener('mousedown', (e) => { dragging = true; last = [e.clientX, e.clientY]; });
  window.addEventListener('mouseup', () => dragging = false);
  window.addEventListener('mousemove', (e) => {
    const rect = canvas.getBoundingClientRect();
    const mouseX = e.clientX - rect.left;
    const mouseY = e.clientY - rect.top;
    if (!dragging) return; offsetX += (e.clientX - last[0]); 
    offsetY += (e.clientY - last[1]); last = [e.clientX, e.clientY]; 
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
    ctx.moveTo(0, canvas.height / 2 + offsetY);
    ctx.lineTo(canvas.width, canvas.height / 2 + offsetY);
    // Vertical axis
    ctx.moveTo(canvas.width / 2 + offsetX, 0);
    ctx.lineTo(canvas.width / 2 + offsetX, canvas.height);
    ctx.stroke();

    // Draw ticks and labels
    ctx.font = '12px Arial';
    ctx.fillStyle = '#666';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';

    // Determine tick interval based on scale
    let tickInterval = niceStep(scale);
    
    // X axis ticks
    const centerX = canvas.width / 2 + offsetX;
    const centerY = canvas.height / 2 + offsetY;
    const minX = -(canvas.width / 2  + offsetX) / scale;
    const maxX = (canvas.width / 2 - offsetX) / scale;
    
    for (let x = Math.ceil(minX / tickInterval) * tickInterval; x <= maxX; x += tickInterval) {
      const px = centerX + x * scale;
      ctx.beginPath();
      ctx.moveTo(px, centerY - 5);
      ctx.lineTo(px, centerY + 5);
      ctx.stroke();
      ctx.fillText(x.toFixed(1), px, centerY + 15);
    }

    // Y axis ticks (inverted)
    const minY = (offsetY - canvas.height / 2) / scale;
    const maxY = (offsetY  + canvas.height / 2) / scale;
    for (let y = Math.ceil(minY / tickInterval) * tickInterval; y <= maxY; y += tickInterval) {
      const py = centerY - y * scale; // inverted
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
        const px = centerX + pts[i].x * scale;
        const py = centerY - pts[i].y * scale; // inverted y
        if (i === 0) ctx.moveTo(px, py); else ctx.lineTo(px, py);
      }
      ctx.stroke();
      const lastp = pts[pts.length - 1]; if (lastp) {
        ctx.fillStyle = trackColors[ip] || 'black';
        ctx.beginPath();
        ctx.arc(centerX + lastp.x * scale, centerY - lastp.y * scale, 4, 0, Math.PI * 2);
        ctx.fill();
      }
    });
  }
  window.drawTracks = drawTracks;

  fit();
})();

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
  const centerX = canvas.width / 2 + offsetX; // Note: offsetX/Y need to be defined in scope, but assuming from setup
  const centerY = canvas.height / 2 + offsetY;
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
        const px = centerX + pts[i].x * scale;
        const py = centerY - pts[i].y * scale;
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
  const width = maxX - minX;
  const height = maxY - minY;
  const canvas = document.getElementById('track-canvas');
  scale = Math.min(canvas.width / (width * 1.1), canvas.height / (height * 1.1));
  offsetX = canvas.width / 2 - (minX + width / 2) * scale;
  offsetY = canvas.height / 2 + (minY + height / 2) * scale; // inverted y
  drawTracks();
}

// helpers
function startRecording() { window._recordBuf = []; }
function stopRecording() { console.log('record stopped. samples:', (window._recordBuf || []).length); }

// kept for compatibility fallback
function guessHostIP() { return hostIp || '192.168.1.100'; }

setInterval(listConns, 1000);