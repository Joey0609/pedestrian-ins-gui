// wsManager.js
const WebSocket = require('ws');
const os = require('os');
const child_process = require('child_process');
const EventEmitter = require('events');
const { networkInterfaces } = os;
const iconv = require('iconv-lite');
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
            // We have an open ws; register handlers and attempt to read connSettings
            const ws = probeRes.ws;
            // install events
            ws.on('message', (data) => {
              try {
                const msg = JSON.parse(data.toString());
                // emit ws message
                this.emit('ws-message', { ip, msg });
                // connSettings handling
                if (msg.ts === 2 || msg.cmd === 'connSettings' || msg.getConnSettings || msg.cmd === 'connSettings') {
                  const cs = {
                    udp_host_ip: msg.udp_host_ip || msg.udp_host || null,
                    udp_host_port: msg.udp_host_port || msg.udp_host_port || msg.udp_slave_port || null
                  };
                  if (!this.conns[ip]) this.conns[ip] = { ws, state: 'open', lastMsg: null, connSettings: null };
                  this.conns[ip].connSettings = cs;
                  this.conns[ip].lastMsg = msg;
                  // evaluate
                  // determine local addresses
                  const localAddrs = Object.values(networkInterfaces()).flat().filter(Boolean).map(i => i.address);
                  if (cs.udp_host_ip && localAddrs.includes(cs.udp_host_ip)) {
                    const p = parseInt(cs.udp_host_port, 10);
                    if (!isNaN(p) && p >= 9001 && p <= 9100) {
                      this.emit('scan-result', { ip, status: 'green' });
                      this.emit('matched', { ip, port: p }); // notify main to start UDP listen
                      return;
                    } else {
                      this.emit('scan-result', { ip, status: 'ws' }); // ws but udp port out of range
                      return;
                    }
                  } else {
                    this.emit('scan-result', { ip, status: 'ws' }); // ws but not pointing to this host
                    return;
                  }
                } else {
                  // not connSettings; still emit ws message
                }
              } catch (e) {
                // non-json or parse error: ignore
              }
            });
            ws.on('close', () => { if (this.conns[ip]) this.conns[ip].state = 'closed'; });
            ws.on('error', (e) => { console.warn('ws error', ip, e); });
            this.conns[ip] = { ws, state: 'open', lastMsg: null, connSettings: null };
            // ask for conn settings
            try { ws.send(JSON.stringify({ cmd: 'getConnSettings' })); } catch (e) { }
            // provisional emit: ws available
            this.emit('scan-result', { ip, status: 'ws' });
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
      const ws = new WebSocket(`http://${ip}/ws`, { handshakeTimeout: timeout });
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
      const ws = new WebSocket('http://' + ip + '/ws');
      ws.on('open', () => {
        this.conns[ip] = { ws, state: 'open', lastMsg: null, connSettings: null };
        try { ws.send(JSON.stringify({ cmd: 'getConnSettings' })); } catch (e) { }
        resolve({ ok: true });
      });
      ws.on('message', (data) => {
        try {
          const msg = JSON.parse(data.toString());
          this.conns[ip].lastMsg = msg;
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
        catch (e) { }
      });
      ws.on('close', () => { if (this.conns[ip]) this.conns[ip].state = 'closed'; });
      ws.on('error', (e) => { resolve({ ok: false, error: String(e) }); });
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
        try { c.ws.send(JSON.stringify(obj)); } catch (e) { }
      }
    });
  }

  listConnections() {
    return Object.keys(this.conns).map(ip => ({ ip, state: this.conns[ip].state, lastMsg: this.conns[ip].lastMsg, connSettings: this.conns[ip].connSettings }));
  }

  async detectAndMatch(hostIp, portRange = { start: 9001, end: 9100 }) {
    const res = [];
    const ips = Object.keys(this.conns);
    for (const ip of ips) {
      try {
        const c = this.conns[ip];
        if (c && c.ws && c.ws.readyState === WebSocket.OPEN) {
          try { c.ws.send(JSON.stringify({ cmd: 'getConnSettings' })); } catch (e) { }
        }
      } catch (e) { }
    }
    await new Promise(r => setTimeout(r, 400));
    for (const ip of ips) {
      const c = this.conns[ip];
      const cs = c && c.connSettings;
      let status = 'unknown';
      if (cs && cs.udp_host_ip && cs.udp_host_ip === hostIp) {
        const p = parseInt(cs.udp_host_port);
        if (!isNaN(p) && p >= portRange.start && p <= portRange.end) status = 'matched';
        else status = 'udp-port-out-of-range';
      } else if (cs) status = 'udp-to-other-host';
      else status = 'no-conn-settings';
      res.push({ ip, status, connSettings: cs || null });
    }
    // emit results too
    res.forEach(r => {
      if (r.status === 'matched') this.emit('scan-result', { ip: r.ip, status: 'green' });
      else this.emit('scan-result', { ip: r.ip, status: 'ws' });
    });
    return res;
  }

  async updateDevicesConfig(ips, hostIp, portMap) {
    const result = [];
    for (const ip of ips) {
      const c = this.conns[ip];
      if (!c || !c.ws || c.ws.readyState !== WebSocket.OPEN) {
        result.push({ ip, ok: false, reason: 'not-open' }); continue;
      }
      const port = portMap[ip];
      if (!port) { result.push({ ip, ok: false, reason: 'no-port-specified' }); continue; }
      const payload = { cmd: 'setUDPSettings', settings: { udp_host_ip: hostIp, udp_host_port: String(port) } };
      try {
        c.ws.send(JSON.stringify(payload));
        result.push({ ip, ok: true });
      }
      catch (e) { result.push({ ip, ok: false, reason: String(e) }); }
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
