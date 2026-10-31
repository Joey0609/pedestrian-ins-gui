import { escapeHtml, formatBytesForOta, otaRowKey } from './utils.js';
import { modalCloseButton } from './dialogs.js';

export function createOtaDialog({ electronAPI, getConnections, getTransportTypeById, listConns, dialogs, showNotification }) {
let otaUiState = {
  modalOpen: false,
  running: false,
  filePath: '',
  firmware: null,
  progressMap: {},
  versionMap: {},
};

function getOtaDeviceCandidates() {
  const seen = new Set();
  return (getConnections() || []).filter((conn) => {
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
  if (!dialogs.content) return;
  const infoEl = dialogs.content.querySelector('#ota-file-info');
  const pathEl = dialogs.content.querySelector('#ota-file-path');
  const dropzone = dialogs.content.querySelector('#ota-dropzone');
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
  if (!dialogs.content) return [];
  return Array.from(dialogs.content.querySelectorAll('.ota-device-check:checked')).map((el) => el.dataset.target);
}

function upsertOtaProgressRow(target) {
  if (!dialogs.content) return null;
  const list = dialogs.content.querySelector('#ota-progress-list');
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
  if (!dialogs.content) return;
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
  if (!dialogs.content) return;
  const ids = [
    '#ota-select-all',
    '#ota-clear-all',
    '#ota-start-btn',
    '#ota-close-x',
  ];
  ids.forEach((selector) => {
    const el = dialogs.content.querySelector(selector);
    if (el) el.disabled = !!disabled;
  });

  dialogs.content.querySelectorAll('.ota-device-check').forEach((el) => {
    el.disabled = !!disabled;
  });

  dialogs.content.querySelectorAll('.ota-device-action-btn').forEach((el) => {
    el.disabled = !!disabled;
  });
}

function updateOtaDeviceVersionHint(target, text) {
  if (!dialogs.content || !target) return;
  const row = Array.from(dialogs.content.querySelectorAll('.ota-device-row')).find((el) => el.dataset.target === String(target));
  if (!row) return;
  const meta = row.querySelector('.ota-device-meta');
  if (!meta) return;
  meta.textContent = `当前版本: ${text}`;
}

function replaceOtaTargetInModal(oldTarget, newTarget) {
  if (!dialogs.content) return;
  const oldKeyText = String(oldTarget || '');
  const newKeyText = String(newTarget || '');
  if (!oldKeyText || !newKeyText || oldKeyText === newKeyText) return;

  const row = Array.from(dialogs.content.querySelectorAll('.ota-device-row')).find((el) => el.dataset.target === oldKeyText);
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
  const progressRow = dialogs.content.querySelector(`.ota-progress-row[data-key="${oldProgressKey}"]`);
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
  if (!dialogs.content || !Array.isArray(targets) || targets.length === 0) return;

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
        ${modalCloseButton('ota-close-x')}
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
        </div>
      </div>
    </div>
  `;

  const closeModalSafely = () => {
    if (otaUiState.running) {
      showNotification('升级进行中，请等待完成后关闭弹窗', 'warning');
      return;
    }
    otaUiState.modalOpen = false;
    dialogs.hide();
  };

  dialogs.show(html, { onRequestClose: closeModalSafely });
  otaUiState.modalOpen = true;
  dialogs.content.querySelector('#ota-close-x').addEventListener('click', closeModalSafely);
  const interruptBtn = dialogs.content.querySelector('#ota-interrupt-btn');
  if (interruptBtn) {
    interruptBtn.disabled = true;
    interruptBtn.addEventListener('click', async () => {
      if (!otaUiState.running) return;
      try {
        await electronAPI.interruptOta();
        showNotification('已请求中断升级，等待设备返回...', 'warning');
        const hint = dialogs.content.querySelector('#ota-footer-hint');
        if (hint) hint.textContent = '正在中断升级任务...';
      } catch (e) {
        showNotification(`中断请求失败: ${(e && e.message) || e}`, 'error');
      }
    });
  }

  dialogs.content.querySelector('#ota-select-all').addEventListener('click', () => {
    dialogs.content.querySelectorAll('.ota-device-check').forEach((el) => {
      el.checked = true;
    });
  });

  dialogs.content.querySelector('#ota-clear-all').addEventListener('click', () => {
    dialogs.content.querySelectorAll('.ota-device-check').forEach((el) => {
      el.checked = false;
    });
  });

  const deviceList = dialogs.content.querySelector('#ota-device-list');
  if (deviceList) {
    deviceList.addEventListener('click', async (e) => {
      const btn = e.target.closest('.ota-device-action-btn');
      if (!btn || !dialogs.content.contains(btn)) return;
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

  const dropzone = dialogs.content.querySelector('#ota-dropzone');
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

  dialogs.content.querySelector('#ota-start-btn').addEventListener('click', async () => {
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
    const hint = dialogs.content.querySelector('#ota-footer-hint');
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

function start() {
electronAPI.onOtaProgress((event) => {
  if (!event || !event.target) return;
  const prev = otaUiState.progressMap[event.target] || {};
  otaUiState.progressMap[event.target] = { ...prev, ...event };

  if (!otaUiState.modalOpen || !dialogs.content) return;
  upsertOtaProgressRow(event.target);
  applyOtaProgressToRow(event.target, otaUiState.progressMap[event.target]);
});
}

return { show: showOtaModal, start };
}
