'use strict';

const { isIPv4Address } = require('./validation');

// Only registers the HTTP calibration bridge; no request is sent on module load.
function registerCalibrationIpc({ ipcMain }) {
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
}

module.exports = { registerCalibrationIpc };
