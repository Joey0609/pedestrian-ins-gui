import { throttle } from './utils.js';

export function createTracks() {
const MAX_TRACK_POINTS = 12000; // Maximum points per track to prevent memory issues
const MIN_TRACK_POINT_DISTANCE = 0.03; // Only store new point if distance to previous point is greater than 3cm
const DRAW_THROTTLE_MS = 50; // Throttle canvas redraw
const LEGEND_THROTTLE_MS = 500; // Throttle legend updates

let tracks = {}, trackColors = {}, trackVisible = {};
let replaying = false;
let throttledDrawTracks = null, throttledUpdateLegend = null;

function randomColorForPort(port) {
  const seed = (parseInt(port) || 1);
  const r = (seed * 97) % 255; const g = (seed * 57) % 255; const b = (seed * 31) % 255;
  return `rgb(${r},${g},${b})`;
}

let usedColors = new Set();
function getUniqueRandomColor(ip) {
  let seed = 0;
  const text = String(ip || '');
  for (let i = 0; i < text.length; i++) {
    seed = (seed * 131 + text.charCodeAt(i)) >>> 0;
  }

  let color = null;
  for (let attempt = 0; attempt < 128; attempt++) {
    const s = (seed + attempt * 1103515245) >>> 0;
    const r = (s * 97) % 255;
    const g = (s * 57) % 255;
    const b = (s * 31) % 255;
    const candidate = `rgb(${r},${g},${b})`;
    if (!usedColors.has(candidate)) {
      color = candidate;
      break;
    }
    if (attempt === 127) {
      console.warn('Failed to generate unique color for', ip);
    }
  }

  if (!color) {
    color = `rgb(${Math.floor(Math.random() * 255)},${Math.floor(Math.random() * 255)},${Math.floor(Math.random() * 255)})`;
  }

  usedColors.add(color);
  console.log('Assigned color for', ip, ':', color);
  return color;
}

// Track canvas state (global for replay/fit functions)
let trackOffsetX = 0, trackOffsetY = 0, trackScale = 50;

function initialize() {
(function setupTrackCanvas() {
  const canvas = document.getElementById('track-canvas');
  if (!canvas) return;
  const ctx = canvas.getContext('2d');
  function fit() { canvas.width = canvas.clientWidth; canvas.height = canvas.clientHeight; drawTracks(); }
  window.addEventListener('resize', fit);
  let dragging = false, last = [0, 0];
  canvas.addEventListener('wheel', (e) => {
    e.preventDefault();
    const rect = canvas.getBoundingClientRect();
    const mouseX = e.clientX - rect.left - canvas.clientWidth / 2;
    const mouseY = e.clientY - rect.top - canvas.clientHeight / 2;
    const worldXBefore = (mouseX - trackOffsetX) / trackScale;
    const worldYBefore = -(mouseY - trackOffsetY) / trackScale; // y inverted
    const factor = Math.exp(-e.deltaY * 0.0008);
    let newScale = Math.max(0.1, Math.min(800, trackScale * factor));
    trackScale = newScale;
    trackOffsetX = mouseX - worldXBefore * trackScale;
    trackOffsetY = mouseY + worldYBefore * trackScale;
    drawTracks();
  });
  canvas.addEventListener('mousedown', (e) => { dragging = true; last = [e.clientX, e.clientY]; });
  window.addEventListener('mouseup', () => dragging = false);
  window.addEventListener('mousemove', (e) => {
    const rect = canvas.getBoundingClientRect();
    const mouseX = e.clientX - rect.left;
    const mouseY = e.clientY - rect.top;
    if (!dragging) return; trackOffsetX += (e.clientX - last[0]); 
    trackOffsetY += (e.clientY - last[1]); last = [e.clientX, e.clientY]; 
    drawTracks();
  });

  document.getElementById('clear-tracks').addEventListener('click', () => { tracks = {}; usedColors.clear(); updateLegend(); drawTracks(); });
  document.getElementById('replay-tracks').addEventListener('click', () => { replayTracks(); });
  document.getElementById('fit-window').addEventListener('click', () => { fitToWindow(); });
  function niceStep(pxPerUnit, targetPx = 80) {
    const raw = targetPx / Math.max(1e-9, pxPerUnit);
    const pow10 = Math.pow(10, Math.floor(Math.log10(raw)));
    const cand = [1, 2, 5].map(m => m * pow10);
    let best = cand[0];
    let bestDiff = Math.abs(cand[0] - raw);
    for (let i = 1; i < cand.length; i++) {
      const diff = Math.abs(cand[i] - raw);
      if (diff < bestDiff) { best = cand[i]; bestDiff = diff; }
    }
    return best;
  }
  function drawTracks() {
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    // Draw axes
    ctx.strokeStyle = '#ddd';
    ctx.lineWidth = 1;
    ctx.beginPath();
    // Horizontal axis
    ctx.moveTo(0, canvas.height / 2 + trackOffsetY);
    ctx.lineTo(canvas.width, canvas.height / 2 + trackOffsetY);
    // Vertical axis
    ctx.moveTo(canvas.width / 2 + trackOffsetX, 0);
    ctx.lineTo(canvas.width / 2 + trackOffsetX, canvas.height);
    ctx.stroke();

    // Draw ticks and labels
    ctx.font = '12px Arial';
    ctx.fillStyle = '#666';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';

    // Determine tick interval based on scale
    let tickInterval = niceStep(trackScale);
    
    // X axis ticks
    const centerX = canvas.width / 2 + trackOffsetX;
    const centerY = canvas.height / 2 + trackOffsetY;
    const minX = -(canvas.width / 2  + trackOffsetX) / trackScale;
    const maxX = (canvas.width / 2 - trackOffsetX) / trackScale;
    
    for (let x = Math.ceil(minX / tickInterval) * tickInterval; x <= maxX; x += tickInterval) {
      const px = centerX + x * trackScale;
      ctx.beginPath();
      ctx.moveTo(px, centerY - 5);
      ctx.lineTo(px, centerY + 5);
      ctx.stroke();
      ctx.fillText(x.toFixed(1), px, centerY + 15);
    }

    // Y axis ticks (inverted)
    const minY = (trackOffsetY - canvas.height / 2) / trackScale;
    const maxY = (trackOffsetY  + canvas.height / 2) / trackScale;
    for (let y = Math.ceil(minY / tickInterval) * tickInterval; y <= maxY; y += tickInterval) {
      const py = centerY - y * trackScale; // inverted
      ctx.beginPath();
      ctx.moveTo(centerX - 5, py);
      ctx.lineTo(centerX + 5, py);
      ctx.stroke();
      ctx.fillText(y.toFixed(1), centerX - 15, py);
    }

    // Draw tracks
    Object.keys(tracks).forEach(ip => {
      if (!trackVisible[ip]) return;
      const pts = tracks[ip];
      ctx.beginPath(); ctx.lineWidth = 2; ctx.strokeStyle = trackColors[ip] || 'black';
      for (let i = 0; i < pts.length; i++) {
        const px = centerX + pts[i].x * trackScale;
        const py = centerY - pts[i].y * trackScale; // inverted y
        if (i === 0) ctx.moveTo(px, py); else ctx.lineTo(px, py);
      }
      ctx.stroke();
      const lastp = pts[pts.length - 1]; if (lastp) {
        ctx.fillStyle = trackColors[ip] || 'black';
        ctx.beginPath();
        ctx.arc(centerX + lastp.x * trackScale, centerY - lastp.y * trackScale, 4, 0, Math.PI * 2);
        ctx.fill();
      }
    });
  }
  window.drawTracks = drawTracks;

  fit();
})();

// Initialize throttled functions after all functions are defined
throttledDrawTracks = throttle(function() { if (typeof window.drawTracks === 'function') window.drawTracks(); }, DRAW_THROTTLE_MS);
throttledUpdateLegend = throttle(updateLegend, LEGEND_THROTTLE_MS);
}

function updateLegend() {
  const container = document.getElementById('track-legend'); if (!container) return; container.innerHTML = '';
  Object.keys(tracks).forEach(ip => {
    const item = document.createElement('div'); item.className = 'track-item';
    const header = document.createElement('div'); header.className = 'track-item-header';
    const ipLabel = document.createElement('span'); ipLabel.className = 'track-item-ip'; ipLabel.textContent = ip;
    const lastPos = tracks[ip][tracks[ip].length - 1];
    const posLabel = document.createElement('span'); posLabel.className = 'track-item-pos'; posLabel.textContent = lastPos ? `(${lastPos.x.toFixed(2)}, ${lastPos.y.toFixed(2)})` : '(No pos)';
    const colorBox = document.createElement('div'); colorBox.className = 'track-item-color'; colorBox.style.background = trackColors[ip];
    const colorInput = document.createElement('input'); colorInput.type = 'color'; colorInput.value = rgbToHex(trackColors[ip]); colorInput.style.display = 'none';
    colorBox.addEventListener('click', () => colorInput.click());
    colorInput.addEventListener('input', (e) => { trackColors[ip] = e.target.value; colorBox.style.background = e.target.value; window.drawTracks(); });
    const toggle = document.createElement('input'); toggle.className = 'track-item-visible'; toggle.type = 'checkbox'; toggle.checked = trackVisible[ip] !== false;
    toggle.addEventListener('change', () => { trackVisible[ip] = toggle.checked; window.drawTracks(); });
    header.appendChild(ipLabel);
    header.appendChild(colorBox);
    header.appendChild(toggle);
    item.appendChild(header);
    item.appendChild(posLabel);
    container.appendChild(item);
  });
}

function rgbToHex(rgb) {
  const [r, g, b] = rgb.match(/\d+/g).map(Number);
  return `#${((1 << 24) + (r << 16) + (g << 8) + b).toString(16).slice(1)}`;
}

function replayTracks() {
  if (replaying) return; replaying = true;
  const allT = Object.values(tracks).flatMap(a => a.map(p => p.t)); if (!allT.length) { replaying = false; return; }
  const maxT = Math.max(...allT); const minT = Math.min(...allT); const dur = maxT - minT || 1000; const start = Date.now();
  const canvas = document.getElementById('track-canvas'); if (!canvas) { replaying = false; return; }
  const ctx = canvas.getContext('2d');
  const centerX = canvas.width / 2 + trackOffsetX;
  const centerY = canvas.height / 2 + trackOffsetY;
  (function step() {
    const el = Date.now() - start;
    const nowT = minT + (el / dur) * (maxT - minT);
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    // Redraw axes and ticks as in drawTracks
    ctx.strokeStyle = '#ddd';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(0, centerY);
    ctx.lineTo(canvas.width, centerY);
    ctx.moveTo(centerX, 0);
    ctx.lineTo(centerX, canvas.height);
    ctx.stroke();

    // Ticks and labels similarly...

    Object.keys(tracks).forEach(ip => {
      if (!trackVisible[ip]) return;
      const pts = tracks[ip].filter(p => p.t <= nowT);
      ctx.beginPath(); ctx.lineWidth = 2; ctx.strokeStyle = trackColors[ip];
      for (let i = 0; i < pts.length; i++) {
        const px = centerX + pts[i].x * trackScale;
        const py = centerY - pts[i].y * trackScale;
        if (i === 0) ctx.moveTo(px, py); else ctx.lineTo(px, py);
      }
      ctx.stroke();
    });
    if (el < dur) requestAnimationFrame(step); else { replaying = false; window.drawTracks(); }
  })();
}

function fitToWindow() {
  const allPoints = Object.values(tracks).flat();
  if (!allPoints.length) return;
  const minX = Math.min(...allPoints.map(p => p.x));
  const maxX = Math.max(...allPoints.map(p => p.x));
  const minY = Math.min(...allPoints.map(p => p.y));
  const maxY = Math.max(...allPoints.map(p => p.y));
  const width = maxX - minX || 1;
  const height = maxY - minY || 1;
  const canvas = document.getElementById('track-canvas');
  trackScale = Math.min(canvas.width / (width * 1.1), canvas.height / (height * 1.1));
  trackOffsetX = canvas.width / 2 - (minX + width / 2) * trackScale;
  trackOffsetY = canvas.height / 2 + (minY + height / 2) * trackScale; // inverted y
  window.drawTracks();
}

function recordPosition(ip, data) {
  // Use displacement[0][0:2] (first sensor's x and y) for track data
  // This follows the imupage.html logic where displacement is parsed from Base64 data
  if (data.displacement && Array.isArray(data.displacement) && data.displacement[0]) {
    const displacement = data.displacement[0]; // First sensor
    const x = displacement[0]; // x coordinate
    const y = displacement[1]; // y coordinate
    
    if (typeof x === 'number' && typeof y === 'number' && !isNaN(x) && !isNaN(y)) {
      if (!tracks[ip]) {
        tracks[ip] = [];
        trackColors[ip] = getUniqueRandomColor(ip);
        trackVisible[ip] = true;
        if (throttledUpdateLegend) throttledUpdateLegend();
      }
      const prev = tracks[ip].length > 0 ? tracks[ip][tracks[ip].length - 1] : null;
      const shouldStore = !prev || !isFinite(prev.x) || !isFinite(prev.y)
        || Math.hypot(x - prev.x, y - prev.y) > MIN_TRACK_POINT_DISTANCE;

      if (shouldStore) {
        tracks[ip].push({ x, y, t: Date.now() });
        // Limit track array size to prevent memory issues
        if (tracks[ip].length > MAX_TRACK_POINTS) {
          tracks[ip] = tracks[ip].slice(-MAX_TRACK_POINTS);
        }
        if (throttledDrawTracks) throttledDrawTracks();
      }
    }
  }
}

function removeDevice(ip) {
    if (tracks[ip]) {
      const oldColor = trackColors[ip];
      if (oldColor) usedColors.delete(oldColor);
      delete tracks[ip];
      delete trackColors[ip];
      delete trackVisible[ip];
      if (throttledUpdateLegend) throttledUpdateLegend();
      if (typeof window.drawTracks === 'function') window.drawTracks();
    }
}

return { initialize, recordPosition, removeDevice, getCacheData: () => ({ tracks, trackColors, trackVisible, usedColors }) };
}
