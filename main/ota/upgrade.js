'use strict';

const { isIPv4Address } = require('../validation');
const { delay } = require('./timing');
const { OTA_CHUNK_SIZE_SERIAL, OTA_CHUNK_SIZE_WS, OTA_WS_MAX_ACK_GAP_PERCENT, OTA_RECONNECT_TIMEOUT_MS } = require('./constants');

// The per-device prepare/transfer/retry/reboot state machine.
function createDeviceUpgrade({ wsMgr, state, emitOtaProgress, transport, transfer }) {
  const { queryFirmwareInfo, sendAndWait, waitForSerialReconnect } = transport;
  const { createOtaAckTracker, sendChunkListWithFlowControl, parseMissingRanges } = transfer;

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
    state.activeSessions.set(deviceId, { transport });
    state.interrupt.currentDeviceId = deviceId;
    state.interrupt.currentTransport = transport;

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
        if (state.interrupt.requested) {
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
      state.activeSessions.delete(deviceId);
      state.interrupt.currentDeviceId = '';
      state.interrupt.currentTransport = '';
    }
  }

  return upgradeSingleDevice;
}

module.exports = { createDeviceUpgrade };
