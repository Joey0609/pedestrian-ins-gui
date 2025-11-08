// udpManager.js
const dgram = require('dgram');
const EventEmitter = require('events');

class UDPManager extends EventEmitter {
  constructor() {
    super();
    this.sockets = {};
  }

  async scanPorts(start = 9001, end = 9100, timeout = 300) {
    const results = {};
    const sockets = [];
    for (let p = start; p <= end; p++) {
      results[p] = false;
      try {
        const sock = dgram.createSocket('udp4');
        sock.on('message', (msg, rinfo) => {
          results[p] = true;
          this.emit('port-scan-update', { port: p, online: true });
        });
        sock.bind(p);
        sockets.push(sock);
      } catch (e) {
        results[p] = 'bind_error';
        this.emit('port-scan-update', { port: p, online: false });
      }
    }
    await new Promise(r => setTimeout(r, timeout));
    sockets.forEach(s => s.close());
    return results;
  }

  startListening(port) {
    if (this.sockets[port]) return;
    const sock = dgram.createSocket('udp4');
    sock.on('message', (msg, rinfo) => {
      const text = msg.toString();
      console.log(`UDP msg on port ${port}:`, text);
      if (text.startsWith('D,')) {
        const parts = text.split(',');
        const x = parseFloat(parts[1]);
        const y = parseFloat(parts[2]);
        this.emit('position', { port, x, y, raw: text, rinfo });
      } else {
        this.emit('udp-raw', { port, raw: text, rinfo });
      }
    });
    sock.on('error', (err) => { console.warn('udp error', port, err); });
    sock.bind(port);
    this.sockets[port] = sock;
  }

  stopListening(port) {
    const s = this.sockets[port];
    if (s) { s.close(); delete this.sockets[port]; }
  }
}

module.exports = { UDPManager };
