// wsManager.js
const WebSocket = require('ws');
const os = require('os');
const child_process = require('child_process');
const EventEmitter = require('events');
const { networkInterfaces } = os;
const iconv = require('iconv-lite');
const { Console } = require('console');
const BMI088_NUM = 4; // Number of BMI088 IMUs connected

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
    this._cancelScan = false;
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
            ws.on('close', () => { if (this.conns[ip]) this.conns[ip].state = 'closed'; });
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
      if (this.conns[ip] && this.conns[ip].ws && this.conns[ip].ws.readyState === WebSocket.OPEN) {
        resolve({ ok: true, note: 'already' }); return;
      }
      const ws = new WebSocket('http://' + ip + '/ws', { skipUTF8Validation: true });
      ws.on('open', () => {
        this.conns[ip] = { ws, state: 'open', lastMsg: null, connSettings: null };
        try { ws.send(JSON.stringify({ cmd: 'getConnSettings' })); console.log('Sent', JSON.stringify({ cmd: 'getConnSettings' }), 'to', ip); } catch (e) { }
        resolve({ ok: true });
      });
      ws.on('message', (data, isBinary) => {
        try {
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
      ws.on('close', () => { if (this.conns[ip]) this.conns[ip].state = 'closed'; });
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
    if (this.conns[ip] && this.conns[ip].ws) { this.conns[ip].ws.close(); delete this.conns[ip]; }
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
    } else {
      console.warn('Device', ip, 'not connected or WebSocket not ready');
    }
  }

  listConnections() {
    return Object.keys(this.conns).map(ip => ({ ip, state: this.conns[ip].state, lastMsg: this.conns[ip].lastMsg, connSettings: this.conns[ip].connSettings }));
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
