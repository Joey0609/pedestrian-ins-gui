// main.js
const { app, BrowserWindow, ipcMain, shell, dialog } = require('electron');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { autoUpdater } = require('electron-updater');
const { WSManager } = require('./src/wsManager');

let mainWin;
let wsMgr;
let lastCpuSample = process.cpuUsage();
let lastCpuSampleAt = process.hrtime.bigint();
let otaBusy = false;
let otaActiveSessions = new Map();
let otaInterruptState = {
  requested: false,
  reason: '',
  currentDeviceId: '',
  currentTransport: '',
};
let manualUpdateCheckPending = false;

function setupApplicationUpdates() {
  if (!app.isPackaged) return;

  autoUpdater.autoDownload = false;
  autoUpdater.autoInstallOnAppQuit = true;

  autoUpdater.on('checking-for-update', () => safeSendToRenderer('app-update-status', { state: 'checking', manual: manualUpdateCheckPending }));
  autoUpdater.on('update-available', (info) => safeSendToRenderer('app-update-status', {
    state: 'available',
    version: info.version,
    currentVersion: app.getVersion(),
    releaseNotes: info.releaseNotes || '',
    manual: manualUpdateCheckPending,
  }));
  autoUpdater.on('download-progress', (progress) => safeSendToRenderer('app-update-status', {
    state: 'downloading',
    percent: Math.round(progress.percent || 0),
  }));
  autoUpdater.on('update-not-available', () => {
    safeSendToRenderer('app-update-status', { state: 'latest', manual: manualUpdateCheckPending });
    manualUpdateCheckPending = false;
  });
  autoUpdater.on('error', (error) => {
    console.error('[updater]', error);
    safeSendToRenderer('app-update-status', { state: 'error', message: error.message, manual: manualUpdateCheckPending });
    manualUpdateCheckPending = false;
  });
  autoUpdater.on('update-downloaded', (info) => {
    safeSendToRenderer('app-update-status', { state: 'downloaded', version: info.version });
  });

  setTimeout(() => autoUpdater.checkForUpdates(), 3000);
}

const OTA_APP_DESC_OFFSET = 0x20;
const OTA_APP_DESC_MAGIC = 0xabcd5432;
const OTA_WAIT_TIMEOUT_MS = 10000;
const OTA_RECONNECT_TIMEOUT_MS = 120000;
const OTA_RECONNECT_ACTIVE_INTERVAL_MS = 450;
const OTA_CHUNK_SIZE_WS = 2048;
const OTA_CHUNK_SIZE_SERIAL = 512;
const OTA_CHUNK_RETRY_WS = 3;
const OTA_CHUNK_RETRY_SERIAL = 6;
const OTA_WS_MAX_ACK_GAP_PERCENT = 10;
const OTA_WS_ACK_GAP_WAIT_TIMEOUT_MS = 30000;
const OTA_SERIAL_CHUNK_ACK_TIMEOUT_MS = 15000;

function safeSendToRenderer(channel, payload) {
  try {
    if (!mainWin || mainWin.isDestroyed()) return;
    if (!mainWin.webContents || mainWin.webContents.isDestroyed()) return;
    mainWin.webContents.send(channel, payload);
  } catch (e) {
    console.warn(`[main] safeSendToRenderer failed on ${channel}:`, e && e.message ? e.message : e);
  }
}

function emitOtaProgress(payload) {
  safeSendToRenderer('ota-progress', payload);
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isOtaInterruptedError(error) {
  const text = (error && error.message ? error.message : String(error || '')).toLowerCase();
  return text.includes('ota_interrupted') || text.includes('ota interrupted') || text.includes('interrupted');
}

function requestOtaInterrupt(reason = 'user') {
  otaInterruptState.requested = true;
  otaInterruptState.reason = reason;

  const targets = otaActiveSessions.size > 0
    ? Array.from(otaActiveSessions.entries())
    : (otaInterruptState.currentDeviceId ? [[otaInterruptState.currentDeviceId, { transport: otaInterruptState.currentTransport || '' }]] : []);

  if (otaBusy && wsMgr && targets.length > 0) {
    targets.forEach(([target, session]) => {
      try {
        wsMgr.sendToDevice(target, { cmd: 'ota_abort' });
        emitOtaProgress({
          target,
          transport: session && session.transport ? session.transport : otaInterruptState.currentTransport || '',
          stage: 'interrupting',
          status: 'running',
          message: '收到中断请求，正在停止升级...',
        });
      } catch (e) {
        // Best-effort interruption.
      }
    });
  }

  return {
    ok: true,
    busy: otaBusy,
    currentTarget: otaInterruptState.currentDeviceId || null,
  };
}

function isIPv4Address(text) {
  if (typeof text !== 'string') return false;
  return /^(25[0-5]|2[0-4]\d|1?\d?\d)(\.(25[0-5]|2[0-4]\d|1?\d?\d)){3}$/.test(text.trim());
}

function readCString(buffer, offset, maxLen) {
  if (!Buffer.isBuffer(buffer) || offset >= buffer.length || maxLen <= 0) return '';
  const end = Math.min(offset + maxLen, buffer.length);
  const slice = buffer.slice(offset, end);
  const nulIdx = slice.indexOf(0);
  const text = (nulIdx >= 0 ? slice.slice(0, nulIdx) : slice).toString('utf8').trim();
  return text;
}

function parseFirmwareDescriptorFromBin(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < OTA_APP_DESC_OFFSET + 128) {
    return null;
  }

  const magic = buffer.readUInt32LE(OTA_APP_DESC_OFFSET);
  if (magic !== OTA_APP_DESC_MAGIC) {
    return null;
  }

  const version = readCString(buffer, OTA_APP_DESC_OFFSET + 16, 32);
  const projectName = readCString(buffer, OTA_APP_DESC_OFFSET + 48, 32);
  const buildTime = readCString(buffer, OTA_APP_DESC_OFFSET + 80, 16);
  const buildDate = readCString(buffer, OTA_APP_DESC_OFFSET + 96, 16);
  const idfVer = readCString(buffer, OTA_APP_DESC_OFFSET + 112, 32);

  return {
    version,
    projectName,
    buildTime,
    buildDate,
    idfVer,
  };
}

function inspectFirmwareBin(filePath) {
  if (!filePath || typeof filePath !== 'string') {
    return { ok: false, error: 'invalid-file-path' };
  }
  if (!filePath.toLowerCase().endsWith('.bin')) {
    return { ok: false, error: 'only-bin-supported' };
  }
  if (!fs.existsSync(filePath)) {
    return { ok: false, error: 'file-not-found' };
  }

  const buffer = fs.readFileSync(filePath);
  const descriptor = parseFirmwareDescriptorFromBin(buffer);
  const fileHash = crypto.createHash('sha256').update(buffer).digest('hex');

  let fallbackVersion = '';
  const markerMatch = buffer.toString('latin1').match(/FWVER:([0-9]+\.[0-9]+\.[0-9]+);/);
  if (markerMatch && markerMatch[1]) {
    fallbackVersion = markerMatch[1];
  }

  const version = fallbackVersion || (descriptor && descriptor.version) || 'unknown';
  const projectName = (descriptor && descriptor.projectName) || 'unknown';
  const buildDateTime = descriptor ? `${descriptor.buildDate || ''} ${descriptor.buildTime || ''}`.trim() : 'unknown';
  const idfVer = (descriptor && descriptor.idfVer) || 'unknown';

  return {
    ok: true,
    filePath,
    fileName: path.basename(filePath),
    size: buffer.length,
    sha256: fileHash,
    version,
    projectName,
    buildDateTime,
    idfVer,
    buffer,
  };
}

function waitForDeviceMessage(deviceId, predicate, timeoutMs = OTA_WAIT_TIMEOUT_MS, otaAware = false) {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      cleanup();
      reject(new Error(`timeout waiting response from ${deviceId}`));
    }, timeoutMs);

    const onMessage = (event) => {
      try {
        if (!event || event.ip !== deviceId) return;
        const msg = event.msg || {};
        if (otaAware && msg && msg.cmd === 'ota_error') {
          cleanup();
          reject(new Error(`ota_error(${msg.stage || 'unknown'}): ${msg.reason || 'unknown'}`));
          return;
        }
        if (otaAware && msg && msg.cmd === 'ota_abort_ack') {
          cleanup();
          reject(new Error('ota_interrupted'));
          return;
        }
        if (predicate(msg, event)) {
          cleanup();
          resolve(msg);
        }
      } catch (e) {
        cleanup();
        reject(e);
      }
    };

    function cleanup() {
      clearTimeout(timeout);
      wsMgr.off('ws-message', onMessage);
    }

    wsMgr.on('ws-message', onMessage);
  });
}

async function sendAndWait(deviceId, cmdObj, predicate, timeoutMs, otaAware = false) {
  const waiter = waitForDeviceMessage(deviceId, predicate, timeoutMs, otaAware);
  wsMgr.sendToDevice(deviceId, cmdObj);
  return waiter;
}

async function queryFirmwareInfo(deviceId, retries = 4) {
  let lastErr = null;
  for (let i = 0; i < retries; i++) {
    try {
      const msg = await sendAndWait(
        deviceId,
        { cmd: 'getFirmwareInfo' },
        (m) => m && (m.cmd === 'firmware_info' || Number(m.ts) === 8),
        5000,
        false
      );
      return {
        version: msg.version || msg.project_ver || 'unknown',
        raw: msg,
      };
    } catch (e) {
      lastErr = e;
      await delay(350);
    }
  }
  return {
    version: 'unknown',
    error: lastErr ? lastErr.message : 'query-firmware-info-failed',
  };
}

function getConnectionById(id, type) {
  const conns = wsMgr.listConnections() || [];
  return conns.find((c) => c.ip === id && (!type || c.type === type));
}

function isTransportOpen(id, transport) {
  const connType = transport === 'serial' ? 'serial' : 'ws';
  const conn = getConnectionById(id, connType);
  return !!(conn && conn.state === 'open');
}

async function waitForTransportDisconnect(id, transport, timeoutMs = 45000) {
  const start = Date.now();
  const wasOpenAtStart = isTransportOpen(id, transport);

  // If already disconnected, treat as disconnected stage completed.
  if (!wasOpenAtStart) {
    return true;
  }

  while (Date.now() - start < timeoutMs) {
    if (otaInterruptState.requested) {
      throw new Error('ota_interrupted');
    }
    if (!isTransportOpen(id, transport)) {
      return true;
    }
    await delay(250);
  }

  throw new Error(`${transport} disconnect timeout: ${id}`);
}

async function waitForWsReconnect(ip, timeoutMs = OTA_RECONNECT_TIMEOUT_MS, requireDisconnect = false) {
  if (requireDisconnect) {
    await waitForTransportDisconnect(ip, 'ws', Math.min(timeoutMs, 45000));
  }

  try {
    if (getConnectionById(ip, 'ws')) {
      wsMgr.disconnect(ip);
    }
  } catch (e) {
    // Ignore stale disconnect errors.
  }

  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (otaInterruptState.requested) {
      throw new Error('ota_interrupted');
    }

    const conns = wsMgr.listConnections() || [];
    const hit = conns.find((c) => c.ip === ip && c.type === 'ws' && c.state === 'open');
    if (hit) return true;

    try {
      const res = await wsMgr.connect(ip);
      if (res && res.ok) {
        return true;
      }
    } catch (e) {
      // Ignore and retry.
    }
    await delay(OTA_RECONNECT_ACTIVE_INTERVAL_MS);
  }
  throw new Error(`ws reconnect timeout: ${ip}`);
}

async function tryProbeAnySerialByDeviceId(expectedDeviceId) {
  const ports = await wsMgr.listSerialPorts();
  for (const p of ports) {
    if (!p || !p.path) continue;
    try {
      const res = await wsMgr.probeSerialPort({ path: p.path, timeoutMs: 900, keepOpen: true });
      if (!res || !res.ok) continue;

      const conn = getConnectionById(p.path, 'serial');
      const gotDeviceId =
        (conn && conn.deviceInfo && conn.deviceInfo.deviceid) ||
        (res.deviceInfo && res.deviceInfo.deviceid) ||
        '';

      if (!expectedDeviceId || (gotDeviceId && gotDeviceId === expectedDeviceId)) {
        return p.path;
      }

      wsMgr.disconnect(p.path);
    } catch (e) {
      // Try next port.
    }
  }

  return null;
}

async function waitForSerialReconnect(pathId, timeoutMs = OTA_RECONNECT_TIMEOUT_MS, requireDisconnect = false, expectedDeviceId = '') {
  if (requireDisconnect) {
    await waitForTransportDisconnect(pathId, 'serial', Math.min(timeoutMs, 50000));
  }

  const start = Date.now();
  let scanTick = 0;

  while (Date.now() - start < timeoutMs) {
    if (otaInterruptState.requested) {
      throw new Error('ota_interrupted');
    }

    const conns = wsMgr.listConnections() || [];
    const hit = conns.find((c) => c.ip === pathId && c.type === 'serial' && c.state === 'open');
    if (hit) {
      if (!expectedDeviceId || (hit.deviceInfo && hit.deviceInfo.deviceid === expectedDeviceId)) {
        return pathId;
      }
    }

    // If port mapping changed after reboot, accept another path with same device id.
    if (expectedDeviceId) {
      const remapHit = conns.find((c) =>
        c.type === 'serial' &&
        c.state === 'open' &&
        c.deviceInfo &&
        c.deviceInfo.deviceid === expectedDeviceId);
      if (remapHit && remapHit.ip) {
        return remapHit.ip;
      }
    }

    try {
      const res = await wsMgr.probeSerialPort({ path: pathId, timeoutMs: 800, keepOpen: true });
      if (res && res.ok) {
        const conn = getConnectionById(pathId, 'serial');
        const gotDeviceId =
          (conn && conn.deviceInfo && conn.deviceInfo.deviceid) ||
          (res.deviceInfo && res.deviceInfo.deviceid) ||
          '';
        if (!expectedDeviceId || (gotDeviceId && gotDeviceId === expectedDeviceId)) {
          return pathId;
        }
      }
    } catch (e) {
      // Ignore and retry.
    }

    scanTick += 1;
    if (scanTick % 6 === 0) {
      const remappedPath = await tryProbeAnySerialByDeviceId(expectedDeviceId);
      if (remappedPath) {
        return remappedPath;
      }
    }

    await delay(1400);
  }
  throw new Error(`serial reconnect timeout: ${pathId}`);
}

function parseMissingRanges(rangesText, totalChunks) {
  if (typeof rangesText !== 'string') return [];
  const text = rangesText.trim();
  if (!text) return [];

  const seqs = new Set();
  const chunks = text.split(',');
  for (const partRaw of chunks) {
    const part = partRaw.trim();
    if (!part) continue;
    if (part.includes('-')) {
      const [s, e] = part.split('-').map((n) => Number(n));
      if (!Number.isInteger(s) || !Number.isInteger(e) || s < 0 || e < s) continue;
      const end = totalChunks > 0 ? Math.min(e, totalChunks - 1) : e;
      for (let i = s; i <= end; i++) {
        seqs.add(i);
      }
      continue;
    }

    const one = Number(part);
    if (Number.isInteger(one) && one >= 0 && (totalChunks <= 0 || one < totalChunks)) {
      seqs.add(one);
    }
  }

  return Array.from(seqs).sort((a, b) => a - b);
}

function createOtaAckTracker(deviceId, totalChunks, progressState, logicalTarget, transport, oldVersion) {
  const onMessage = (event) => {
    if (!event || event.ip !== deviceId) return;
    const msg = event.msg || {};
    if (msg.cmd !== 'ota_progress') return;

    const seq = Number(msg.seq);
    if (Number.isInteger(seq) && seq >= 0 && seq < totalChunks) {
      progressState.ackedSeqSet.add(seq);
      progressState.ackPercent = Math.floor((progressState.ackedSeqSet.size * 100) / totalChunks);
    } else if (Number.isFinite(Number(msg.percent))) {
      progressState.ackPercent = Math.max(progressState.ackPercent, Number(msg.percent));
    }

    const key = `${progressState.sendPercent}/${progressState.ackPercent}`;
    if (key === progressState.lastProgressKey) return;
    progressState.lastProgressKey = key;

    emitOtaProgress({
      target: logicalTarget,
      transport,
      stage: 'transfer',
      status: 'running',
      percent: progressState.sendPercent,
      sendPercent: progressState.sendPercent,
      ackPercent: progressState.ackPercent,
      oldVersion,
      message: `发送 ${progressState.sendPercent}% / 回执 ${progressState.ackPercent}%`,
    });
  };

  wsMgr.on('ws-message', onMessage);
  return {
    stop: () => wsMgr.off('ws-message', onMessage),
  };
}

async function waitForWsAckWindow(progressState, projectedSendPercent, logicalTarget, transport, oldVersion) {
  const start = Date.now();
  let emittedWaitHint = false;

  while (projectedSendPercent - progressState.ackPercent > OTA_WS_MAX_ACK_GAP_PERCENT) {
    if (otaInterruptState.requested) {
      throw new Error('ota_interrupted');
    }

    if (!emittedWaitHint) {
      emittedWaitHint = true;
      const gap = Math.max(0, projectedSendPercent - progressState.ackPercent);
      emitOtaProgress({
        target: logicalTarget,
        transport,
        stage: 'transfer',
        status: 'running',
        percent: progressState.sendPercent,
        sendPercent: progressState.sendPercent,
        ackPercent: progressState.ackPercent,
        oldVersion,
        message: `WS流控: 发送领先 ${gap}% ，等待回执追平`,
      });
    }

    if (Date.now() - start > OTA_WS_ACK_GAP_WAIT_TIMEOUT_MS) {
      throw new Error(`ota_ws_ack_window_timeout(send=${projectedSendPercent},ack=${progressState.ackPercent})`);
    }

    await delay(30);
  }
}

async function sendChunkListWithFlowControl(deviceId, firmwareInfo, seqList, chunkSize, transport, progressState, logicalTarget, oldVersion) {
  const totalChunks = progressState.totalChunks;

  for (let i = 0; i < seqList.length; i++) {
    if (otaInterruptState.requested) {
      throw new Error('ota_interrupted');
    }

    const seq = seqList[i];
    if (!Number.isInteger(seq) || seq < 0 || seq >= totalChunks) continue;

    if (transport === 'ws') {
      const nextSentCount = progressState.sentSeqSet.has(seq)
        ? progressState.sentSeqSet.size
        : (progressState.sentSeqSet.size + 1);
      const projectedSendPercent = Math.floor((nextSentCount * 100) / totalChunks);
      await waitForWsAckWindow(progressState, projectedSendPercent, logicalTarget, transport, oldVersion);
    }

    const offset = seq * chunkSize;
    const chunk = firmwareInfo.buffer.subarray(offset, Math.min(offset + chunkSize, firmwareInfo.buffer.length));
    const chunkB64 = chunk.toString('base64');

    if (transport === 'serial') {
      await sendAndWait(
        deviceId,
        { cmd: 'ota_chunk', seq, offset, data: chunkB64 },
        (m) => m && m.cmd === 'ota_progress' && Number(m.seq) === seq,
        OTA_SERIAL_CHUNK_ACK_TIMEOUT_MS,
        true
      );
    } else {
      wsMgr.sendToDevice(deviceId, { cmd: 'ota_chunk', seq, offset, data: chunkB64 });
    }

    progressState.sentSeqSet.add(seq);
    const newSendPercent = Math.floor((progressState.sentSeqSet.size * 100) / totalChunks);
    if (newSendPercent !== progressState.sendPercent) {
      progressState.sendPercent = newSendPercent;
      const key = `${progressState.sendPercent}/${progressState.ackPercent}`;
      if (key !== progressState.lastProgressKey) {
        progressState.lastProgressKey = key;
        emitOtaProgress({
          target: logicalTarget,
          transport,
          stage: 'transfer',
          status: 'running',
          percent: progressState.sendPercent,
          sendPercent: progressState.sendPercent,
          ackPercent: progressState.ackPercent,
          oldVersion,
          message: `发送 ${progressState.sendPercent}% / 回执 ${progressState.ackPercent}%`,
        });
      }
    }

    if (transport === 'ws' && (i + 1) % 12 === 0) {
      await delay(0);
    }
  }
}

async function upgradeSingleDevice(deviceId, firmwareInfo) {
  const logicalTarget = deviceId;
  const conns = wsMgr.listConnections() || [];
  const conn = conns.find((c) => c.ip === deviceId);
  if (!conn) {
    throw new Error('device-not-connected');
  }

  const transport = conn.type === 'serial' ? 'serial' : (isIPv4Address(deviceId) ? 'ws' : 'serial');
  const chunkSize = transport === 'serial' ? OTA_CHUNK_SIZE_SERIAL : OTA_CHUNK_SIZE_WS;
  const totalChunks = Math.ceil(firmwareInfo.buffer.length / chunkSize);
  otaActiveSessions.set(deviceId, { transport });
  otaInterruptState.currentDeviceId = deviceId;
  otaInterruptState.currentTransport = transport;

  try {

  emitOtaProgress({
    target: logicalTarget,
    transport,
    stage: 'prepare',
    status: 'running',
    percent: 0,
    message: '读取设备当前固件信息',
  });

  const oldInfo = await queryFirmwareInfo(deviceId, 4);
  const oldVersion = oldInfo.version || 'unknown';
  const serialDeviceId = transport === 'serial'
    ? ((conn.deviceInfo && conn.deviceInfo.deviceid) || '')
    : '';

  await sendAndWait(
    deviceId,
    {
      cmd: 'ota_begin',
      size: firmwareInfo.size,
      sha256: firmwareInfo.sha256,
      version: firmwareInfo.version,
      chunks: totalChunks,
    },
    (m) => m && m.cmd === 'ota_begin_ack',
    10000,
    true
  );

  emitOtaProgress({
    target: logicalTarget,
    transport,
    stage: 'transfer',
    status: 'running',
    percent: 0,
    sendPercent: 0,
    ackPercent: 0,
    oldVersion,
    message: transport === 'serial'
      ? 'USB模式：逐包发送并等待回执（蓝=发送，绿=回执）'
      : `WS模式：窗口发送，限制 发送-回执<=${OTA_WS_MAX_ACK_GAP_PERCENT}%`,
  });

  const progressState = {
    totalChunks,
    sendPercent: 0,
    ackPercent: 0,
    sentSeqSet: new Set(),
    ackedSeqSet: new Set(),
    lastProgressKey: '',
  };
  const ackTracker = createOtaAckTracker(deviceId, totalChunks, progressState, logicalTarget, transport, oldVersion);

  try {
    const allSeq = Array.from({ length: totalChunks }, (_, i) => i);

    await sendChunkListWithFlowControl(
      deviceId,
      firmwareInfo,
      allSeq,
      chunkSize,
      transport,
      progressState,
      logicalTarget,
      oldVersion
    );

    await delay(500);

    const maxRetransmitRounds = 8;
    let downloadCompleted = false;

    for (let round = 0; round <= maxRetransmitRounds; round++) {
      if (otaInterruptState.requested) {
        throw new Error('ota_interrupted');
      }

      const endResp = await sendAndWait(
        deviceId,
        { cmd: 'ota_end' },
        (m) => m && (m.cmd === 'ota_download_complete' || m.cmd === 'ota_validate'),
        45000,
        true
      );

      if (endResp && endResp.cmd === 'ota_download_complete') {
        downloadCompleted = true;
        break;
      }

      const reason = endResp && endResp.reason ? String(endResp.reason) : 'unknown';
      const missingRanges = endResp && endResp.missing_ranges ? String(endResp.missing_ranges) : '';
      const missingSeqs = parseMissingRanges(missingRanges, totalChunks);

      if (reason === 'missing_chunks' && missingSeqs.length > 0 && round < maxRetransmitRounds) {
        emitOtaProgress({
          target: logicalTarget,
          transport,
          stage: 'retransmit',
          status: 'running',
          percent: progressState.sendPercent,
          sendPercent: progressState.sendPercent,
          ackPercent: progressState.ackPercent,
          oldVersion,
          message: `检测到丢块 ${missingSeqs.length} 个，开始重传（第 ${round + 1} 轮）`,
        });

        await sendChunkListWithFlowControl(
          deviceId,
          firmwareInfo,
          missingSeqs,
          chunkSize,
          transport,
          progressState,
          logicalTarget,
          oldVersion
        );

        await delay(700);
        continue;
      }

      throw new Error(`ota_validate_failed(${reason}), missing_ranges=${missingRanges || 'none'}`);
    }

    if (!downloadCompleted) {
      throw new Error('ota_retransmit_exhausted');
    }
  } finally {
    ackTracker.stop();
  }

  emitOtaProgress({
    target: logicalTarget,
    transport,
    stage: 'rebooting',
    status: 'running',
    percent: 100,
    sendPercent: 100,
    ackPercent: progressState ? progressState.ackPercent : 0,
    oldVersion,
    message: '固件下载完成，等待设备重启并重连',
  });

  let postCheckError = '';
  let newVersion = 'unknown';

  try {
    if (transport === 'ws') {
      try {
        wsMgr.disconnect(deviceId);
      } catch (e) {
        // Ignore disconnect races after OTA complete.
      }

      emitOtaProgress({
        target: logicalTarget,
        transport,
        stage: 'done',
        status: 'success',
        percent: 100,
        sendPercent: 100,
        ackPercent: progressState ? progressState.ackPercent : 100,
        oldVersion,
        newVersion: 'unknown',
        message: 'WS传输完成，升级成功，连接已自动断开',
      });

      return {
        target: logicalTarget,
        transport,
        ok: true,
        oldVersion,
        newVersion: 'unknown',
        postCheckError: '',
      };
    } else {
      const recoveredPath = await waitForSerialReconnect(deviceId, OTA_RECONNECT_TIMEOUT_MS, true, serialDeviceId);
      if (recoveredPath && recoveredPath !== deviceId) {
        deviceId = recoveredPath;
      }
    }

    await delay(1500);

    const newInfo = await queryFirmwareInfo(deviceId, 12);
    newVersion = newInfo.version || 'unknown';
    if (!newInfo || (newInfo.error && newVersion === 'unknown')) {
      postCheckError = newInfo && newInfo.error ? newInfo.error : 'query-new-version-failed';
    }
  } catch (e) {
    postCheckError = e && e.message ? e.message : String(e);
  }

  // 协议要求：传输完成并通过校验即判定 OTA 成功。
  const ok = true;
  const successMessage = postCheckError
    ? `升级成功（校验已通过），但重连/版本读取失败: ${postCheckError}`
    : (newVersion !== 'unknown'
      ? `升级成功（校验已通过），当前版本 ${newVersion}`
      : '升级成功（校验已通过），可手动刷新版本');

  emitOtaProgress({
    target: logicalTarget,
    transport,
    stage: 'done',
    status: 'success',
    percent: 100,
    sendPercent: 100,
    ackPercent: 100,
    oldVersion,
    newVersion,
    message: successMessage,
  });

  return {
    target: logicalTarget,
    transport,
    ok,
    oldVersion,
    newVersion,
    postCheckError,
  };

  } finally {
    otaActiveSessions.delete(deviceId);
    otaInterruptState.currentDeviceId = '';
    otaInterruptState.currentTransport = '';
  }
}

async function startOtaForTargets({ targets, filePath }) {
  if (otaBusy) {
    throw new Error('ota-task-busy');
  }

  otaInterruptState.requested = false;
  otaInterruptState.reason = '';
  otaInterruptState.currentDeviceId = '';
  otaInterruptState.currentTransport = '';

  otaBusy = true;
  try {
    if (!Array.isArray(targets) || targets.length === 0) {
      throw new Error('no-target-selected');
    }

    const binInfo = inspectFirmwareBin(filePath);
    if (!binInfo.ok) {
      throw new Error(`invalid-firmware-bin: ${binInfo.error}`);
    }

    const tasks = targets.map(async (target) => {
      if (otaInterruptState.requested) {
        emitOtaProgress({
          target,
          stage: 'interrupted',
          status: 'error',
          percent: 0,
          message: '升级任务已中断',
        });
        return { target, ok: false, error: 'ota_interrupted' };
      }

      emitOtaProgress({
        target,
        stage: 'queued',
        status: 'running',
        percent: 0,
        message: '已加入升级队列',
      });

      try {
        return await upgradeSingleDevice(target, binInfo);
      } catch (e) {
        const failMsg = e && e.message ? e.message : String(e);
        if (isOtaInterruptedError(e)) {
          otaInterruptState.requested = true;
          emitOtaProgress({
            target,
            stage: 'interrupted',
            status: 'error',
            percent: 0,
            message: '升级已中断',
          });
          return { target, ok: false, error: 'ota_interrupted' };
        }

        emitOtaProgress({
          target,
          stage: 'failed',
          status: 'error',
          percent: 0,
          message: `升级失败: ${failMsg}`,
        });
        return { target, ok: false, error: failMsg };
      }
    });

    const results = await Promise.all(tasks);

    const { buffer, ...publicInfo } = binInfo;
    return {
      ok: true,
      firmware: publicInfo,
      results,
    };
  } finally {
    otaBusy = false;
    otaInterruptState.requested = false;
    otaInterruptState.reason = '';
    otaInterruptState.currentDeviceId = '';
    otaInterruptState.currentTransport = '';
    otaActiveSessions.clear();
  }
}

async function queryOtaDeviceVersions({ targets }) {
  if (!Array.isArray(targets) || targets.length === 0) {
    return { ok: true, versions: {} };
  }

  const conns = wsMgr.listConnections() || [];
  const connMap = new Map(conns.map((c) => [c.ip, c]));
  const versions = {};

  for (const target of targets) {
    if (!target || typeof target !== 'string') continue;

    const conn = connMap.get(target);
    if (!conn) {
      versions[target] = {
        ok: false,
        version: '未知',
        error: 'device-not-connected',
      };
      continue;
    }

    try {
      const info = await queryFirmwareInfo(target, 2);
      if (info && info.version && info.version !== 'unknown') {
        versions[target] = {
          ok: true,
          version: info.version,
        };
      } else {
        versions[target] = {
          ok: false,
          version: '未知',
          error: info && info.error ? info.error : 'query-firmware-info-failed',
        };
      }
    } catch (e) {
      versions[target] = {
        ok: false,
        version: '未知',
        error: e && e.message ? e.message : String(e),
      };
    }
  }

  return {
    ok: true,
    versions,
  };
}

async function reconnectOtaDevice(target) {
  if (!target || typeof target !== 'string') {
    return { ok: false, error: 'invalid-target' };
  }

  const conn = getConnectionById(target);
  if (!conn) {
    return { ok: false, target, error: 'device-not-connected' };
  }

  const transport = conn.type === 'serial' ? 'serial' : 'ws';

  if (transport === 'ws') {
    try {
      wsMgr.disconnect(target);
    } catch (e) {
      // Ignore stale disconnect errors.
    }

    let lastErr = 'ws-connect-failed';
    for (let i = 0; i < 10; i++) {
      try {
        const res = await wsMgr.connect(target);
        if (res && res.ok) {
          const info = await queryFirmwareInfo(target, 2);
          return {
            ok: true,
            target,
            resolvedTarget: target,
            transport,
            version: info.version || 'unknown',
          };
        }
        if (res && res.error) lastErr = res.error;
      } catch (e) {
        lastErr = e && e.message ? e.message : String(e);
      }
      await delay(450);
    }

    return {
      ok: false,
      target,
      resolvedTarget: target,
      transport,
      error: lastErr,
    };
  }

  const expectedDeviceId = conn.deviceInfo && conn.deviceInfo.deviceid
    ? String(conn.deviceInfo.deviceid)
    : '';

  try {
    wsMgr.disconnect(target);
  } catch (e) {
    // Ignore stale disconnect errors.
  }

  await delay(160);

  let resolvedTarget = target;
  let lastErr = 'serial-reconnect-failed';

  for (let i = 0; i < 12; i++) {
    try {
      const res = await wsMgr.probeSerialPort({ path: resolvedTarget, timeoutMs: 900, keepOpen: true });
      if (res && res.ok) {
        const hit = getConnectionById(resolvedTarget, 'serial');
        const gotDeviceId =
          (hit && hit.deviceInfo && hit.deviceInfo.deviceid) ||
          (res.deviceInfo && res.deviceInfo.deviceid) ||
          '';
        if (!expectedDeviceId || (gotDeviceId && gotDeviceId === expectedDeviceId)) {
          const info = await queryFirmwareInfo(resolvedTarget, 2);
          return {
            ok: true,
            target,
            resolvedTarget,
            transport,
            deviceId: expectedDeviceId || gotDeviceId || '',
            version: info.version || 'unknown',
          };
        }

        wsMgr.disconnect(resolvedTarget);
      } else if (res && res.error) {
        lastErr = res.error;
      }
    } catch (e) {
      lastErr = e && e.message ? e.message : String(e);
    }

    if ((i + 1) % 3 === 0) {
      const remappedPath = await tryProbeAnySerialByDeviceId(expectedDeviceId);
      if (remappedPath) {
        resolvedTarget = remappedPath;
        const info = await queryFirmwareInfo(remappedPath, 2);
        return {
          ok: true,
          target,
          resolvedTarget: remappedPath,
          transport,
          deviceId: expectedDeviceId || '',
          version: info.version || 'unknown',
        };
      }
    }

    await delay(550);
  }

  return {
    ok: false,
    target,
    resolvedTarget,
    transport,
    error: lastErr,
  };
}

async function handleOtaDeviceAction({ target, action }) {
  if (otaBusy) {
    return { ok: false, target, action, error: 'ota-task-busy' };
  }

  if (!target || typeof target !== 'string') {
    return { ok: false, target: '', action, error: 'invalid-target' };
  }

  if (action === 'refresh-version') {
    const info = await queryFirmwareInfo(target, 3);
    if (info && info.version && info.version !== 'unknown') {
      return {
        ok: true,
        target,
        action,
        version: info.version,
      };
    }

    return {
      ok: false,
      target,
      action,
      version: '未知',
      error: info && info.error ? info.error : 'query-firmware-info-failed',
    };
  }

  if (action === 'reconnect') {
    const result = await reconnectOtaDevice(target);
    return {
      action,
      ...result,
    };
  }

  return {
    ok: false,
    target,
    action,
    error: 'unsupported-action',
  };
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
  setupApplicationUpdates();

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
  ipcMain.handle('app-check-update', async () => {
    if (!app.isPackaged) return { ok: false, error: 'development-mode' };
    try {
      manualUpdateCheckPending = true;
      await autoUpdater.checkForUpdates();
      return { ok: true };
    } catch (error) {
      console.error('[updater] check failed', error);
      manualUpdateCheckPending = false;
      return { ok: false, error: error.message };
    }
  });

  ipcMain.handle('app-download-update', async () => {
    if (!app.isPackaged) return { ok: false, error: 'development-mode' };
    try {
      await autoUpdater.downloadUpdate();
      return { ok: true };
    } catch (error) {
      console.error('[updater] download failed', error);
      return { ok: false, error: error.message };
    }
  });

  ipcMain.handle('app-install-update', () => {
    if (!app.isPackaged) return { ok: false, error: 'development-mode' };
    autoUpdater.quitAndInstall();
    return { ok: true };
  });

  ipcMain.handle('imu-calibration-request', async (_event, args = {}) => {
    const ip = typeof args.ip === 'string' ? args.ip.trim() : '';
    const sensor = Number.parseInt(args.sensor, 10);
    const action = args.action;
    if (!isIPv4Address(ip) || !Number.isInteger(sensor) || sensor < 0 || sensor > 4) {
      return { ok: false, error: 'invalid calibration request' };
    }

    const routes = {
      current: { path: `/api/calibration/current?sensor=${sensor}`, method: 'GET' },
      upload: { path: `/api/calibration/upload?sensor=${sensor}`, method: 'POST' },
      reset: { path: `/api/calibration/reset?sensor=${sensor}`, method: 'POST' },
    };
    const route = routes[action];
    if (!route) return { ok: false, error: 'unsupported calibration action' };

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 10000);
    try {
      const response = await fetch(`http://${ip}${route.path}`, {
        method: route.method,
        body: action === 'upload' ? String(args.payload || '') : undefined,
        signal: controller.signal,
      });
      const body = await response.json();
      return response.ok ? body : { ok: false, error: body.error || `HTTP ${response.status}` };
    } catch (error) {
      return { ok: false, error: error.name === 'AbortError' ? 'request timeout' : error.message };
    } finally {
      clearTimeout(timer);
    }
  });
  ipcMain.handle('getSubnets', async () => {
    return wsMgr.getLocalSubnets();
  });

  ipcMain.handle('list-serial-ports', async () => {
    return await wsMgr.listSerialPorts();
  });

  ipcMain.handle('probe-serial-port', async (event, args) => {
    return await wsMgr.probeSerialPort(args || {});
  });

  ipcMain.handle('ota-select-bin', async () => {
    const result = await dialog.showOpenDialog(mainWin, {
      title: '选择固件文件',
      properties: ['openFile'],
      filters: [{ name: 'ESP Firmware', extensions: ['bin'] }],
    });

    if (result.canceled || !result.filePaths || result.filePaths.length === 0) {
      return { canceled: true };
    }

    return { canceled: false, filePath: result.filePaths[0] };
  });

  ipcMain.handle('ota-inspect-bin', async (event, args) => {
    const info = inspectFirmwareBin(args && args.filePath ? args.filePath : '');
    if (!info.ok) return info;
    const { buffer, ...publicInfo } = info;
    return publicInfo;
  });

  ipcMain.handle('ota-start', async (event, args) => {
    try {
      return await startOtaForTargets(args || {});
    } catch (e) {
      return {
        ok: false,
        error: e && e.message ? e.message : String(e),
      };
    }
  });

  ipcMain.handle('ota-interrupt', async () => {
    return requestOtaInterrupt('user');
  });

  ipcMain.handle('ota-query-device-versions', async (event, args) => {
    try {
      return await queryOtaDeviceVersions(args || {});
    } catch (e) {
      return {
        ok: false,
        error: e && e.message ? e.message : String(e),
        versions: {},
      };
    }
  });

  ipcMain.handle('ota-device-action', async (event, args) => {
    try {
      return await handleOtaDeviceAction(args || {});
    } catch (e) {
      return {
        ok: false,
        target: args && args.target ? args.target : '',
        action: args && args.action ? args.action : '',
        error: e && e.message ? e.message : String(e),
      };
    }
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

