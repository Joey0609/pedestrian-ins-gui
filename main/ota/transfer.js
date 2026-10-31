'use strict';

const { delay } = require('./timing');
const { OTA_WS_MAX_ACK_GAP_PERCENT, OTA_WS_ACK_GAP_WAIT_TIMEOUT_MS, OTA_SERIAL_CHUNK_ACK_TIMEOUT_MS } = require('./constants');

// Firmware chunk protocol, progress acknowledgements and WS/serial flow control.
function createOtaTransfer({ wsMgr, state, emitOtaProgress, sendAndWait }) {
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
      if (state.interrupt.requested) {
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
      if (state.interrupt.requested) {
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

  return { parseMissingRanges, createOtaAckTracker, waitForWsAckWindow, sendChunkListWithFlowControl };
}

module.exports = { createOtaTransfer };
