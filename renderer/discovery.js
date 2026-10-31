import { enhanceSelect } from './ui-controls.js';
import { createScanTooltip } from './scan-tooltip.js';
import { modalCloseButton } from './dialogs.js';
import { escapeHtml } from './utils.js';

export function createDiscovery({ electronAPI, listConns, dialogs, showNotification }) {
let scanState = null;
let hostIp = null;
let scanAbortRequested = false;
const SERIAL_SCAN_MAX_CONCURRENCY = 8;
const COLORS = {
  offline: 'red',
  ping: '#FFC107',       // ping ok (橙黄色)
  green: '#00FF00',
  black: '#444444'
};

function updateProgress(percent) {
  if (dialogs.content) {
    let prog = dialogs.content.querySelector('#scanProgress');
    if (!prog) {
      prog = document.createElement('div'); prog.id = 'scanProgress'; dialogs.content.appendChild(prog);
    }
    prog.style.marginTop = '32px';
    prog.textContent = `进度: ${percent.toFixed(1)}%`;
    let bar = dialogs.content.querySelector('#scanProgressBar');
    if (!bar) {
      bar = document.createElement('div'); bar.id = 'scanProgressBar'; bar.style.height = '4px'; bar.style.marginTop = '8px';
      dialogs.content.appendChild(bar);
    }
    bar.style.width = `${percent}%`; bar.style.background = '#2b6ef6';
  }
}

// scan IP modal building
function showModalScanIPs(ips, subnet) {
  const N = ips.length;
  const cols = Math.ceil(Math.sqrt(N));
  const size = Math.min(320 / cols, 32);
  const html = `<div style="display:flex;justify-content:space-between;align-items:center"><h3>扫描子网 ${subnet}</h3>${modalCloseButton('modalCloseX', '停止并关闭')}</div>
  <div id="gridContainer" style="display:grid; grid-template-columns:repeat(${cols},1fr); gap:2px; width:${cols * size + 30}px; height:${Math.ceil(N / cols) * size}px;"></div><div id="scanProgress" style="margin-top: 32px;">扫描中...</div>
 `;
  const closeScan = async () => {
    scanAbortRequested = true;
    try { await electronAPI.cancelScan(); }
    catch (error) { showNotification('停止扫描失败，请重试', 'error'); return; }
    dialogs.hide();
  };
  dialogs.show(html, { onRequestClose: closeScan });
  dialogs.content.querySelector('#modalCloseX').addEventListener('click', closeScan);

  scanState = {
    type: 'ips',
    ips,
    cells: Array.from({ length: N }, () => ({ color: COLORS.black })), // default black until updated
    completed: 0,
    running: false
  };
  const gridCont = dialogs.content.querySelector('#gridContainer');
  const tooltip = createScanTooltip();
  dialogs.scanTooltip = tooltip;
  
  scanState.cells.forEach((cell, i) => {
    const div = document.createElement('div');
    div.style.background = cell.color;
    div.style.width = `${size - 4}px`; div.style.height = `${size - 4}px`; div.style.margin = '2px';
    div.addEventListener('mouseenter', () => tooltip.show(div, `IP: ${ips[i]}`));
    div.addEventListener('mousemove', tooltip.reposition);
    div.addEventListener('mouseleave', tooltip.hide);

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
  if (!dialogs.content) return;
  // remove existing control area
  const existing = dialogs.content.querySelector('#scanControlArea');
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
  dialogs.content.appendChild(btnsWrap);
}

function updateSerialScanProgress() {
  if (!scanState || scanState.type !== 'serial' || !dialogs.content) return;
  const prog = dialogs.content.querySelector('#serialScanProgress');
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
  if (!scanState || scanState.type !== 'serial' || !dialogs.content) return;
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
        ${modalCloseButton('closeSerialScanX')}
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

  dialogs.show(html);
  scanState = {
    type: 'serial',
    rows: {},
    total: 0,
    completed: 0,
    running: false,
  };

  dialogs.content.querySelector('#closeSerialScanX').addEventListener('click', () => {
    dialogs.hide();
  });

  dialogs.content.querySelector('#serialRescanBtn').addEventListener('click', async () => {
    if (scanState && scanState.type === 'serial' && scanState.running) {
      showNotification('正在扫描中，请稍候...', 'warning');
      return;
    }
    showNotification('重新获取串口列表并扫描中...', 'info');
    await showSerialScanModal();
  });

  dialogs.content.querySelector('#serialCloseBtn').addEventListener('click', () => {
    dialogs.hide();
  });

  try {
    const ports = await electronAPI.listSerialPorts();
    if (!scanState || scanState.type !== 'serial') return;

    const listEl = dialogs.content.querySelector('#serialScanList');
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
    const listEl = dialogs.content.querySelector('#serialScanList');
    listEl.innerHTML = `<div class="serial-empty">获取串口失败: ${(e && e.message) || 'unknown error'}</div>`;
    updateSerialScanProgress();
  }
}

// show subnet select modal with memory + prioritize /24
function showSubnetSelectModalWithMemory(subnets, callback) {
  const key = 'xj_last_subnet_choice';
  const last = localStorage.getItem(key);
  // build options sorted: subnets already sorted by cidr desc at caller
  const html = `<div class="subnet-dialog">
    <div class="subnet-dialog-header"><h3>选择子网</h3><div class="subnet-dialog-tools"><button type="button" id="refreshSubnets" class="modal-icon-button" aria-label="刷新子网" title="刷新子网"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21 12a9 9 0 0 0-15.36-6.36L3 8"/><path d="M3 3v5h5"/><path d="M3 12a9 9 0 0 0 15.36 6.36L21 16"/><path d="M16 16h5v5"/></svg></button>${modalCloseButton('closeSubnetX')}</div></div>
    <select id="subnetSelect">${subnets.map(s => `<option value="${encodeURIComponent(JSON.stringify(s))}" data-primary="${escapeHtml(`${s.base}/${s.cidr}`)}" data-detail="${escapeHtml(s.ifname || 'if')}">${escapeHtml(`${s.base}/${s.cidr} (${s.ifname || 'if'})`)}</option>`).join('')}</select>
    <div class="subnet-dialog-actions"><button id="confirmSubnet">确认</button></div>
  </div>`;
  dialogs.show(html);
  // close X
  dialogs.content.querySelector('#closeSubnetX').addEventListener('click', () => { dialogs.hide(); });

  const sel = dialogs.content.querySelector('#subnetSelect');
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

  sel.setAttribute('aria-label', '选择子网');
  dialogs.select = enhanceSelect(sel, '选择子网');
  dialogs.content.querySelector('#confirmSubnet').disabled = sel.options.length === 0;

  dialogs.content.querySelector('#confirmSubnet').addEventListener('click', () => {
    const raw = sel.value;
    const decoded = decodeURIComponent(raw);
    const selected = JSON.parse(decoded);
    try { localStorage.setItem(key, JSON.stringify(selected)); } catch (e) { }
    dialogs.hide();
    callback(selected);
  });

  dialogs.content.querySelector('#refreshSubnets').addEventListener('click', async (event) => {
    const refreshButton = event.currentTarget;
    const card = dialogs.content;
    refreshButton.disabled = true;
    refreshButton.classList.add('is-refreshing');
    refreshButton.setAttribute('aria-busy', 'true');
    try {
      const subs = await electronAPI.getSubnets();
      if (dialogs.content !== card) return;
      subs.sort((a, b) => b.cidr - a.cidr);
      dialogs.hide();
      showSubnetSelectModalWithMemory(subs, callback);
    } catch (e) {
      if (dialogs.content === card) showNotification('刷新子网失败', 'error');
    } finally {
      refreshButton.disabled = false;
      refreshButton.classList.remove('is-refreshing');
      refreshButton.removeAttribute('aria-busy');
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

function start() {
document.getElementById('btn-scan-ips').addEventListener('click', async () => {
  try {
    const subnets = await electronAPI.getSubnets();
    // sort: prefer smaller host count -> larger cidr first (e.g., /24 before /23)
    subnets.sort((a, b) => b.cidr - a.cidr);
    showSubnetSelectModalWithMemory(subnets, async (selected) => {
      // get host IP for that subnet using ipconfig
      try {
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
    showNotification('获取子网失败: ' + e.message, 'error');
  }
});

document.getElementById('btn-scan-serial').addEventListener('click', async () => {
  showSerialScanModal();
});
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
}

function reset() {
  scanState = null;
  scanAbortRequested = false;
}

return { start, reset, getCacheData: () => ({ scanState }) };
}
