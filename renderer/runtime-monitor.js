import { formatBytes, formatBytesSmart } from './utils.js';

export function createRuntimeMonitor({ getCaches, getModelCache }) {
const runtimeMemoryEl = document.getElementById('runtime-memory');
const runtimeCpuEl = document.getElementById('runtime-cpu');
const runtimeCacheEl = document.getElementById('runtime-cache');

function estimateValueBytes(value, seen, state) {
  if (value === null || value === undefined) return 0;

  const valueType = typeof value;
  if (valueType === 'string') return value.length * 2;
  if (valueType === 'number') return 8;
  if (valueType === 'boolean') return 4;
  if (valueType === 'bigint') return 8;
  if (valueType === 'function' || valueType === 'symbol') return 0;

  if (seen.has(value)) return 0;
  seen.add(value);

  state.nodes += 1;
  if (state.nodes > state.maxNodes) {
    state.truncated = true;
    return 0;
  }

  if (ArrayBuffer.isView(value)) {
    return value.byteLength || 0;
  }
  if (value instanceof ArrayBuffer) {
    return value.byteLength || 0;
  }
  if (value instanceof Date) {
    return 8;
  }

  let total = 0;

  if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i++) {
      total += estimateValueBytes(value[i], seen, state);
      if (state.truncated) break;
    }
    return total;
  }

  if (value instanceof Map) {
    for (const [k, v] of value.entries()) {
      total += estimateValueBytes(k, seen, state);
      total += estimateValueBytes(v, seen, state);
      if (state.truncated) break;
    }
    return total;
  }

  if (value instanceof Set) {
    for (const item of value.values()) {
      total += estimateValueBytes(item, seen, state);
      if (state.truncated) break;
    }
    return total;
  }

  const keys = Object.keys(value);
  for (let i = 0; i < keys.length; i++) {
    const key = keys[i];
    total += key.length * 2;
    total += estimateValueBytes(value[key], seen, state);
    if (state.truncated) break;
  }
  return total;
}

function estimateThreeObjectBytes(root) {
  if (!root || typeof root.traverse !== 'function') return 0;

  let total = 0;
  const seenGeometry = new Set();
  const seenTextures = new Set();

  root.traverse((obj) => {
    if (!obj || !obj.isMesh) return;

    const geometry = obj.geometry;
    if (geometry && !seenGeometry.has(geometry)) {
      seenGeometry.add(geometry);
      const attrs = geometry.attributes || {};
      for (const attrName of Object.keys(attrs)) {
        const attr = attrs[attrName];
        if (attr && attr.array && Number.isFinite(attr.array.byteLength)) {
          total += attr.array.byteLength;
        }
      }

      if (geometry.index && geometry.index.array && Number.isFinite(geometry.index.array.byteLength)) {
        total += geometry.index.array.byteLength;
      }

      const morph = geometry.morphAttributes || {};
      for (const morphName of Object.keys(morph)) {
        const list = morph[morphName] || [];
        for (let i = 0; i < list.length; i++) {
          const attr = list[i];
          if (attr && attr.array && Number.isFinite(attr.array.byteLength)) {
            total += attr.array.byteLength;
          }
        }
      }
    }

    const materials = Array.isArray(obj.material) ? obj.material : [obj.material];
    for (let i = 0; i < materials.length; i++) {
      const mat = materials[i];
      if (!mat) continue;
      const textureKeys = ['map', 'normalMap', 'roughnessMap', 'metalnessMap', 'emissiveMap', 'alphaMap', 'aoMap', 'displacementMap', 'lightMap', 'specularMap'];
      for (let k = 0; k < textureKeys.length; k++) {
        const tex = mat[textureKeys[k]];
        if (!tex || seenTextures.has(tex)) continue;
        seenTextures.add(tex);
        const image = tex.image || (tex.source && tex.source.data);
        if (image && Number.isFinite(image.width) && Number.isFinite(image.height)) {
          total += image.width * image.height * 4;
        }
      }
    }
  });

  return total;
}

function getRuntimeCacheStats() {
  const { tracks, trackColors, trackVisible, recordingData, connections, scanState, usedColors } = getCaches();
  const PCBModelGlobal = getModelCache();
  const state = { nodes: 0, maxNodes: 80000, truncated: false };
  const seen = new WeakSet();
  let total = 0;

  // Data-heavy runtime caches in renderer process.
  total += estimateValueBytes(tracks, seen, state);
  total += estimateValueBytes(trackColors, seen, state);
  total += estimateValueBytes(trackVisible, seen, state);
  total += estimateValueBytes(recordingData, seen, state);
  total += estimateValueBytes(connections, seen, state);
  total += estimateValueBytes(scanState, seen, state);
  total += estimateValueBytes(Array.from(usedColors), seen, state);

  // Explicit model cache (loaded once and reused by cloned instances).
  total += estimateThreeObjectBytes(PCBModelGlobal);

  return {
    bytes: total,
    truncated: state.truncated,
  };
}

async function updateRuntimeStats() {
  if (!window.electronAPI || typeof window.electronAPI.getRuntimeStats !== 'function') return;
  try {
    const stats = await window.electronAPI.getRuntimeStats();
    if (runtimeCacheEl) {
      const cacheStats = getRuntimeCacheStats();
      runtimeCacheEl.textContent = `${formatBytesSmart(cacheStats.bytes)}${cacheStats.truncated ? '+' : ''}`;
    }
    if (runtimeMemoryEl && stats && stats.memory) {
      runtimeMemoryEl.textContent = formatBytes(stats.memory.rss);
    }
    if (runtimeCpuEl && stats && stats.cpu) {
      const cpu = Math.max(0, stats.cpu.percent || 0);
      runtimeCpuEl.textContent = `${cpu.toFixed(cpu >= 10 ? 0 : 1)}%`;
    }
  } catch (e) {
    console.warn('updateRuntimeStats error', e);
  }
}

function start() {
updateRuntimeStats();
setInterval(updateRuntimeStats, 1000);
}

return { start, getRuntimeCacheStats };
}
