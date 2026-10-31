'use strict';

const { delay } = require('./timing');

// Version refresh and explicit device reconnect actions outside an active upgrade.
function createOtaDeviceActions({ wsMgr, state, transport }) {
  const { queryFirmwareInfo, getConnectionById, tryProbeAnySerialByDeviceId } = transport;

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
    if (state.busy) {
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

  return { queryOtaDeviceVersions, reconnectOtaDevice, handleOtaDeviceAction };
}

module.exports = { createOtaDeviceActions };
