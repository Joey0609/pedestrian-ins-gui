// wsManager.js
const WebSocket = require('ws');
const os = require('os');
const child_process = require('child_process');
const EventEmitter = require('events');
const { networkInterfaces } = os;
const iconv = require('iconv-lite');
const BMI088_NUM = 4; // Number of BMI088 IMUs connected
const USB_PC_HEARTBEAT_CMD = 'CtrlPChost';
const USB_PC_HEARTBEAT_INTERVAL_MS = 12000;

let SerialPort = null;
try {
  ({ SerialPort } = require('serialport'));
} catch (e) {
  SerialPort = null;
}

function pullJsonObjectsFromAccumulator(acc) {
  const jsonStrings = [];
  let depth = 0;
  let inString = false;
  let escaped = false;
  let start = -1;

  for (let i = 0; i < acc.length; i++) {
    const ch = acc[i];

    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (ch === '\\') {
        escaped = true;
      } else if (ch === '"') {
        inString = false;
      }
      continue;
    }

    if (ch === '"') {
      inString = true;
      continue;
    }

    if (ch === '{') {
        // 仅在该 '{' 位于其行的前 10 个字符内时，才将其视为 JSON 起始。
        // 向前查找最近的换行符以确定行首位置。
        const lastNl = acc.lastIndexOf('\n', i - 1);
        const lastCr = acc.lastIndexOf('\r', i - 1);
        let lineStart = Math.max(lastNl, lastCr);
        if (lineStart === -1) lineStart = 0; else lineStart = lineStart + 1;
        const offsetInLine = i - lineStart;
        if (offsetInLine < 10) {
          if (depth === 0) start = i;
        } else {
          // 忽略此 '{'，它出现在当前行前 10 字符之外（可能是杂数据）
          continue;
        }
      depth += 1;
      continue;
    }

    if (ch === '}') {
      depth -= 1;
      if (depth === 0 && start >= 0) {
        jsonStrings.push(acc.slice(start, i + 1));
        start = -1;
      }
      continue;
    }
  }

  if (depth > 0 && start >= 0) {
    return { jsonStrings, rest: acc.slice(start) };
  }
  return { jsonStrings, rest: '' };
}

function safeJsonParse(raw) {
  try {
    return JSON.parse(raw);
  } catch (e) {
    return null;
  }
}

function previewFrameData(data, limit = 128) {
  if (data == null) return { kind: 'null', length: 0, text: '' };
  if (typeof data === 'string') {
    return {
      kind: 'string',
      length: data.length,
      text: data.slice(0, limit),
    };
  }

  const buffer = Buffer.isBuffer(data) ? data : Buffer.from(data);
  const hex = buffer.subarray(0, limit).toString('hex').match(/.{1,2}/g)?.join(' ') || '';
  const utf8 = buffer.toString('utf8', 0, Math.min(buffer.length, limit));
  const latin1 = buffer.toString('latin1', 0, Math.min(buffer.length, limit));
  return {
    kind: Buffer.isBuffer(data) ? 'buffer' : data?.constructor?.name || 'binary',
    length: buffer.length,
    hex,
    utf8,
    latin1,
  };
}

function cidrToRange(base, cidr) {
  const parts = base.split('.').map(Number);
  const hostBits = 32 - cidr;
  const total = 2 ** hostBits;
  const baseInt = (parts[0] << 24) + (parts[1] << 16) + (parts[2] << 8) + parts[3];
  const ips = [];
  for (let i = 1; i < Math.max(2, total - 1); i++) {
    const ipInt = baseInt + i;
    ips.push(((ipInt >> 24) & 255) + '.' + ((ipInt >> 16) & 255) + '.' + ((ipInt >> 8) & 255) + '.' + (ipInt & 255));
  }
  return ips;
}

class WSManager extends EventEmitter {
  constructor() {
    super();
    this.conns = {};
    this.serialConns = {};
    this._cancelScan = false;
    this._serialHeartbeatTimer = setInterval(() => {
      this._sendSerialHeartbeats();
    }, USB_PC_HEARTBEAT_INTERVAL_MS);
    if (typeof this._serialHeartbeatTimer.unref === 'function') {
      this._serialHeartbeatTimer.unref();
    }

    // Performance counters for ws message rates and connection events
    this._perf = { counters: {} };
    this._perfTimer = setInterval(() => {
      try {
        const lines = [];
        // WS connections
        Object.keys(this.conns || {}).forEach(ip => {
          const c = this.conns[ip];
          const cnt = (this._perf.counters[ip] && this._perf.counters[ip].msgs) ? this._perf.counters[ip].msgs : 0;
          lines.push(`[WS-PERF] ${ip} state=${c && c.state ? c.state : 'unknown'} msgs/s=${cnt}`);
          if (this._perf.counters[ip]) this._perf.counters[ip].msgs = 0;
        });
        // Serial connections
        Object.keys(this.serialConns || {}).forEach(p => {
          const c = this.serialConns[p];
          const key = `serial:${p}`;
          const cnt = (this._perf.counters[key] && this._perf.counters[key].msgs) ? this._perf.counters[key].msgs : 0;
          lines.push(`[WS-PERF] ${p} state=${c && c.state ? c.state : 'unknown'} msgs/s=${cnt}`);
          if (this._perf.counters[key]) this._perf.counters[key].msgs = 0;
        });
        if (lines.length) console.log(lines.join('\n'));
      } catch (e) {
        console.warn('Perf logging failed', e && e.message ? e.message : e);
      }
    }, 1000);
    if (typeof this._perfTimer.unref === 'function') this._perfTimer.unref();

    // Auto reconnect config/state (for ws only)
    this._manualDisconnectIPs = new Set();
    this._reconnectState = {};
    this._reconnectMaxRetries = 3;
    this._reconnectDelayMs = 5000;
  }

  _incPerfMsg(ip, isSerial = false) {
    const key = isSerial ? `serial:${ip}` : ip;
    if (!this._perf.counters[key]) this._perf.counters[key] = { msgs: 0 };
    this._perf.counters[key].msgs = (this._perf.counters[key].msgs || 0) + 1;
  }

  _markManualDisconnect(ip) {
    this._manualDisconnectIPs.add(ip);
    const state = this._reconnectState[ip];
    if (state && state.timer) {
      clearTimeout(state.timer);
      state.timer = null;
    }
    delete this._reconnectState[ip];
  }

  _markConnected(ip) {
    this._manualDisconnectIPs.delete(ip);
    const state = this._reconnectState[ip];
    if (state && state.timer) {
      clearTimeout(state.timer);
      state.timer = null;
    }
    this._reconnectState[ip] = { attempts: 0, timer: null };
  }

  _scheduleReconnect(ip, reason = 'close') {
    if (!ip || this._manualDisconnectIPs.has(ip)) return;
    const conn = this.conns[ip];
    if (conn && conn.ws && conn.ws.readyState === WebSocket.OPEN) return;

    if (!this._reconnectState[ip]) this._reconnectState[ip] = { attempts: 0, timer: null };
    const state = this._reconnectState[ip];
    if (state.timer) return;

    if (state.attempts >= this._reconnectMaxRetries) {
      console.warn(`[WS RECONNECT] ${ip} reached max retries (${this._reconnectMaxRetries}), stop reconnecting`);
      return;
    }

    state.attempts += 1;
    const attempt = state.attempts;
    console.warn(`[WS RECONNECT] ${ip} attempt ${attempt}/${this._reconnectMaxRetries} in ${this._reconnectDelayMs / 1000}s (reason=${reason})`);

    state.timer = setTimeout(async () => {
      state.timer = null;
      if (this._manualDisconnectIPs.has(ip)) return;

      try {
        const res = await this.connect(ip);
        if (res && res.ok) {
          console.log(`[WS RECONNECT] ${ip} reconnected on attempt ${attempt}`);
          return;
        }
        console.warn(`[WS RECONNECT] ${ip} attempt ${attempt} failed`, res && res.error ? res.error : res);
      } catch (e) {
        console.warn(`[WS RECONNECT] ${ip} attempt ${attempt} error`, e && e.message ? e.message : e);
      }

      if (!this._manualDisconnectIPs.has(ip)) {
        this._scheduleReconnect(ip, 'retry-failed');
      }
    }, this._reconnectDelayMs);

    if (typeof state.timer.unref === 'function') {
      state.timer.unref();
    }
  }

  _sendSerialHeartbeat(path, port) {
    if (!port || !port.isOpen) return false;
    try {
      port.write(`${USB_PC_HEARTBEAT_CMD}\r\n`);
      console.log(`[serial:${path}] TX heartbeat: ${USB_PC_HEARTBEAT_CMD}`);
      return true;
    } catch (e) {
      console.warn(`[serial:${path}] heartbeat write failed:`, e && e.message ? e.message : e);
      return false;
    }
  }

  _sendSerialHeartbeats() {
    const paths = Object.keys(this.serialConns);
    for (const path of paths) {
      const conn = this.serialConns[path];
      if (!conn || !conn.port) continue;
      this._sendSerialHeartbeat(path, conn.port);
    }
  }

  _isValidDeviceInfo(msg) {
    return !!(
      msg &&
      typeof msg.deviceid === 'string' &&
      msg.deviceid.length > 0 &&
      typeof msg.ip_addr === 'string' &&
      msg.ip_addr.length > 0 &&
      typeof msg.wifi_mac === 'string' &&
      msg.wifi_mac.length > 0
    );
  }

  _writeSerialCommand(port, obj) {
    try {
      const payload = JSON.stringify(obj) + '\n';
      port.write(payload);
      return true;
    } catch (e) {
      return false;
    }
  }

  _handleSerialChunk(path, chunk) {
    const conn = this.serialConns[path];
    if (!conn) return;
    try { this._incPerfMsg(path, true); } catch (e) {}
    // 先按行尝试快速解析：如果某一行在前10字符内出现 '{'，则认为该行可能是 JSON 并尝试解析
    const chunkStr = Buffer.isBuffer(chunk) ? chunk.toString('utf8') : String(chunk);
    const parts = chunkStr.split(/\r?\n/);
    const remainderParts = [];
    for (let i = 0; i < parts.length; i++) {
      const line = parts[i];
      if (!line || line.length === 0) {
        // 保留空行到 remainder（以防分段）
        remainderParts.push(line);
        continue;
      }
      const idx = line.indexOf('{');
      if (idx >= 0 && idx < 10) {
        const candidate = line.slice(idx);
        const msg = safeJsonParse(candidate);
        if (msg) {
          conn.lastMsg = msg;
          if (this._isValidDeviceInfo(msg)) {
            conn.deviceInfo = {
              ts: msg.ts,
              deviceid: msg.deviceid,
              ip_addr: msg.ip_addr,
              wifi_mac: msg.wifi_mac,
            };
          }
          this.emit('ws-message', { ip: path, msg, source: 'serial' });
          // 已处理该行，跳过将其加入累积缓冲
          continue;
        }
      }
      // 未被即时处理，保留到累积缓冲中以便后续的粘包/分片处理
      remainderParts.push(line);
    }

    // 将未处理部分追加到连接的原始缓冲并尝试用原有的 JSON 提取器解析
    conn.rawBuffer += remainderParts.join('\n');
    const { jsonStrings, rest } = pullJsonObjectsFromAccumulator(conn.rawBuffer);
    conn.rawBuffer = rest;

    jsonStrings.forEach((raw) => {
      const msg = safeJsonParse(raw);
      if (!msg) return;
      conn.lastMsg = msg;
      if (this._isValidDeviceInfo(msg)) {
        conn.deviceInfo = {
          ts: msg.ts,
          deviceid: msg.deviceid,
          ip_addr: msg.ip_addr,
          wifi_mac: msg.wifi_mac,
        };
      }
      this.emit('ws-message', { ip: path, msg, source: 'serial' });
    });
  }

  async listSerialPorts() {
    const map = new Map();

    if (SerialPort) {
      try {
        const ports = await SerialPort.list();
        ports.forEach((p) => {
          const key = String(p.path || '').toUpperCase();
          if (!key) return;
          map.set(key, {
            path: p.path,
            manufacturer: p.manufacturer || '',
            serialNumber: p.serialNumber || '',
            friendlyName: p.friendlyName || '',
            vendorId: p.vendorId || '',
            productId: p.productId || '',
          });
        });
      } catch (e) {
        // ignore and fallback to mode list below
      }
    }

    // Windows 上补充使用 `mode` 枚举，避免某些虚拟串口未出现在 serialport.list()。
    try {
      const out = child_process.execSync('cmd /c mode', { encoding: 'buffer', windowsHide: true, timeout: 4000 });
      const txt = iconv.decode(out, 'cp936');
      const re = /\b(COM\d+):/gi;
      let m;
      while ((m = re.exec(txt)) !== null) {
        const com = (m[1] || '').toUpperCase();
        if (!com) continue;
        if (!map.has(com)) {
          map.set(com, {
            path: com,
            manufacturer: '',
            serialNumber: '',
            friendlyName: 'mode-detected',
            vendorId: '',
            productId: '',
          });
        }
      }
    } catch (e) {
      // ignore mode fallback failures
    }

    const list = Array.from(map.values());
    list.sort((a, b) => {
      const ma = String(a.path || '').match(/^COM(\d+)$/i);
      const mb = String(b.path || '').match(/^COM(\d+)$/i);
      const na = ma ? parseInt(ma[1], 10) : Number.MAX_SAFE_INTEGER;
      const nb = mb ? parseInt(mb[1], 10) : Number.MAX_SAFE_INTEGER;
      if (na !== nb) return na - nb;
      return String(a.path || '').localeCompare(String(b.path || ''));
    });

    return list;
  }

  async _probeSerialAtBaud({ path, baudRate, timeoutMs, keepOpen }) {
    return new Promise((resolve) => {
      let port;
      try {
        port = new SerialPort({
          path,
          baudRate,
          autoOpen: false,
        });
      } catch (e) {
        resolve({
          ok: false,
          status: 'open-failed',
          type: 'serial',
          path,
          baudRate,
          error: e && e.message ? e.message : String(e),
        });
        return;
      }

      let settled = false;
      let scanBuffer = '';
      let gotAnyMessage = false;
      let foundDeviceInfo = null;

      const cleanup = () => {
        try { port.removeAllListeners('data'); } catch (e) {}
        try { port.removeAllListeners('error'); } catch (e) {}
      };

      const finalize = async (result) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        cleanup();

        if (result.ok && keepOpen) {
          const connEntry = {
            type: 'serial',
            path,
            baudRate,
            port,
            state: 'open',
            rawBuffer: '',
            lastMsg: foundDeviceInfo,
            deviceInfo: foundDeviceInfo,
          };
          this.serialConns[path] = connEntry;
          port.on('data', (chunk) => this._handleSerialChunk(path, chunk));
          port.on('close', () => {
            if (this.serialConns[path]) {
              this.serialConns[path].state = 'closed';
              delete this.serialConns[path];
            }
            console.log('[SERIAL CLOSED]', path);
            try { if (this._perf && this._perf.counters[`serial:${path}`]) this._perf.counters[`serial:${path}`].closed = true; } catch (e) {}
          });
          port.on('error', (e) => {
            if (this.serialConns[path]) {
              this.serialConns[path].lastError = e && e.message ? e.message : String(e);
            }
          });

          // 串口连上后立即发送一次心跳，避免等待首个周期
          this._sendSerialHeartbeat(path, port);

          if (foundDeviceInfo) {
            this.emit('ws-message', { ip: path, msg: foundDeviceInfo, source: 'serial' });
          }
          resolve(result);
          return;
        }

        if (port.isOpen) {
          port.close(() => resolve(result));
          return;
        }
        resolve(result);
      };

      const onProbeData = (chunk) => {
        // 首先按行快速检查：若某行在前10字符内含 '{' 则尝试立即解析该行并处理
        const s = Buffer.isBuffer(chunk) ? chunk.toString('utf8') : String(chunk);
        let combined = scanBuffer + s;
        const lines = combined.split(/\r?\n/);
        // 最后一行可能是未结束的分片，保留到 scanBuffer
        scanBuffer = lines.pop() || '';

        for (const line of lines) {
          if (!line) continue;
          const idx = line.indexOf('{');
          if (idx >= 0 && idx < 10) {
            const candidate = line.slice(idx);
            const msg = safeJsonParse(candidate);
            if (msg) {
              gotAnyMessage = true;
              if (this._isValidDeviceInfo(msg)) {
                foundDeviceInfo = {
                  ts: msg.ts,
                  deviceid: msg.deviceid,
                  ip_addr: msg.ip_addr,
                  wifi_mac: msg.wifi_mac,
                };
                finalize({
                  ok: true,
                  status: 'connected',
                  type: 'serial',
                  path,
                  baudRate,
                  deviceInfo: foundDeviceInfo,
                });
                return;
              }
            }
          }
          // 若未即时解析成功，则将该行追加到 scanBuffer，让后续的累积器尝试解析（处理粘包/分片情况）
          scanBuffer += line + '\n';
        }

        // 仍使用原累积器做额外解析（以防 JSON 被分片或多行情况）
        const { jsonStrings, rest } = pullJsonObjectsFromAccumulator(scanBuffer);
        scanBuffer = rest;

        for (const raw of jsonStrings) {
          const msg = safeJsonParse(raw);
          if (!msg) continue;
          gotAnyMessage = true;
          if (this._isValidDeviceInfo(msg)) {
            foundDeviceInfo = {
              ts: msg.ts,
              deviceid: msg.deviceid,
              ip_addr: msg.ip_addr,
              wifi_mac: msg.wifi_mac,
            };
            finalize({
              ok: true,
              status: 'connected',
              type: 'serial',
              path,
              baudRate,
              deviceInfo: foundDeviceInfo,
            });
            return;
          }
        }
      };

      const onProbeError = (err) => {
        finalize({
          ok: false,
          status: 'open-failed',
          type: 'serial',
          path,
          baudRate,
          error: err && err.message ? err.message : String(err),
        });
      };

      port.on('data', onProbeData);
      port.on('error', onProbeError);

      const timer = setTimeout(() => {
        if (foundDeviceInfo) return;
        finalize({
          ok: false,
          status: gotAnyMessage ? 'non-esp' : 'non-esp',
          type: 'serial',
          path,
          baudRate,
          error: gotAnyMessage ? 'invalid-device-info' : 'timeout',
        });
      }, timeoutMs);

      port.open((openErr) => {
        if (openErr) {
          onProbeError(openErr);
          return;
        }
        const writeOk = this._writeSerialCommand(port, { cmd: 'getDeviceInfos' });
        if (!writeOk) {
          finalize({
            ok: false,
            status: 'open-failed',
            type: 'serial',
            path,
            baudRate,
            error: 'write-failed',
          });
        }
      });
    });
  }

  async probeSerialPort(opts = {}) {
    const path = opts.path;
    const keepOpen = opts.keepOpen !== false;
    const timeoutMs = Number(opts.timeoutMs) > 0 ? Number(opts.timeoutMs) : 500;

    if (!SerialPort) {
      return { ok: false, status: 'unsupported', type: 'serial', path, error: 'serialport-not-installed' };
    }
    if (!path) {
      return { ok: false, status: 'invalid', type: 'serial', path: '', error: 'missing-path' };
    }

    const existing = this.serialConns[path];
    if (existing && existing.port && existing.port.isOpen) {
      this._sendSerialHeartbeat(path, existing.port);
      return {
        ok: true,
        status: 'connected',
        type: 'serial',
        path,
        baudRate: existing.baudRate,
        deviceInfo: existing.deviceInfo || null,
        reused: true,
      };
    }

    const baudRates = Array.isArray(opts.baudRates) && opts.baudRates.length > 0
      ? opts.baudRates
      : [921600, 460800, 230400, 115200];

    let lastResult = null;
    for (const baudRate of baudRates) {
      const result = await this._probeSerialAtBaud({ path, baudRate, timeoutMs, keepOpen });
      lastResult = result;
      if (result.ok) return result;
      if (result.status === 'open-failed' || result.status === 'unsupported') return result;
    }

    return lastResult || { ok: false, status: 'non-esp', type: 'serial', path, error: 'probe-failed' };
  }

  getLocalSubnets() {
    const nets = networkInterfaces();
    const subnets = [];
    Object.keys(nets).forEach(ifname => {
      nets[ifname].forEach(info => {
        if (!info || !info.address || !info.netmask || info.family !== 'IPv4') return;
        const addr = info.address;
        const mask = info.netmask;
        const a = addr.split('.').map((v) => Number(v));
        const m = mask.split('.').map((v) => Number(v));
        const base = a.map((v, i) => v & m[i]).join('.') + '.0';
        let cidr = 0;
        m.forEach(byte => {
          cidr += ((byte).toString(2).match(/1/g) || []).length;
        });
        subnets.push({ ifname, addr, mask, base, cidr });
      });
    });
    return subnets;
  }

  cancelScan() {
    this._cancelScan = true;
  }
  async scanIPs(ips, timeout = 800, concurrency = 40) {
    this._cancelScan = false;
    const results = {};
    let idx = 0;
    const total = ips.length;
    const pool = new Array(Math.max(1, Math.min(concurrency, total))).fill(null).map(async () => {
      while (idx < ips.length) {
        if (this._cancelScan) break;
        const i = idx++;
        const ip = ips[i];
        this.emit('scan-progress', { ip, progress: i / ips.length });
        if (this.conns[ip] && this.conns[ip].ws && this.conns[ip].ws.readyState === WebSocket.OPEN) {
          results[ip] = 'green';
          this.emit('scan-result', { ip, status: 'green' });
          continue;
        }
        const online = await this.isHostOnline(ip, timeout * 2);
        if (!online) {
          results[ip] = 'offline';
          this.emit('scan-result', { ip, status: 'offline' });
          continue;
        } else {
          // ping ok -> send ping-status (orange-yellow)
          results[ip] = 'ping';
          this.emit('scan-result', { ip, status: 'ping' });
        }
        if (this._cancelScan) break;
        try {
          const probeRes = await this.tryConnectProbe(ip, timeout);
          if (this._cancelScan) break;
          results[ip] = probeRes.status;
          if (probeRes.status === 'connectable') {
            this.emit('scan-result', { ip, status: 'green' });
            const ws = probeRes.ws;
            // install events
            ws.on('message', (data, isBinary) => {
              try {
                // perf: count incoming ws message for this ip (scan probe socket)
                try { this._incPerfMsg(ip); } catch (e) {}
                const rawText = Buffer.isBuffer(data) ? data.toString('utf8') : data.toString();
                const msg = JSON.parse(rawText);
                // emit ws message
                // connSettings handling
                if (msg.ts <= 3){ }  // 设置信息，轨道信息，wifi设置信息，系统信息
                else if (msg.ts === 4) { 
                  console.log("Received message from", ip, ":", msg);
                  if (msg.data && typeof msg.data === 'string') {
                    try {
                      // 解码 Base64 数据
                      const binaryString = atob(msg.data);
                      const bytes = new Uint8Array(binaryString.length);
                      for (let i = 0; i < binaryString.length; i++) {
                        bytes[i] = binaryString.charCodeAt(i);
                      }
                      const view = new DataView(bytes.buffer);
                      let offset = 0;
                      // Parse the float[10][3] array
                      const positions = [];
                      for (let i = 0; i < 10; i++) {
                        const position = [];
                        for (let j = 0; j < 3; j++) {
                          position.push(view.getFloat32(offset, true)); // Little-endian
                          offset += 4;
                        }
                        positions.push(position);
                      }
                      msg.positions = positions;
                    } catch (error) {
                      console.error("Base64 解码失败:", error);
                      showNotification("INS 数据解析错误", 'error');
                      return;
                    }

                  }

                } else { /* 正常数据 */
                  if (msg.data && typeof msg.data === 'string') {
                    try {
                      // 解码 Base64 数据
                      const binaryString = atob(msg.data);
                      const bytes = new Uint8Array(binaryString.length);

                      for (let i = 0; i < binaryString.length; i++) {
                        bytes[i] = binaryString.charCodeAt(i);
                      }

                      // 使用 DataView 解析二进制数据
                      const view = new DataView(bytes.buffer);
                      let offset = 0;

                      // 解析时间戳 (8字节)
                      const timestamp = view.getBigUint64(offset, true); // 小端序
                      offset += 8;

                      // 解析传感器数据数组
                      const parseSensorArray = (count, dimensions) => {
                        const result = [];
                        for (let s = 0; s < count; s++) {
                          const sensorData = [];
                          for (let d = 0; d < dimensions; d++) {
                            sensorData.push(view.getFloat32(offset, true)); // 小端序
                            offset += 4;
                          }
                          result.push(sensorData);
                        }
                        return result;
                      };

                      // 解析标量数组
                      const parseScalarArray = (count) => {
                        const result = [];
                        for (let i = 0; i < count; i++) {
                          result.push(view.getFloat32(offset, true));
                          offset += 4;
                        }
                        return result;
                      };

                      // 解析布尔数组
                      const parseBoolArray = (count) => {
                        const result = [];
                        for (let i = 0; i < count; i++) {
                          result.push(view.getUint8(offset) !== 0);
                          offset += 1;
                        }
                        return result;
                      };

                      // 解析所有 IMU 数据字段
                      const imuData = {
                        timestamp: Number(timestamp),
                        raw_accel: parseSensorArray(BMI088_NUM + 1, 3),
                        raw_gyro: parseSensorArray(BMI088_NUM + 1, 3),
                        raw_temp: parseScalarArray(BMI088_NUM + 1),
                        quat: parseSensorArray(BMI088_NUM + 1, 4),
                        rotation_matrix: parseSensorArray(BMI088_NUM + 1, 9),
                        eular: parseSensorArray(BMI088_NUM + 1, 3),
                        linear_accel: parseSensorArray(BMI088_NUM + 1, 3),
                        earth_accel: parseSensorArray(BMI088_NUM + 1, 3),
                        kf_accel: parseSensorArray(BMI088_NUM + 1, 3),
                        kf_velocity: parseSensorArray(BMI088_NUM + 1, 3),
                        displacement: parseSensorArray(BMI088_NUM + 1, 3),
                        stationary: parseBoolArray(BMI088_NUM + 1)
                      };

                      // 将解析后的数据合并到 msg 对象
                      Object.assign(msg, imuData);
                    } catch (error) {
                      console.error("Base64 解码失败:", error);
                      showNotification("IMU 数据解析错误", 'error');
                      return;
                    }

                  }

                }
                this.conns[ip].lastMsg = msg;
                this.conns[ip].lastRawPreview = previewFrameData(data);
                this.emit('ws-message', { ip, msg });
              } catch (e) {
                console.warn('[WS DEBUG] message parse failed', ip, {
                  error: e && e.message,
                  isBinary,
                  preview: previewFrameData(data),
                });
              }
              
            });
            ws.on('close', () => {
              if (this.conns[ip]) this.conns[ip].state = 'closed';
              const manual = this._manualDisconnectIPs.has(ip);
              console.log('[WS CLOSED]', ip, manual ? '(manual)' : '(unexpected)');
              try { if (this._perf && this._perf.counters[ip]) this._perf.counters[ip].closed = true; } catch (e) {}
              if (manual) {
                this._manualDisconnectIPs.delete(ip);
                return;
              }
              this._scheduleReconnect(ip, 'close');
            });
            ws.on('error', (e) => {
              console.warn('[WS ERROR]', ip, {
                code: e && e.code,
                message: e && e.message,
                status: this.conns[ip] && this.conns[ip].state,
                remoteAddress: ws && ws._socket ? ws._socket.remoteAddress : undefined,
                remotePort: ws && ws._socket ? ws._socket.remotePort : undefined,
                lastRawPreview: this.conns[ip] && this.conns[ip].lastRawPreview,
              });
              if (e && e.code === 'WS_ERR_INVALID_UTF8') {
                console.warn('[WS DEBUG] invalid utf8 frame details', ip, this.conns[ip] && this.conns[ip].lastRawPreview);
              }
            });
            this.conns[ip] = { ws, state: 'open', lastMsg: null, connSettings: null };
            this._markConnected(ip);
          } else {
            // timeout/no-ws
            this.emit('scan-result', { ip, status: 'ping' });
          }
        } catch (e) {
          results[ip] = 'error';
          this.emit('scan-result', { ip, status: 'ping' });
        }
      }
    });
    await Promise.all(pool);
    return results;
  }

  async isHostOnline(ip, pingTimeout = 500) {
    return new Promise((resolve) => {
      child_process.exec(`ping -n 1 -w ${pingTimeout} ${ip}`, (err, stdout) => {
        resolve(/TTL=/.test(stdout));
      });
    });
  }

  tryConnectProbe(ip, timeout = 800) {
    return new Promise((resolve) => {
      const ws = new WebSocket(`http://${ip}/ws`, { handshakeTimeout: timeout, skipUTF8Validation: true });
      let settled = false;
      ws.on('open', () => {
        settled = true;
        resolve({ status: 'connectable', ws });
      });
      ws.on('error', () => {
        if (!settled) { settled = true; resolve({ status: 'no-ws', ws: null }); }
      });
      setTimeout(() => { if (!settled) { settled = true; resolve({ status: 'timeout', ws: null }); } }, timeout);
    });
  }

  connect(ip) {
    return new Promise((resolve) => {
      if (this.serialConns[ip] && this.serialConns[ip].port && this.serialConns[ip].port.isOpen) {
        resolve({ ok: true, note: 'serial-already' });
        return;
      }
      if (this.conns[ip] && this.conns[ip].ws && this.conns[ip].ws.readyState === WebSocket.OPEN) {
        resolve({ ok: true, note: 'already' }); return;
      }
      const ws = new WebSocket('http://' + ip + '/ws', { skipUTF8Validation: true });
      ws.on('open', () => {
        this.conns[ip] = { ws, state: 'open', lastMsg: null, connSettings: null };
        this._markConnected(ip);
        try { ws.send(JSON.stringify({ cmd: 'getConnSettings' })); console.log('Sent', JSON.stringify({ cmd: 'getConnSettings' }), 'to', ip); } catch (e) { }
        resolve({ ok: true });
      });
      ws.on('message', (data, isBinary) => {
        try {
          // perf: count incoming ws message for this ip
          try { this._incPerfMsg(ip); } catch (e) {}
          const rawText = Buffer.isBuffer(data) ? data.toString('utf8') : data.toString();
          const msg = JSON.parse(rawText);
          this.conns[ip].lastMsg = msg;
          this.conns[ip].lastRawPreview = previewFrameData(data);
          this.emit('ws-message', { ip, msg });
          if (msg.ts === 2 || msg.cmd === 'connSettings' || msg.getConnSettings) {
            const cs = {
              udp_host_ip: msg.udp_host_ip || msg.udp_host || null,
              udp_host_port: msg.udp_host_port || msg.udp_host_port || msg.udp_slave_port || null
            };
            this.conns[ip].connSettings = cs;
            // if matched, emit matched immediately
            const localAddrs = Object.values(networkInterfaces()).flat().filter(Boolean).map(i => i.address);
            if (cs.udp_host_ip && localAddrs.includes(cs.udp_host_ip)) {
              const p = parseInt(cs.udp_host_port, 10);
              if (!isNaN(p) && p >= 9001 && p <= 9100) {
                this.emit('matched', { ip, port: p });
                this.emit('ws-message', { ip, msg }); // forward
              }
            }
          }
          else if (msg.ts >= 10)
          {
            // 解码姿态信息
          }
          else{
            // other messages
          }
        }
        catch (e) {
          console.warn('[WS DEBUG] connect() message parse failed', ip, {
            error: e && e.message,
            isBinary,
            preview: previewFrameData(data),
          });
        }
      });
      ws.on('close', () => {
        if (this.conns[ip]) this.conns[ip].state = 'closed';
        const manual = this._manualDisconnectIPs.has(ip);
        console.log('[WS CLOSED]', ip, manual ? '(manual)' : '(unexpected)');
        try { if (this._perf && this._perf.counters[ip]) this._perf.counters[ip].closed = true; } catch (e) {}
        if (manual) {
          this._manualDisconnectIPs.delete(ip);
          return;
        }
        this._scheduleReconnect(ip, 'close');
      });
      ws.on('error', (e) => {
        console.warn('[WS ERROR] connect()', ip, {
          code: e && e.code,
          message: e && e.message,
          lastRawPreview: this.conns[ip] && this.conns[ip].lastRawPreview,
        });
        resolve({ ok: false, error: String(e) });
      });
    });
  }

  disconnect(ip) {
    if (this.conns[ip] && this.conns[ip].ws) {
      this._markManualDisconnect(ip);
      this.conns[ip].ws.close();
      delete this.conns[ip];
      return { ok: true };
    }
    if (this.serialConns[ip] && this.serialConns[ip].port) {
      try {
        if (this.serialConns[ip].port.isOpen) {
          this.serialConns[ip].port.close();
        }
      } catch (e) {}
      delete this.serialConns[ip];
    }
    return { ok: true };
  }

  broadcast(obj) {
    Object.keys(this.conns).forEach(ip => {
      const c = this.conns[ip];
      if (c && c.ws && c.ws.readyState === WebSocket.OPEN) {
        console.log('broadcast to', ip, obj);
        try { c.ws.send(JSON.stringify(obj));console.log("Sent", JSON.stringify(obj), "to", ip) } catch (e) { }
      }
    });

    Object.keys(this.serialConns).forEach((path) => {
      const c = this.serialConns[path];
      if (c && c.port && c.port.isOpen) {
        try {
          c.port.write(JSON.stringify(obj) + '\n');
          console.log('broadcast to serial', path, obj);
        } catch (e) {}
      }
    });
  }

  sendToDevice(ip, obj) {
    const c = this.conns[ip];
    if (c && c.ws && c.ws.readyState === WebSocket.OPEN) {
      console.log('send to', ip, obj);
      try { 
        c.ws.send(JSON.stringify(obj));
        console.log("Sent", JSON.stringify(obj), "to", ip);
      } catch (e) {
        console.error('Failed to send to', ip, e);
      }
      return;
    }

    const serial = this.serialConns[ip];
    if (serial && serial.port && serial.port.isOpen) {
      try {
        serial.port.write(JSON.stringify(obj) + '\n');
        console.log('Sent', JSON.stringify(obj), 'to serial', ip);
      } catch (e) {
        console.error('Failed to send to serial', ip, e);
      }
      return;
    }

    console.warn('Device', ip, 'not connected or transport not ready');
  }

  listConnections() {
    const wsList = Object.keys(this.conns).map(ip => ({
      ip,
      state: this.conns[ip].state,
      lastMsg: this.conns[ip].lastMsg,
      connSettings: this.conns[ip].connSettings,
      type: 'ws',
    }));

    const serialList = Object.keys(this.serialConns).map((path) => ({
      ip: path,
      state: this.serialConns[path].state || 'open',
      lastMsg: this.serialConns[path].lastMsg || null,
      connSettings: null,
      type: 'serial',
      deviceInfo: this.serialConns[path].deviceInfo || null,
    }));

    return [...wsList, ...serialList];
  }

  async updateDevicesConfig(ips, hostIp, portMap) {
    const result = [];
    for (const ip of ips) {
      const c = this.conns[ip];
      console.log('Updating device', ip, 'to', hostIp, 'port', portMap[ip]);
      if (!c || !c.ws || c.ws.readyState !== WebSocket.OPEN) {
        result.push({ ip, ok: false, reason: 'not-open' }); continue;
      }
      const port = portMap[ip];
      if (!port) { result.push({ ip, ok: false, reason: 'no-port-specified' }); continue; }
      const payload = { cmd: 'setUDPSettings', settings: { udp_host_ip: hostIp, udp_host_port: String(port) } };
      try {
        c.ws.send(JSON.stringify(payload));
        console.log('Sent', payload, 'to', ip);
        result.push({ ip, ok: true });
      }
      catch (e) { result.push({ ip, ok: false, reason: String(e) });console.log('Error sending to', ip, e); }
    }
    return result;
  }

  async getHostIPForSubnet({ base, cidr, ifname }) {
    // run ipconfig (Windows) and attempt to parse IPv4 address of interface matching provided base/cidr or ifname
    try {
      const out = child_process.execSync('ipconfig', { encoding: 'buffer' });
      const txt = iconv.decode(out, 'cp936'); // handle Chinese Windows codepage
      // simple parse: find IPv4 地址: xxx.xxx.xxx.xxx lines
      const lines = txt.split(/\r?\n/);
      let currentIf = null;
      const addrs = [];
      for (const line of lines) {
        const l = line.trim();
        // interface header
        if (l.endsWith(':') && l.length > 0 && !/IPv4 Address/.test(l)) {
          currentIf = l.replace(':', '');
        }
        const m = l.match(/(?:IPv4 地址[.\s]*|IPv4 Address[.\s]*):\s*([\d.]+)/i);
        if (m) {
          addrs.push({ ifname: currentIf || '', addr: m[1] });
        }
      }
      // try to find address in same base as requested base
      if (base) {
        const baseParts = base.split('.');
        for (const a of addrs) {
          const p = a.addr.split('.');
          if (p[0] === baseParts[0] && p[1] === baseParts[1] && p[2] === baseParts[2]) {
            console.log("Found matching address:", a.addr);
            return a.addr;
          }
        }
      }
      // fallback to first
      return addrs[0] ? addrs[0].addr : null;
    } catch (e) {
      return null;
    }
  }
}

module.exports = { WSManager };
