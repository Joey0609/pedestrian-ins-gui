'use strict';

const { delay } = require('./timing');
const { OTA_WAIT_TIMEOUT_MS, OTA_RECONNECT_TIMEOUT_MS, OTA_RECONNECT_ACTIVE_INTERVAL_MS } = require('./constants');

// Message waits, transport liveness and reconnects all observe the service's shared state.
function createOtaTransport({ wsMgr, state }) {
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
      if (state.interrupt.requested) {
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
      if (state.interrupt.requested) {
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
      if (state.interrupt.requested) {
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

  return { waitForDeviceMessage, sendAndWait, queryFirmwareInfo, getConnectionById, isTransportOpen, waitForTransportDisconnect, waitForWsReconnect, tryProbeAnySerialByDeviceId, waitForSerialReconnect };
}

module.exports = { createOtaTransport };
