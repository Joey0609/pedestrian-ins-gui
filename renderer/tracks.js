import { onThemeChange } from './theme.js';

export function createTracks() {
const MAX_TRACK_POINTS = 12000; // Maximum points per track to prevent memory issues
const MIN_TRACK_POINT_DISTANCE = 0.03; // Only store new point if distance to previous point is greater than 3cm
const ORIGIN_STORAGE_KEY = 'wj.track-origins';
const CHIP_REFRESH_MS = 400;
const PULSE_MS = 1500;
const TRACK_SERIES_TOKENS = ['--series-1', '--series-2', '--series-3', '--series-4', '--series-5', '--series-6'];
const PAD = { left: 44, right: 18, top: 16, bottom: 88 };

// ---------------------------------------------------------------------------
// Colours come from the theme tokens; Canvas 2D cannot resolve var(), so they
// are read here and re-read whenever the theme changes.
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
    background: readToken('--track-map-bg', '--viz-bg', '--bg-card'),
    tint: readToken('--track-map-tint', '--viz-bg', '--bg-card'),
    gridMinor: readToken('--track-grid-minor', '--viz-grid'),
    gridMajor: readToken('--track-grid-major', '--viz-grid'),
    text: readToken('--viz-text', '--text-secondary'),
    muted: readToken('--text-tertiary', '--text-secondary'),
    series: TRACK_SERIES_TOKENS.map((token) => readToken(token, '--primary')),
  };
}

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

function withAlpha(color, alpha) {
  const text = String(color || '').trim();
  const hex = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(text);
  if (hex) {
    let h = hex[1];
    if (h.length === 3) h = h.split('').map((c) => c + c).join('');
    const r = parseInt(h.slice(0, 2), 16);
    const g = parseInt(h.slice(2, 4), 16);
    const b = parseInt(h.slice(4, 6), 16);
    return `rgba(${r},${g},${b},${alpha})`;
  }
  const rgb = /^rgba?\(([^)]+)\)$/i.exec(text);
  if (rgb) {
    const parts = rgb[1].split(/[\s,/]+/).filter(Boolean).slice(0, 3).join(',');
    return `rgba(${parts},${alpha})`;
  }
  return text;
}

let palette = readCanvasPalette();
let tracks = {}, trackColors = {}, trackVisible = {}, trackOrigin = {};
let trackColorIndex = {}, trackColorCustom = {};
let usedColors = new Set();
let themeSubscription = null;

// view state
let trackOffsetX = 0, trackOffsetY = 0, trackScale = 60, baseScale = 60;
let cssW = 0, cssH = 0, dpr = 1;
let hoverPoint = null;
let selectedIp = null;
let hoverIp = null;
let windowSec = 0;
let replay = { active: false, paused: false, startedAt: 0, elapsed: 0, t0: 0, t1: 0, duration: 1 };
let lastChipRefresh = 0;
let rafId = 0;

// shared handle so helpers defined outside initialize() can reach the canvas API
const apiRefs = { fitToWindow: null, refreshChips: null, scheduleDraw: null, setSelected: null };

// ---------------------------------------------------------------------------
// Per-device start position
// ---------------------------------------------------------------------------
function loadOrigins() {
  try {
    const raw = window.localStorage.getItem(ORIGIN_STORAGE_KEY);
    const parsed = raw ? JSON.parse(raw) : null;
    if (!parsed || typeof parsed !== 'object') return {};
    const clean = {};
    Object.keys(parsed).forEach((ip) => {
      const v = parsed[ip];
      if (v && isFinite(Number(v.x)) && isFinite(Number(v.y))) clean[ip] = { x: Number(v.x), y: Number(v.y) };
    });
    return clean;
  } catch (e) {
    return {};
  }
}

function saveOrigins() {
  try {
    window.localStorage.setItem(ORIGIN_STORAGE_KEY, JSON.stringify(trackOrigin));
  } catch (e) { /* storage may be unavailable */ }
}

function getOrigin(ip) { return trackOrigin[ip] || { x: 0, y: 0 }; }

function setOrigin(ip, x, y) {
  trackOrigin[ip] = {
    x: isFinite(Number(x)) ? Number(x) : 0,
    y: isFinite(Number(y)) ? Number(y) : 0,
  };
  saveOrigins();
  if (apiRefs.scheduleDraw) apiRefs.scheduleDraw();
  refreshLegend();
}

trackOrigin = loadOrigins();

function nextSeriesIndex() {
  const taken = new Set(Object.values(trackColorIndex));
  for (let i = 0; i < palette.series.length; i++) if (!taken.has(i)) return i;
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
  refreshLegend();
  if (apiRefs.refreshChips) apiRefs.refreshChips();
  if (apiRefs.scheduleDraw) apiRefs.scheduleDraw();
}

function subscribeToThemeChanges() {
  if (themeSubscription) return;
  themeSubscription = onThemeChange(applyThemeToTracks);
}

// ---------------------------------------------------------------------------
// Geometry helpers
// ---------------------------------------------------------------------------
function niceStep(pxPerUnit, targetPx = 90) {
  const raw = targetPx / Math.max(1e-9, pxPerUnit);
  const pow10 = Math.pow(10, Math.floor(Math.log10(raw)));
  const cand = [1, 2, 5].map((m) => m * pow10);
  let best = cand[0];
  let bestDiff = Math.abs(cand[0] - raw);
  for (let i = 1; i < cand.length; i++) {
    const diff = Math.abs(cand[i] - raw);
    if (diff < bestDiff) { best = cand[i]; bestDiff = diff; }
  }
  return best;
}

function formatAxisValue(v, step) {
  if (Math.abs(v) < 1e-9) return '0';
  if (step >= 1) return String(Math.round(v * 10) / 10).replace(/\.0$/, '');
  if (step >= 0.1) return v.toFixed(1);
  return v.toFixed(2);
}

function plotBox() {
  return { x: PAD.left, y: PAD.top, w: Math.max(1, cssW - PAD.left - PAD.right), h: Math.max(1, cssH - PAD.top - PAD.bottom) };
}

function worldToScreen(x, y, origin) {
  const box = plotBox();
  const cx = box.x + box.w / 2 + trackOffsetX;
  const cy = box.y + box.h / 2 + trackOffsetY;
  return {
    x: cx + (x + (origin ? origin.x : 0)) * trackScale,
    y: cy - (y + (origin ? origin.y : 0)) * trackScale,
  };
}

// ---------------------------------------------------------------------------
// Canvas
// ---------------------------------------------------------------------------
function initialize() {
  const canvas = document.getElementById('track-canvas');
  if (!canvas) return;
  const ctx = canvas.getContext('2d');
  const page = document.getElementById('page-device-track');

  function resizeCanvas() {
    const w = Math.max(1, Math.round(canvas.clientWidth));
    const h = Math.max(1, Math.round(canvas.clientHeight));
    const ratio = window.devicePixelRatio || 1;
    if (w === cssW && h === cssH && ratio === dpr) return;
    cssW = w; cssH = h; dpr = ratio;
    canvas.width = Math.round(w * ratio);
    canvas.height = Math.round(h * ratio);
  }

  // A quiet map surface with a metric grid anchored to world coordinates.
  function drawBackground() {
    const wash = ctx.createLinearGradient(0, 0, cssW, cssH);
    wash.addColorStop(0, palette.background);
    wash.addColorStop(1, palette.tint);
    ctx.fillStyle = wash;
    ctx.fillRect(0, 0, cssW, cssH);
  }

  function drawMetricGrid() {
    // Use the same metres-to-pixels scale as the tracks and the scale bar.
    const box = plotBox();
    const cx = box.x + box.w / 2 + trackOffsetX;
    const cy = box.y + box.h / 2 + trackOffsetY;
    const major = niceStep(trackScale);
    const minor = major / 2;

    // A 1 CSS px line at dpr 1.5 lands on a half device pixel and gets antialiased
    // over two device pixels, losing half its contrast. Snap to the device pixel
    // grid and stroke exactly one device pixel instead.
    const snap = (v) => Math.round(v * dpr) / dpr + 0.5 / dpr;

    function lineSet(spacing) {
      const px = spacing * trackScale;
      const xs = [];
      const ys = [];
      if (px < 28) return { xs, ys, px };
      for (let k = Math.ceil(-cx / px); k <= Math.floor((cssW - cx) / px); k++) {
        xs.push({ pos: snap(cx + k * px), value: k * spacing });
      }
      for (let k = Math.ceil((cy - cssH) / px); k <= Math.floor(cy / px); k++) {
        ys.push({ pos: snap(cy - k * px), value: k * spacing });
      }
      return { xs, ys, px };
    }

    function strokeLines(set, color) {
      ctx.beginPath();
      for (const { pos } of set.xs) { ctx.moveTo(pos, 0); ctx.lineTo(pos, cssH); }
      for (const { pos } of set.ys) { ctx.moveTo(0, pos); ctx.lineTo(cssW, pos); }
      ctx.strokeStyle = color;
      ctx.lineWidth = 1 / dpr;
      ctx.stroke();
    }

    const minorSet = lineSet(minor);
    const majorSet = lineSet(major);
    strokeLines(minorSet, palette.gridMinor);
    strokeLines(majorSet, palette.gridMajor);

    // metre labels on the major lines, kept in the margins so the surface stays clean
    if (majorSet.px >= 64) {
      ctx.fillStyle = withAlpha(palette.text, 0.62);
      ctx.font = '10px ui-sans-serif, system-ui, "Segoe UI", sans-serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'bottom';
      for (const { pos, value } of majorSet.xs) {
        if (Math.abs(value) < major / 100) continue;
        ctx.fillText(formatAxisValue(value, major), Math.min(cssW - 14, Math.max(14, pos)), cssH - 10);
      }
      ctx.textAlign = 'left';
      ctx.textBaseline = 'middle';
      for (const { pos, value } of majorSet.ys) {
        if (Math.abs(value) < major / 100) continue;
        if (pos > cssH - 96) continue; // keep clear of the bottom HUD
        ctx.fillText(formatAxisValue(value, major), 8, pos);
      }
    }
  }

  function visiblePoints(ip, cutoffT) {
    const all = tracks[ip];
    if (!all || !all.length) return null;
    let start = 0;
    if (cutoffT !== null && cutoffT !== undefined) {
      let end = all.length;
      while (end > 0 && all[end - 1].t > cutoffT) end--;
      if (!end) return null;
      return all.slice(0, end);
    }
    if (windowSec > 0) {
      const lastT = all[all.length - 1].t;
      const from = lastT - windowSec * 1000;
      while (start < all.length && all[start].t < from) start++;
    }
    return start ? all.slice(start) : all;
  }

  function drawTrack(ip, pts, alpha) {
    if (!pts || !pts.length) return;
    const origin = getOrigin(ip);
    const color = trackColors[ip] || palette.series[0];
    const box = plotBox();

    ctx.save();
    ctx.beginPath();
    ctx.rect(box.x, box.y, box.w, box.h);
    ctx.clip();
    ctx.globalAlpha = alpha;
    ctx.lineJoin = 'round';
    ctx.lineCap = 'round';

    // decimate to ~1px steps so long tracks stay cheap
    const screen = [];
    let lastX = Infinity, lastY = Infinity;
    for (let i = 0; i < pts.length; i++) {
      const p = worldToScreen(pts[i].x, pts[i].y, origin);
      if (screen.length && i !== pts.length - 1
        && Math.abs(p.x - lastX) < 0.75 && Math.abs(p.y - lastY) < 0.75) continue;
      screen.push(p);
      lastX = p.x; lastY = p.y;
    }
    if (!screen.length) { ctx.restore(); return; }

    ctx.beginPath();
    for (let i = 0; i < screen.length; i++) {
      if (i === 0) ctx.moveTo(screen[i].x, screen[i].y);
      else ctx.lineTo(screen[i].x, screen[i].y);
    }
    // casing, then core — no fading on the trail
    ctx.strokeStyle = withAlpha(palette.background, 0.85);
    ctx.lineWidth = 7;
    ctx.stroke();
    ctx.strokeStyle = color;
    ctx.lineWidth = 3;
    ctx.stroke();

    // start marker: solid dot + ring + label
    const start = screen[0];
    ctx.beginPath();
    ctx.arc(start.x, start.y, 5, 0, Math.PI * 2);
    ctx.fillStyle = palette.background;
    ctx.fill();
    ctx.beginPath();
    ctx.arc(start.x, start.y, 8, 0, Math.PI * 2);
    ctx.strokeStyle = color;
    ctx.lineWidth = 2.5;
    ctx.stroke();
    ctx.fillStyle = withAlpha(palette.text, 0.9);
    ctx.font = '10px ui-sans-serif, system-ui, "Segoe UI", sans-serif';
    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';
    ctx.fillText('起点', start.x + 11, start.y - 12);

    // current marker: heading arrow + pulsing ring
    const head = pts[pts.length - 1];
    const last = screen[screen.length - 1];
    const phase = (performance.now() % PULSE_MS) / PULSE_MS;
    ctx.beginPath();
    ctx.arc(last.x, last.y, 6 + phase * 4, 0, Math.PI * 2);
    ctx.strokeStyle = withAlpha(color, 0.5 * (1 - phase));
    ctx.lineWidth = 2;
    ctx.stroke();

    ctx.beginPath();
    ctx.arc(last.x, last.y, 3.5, 0, Math.PI * 2);
    ctx.fillStyle = color;
    ctx.fill();

    if (isFinite(head.yaw)) {
      const angle = -head.yaw;
      const len = 15;
      const tipX = last.x + Math.cos(angle) * len;
      const tipY = last.y + Math.sin(angle) * len;
      ctx.strokeStyle = color;
      ctx.lineWidth = 2.5;
      ctx.beginPath();
      ctx.moveTo(last.x, last.y);
      ctx.lineTo(tipX, tipY);
      ctx.stroke();
      ctx.beginPath();
      ctx.moveTo(tipX, tipY);
      ctx.lineTo(tipX - Math.cos(angle - 0.45) * 5, tipY - Math.sin(angle - 0.45) * 5);
      ctx.lineTo(tipX - Math.cos(angle + 0.45) * 5, tipY - Math.sin(angle + 0.45) * 5);
      ctx.closePath();
      ctx.fillStyle = color;
      ctx.fill();
    }
    ctx.restore();
  }

  function drawCrosshair() {
    if (!hoverPoint) return;
    const box = plotBox();
    const { sx, sy } = hoverPoint;
    ctx.strokeStyle = withAlpha(palette.text, 0.25);
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(box.x, Math.round(sy) + 0.5);
    ctx.lineTo(box.x + box.w, Math.round(sy) + 0.5);
    ctx.moveTo(Math.round(sx) + 0.5, box.y);
    ctx.lineTo(Math.round(sx) + 0.5, box.y + box.h);
    ctx.stroke();
    ctx.beginPath();
    ctx.arc(sx, sy, 4.5, 0, Math.PI * 2);
    ctx.fillStyle = trackColors[hoverPoint.ip] || palette.series[0];
    ctx.fill();
  }

  function replayCutoff() {
    if (!replay.active) return null;
    if (replay.paused) {
      return replay.t0 + (replay.t1 - replay.t0) * (replay.elapsed / Math.max(1, replay.duration));
    }
    const elapsed = performance.now() - replay.startedAt;
    const k = Math.min(1, elapsed / Math.max(1, replay.duration));
    if (k >= 1) {
      replay.active = false;
      setReplayButton(false);
      return null;
    }
    return replay.t0 + (replay.t1 - replay.t0) * k;
  }

  function render() {
    resizeCanvas();
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    drawBackground();
    drawMetricGrid();

    const cutoff = replayCutoff();
    const order = Object.keys(tracks).sort((a, b) => {
      if (a === selectedIp) return 1;
      if (b === selectedIp) return -1;
      return 0;
    });
    order.forEach((ip) => {
      if (trackVisible[ip] === false) return;
      const pts = visiblePoints(ip, cutoff);
      if (!pts) return;
      const dimmed = selectedIp && ip !== selectedIp;
      drawTrack(ip, pts, dimmed ? 0.35 : 1);
    });

    drawCrosshair();
    updateScaleHud();
  }

  // ------------------------------------------------------------ HUD widgets
  const scaleBar = document.getElementById('track-scale-bar');
  const scaleLabel = document.getElementById('track-scale-label');
  const zoomLabel = document.getElementById('track-zoom-label');

  function updateScaleHud() {
    const step = niceStep(trackScale);
    const px = step * trackScale;
    if (scaleBar) scaleBar.style.width = `${Math.round(Math.min(140, px))}px`;
    if (scaleLabel) scaleLabel.textContent = step >= 1 ? `${step} m` : `${Math.round(step * 100)} cm`;
    if (zoomLabel) zoomLabel.textContent = `${Math.round((trackScale / Math.max(1e-6, baseScale)) * 100)}%`;
  }

  function setReplayButton(active) {
    const btn = document.getElementById('track-replay');
    if (!btn) return;
    btn.classList.toggle('active', !!active);
    btn.title = active ? '暂停/继续回放（空格）' : '回放轨迹（空格）';
  }

  function startReplay() {
    const all = Object.keys(tracks).flatMap((ip) => tracks[ip]);
    if (!all.length) return;
    const times = all.map((p) => p.t);
    replay = {
      active: true, paused: false, startedAt: performance.now(), elapsed: 0,
      t0: Math.min(...times), t1: Math.max(...times), duration: 1,
    };
    replay.duration = Math.max(2500, Math.min(20000, replay.t1 - replay.t0));
    setReplayButton(true);
    scheduleDraw();
  }

  function toggleReplayPause() {
    if (!replay.active) { startReplay(); return; }
    if (replay.paused) {
      replay.startedAt = performance.now() - replay.elapsed;
      replay.paused = false;
    } else {
      replay.elapsed = performance.now() - replay.startedAt;
      replay.paused = true;
    }
    scheduleDraw();
  }

  // ------------------------------------------------------------------ chips
  function refreshChips() {
    const box = document.getElementById('track-chips');
    if (!box) return;
    const ips = Object.keys(tracks);
    const signature = ips.join('|');
    if (box.dataset.signature !== signature) {
      box.dataset.signature = signature;
      box.innerHTML = '';
      ips.forEach((ip) => {
        const chip = document.createElement('button');
        chip.type = 'button';
        chip.className = 'track-chip';
        chip.dataset.ip = ip;
        chip.innerHTML = `
          <span class="track-chip-dot" style="background:${trackColors[ip] || palette.series[0]}"></span>
          <span class="track-chip-ip">${ip}</span>
          <span class="track-chip-pos">--</span>
        `;
        chip.addEventListener('click', () => {
          selectedIp = selectedIp === ip ? null : ip;
          syncChipSelection();
          scheduleDraw();
        });
        chip.addEventListener('mouseenter', () => { hoverIp = ip; scheduleDraw(); });
        chip.addEventListener('mouseleave', () => { hoverIp = null; scheduleDraw(); });
        box.appendChild(chip);
      });
      syncChipSelection();
    }
    ips.forEach((ip) => {
      const chip = box.querySelector(`.track-chip[data-ip="${ip.replace(/"/g, '\\"')}"]`);
      if (!chip) return;
      const last = tracks[ip][tracks[ip].length - 1];
      const origin = getOrigin(ip);
      const pos = chip.querySelector('.track-chip-pos');
      if (pos && last) pos.textContent = `(${(origin.x + last.x).toFixed(2)}, ${(origin.y + last.y).toFixed(2)})`;
      const dot = chip.querySelector('.track-chip-dot');
      if (dot) dot.style.background = trackColors[ip] || palette.series[0];
      chip.classList.toggle('selected', ip === selectedIp);
    });
  }

  function syncChipSelection() {
    const box = document.getElementById('track-chips');
    if (!box) return;
    box.querySelectorAll('.track-chip').forEach((chip) => {
      chip.classList.toggle('selected', chip.dataset.ip === selectedIp);
    });
  }

  // --------------------------------------------------------------- tooltip
  const tooltip = document.getElementById('track-tooltip');

  function showTooltip(info) {
    if (!tooltip) return;
    if (!info) { tooltip.classList.add('hidden'); return; }
    tooltip.innerHTML = `
      <div class="track-tooltip-head"><span class="track-tooltip-dot" style="background:${info.color}"></span>${info.ip}</div>
      <div class="track-tooltip-row"><span>时间</span><strong>${info.time}</strong></div>
      <div class="track-tooltip-row"><span>速度</span><strong>${info.speed}</strong></div>
      <div class="track-tooltip-row"><span>坐标</span><strong>${info.pos}</strong></div>
    `;
    tooltip.classList.remove('hidden');
    const rect = tooltip.getBoundingClientRect();
    let left = info.clientX + 14;
    let top = info.clientY + 14;
    if (left + rect.width > window.innerWidth - 8) left = info.clientX - rect.width - 14;
    if (top + rect.height > window.innerHeight - 8) top = info.clientY - rect.height - 14;
    tooltip.style.left = `${left}px`;
    tooltip.style.top = `${top}px`;
  }

  function findNearest(clientX, clientY) {
    const rect = canvas.getBoundingClientRect();
    const sx = clientX - rect.left;
    const sy = clientY - rect.top;
    let best = null;
    Object.keys(tracks).forEach((ip) => {
      if (trackVisible[ip] === false) return;
      if (selectedIp && ip !== selectedIp && hoverIp !== ip) return;
      const origin = getOrigin(ip);
      const pts = tracks[ip];
      const step = Math.max(1, Math.floor(pts.length / 4000));
      for (let i = 0; i < pts.length; i += step) {
        const p = worldToScreen(pts[i].x, pts[i].y, origin);
        const dx = p.x - sx;
        const dy = p.y - sy;
        const d2 = dx * dx + dy * dy;
        if (!best || d2 < best.d2) best = { ip, index: i, d2, sx: p.x, sy: p.y };
      }
    });
    if (!best || best.d2 > 20 * 20) return null;
    return best;
  }

  function updateHover(clientX, clientY) {
    const hit = findNearest(clientX, clientY);
    if (!hit) {
      hoverPoint = null;
      showTooltip(null);
      scheduleDraw();
      return;
    }
    const ip = hit.ip;
    const origin = getOrigin(ip);
    const pts = tracks[ip];
    const p = pts[hit.index];
    const prev = hit.index > 0 ? pts[hit.index - 1] : null;
    let speed = null;
    if (prev) {
      const dt = (p.t - prev.t) / 1000;
      if (dt > 1e-6) speed = Math.hypot(p.x - prev.x, p.y - prev.y) / dt;
    }
    const date = new Date(p.t);
    const time = `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}:${String(date.getSeconds()).padStart(2, '0')}`;
    hoverPoint = { ip, index: hit.index, sx: hit.sx, sy: hit.sy };
    showTooltip({
      ip,
      color: trackColors[ip] || palette.series[0],
      time,
      speed: speed === null ? '--' : `${speed.toFixed(2)} m/s`,
      pos: `(${(origin.x + p.x).toFixed(2)}, ${(origin.y + p.y).toFixed(2)}) m`,
      clientX,
      clientY,
    });
    scheduleDraw();
  }

  // ------------------------------------------------------------ interaction
  let dragging = false, dragMoved = false, last = [0, 0];

  canvas.addEventListener('wheel', (e) => {
    e.preventDefault();
    const rect = canvas.getBoundingClientRect();
    const mx = e.clientX - rect.left;
    const my = e.clientY - rect.top;
    const box = plotBox();
    const cx = box.x + box.w / 2 + trackOffsetX;
    const cy = box.y + box.h / 2 + trackOffsetY;
    const wx = (mx - cx) / trackScale;
    const wy = -(my - cy) / trackScale;
    const factor = Math.exp(-e.deltaY * 0.0008);
    trackScale = Math.max(0.2, Math.min(1200, trackScale * factor));
    const cx2 = box.x + box.w / 2;
    const cy2 = box.y + box.h / 2;
    trackOffsetX = mx - cx2 - wx * trackScale;
    trackOffsetY = my - cy2 + wy * trackScale;
    scheduleDraw();
  }, { passive: false });

  canvas.addEventListener('mousedown', (e) => {
    if (e.button !== 0) return;
    dragging = true;
    dragMoved = false;
    last = [e.clientX, e.clientY];
  });
  window.addEventListener('mouseup', (e) => {
    if (dragging && !dragMoved) {
      const hit = findNearest(e.clientX, e.clientY);
      selectedIp = hit ? (selectedIp === hit.ip ? null : hit.ip) : null;
      syncChipSelection();
      scheduleDraw();
    }
    dragging = false;
  });
  window.addEventListener('mousemove', (e) => {
    if (!dragging) return;
    const dx = e.clientX - last[0];
    const dy = e.clientY - last[1];
    if (Math.abs(dx) + Math.abs(dy) > 2) dragMoved = true;
    trackOffsetX += dx;
    trackOffsetY += dy;
    last = [e.clientX, e.clientY];
    scheduleDraw();
  });
  canvas.addEventListener('mousemove', (e) => updateHover(e.clientX, e.clientY));
  canvas.addEventListener('mouseleave', () => {
    hoverPoint = null;
    showTooltip(null);
    scheduleDraw();
  });
  canvas.addEventListener('dblclick', (e) => { e.preventDefault(); fitToWindow(); });

  document.getElementById('track-zoom-in')?.addEventListener('click', () => { trackScale = Math.min(1200, trackScale * 1.25); scheduleDraw(); });
  document.getElementById('track-zoom-out')?.addEventListener('click', () => { trackScale = Math.max(0.2, trackScale / 1.25); scheduleDraw(); });
  document.getElementById('track-fit')?.addEventListener('click', () => fitToWindow());
  document.getElementById('fit-window')?.addEventListener('click', () => fitToWindow());
  document.getElementById('track-replay')?.addEventListener('click', () => toggleReplayPause());
  document.getElementById('clear-tracks')?.addEventListener('click', () => {
    tracks = {};
    usedColors.clear();
    trackColorIndex = {};
    trackColorCustom = {};
    selectedIp = null;
    refreshChips();
    refreshLegend();
    scheduleDraw();
  });

  const windowToggle = document.getElementById('track-window-toggle');
  windowToggle?.querySelectorAll('button').forEach((btn) => {
    btn.addEventListener('click', () => {
      windowToggle.querySelectorAll('button').forEach((b) => b.classList.toggle('active', b === btn));
      windowSec = Number(btn.dataset.sec) || 0;
      scheduleDraw();
    });
  });

  const panel = document.getElementById('track-panel');
  const setPanel = (open) => {
    if (!panel) return;
    panel.classList.toggle('open', open);
    panel.setAttribute('aria-hidden', open ? 'false' : 'true');
  };
  document.getElementById('track-panel-toggle')?.addEventListener('click', () => setPanel(!panel.classList.contains('open')));
  document.getElementById('track-panel-close')?.addEventListener('click', () => setPanel(false));

  window.addEventListener('keydown', (e) => {
    if (e.code !== 'Space') return;
    const tag = (document.activeElement && document.activeElement.tagName) || '';
    if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;
    if (!page || !page.classList.contains('active')) return;
    e.preventDefault();
    toggleReplayPause();
  });

  window.addEventListener('resize', () => { resizeCanvas(); scheduleDraw(); });

  // ------------------------------------------------------------------ loop
  function scheduleDraw() {
    if (!rafId) rafId = requestAnimationFrame(frame);
  }

  function frame() {
    rafId = 0;
    if (page && !page.classList.contains('active')) return;
    render();
    if (!replay.paused) scheduleDraw();
  }

  window.drawTracks = () => { scheduleDraw(); };
  window.drawTracksScene = () => { scheduleDraw(); };

  function fitToWindow() {
    const pts = [];
    Object.keys(tracks).forEach((ip) => {
      const origin = getOrigin(ip);
      tracks[ip].forEach((p) => pts.push({ x: p.x + origin.x, y: p.y + origin.y }));
    });
    resizeCanvas();
    const box = plotBox();
    if (!pts.length) {
      trackScale = 60;
      baseScale = 60;
      trackOffsetX = 0;
      trackOffsetY = 0;
      scheduleDraw();
      return;
    }
    const minX = Math.min(...pts.map((p) => p.x));
    const maxX = Math.max(...pts.map((p) => p.x));
    const minY = Math.min(...pts.map((p) => p.y));
    const maxY = Math.max(...pts.map((p) => p.y));
    const width = Math.max(0.5, maxX - minX);
    const height = Math.max(0.5, maxY - minY);
    const scale = Math.min((box.w * 0.82) / width, (box.h * 0.82) / height);
    trackScale = Math.max(0.2, Math.min(1200, scale));
    baseScale = trackScale;
    const cxWorld = (minX + maxX) / 2;
    const cyWorld = (minY + maxY) / 2;
    const cx = box.x + box.w / 2;
    const cy = box.y + box.h / 2;
    trackOffsetX = -cxWorld * trackScale;
    trackOffsetY = cyWorld * trackScale;
    scheduleDraw();
  }

  apiRefs.fitToWindow = fitToWindow;
  apiRefs.refreshChips = refreshChips;
  apiRefs.scheduleDraw = scheduleDraw;
  apiRefs.setSelected = (ip) => { selectedIp = ip; syncChipSelection(); scheduleDraw(); };

  // The page is display:none until its tab is selected: fit once it becomes visible.
  let fitted = false;
  const mo = new MutationObserver(() => {
    if (!page || !page.classList.contains('active')) return;
    resizeCanvas();
    if (!fitted) { fitted = true; fitToWindow(); }
    render();
    scheduleDraw();
  });
  mo.observe(page, { attributes: true, attributeFilter: ['class'] });
  requestAnimationFrame(() => {
    if (page && page.classList.contains('active')) { fitted = true; resizeCanvas(); fitToWindow(); render(); }
  });
}

// ---------------------------------------------------------------------------
// Legend / settings panel
// ---------------------------------------------------------------------------
function refreshLegend() {
  const container = document.getElementById('track-legend');
  if (!container) return;
  container.innerHTML = '';
  Object.keys(tracks).forEach((ip) => {
    const item = document.createElement('div');
    item.className = 'track-item';

    const header = document.createElement('div');
    header.className = 'track-item-header';
    const ipLabel = document.createElement('span');
    ipLabel.className = 'track-item-ip';
    ipLabel.textContent = ip;
    const lastPos = tracks[ip][tracks[ip].length - 1];
    const origin = getOrigin(ip);
    const posLabel = document.createElement('span');
    posLabel.className = 'track-item-pos';
    posLabel.textContent = lastPos ? `(${(origin.x + lastPos.x).toFixed(2)}, ${(origin.y + lastPos.y).toFixed(2)})` : '(No pos)';
    const colorBox = document.createElement('div');
    colorBox.className = 'track-item-color';
    colorBox.style.background = trackColors[ip];
    const colorInput = document.createElement('input');
    colorInput.type = 'color';
    colorInput.value = cssColorToHex(trackColors[ip]);
    colorInput.style.display = 'none';
    colorBox.addEventListener('click', () => colorInput.click());
    colorInput.addEventListener('input', (e) => {
      trackColors[ip] = e.target.value;
      trackColorCustom[ip] = true;
      colorBox.style.background = e.target.value;
      if (apiRefs.refreshChips) apiRefs.refreshChips();
      if (apiRefs.scheduleDraw) apiRefs.scheduleDraw();
    });
    const toggle = document.createElement('input');
    toggle.className = 'track-item-visible';
    toggle.type = 'checkbox';
    toggle.checked = trackVisible[ip] !== false;
    toggle.addEventListener('change', () => {
      trackVisible[ip] = toggle.checked;
      if (apiRefs.scheduleDraw) apiRefs.scheduleDraw();
    });

    header.appendChild(ipLabel);
    header.appendChild(colorBox);
    header.appendChild(toggle);
    item.appendChild(header);
    item.appendChild(posLabel);

    const originRow = document.createElement('div');
    originRow.className = 'track-origin';
    const label = document.createElement('span');
    label.className = 'track-origin-label';
    label.textContent = '起点';
    const inputX = document.createElement('input');
    inputX.type = 'number';
    inputX.step = '0.1';
    inputX.className = 'track-origin-input';
    inputX.value = String(origin.x);
    inputX.title = '起点 X（米）';
    const inputY = document.createElement('input');
    inputY.type = 'number';
    inputY.step = '0.1';
    inputY.className = 'track-origin-input';
    inputY.value = String(origin.y);
    inputY.title = '起点 Y（米）';
    const applyOrigin = () => setOrigin(ip, inputX.value, inputY.value);
    inputX.addEventListener('change', applyOrigin);
    inputY.addEventListener('change', applyOrigin);
    const resetBtn = document.createElement('button');
    resetBtn.type = 'button';
    resetBtn.className = 'track-origin-reset';
    resetBtn.textContent = '归零';
    resetBtn.title = '起点回到 (0, 0)';
    resetBtn.addEventListener('click', () => {
      inputX.value = '0';
      inputY.value = '0';
      setOrigin(ip, 0, 0);
    });
    originRow.appendChild(label);
    originRow.appendChild(inputX);
    originRow.appendChild(inputY);
    originRow.appendChild(resetBtn);
    item.appendChild(originRow);

    container.appendChild(item);
  });
}

// ---------------------------------------------------------------------------
// Data intake
// ---------------------------------------------------------------------------
function recordPosition(ip, data) {
  if (!data.displacement || !Array.isArray(data.displacement) || !data.displacement[0]) return;
  const displacement = data.displacement[0];
  const x = displacement[0];
  const y = displacement[1];
  if (typeof x !== 'number' || typeof y !== 'number' || isNaN(x) || isNaN(y)) return;

  let isNewTrack = false;
  if (!tracks[ip]) {
    tracks[ip] = [];
    assignTrackColor(ip);
    trackVisible[ip] = true;
    isNewTrack = true;
  }
  const prev = tracks[ip].length ? tracks[ip][tracks[ip].length - 1] : null;
  const shouldStore = !prev || !isFinite(prev.x) || !isFinite(prev.y)
    || Math.hypot(x - prev.x, y - prev.y) > MIN_TRACK_POINT_DISTANCE;
  if (!shouldStore) return;

  let yaw = NaN;
  if (Array.isArray(data.eular) && data.eular[0] && isFinite(data.eular[0][2])) yaw = data.eular[0][2];
  tracks[ip].push({ x, y, yaw, t: Date.now() });
  if (tracks[ip].length > MAX_TRACK_POINTS) tracks[ip] = tracks[ip].slice(-MAX_TRACK_POINTS);

  const now = Date.now();
  if (isNewTrack) {
    if (apiRefs.refreshChips) apiRefs.refreshChips();
    refreshLegend();
  } else if (now - lastChipRefresh > CHIP_REFRESH_MS) {
    lastChipRefresh = now;
    if (apiRefs.refreshChips) apiRefs.refreshChips();
  }
  if (apiRefs.scheduleDraw) apiRefs.scheduleDraw();
}

function removeDevice(ip) {
  if (!tracks[ip]) return;
  delete tracks[ip];
  delete trackColors[ip];
  delete trackVisible[ip];
  delete trackColorIndex[ip];
  delete trackColorCustom[ip];
  if (selectedIp === ip) selectedIp = null;
  if (apiRefs.refreshChips) apiRefs.refreshChips();
  refreshLegend();
  if (apiRefs.scheduleDraw) apiRefs.scheduleDraw();
}

subscribeToThemeChanges();

return {
  initialize,
  recordPosition,
  removeDevice,
  setOrigin,
  getOrigin,
  getCacheData: () => ({ tracks, trackColors, trackVisible, trackOrigin, usedColors }),
};
}