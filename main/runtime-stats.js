'use strict';

// Capture the initial CPU sample when the entry creates the service, before ready.
function createRuntimeStats() {
  let lastCpuSample = process.cpuUsage();
  let lastCpuSampleAt = process.hrtime.bigint();

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

  return getRuntimeStats;
}

module.exports = { createRuntimeStats };
