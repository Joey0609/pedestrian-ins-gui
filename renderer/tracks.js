import { throttle } from './utils.js';
import { onThemeChange } from './theme.js';

export function createTracks() {
const MAX_TRACK_POINTS = 12000; // Maximum points per track to prevent memory issues
const MIN_TRACK_POINT_DISTANCE = 0.03; // Only store new point if distance to previous point is greater than 3cm
const DRAW_THROTTLE_MS = 50; // Throttle canvas redraw
const LEGEND_THROTTLE_MS = 500; // Throttle legend updates
const TRACK_SERIES_TOKENS = ['--series-1', '--series-2', '--series-3', '--series-4', '--series-5', '--series-6'];

// ---------------------------------------------------------------------------
// Canvas 2D cannot resolve CSS custom properties, so the concrete colours are
// read from the theme tokens here and re-read whenever `wj:themechange` fires.
// ---------------------------------------------------------------------------
function readCssVar(name) {
  if (typeof document === 'undefined' || !document.documentElement || !name) return '';
  try {
    return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  } catch (e) {
    return '';
  }
}

function readToken(name, ...fallbacks) {
  const names = [name].concat(fallbacks);
  for (let i = 0; i < names.length; i++) {
    const value = readCssVar(names[i]);
    if (value) return value;
  }
  return 'transparent';
}

function readCanvasPalette() {
  return {
    background: readToken('--viz-bg', '--bg-card'),
    grid: readToken('--viz-grid', '--border-light'),
    axis: readToken('--viz-axis', '--border-strong'),
    text: readToken('--viz-text', '--text-secondary'),
    series: TRACK_SERIES_TOKENS.map((token) => readToken(token, '--primary')),
  };
}

// Normalise a resolved token to #rrggbb for <input type="color">.
function cssColorToHex(value) {
  const text = String(value || '').trim();
  const short = /^#([0-9a-f])([0-9a-f])([0-9a-f])$/i.exec(text);
  if (short) return ('#' + short[1] + short[1] + short[2] + short[2] + short[3] + short[3]).toLowerCase();
  if (/^#[0-9a-f]{6}$/i.test(text)) return text.toLowerCase();
  const match = /^rgba?\(([^)]+)\)$/i.exec(text);
  if (match) {
    const parts = match[1].split(/[\s,/]+/).filter(Boolean);
    if (parts.length >= 3) {
      const channel = (part) => {
        const n = parseFloat(part);
        if (!isFinite(n)) return 0;
        return Math.max(0, Math.min(255, Math.round(part.indexOf('%') !== -1 ? n * 2.55 : n)));
      };
      return '#' + [channel(parts[0]), channel(parts[1]), channel(parts[2])]
        .map((n) => n.toString(16).padStart(2, '0')).join('');
    }
  }
  return text;
}

let palette = readCanvasPalette();
let tracks = {}, trackColors = {}, trackVisible = {};
let trackColorIndex = {}, trackColorCustom = {};
let usedColors = new Set();
let replaying = false;
let throttledDrawTracks = null, throttledUpdateLegend = null;
let themeSubscription = null;

function nextSeriesIndex() {
  const taken = new Set(Object.values(trackColorIndex));
  for (let i = 0; i < palette.series.length; i++) {
    if (!taken.has(i)) return i;
  }
  return Object.keys(trackColorIndex).length % palette.series.length;
}

function assignTrackColor(ip) {
  const index = nextSeriesIndex();
  trackColorIndex[ip] = index;
  trackColorCustom[ip] = false;
  trackColors[ip] = palette.series[index % palette.series.length];
  if (trackColors[ip]) usedColors.add(trackColors[ip]);
  return trackColors[ip];
}

function applyThemeToTracks() {
  palette = readCanvasPalette();
  usedColors.clear();
  Object.keys(tracks).forEach((ip) => {
    if (!trackColorCustom[ip]) {
      const index = typeof trackColorIndex[ip] === 'number' ? trackColorIndex[ip] : 0;
      trackColors[ip] = palette.series[index % palette.series.length];
    }
    if (trackColors[ip]) usedColors.add(trackColors[ip]);
  });
  updateLegend();
  if (typeof window.drawTracks === 'function') window.drawTracks();
}

function subscribeToThemeChanges() {
  if (themeSubscription) return;
  themeSubscription = onThemeChange(applyThemeToTracks);
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

  document.getElementById('clear-tracks').addEventListener('click', () => { tracks = {}; usedColors.clear(); trackColorIndex = {}; trackColorCustom = {}; updateLegend(); drawTracks(); });
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
    ctx.fillStyle = palette.background;
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    // Draw axes (the crosshair is the grid; ticks below use the axis stroke)
    ctx.strokeStyle = palette.grid;
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
    ctx.strokeStyle = palette.axis;
    ctx.font = '12px Arial';
    ctx.fillStyle = palette.text;
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
      const color = trackColors[ip] || palette.series[0];
      ctx.beginPath(); ctx.lineWidth = 2; ctx.strokeStyle = color;
      for (let i = 0; i < pts.length; i++) {
        const px = centerX + pts[i].x * trackScale;
        const py = centerY - pts[i].y * trackScale; // inverted y
        if (i === 0) ctx.moveTo(px, py); else ctx.lineTo(px, py);
      }
      ctx.stroke();
      const lastp = pts[pts.length - 1]; if (lastp) {
        ctx.fillStyle = color;
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
    const colorInput = document.createElement('input'); colorInput.type = 'color'; colorInput.value = cssColorToHex(trackColors[ip]); colorInput.style.display = 'none';
    colorBox.addEventListener('click', () => colorInput.click());
    colorInput.addEventListener('input', (e) => { trackColors[ip] = e.target.value; trackColorCustom[ip] = true; colorBox.style.background = e.target.value; window.drawTracks(); });
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
    ctx.fillStyle = palette.background;
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    // Redraw axes and ticks as in drawTracks
    ctx.strokeStyle = palette.grid;
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
      const color = trackColors[ip] || palette.series[0];
      ctx.beginPath(); ctx.lineWidth = 2; ctx.strokeStyle = color;
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
        assignTrackColor(ip);
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
      delete trackColorIndex[ip];
      delete trackColorCustom[ip];
      if (throttledUpdateLegend) throttledUpdateLegend();
      if (typeof window.drawTracks === 'function') window.drawTracks();
    }
}

subscribeToThemeChanges();

return { initialize, recordPosition, removeDevice, getCacheData: () => ({ tracks, trackColors, trackVisible, usedColors }) };
}
