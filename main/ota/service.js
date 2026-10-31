'use strict';

const { inspectFirmwareBin } = require('./firmware');
const { createOtaTransport } = require('./transport');
const { createOtaTransfer } = require('./transfer');
const { createDeviceUpgrade } = require('./upgrade');
const { createOtaDeviceActions } = require('./device-actions');

// One owner for busy/session/interrupt state. All collaborators receive the SAME
// object; no module-global state or copied primitive can diverge between devices.
function createOtaService({ wsMgr, safeSendToRenderer }) {
  const state = {
    busy: false,
    activeSessions: new Map(),
    interrupt: { requested: false, reason: '', currentDeviceId: '', currentTransport: '' },
  };

  function emitOtaProgress(payload) {
    safeSendToRenderer('ota-progress', payload);
  }

  function isOtaInterruptedError(error) {
    const text = (error && error.message ? error.message : String(error || '')).toLowerCase();
    return text.includes('ota_interrupted') || text.includes('ota interrupted') || text.includes('interrupted');
  }

  const transport = createOtaTransport({ wsMgr, state });
  const transfer = createOtaTransfer({ wsMgr, state, emitOtaProgress, sendAndWait: transport.sendAndWait });
  const upgradeSingleDevice = createDeviceUpgrade({ wsMgr, state, emitOtaProgress, transport, transfer });
  const actions = createOtaDeviceActions({ wsMgr, state, transport });

  function requestOtaInterrupt(reason = 'user') {
    state.interrupt.requested = true;
    state.interrupt.reason = reason;

    const targets = state.activeSessions.size > 0
      ? Array.from(state.activeSessions.entries())
      : (state.interrupt.currentDeviceId ? [[state.interrupt.currentDeviceId, { transport: state.interrupt.currentTransport || '' }]] : []);

    if (state.busy && wsMgr && targets.length > 0) {
      targets.forEach(([target, session]) => {
        try {
          wsMgr.sendToDevice(target, { cmd: 'ota_abort' });
          emitOtaProgress({
            target,
            transport: session && session.transport ? session.transport : state.interrupt.currentTransport || '',
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
      busy: state.busy,
      currentTarget: state.interrupt.currentDeviceId || null,
    };
  }

  async function startOtaForTargets({ targets, filePath }) {
    if (state.busy) {
      throw new Error('ota-task-busy');
    }

    state.interrupt.requested = false;
    state.interrupt.reason = '';
    state.interrupt.currentDeviceId = '';
    state.interrupt.currentTransport = '';

    state.busy = true;
    try {
      if (!Array.isArray(targets) || targets.length === 0) {
        throw new Error('no-target-selected');
      }

      const binInfo = inspectFirmwareBin(filePath);
      if (!binInfo.ok) {
        throw new Error(`invalid-firmware-bin: ${binInfo.error}`);
      }

      const tasks = targets.map(async (target) => {
        if (state.interrupt.requested) {
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
            state.interrupt.requested = true;
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
      state.busy = false;
      state.interrupt.requested = false;
      state.interrupt.reason = '';
      state.interrupt.currentDeviceId = '';
      state.interrupt.currentTransport = '';
      state.activeSessions.clear();
    }
  }

  return { inspectFirmwareBin, requestOtaInterrupt, startOtaForTargets, ...actions };
}

module.exports = { createOtaService };
