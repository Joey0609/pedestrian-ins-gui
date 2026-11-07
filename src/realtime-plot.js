// Realtime canvas plot for the device page.
//
// Design goals (borrowed from the x-IMU3 GUI):
//   * ring buffers: samples are appended in O(1), never sliced or re-allocated
//   * pixel-column aggregation: cost per frame depends on canvas width, not rate
//   * a cached static layer (grid/axes/labels) redrawn only on resize/theme/range
//   * one rAF-driven redraw per dirty frame, no per-sample DOM or layout work
//
// Usage:
//   const store = RealtimePlot.createStore();     // shared time + per-key rings
//   store.pushTime(tSec); store.push('raw_accel_0_0', value);
//   const plot = RealtimePlot.create(el, { dims, colors, windowSec });
//   plot.bind(store, ['raw_accel_0_0', 'raw_accel_0_1', 'raw_accel_0_2']);
//   plot.render();
(function (root) {
  'use strict';

  // ---------------------------------------------------------------- ring buffer
  function Ring(capacity) {
    this.capacity = capacity;
    this.data = new Float32Array(capacity);
    this.head = 0;   // next write slot
    this.count = 0;
    this.last = NaN;
  }
  Ring.prototype.push = function (value) {
    this.data[this.head] = value;
    this.head = (this.head + 1) % this.capacity;
    if (this.count < this.capacity) this.count++;
    this.last = value;
  };
  Ring.prototype.at = function (i) {
    const start = (this.head - this.count + this.capacity) % this.capacity;
    return this.data[(start + i) % this.capacity];
  };
  Ring.prototype.clear = function () {
    this.head = 0;
    this.count = 0;
    this.last = NaN;
  };

  function createStore(capacity) {
    const cap = capacity || 65536;
    const time = new Ring(cap);
    const series = new Map();
    // Timestamps are kept relative to the first sample: absolute epoch seconds do
    // not fit in a Float32 with millisecond resolution (1.7e9 s -> ~128 s steps).
    let t0 = null;
    return {
      capacity: cap,
      time,
      pushTime(t) {
        if (t0 === null) t0 = t;
        time.push(t - t0);
      },
      ensure(key) {
        let ring = series.get(key);
        if (!ring) { ring = new Ring(cap); series.set(key, ring); }
        return ring;
      },
      push(key, value) { this.ensure(key).push(value); },
      ring(key) { return series.get(key) || null; },
      clear() {
        t0 = null;
        time.clear();
        series.forEach((r) => r.clear());
      },
      keys() { return Array.from(series.keys()); },
    };
  }

  // ------------------------------------------------------------------- helpers
  function niceStep(range, targetTicks) {
    const raw = range / Math.max(1, targetTicks);
    const mag = Math.pow(10, Math.floor(Math.log10(raw)));
    const norm = raw / mag;
    let step;
    if (norm <= 1) step = 1; else if (norm <= 2) step = 2; else if (norm <= 2.5) step = 2.5; else if (norm <= 5) step = 5; else step = 10;
    return step * mag;
  }

  function formatValue(v, step) {
    if (!isFinite(v)) return '--';
    if (Math.abs(v) < 1e-12) return '0';
    const abs = Math.abs(v);
    if (abs >= 1000) return v.toFixed(0);
    if (step >= 1) return v.toFixed(step >= 10 ? 0 : 1);
    if (step >= 0.1) return v.toFixed(1);
    if (step >= 0.01) return v.toFixed(2);
    if (abs === 0) return '0';
    return v.toPrecision(2);
  }

  function toRgba(color, alpha) {
    if (!color) return `rgba(255,255,255,${alpha})`;
    const c = color.trim();
    if (c.startsWith('#')) {
      let hex = c.slice(1);
      if (hex.length === 3) hex = hex.split('').map((ch) => ch + ch).join('');
      const r = parseInt(hex.slice(0, 2), 16);
      const g = parseInt(hex.slice(2, 4), 16);
      const b = parseInt(hex.slice(4, 6), 16);
      return `rgba(${r},${g},${b},${alpha})`;
    }
    if (c.startsWith('rgb(')) return c.replace('rgb(', 'rgba(').replace(')', `,${alpha})`);
    if (c.startsWith('rgba(')) return c.replace(/[\d.]+\)$/, `${alpha})`);
    return color;
  }

  function readPalette(el) {
    const cs = getComputedStyle(el || document.documentElement);
    // The device page defines its own variables (--card/--plot-grid/--muted);
    // the main window defines --viz-*. Accept either so both themes look right.
    const pick = (...names) => {
      for (const name of names) {
        const v = (cs.getPropertyValue(name) || '').trim();
        if (v) return v;
      }
      return '';
    };
    return {
      bg: pick('--viz-bg', '--card') || '#0b0d10',
      grid: pick('--viz-grid', '--plot-grid') || 'rgba(127,127,127,0.18)',
      axis: pick('--viz-axis', '--muted') || 'rgba(127,127,127,0.5)',
      text: pick('--viz-text', '--muted') || '#9aa3b2',
      primary: pick('--accent', '--primary') || '#5a8ff8',
      font: '11px ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, "Helvetica Neue", Arial',
    };
  }

  const PAD = { left: 44, right: 10, top: 10, bottom: 22 };

  // ---------------------------------------------------------------------- plot
  function createPlot(container, options) {
    const opts = Object.assign({
      dims: 3,
      colors: ['#ef4444', '#22c55e', '#3b82f6'],
      windowSec: 5,
      autoY: true,
      yMin: -1,
      yMax: 1,
      valueUnit: '',
    }, options || {});

    // One canvas: grid, series and cursor are all drawn in the same pass.
    // Stacking extra canvases costs more in compositing than it saves.
    const canvas = document.createElement('canvas');
    canvas.className = 'rt-plot-canvas';
    canvas.style.cssText = 'position:absolute;inset:0;width:100%;height:100%;';
    const ctx = canvas.getContext('2d');

    container.style.position = container.style.position || 'relative';
    container.appendChild(canvas);

    const state = {
      palette: readPalette(container),
      store: null,
      keys: [],
      dims: opts.dims,
      colors: opts.colors.slice(),
      windowSec: opts.windowSec,
      offsetSec: 0,
      autoY: opts.autoY,
      yMin: opts.yMin,
      yMax: opts.yMax,
      axesVisible: new Array(opts.dims).fill(true),
      paused: false,
      frozenNow: null,
      cssW: 0,
      cssH: 0,
      dpr: 1,
      hover: null,
      dirty: true,
      rafId: 0,
      destroyed: false,
    };

    function resize() {
      const w = Math.max(1, Math.round(container.clientWidth));
      const h = Math.max(1, Math.round(container.clientHeight || 310));
      const dpr = window.devicePixelRatio || 1;
      if (w === state.cssW && h === state.cssH && dpr === state.dpr) return;
      state.cssW = w; state.cssH = h; state.dpr = dpr;
      canvas.width = Math.round(w * dpr);
      canvas.height = Math.round(h * dpr);
      state.dirty = true;
    }

    function plotRect() {
      return {
        x: PAD.left,
        y: PAD.top,
        w: Math.max(1, state.cssW - PAD.left - PAD.right),
        h: Math.max(1, state.cssH - PAD.top - PAD.bottom),
      };
    }

    function timeWindow(now) {
      const end = state.paused ? (state.frozenNow || now) - state.offsetSec : now - state.offsetSec;
      return { min: end - state.windowSec, max: end };
    }

    function seriesBounds(ring, timeRing, tw) {
      // returns [min, max] over the visible window
      let min = Infinity, max = -Infinity;
      const n = timeRing.count;
      for (let i = 0; i < n; i++) {
        const t = timeRing.at(i);
        if (t < tw.min || t > tw.max) continue;
        const v = ring.at(i);
        if (!isFinite(v)) continue;
        if (v < min) min = v;
        if (v > max) max = v;
      }
      return { min, max };
    }

    // Grid + axes + labels. Redrawn every frame: a few dozen 1px lines are
    // cheaper than compositing an extra full-size canvas layer.
    function drawBackground(now) {
      const { palette } = state;
      const r = plotRect();
      const tw = timeWindow(now);
      const yMin = state.yMin;
      const yMax = state.yMax;
      const yRange = Math.max(1e-9, yMax - yMin);

      ctx.fillStyle = palette.bg;
      ctx.fillRect(0, 0, state.cssW, state.cssH);

      const yStep = niceStep(yRange, 5);
      const xStep = niceStep(state.windowSec, 5);

      // Time ticks are anchored to the right edge (t = 0) so the labels stay
      // -5 … 0 instead of drifting/jittering as absolute time advances.
      const xTicks = [];
      const tickCount = Math.max(1, Math.round(state.windowSec / xStep));
      for (let k = tickCount; k >= 0; k--) {
        const rel = -k * xStep;
        const t = tw.max + rel;
        if (t < tw.min - 1e-9) continue;
        xTicks.push({ rel, t });
      }

      ctx.strokeStyle = palette.grid;
      ctx.lineWidth = 1;
      ctx.beginPath();
      const firstY = Math.ceil(yMin / yStep) * yStep;
      for (let v = firstY; v <= yMax + 1e-9; v += yStep) {
        const py = Math.round(r.y + r.h - ((v - yMin) / yRange) * r.h) + 0.5;
        ctx.moveTo(r.x, py);
        ctx.lineTo(r.x + r.w, py);
      }
      for (const tick of xTicks) {
        const px = Math.round(r.x + ((tick.t - tw.min) / Math.max(1e-9, tw.max - tw.min)) * r.w) + 0.5;
        ctx.moveTo(px, r.y);
        ctx.lineTo(px, r.y + r.h);
      }
      ctx.stroke();

      ctx.fillStyle = palette.text;
      ctx.font = palette.font;
      ctx.textAlign = 'right';
      ctx.textBaseline = 'middle';
      for (let v = firstY; v <= yMax + 1e-9; v += yStep) {
        const py = r.y + r.h - ((v - yMin) / yRange) * r.h;
        ctx.fillText(formatValue(v, yStep), r.x - 6, py);
      }
      ctx.textAlign = 'center';
      ctx.textBaseline = 'top';
      const timeDigits = xStep >= 1 ? 0 : (xStep >= 0.1 ? 1 : 2);
      for (const tick of xTicks) {
        const px = r.x + ((tick.t - tw.min) / Math.max(1e-9, tw.max - tw.min)) * r.w;
        const label = Math.abs(tick.rel) < xStep / 100 ? '0' : tick.rel.toFixed(timeDigits);
        ctx.fillText(label, px, r.y + r.h + 5);
      }

      // window badge, top-right inside the plot area
      ctx.textAlign = 'right';
      ctx.textBaseline = 'top';
      const windowLabel = state.windowSec >= 10 ? state.windowSec.toFixed(0) : state.windowSec.toFixed(1);
      ctx.fillText(`${windowLabel}s`, r.x + r.w - 4, r.y + 4);
    }

    function drawSeriesData(now) {
      const { store, palette } = state;
      if (!store) return;
      const tw = timeWindow(now);
      const r = plotRect();
      const span = Math.max(1e-9, tw.max - tw.min);
      const timeRing = store.time;
      const n = timeRing.count;

      if (state.autoY) {
        let min = Infinity, max = -Infinity;
        for (let s = 0; s < state.dims; s++) {
          if (!state.axesVisible[s]) continue;
          const ring = state.store.ring(state.keys[s]);
          if (!ring) continue;
          const b = seriesBounds(ring, timeRing, tw);
          if (b.min < min) min = b.min;
          if (b.max > max) max = b.max;
        }
        if (isFinite(min) && isFinite(max)) {
          if (min === max) { min -= 1; max += 1; }
          const pad = (max - min) * 0.08;
          state.yMin = min - pad;
          state.yMax = max + pad;
        }
      }

      const yMin = state.yMin;
      const yMax = state.yMax;
      const yRange = Math.max(1e-9, yMax - yMin);

      // Reuse the column scratch buffers; allocating them per frame is pure GC.
      const cols = Math.max(1, Math.floor(r.w));
      if (!state.colMin || state.colMin.length < cols) {
        state.colMin = new Float32Array(cols);
        state.colMax = new Float32Array(cols);
        state.colHit = new Uint8Array(cols);
      }
      const colMin = state.colMin;
      const colMax = state.colMax;
      const colHit = state.colHit;

      for (let s = 0; s < state.dims; s++) {
        if (!state.axesVisible[s]) continue;
        const ring = store.ring(state.keys[s]);
        if (!ring || ring.count === 0) continue;

        colMin.fill(Infinity, 0, cols);
        colMax.fill(-Infinity, 0, cols);
        colHit.fill(0, 0, cols);

        let lastCol = -1;
        for (let i = 0; i < n; i++) {
          const t = timeRing.at(i);
          if (t < tw.min || t > tw.max) continue;
          const v = ring.at(i);
          if (!isFinite(v)) continue;
          const col = Math.min(cols - 1, Math.max(0, Math.floor(((t - tw.min) / span) * cols)));
          if (v < colMin[col]) colMin[col] = v;
          if (v > colMax[col]) colMax[col] = v;
          colHit[col] = 1;
          lastCol = col;
        }
        if (lastCol < 0) continue;

        const color = state.colors[s % state.colors.length] || palette.primary;
        ctx.strokeStyle = color;
        ctx.lineWidth = 1.25;
        ctx.lineJoin = 'round';
        ctx.lineCap = 'round';
        ctx.beginPath();
        let started = false;
        for (let col = 0; col <= lastCol; col++) {
          if (!colHit[col]) continue;
          const x = r.x + col + 0.5;
          const yTop = r.y + r.h - ((colMax[col] - yMin) / yRange) * r.h;
          const yBottom = r.y + r.h - ((colMin[col] - yMin) / yRange) * r.h;
          if (!started) { ctx.moveTo(x, yTop); started = true; }
          else ctx.lineTo(x, yTop);
          if (yBottom !== yTop) ctx.lineTo(x, yBottom);
        }
        ctx.stroke();

        const lastT = timeRing.at(n - 1);
        const lastV = ring.at(n - 1);
        if (isFinite(lastV) && lastT >= tw.min && lastT <= tw.max) {
          const hx = r.x + ((lastT - tw.min) / span) * r.w;
          const hy = r.y + r.h - ((lastV - yMin) / yRange) * r.h;
          ctx.fillStyle = color;
          ctx.beginPath();
          ctx.arc(hx, hy, 2.2, 0, Math.PI * 2);
          ctx.fill();
        }
      }
    }

    function drawCursor(now) {
      if (!state.hover || !state.store) return;
      const r = plotRect();
      const x = state.hover.x;
      const y = state.hover.y;
      if (x < r.x || x > r.x + r.w || y < r.y || y > r.y + r.h) return;

      ctx.strokeStyle = toRgba(state.palette.text, 0.35);
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(Math.round(x) + 0.5, r.y);
      ctx.lineTo(Math.round(x) + 0.5, r.y + r.h);
      ctx.stroke();

      const tw = timeWindow(state.store.time.last);
      const span = Math.max(1e-9, tw.max - tw.min);
      const t = tw.min + ((x - r.x) / r.w) * span;
      ctx.fillStyle = state.palette.text;
      ctx.font = state.palette.font;
      ctx.textAlign = 'left';
      ctx.textBaseline = 'bottom';
      ctx.fillText(`t=${(t - tw.max).toFixed(2)}s`, r.x + 6, r.y + 12);

      const timeRing = state.store.time;
      let best = -1, bestDt = Infinity;
      for (let i = 0; i < timeRing.count; i++) {
        const dt = Math.abs(timeRing.at(i) - t);
        if (dt < bestDt) { bestDt = dt; best = i; }
      }
      if (best >= 0) {
        let ty = r.y + 26;
        for (let s = 0; s < state.dims; s++) {
          if (!state.axesVisible[s]) continue;
          const ring = state.store.ring(state.keys[s]);
          if (!ring) continue;
          const v = ring.at(best);
          ctx.fillStyle = state.colors[s % state.colors.length];
          ctx.fillText(`${v.toFixed(3)}`, r.x + 6, ty);
          ty += 14;
        }
      }
    }

    function renderFrame(now) {
      ctx.setTransform(state.dpr, 0, 0, state.dpr, 0, 0);
      ctx.clearRect(0, 0, state.cssW, state.cssH);
      drawBackground(now);
      drawSeriesData(now);
      drawCursor(now);
    }
    function frame() {
      state.rafId = 0;
      if (state.destroyed) return;
      if (!state.dirty) return;
      state.dirty = false;
      const now = state.store && state.store.time.count ? state.store.time.last : 0;
      renderFrame(now);
    }

    function requestDraw() {
      if (state.destroyed) return;
      state.dirty = true;
      if (!state.rafId) state.rafId = requestAnimationFrame(frame);
    }

    function onPointerMove(ev) {
      const rect = canvas.getBoundingClientRect();
      state.hover = { x: ev.clientX - rect.left, y: ev.clientY - rect.top };
      state.dirty = true;
      requestDraw();
    }
    function onPointerLeave() {
      state.hover = null;
      state.dirty = true;
      requestDraw();
    }
    canvas.addEventListener('mousemove', onPointerMove);
    canvas.addEventListener('mouseleave', onPointerLeave);

    const ro = typeof ResizeObserver === 'function' ? new ResizeObserver(() => { resize(); requestDraw(); }) : null;
    if (ro) ro.observe(container);

    const plot = {
      canvas,
      bind(store, keys) {
        state.store = store;
        state.keys = keys.slice();
        state.dims = keys.length;
        state.dirty = true;
        requestDraw();
      },
      setAxesVisible(visible) {
        state.axesVisible = visible.slice();
        state.dirty = true;
        requestDraw();
      },
      setWindow(seconds) { state.windowSec = Math.max(0.1, seconds); requestDraw(); },
      setOffset(seconds) { state.offsetSec = Math.max(0, seconds || 0); requestDraw(); },
      setYRange(min, max) { state.yMin = min; state.yMax = max; requestDraw(); },
      setAutoY(on) { state.autoY = !!on; requestDraw(); },
      setPaused(paused) {
        state.paused = !!paused;
        state.frozenNow = paused ? (state.store && state.store.time.count ? state.store.time.last : 0) + state.offsetSec : null;
        requestDraw();
      },
      setPalette(palette) { state.palette = palette || readPalette(container); requestDraw(); },
      setColors(colors) { if (Array.isArray(colors) && colors.length) { state.colors = colors.slice(); state.dirty = true; requestDraw(); } },
      resize() { resize(); requestDraw(); },
      render() { requestDraw(); },
      drawNow() { state.dirty = true; if (state.rafId) { cancelAnimationFrame(state.rafId); state.rafId = 0; } frame(); },
      debugInfo() { return { yMin: state.yMin, yMax: state.yMax, autoY: state.autoY, windowSec: state.windowSec, offset: state.offsetSec, keys: state.keys.slice(), dims: state.dims, cssW: state.cssW, cssH: state.cssH, last: state.store ? state.store.time.last : null, count: state.store ? state.store.time.count : 0 }; },
      bounds() {
        if (!state.store) return { min: -1, max: 1 };
        const tw = timeWindow(state.store.time.last);
        let min = Infinity, max = -Infinity;
        for (let s = 0; s < state.dims; s++) {
          if (!state.axesVisible[s]) continue;
          const ring = state.store.ring(state.keys[s]);
          if (!ring) continue;
          const b = seriesBounds(ring, state.store.time, tw);
          if (b.min < min) min = b.min;
          if (b.max > max) max = b.max;
        }
        return { min, max };
      },
      destroy() {
        state.destroyed = true;
        if (state.rafId) cancelAnimationFrame(state.rafId);
        canvas.removeEventListener('mousemove', onPointerMove);
        canvas.removeEventListener('mouseleave', onPointerLeave);
        if (ro) ro.disconnect();
        canvas.remove();
      },
    };

    resize();
    requestDraw();
    return plot;
  }

  root.RealtimePlot = { createStore, create: createPlot, readPalette, toRgba };
})(typeof window !== 'undefined' ? window : globalThis);