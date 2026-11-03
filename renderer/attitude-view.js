// Relative URLs remain resolvable when the renderer is loaded via file:// in
// the packaged Electron application.
import * as THREE from '../node_modules/three/build/three.module.js';
import { OrbitControls } from '../node_modules/three/examples/jsm/controls/OrbitControls.js';
import { OBJLoader } from '../node_modules/three/examples/jsm/loaders/OBJLoader.js';
import { MTLLoader } from '../node_modules/three/examples/jsm/loaders/MTLLoader.js';
import { isIPv4Address } from './utils.js';
import { onThemeChange } from './theme.js';

// ===========================================================================
// Theme-aware palette
// ---------------------------------------------------------------------------
// WebGL cannot resolve CSS custom properties, so the concrete colours are read
// from the `--viz-*` tokens at view creation and re-read on every
// `wj:themechange`. The scene background is the `--viz-bg` colour (the cards
// behind the canvases use the same value via `--bg-card`), so the 3D view is
// opaque and self-consistent in both themes.
// ===========================================================================
const VIZ_ROLE_MODEL = 'model';
const VIZ_ROLE_ACCENT = 'accent';

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

function parseCssColor(raw) {
  const text = String(raw || '').trim().toLowerCase();
  if (!text || text === 'transparent') return { r: 0, g: 0, b: 0, a: 0 };
  if (text.charAt(0) === '#') {
    const hex = text.slice(1);
    if (hex.length === 3 || hex.length === 4) {
      const r = parseInt(hex.charAt(0) + hex.charAt(0), 16);
      const g = parseInt(hex.charAt(1) + hex.charAt(1), 16);
      const b = parseInt(hex.charAt(2) + hex.charAt(2), 16);
      const a = hex.length === 4 ? parseInt(hex.charAt(3) + hex.charAt(3), 16) / 255 : 1;
      if (isFinite(r) && isFinite(g) && isFinite(b)) return { r, g, b, a: isFinite(a) ? a : 1 };
    } else if (hex.length === 6 || hex.length === 8) {
      const r = parseInt(hex.slice(0, 2), 16);
      const g = parseInt(hex.slice(2, 4), 16);
      const b = parseInt(hex.slice(4, 6), 16);
      const a = hex.length === 8 ? parseInt(hex.slice(6, 8), 16) / 255 : 1;
      if (isFinite(r) && isFinite(g) && isFinite(b)) return { r, g, b, a: isFinite(a) ? a : 1 };
    }
    return { r: 0, g: 0, b: 0, a: 0 };
  }
  const rgbMatch = /^rgba?\(([^)]+)\)$/.exec(text);
  if (rgbMatch) {
    const parts = rgbMatch[1].split(/[\s,/]+/).filter(Boolean);
    if (parts.length >= 3) {
      const channel = (part) => {
        const value = parseFloat(part);
        if (!isFinite(value)) return 0;
        const scaled = part.indexOf('%') !== -1 ? value * 2.55 : value;
        return Math.max(0, Math.min(255, scaled));
      };
      const alpha = parts.length >= 4 ? parseFloat(parts[3]) : 1;
      return {
        r: channel(parts[0]),
        g: channel(parts[1]),
        b: channel(parts[2]),
        a: isFinite(alpha) ? Math.max(0, Math.min(1, alpha)) : 1,
      };
    }
  }
  return { r: 0, g: 0, b: 0, a: 0 };
}

function cssColorToHex(rgba) {
  const channel = (value) => {
    const n = Math.max(0, Math.min(255, Math.round(value)));
    return n.toString(16).padStart(2, '0');
  };
  return '#' + channel(rgba.r) + channel(rgba.g) + channel(rgba.b);
}

function toThreeColor(rgba) {
  return new THREE.Color(cssColorToHex(rgba));
}

function readVizPalette() {
  const root = typeof document !== 'undefined' ? document.documentElement : null;
  const dark = !!(root && root.dataset && root.dataset.theme === 'dark');
  const token = (name, ...fallbacks) => parseCssColor(readToken(name, ...fallbacks));
  const background = token('--viz-bg', '--bg-card');
  const axis = token('--viz-axis', '--border-strong');
  return {
    dark,
    background: toThreeColor(background),
    axis: { color: toThreeColor(axis), opacity: axis.a },
    model: toThreeColor(token('--viz-model', '--text-secondary')),
    modelAccent: toThreeColor(token('--viz-model-accent', '--primary')),
    ambient: toThreeColor(token('--viz-ambient', '--text-primary')),
    // Dark surfaces need a little more light to keep the model readable, but
    // stay below the blow-out point for the light MTL materials.
    ambientIntensity: dark ? 0.75 : 0.6,
    directionalIntensity: dark ? 0.65 : 0.6,
  };
}

// Materials created by the fallback paths are tagged with the token they follow
// so theme changes can recolour the existing material instead of rebuilding the
// scene. Materials that came from the PCBmodel.mtl file keep their authoring
// colours and are lit by the theme-aware lights.
function tagVizMaterial(material, role) {
  const materials = Array.isArray(material) ? material : [material];
  materials.forEach((mat) => {
    if (!mat) return;
    if (!mat.userData) mat.userData = {};
    mat.userData.wjVizRole = role;
  });
  return material;
}

function paintVizMaterial(material, palette) {
  const materials = Array.isArray(material) ? material : [material];
  materials.forEach((mat) => {
    if (!mat || !mat.color || typeof mat.color.copy !== 'function' || !mat.userData) return;
    const role = mat.userData.wjVizRole;
    if (role === VIZ_ROLE_MODEL) mat.color.copy(palette.model);
    else if (role === VIZ_ROLE_ACCENT) mat.color.copy(palette.modelAccent);
  });
}

function createLineMaterial(spec) {
  return new THREE.LineBasicMaterial({
    color: spec.color,
    transparent: spec.opacity < 1,
    opacity: spec.opacity,
  });
}

function applyVizPaletteToView(view, palette) {
  // The view may have been disposed while the theme event was in flight.
  if (!view || view.disposed || !view.scene) return;
  const scene = view.scene;
  if (scene.background && scene.background.isColor) scene.background.set(palette.background);
  else scene.background = palette.background.clone();

  if (view.ambientLight) {
    view.ambientLight.color.copy(palette.ambient);
    view.ambientLight.intensity = palette.ambientIntensity;
  }
  if (view.directionalLight) {
    view.directionalLight.color.copy(palette.ambient);
    view.directionalLight.intensity = palette.directionalIntensity;
  }
  if (view.axes) {
    const materials = Array.isArray(view.axes.material) ? view.axes.material : [view.axes.material];
    materials.forEach((mat) => {
      if (!mat || !mat.color || typeof mat.color.copy !== 'function') return;
      const wasTransparent = !!mat.transparent;
      mat.color.copy(palette.axis.color);
      mat.opacity = palette.axis.opacity;
      mat.transparent = palette.axis.opacity < 1;
      if (wasTransparent !== mat.transparent) mat.needsUpdate = true;
    });
  }
  scene.traverse((obj) => {
    if (obj && obj.isMesh && obj.material) paintVizMaterial(obj.material, palette);
  });
  if (view.renderer && view.camera && typeof view.renderer.render === 'function') {
    try {
      view.renderer.render(scene, view.camera);
    } catch (e) {
      /* the renderer was disposed between the event and this repaint */
    }
  }
}

export function createAttitudeView({ electronAPI, getConnections }) {
// One board model per firmware family; devices whose family is not (yet) known,
// or whose model file is missing, fall back to the default board.
const MODEL_VARIANTS = {
  bmi088: 'PCBmodel',
  all_sensors: 'PCBmodel_all_sensors',
};
const DEFAULT_MODEL = 'PCBmodel';
const modelCache = new Map();   // model base name -> Promise<Object3D|null>
const loadedModels = [];        // resolved models, for the runtime cache estimate

let rendererMap = new Map();
let themeSubscription = null;

function modelNameForFamily(family) {
  return MODEL_VARIANTS[family] || DEFAULT_MODEL;
}

async function loadModelFile(baseName) {
  try {
    console.log('Loading PCB model:', baseName);
    // compute a URL relative to the current index.html
    const modelUrl = new URL(`../assets/models/${baseName}.obj`, window.location.href).href;
    const basePathAbs = modelUrl.substring(0, modelUrl.lastIndexOf('/') + 1);
    const mtlFilename = `${baseName}.mtl`;

    const mtlLoader = new MTLLoader();
    mtlLoader.setPath(basePathAbs);
    mtlLoader.setResourcePath(basePathAbs);

    try {
      const materials = await new Promise((resolve, reject) => {
        mtlLoader.load(mtlFilename, resolve, undefined, () => reject(new Error('MTL not found')));
      });
      materials.preload();
      const objLoader = new OBJLoader();
      objLoader.setMaterials(materials);
      const obj = await new Promise((resolve, reject) => {
        objLoader.load(modelUrl, resolve, undefined, reject);
      });
      // traverse to compute normals if missing
      obj.traverse((c) => {
        if (c.isMesh && c.geometry && !c.geometry.attributes.normal && typeof c.geometry.computeVertexNormals === 'function') {
          c.geometry.computeVertexNormals();
        }
      });
      loadedModels.push(obj);
      return obj;
    } catch (err) {
      console.info('MTL load failed or not present, falling back to plain OBJ. tried=', basePathAbs + mtlFilename);
    }

    // fallback to plain OBJ
    const objLoader = new OBJLoader();
    const obj = await new Promise((resolve, reject) => {
      objLoader.load(modelUrl, resolve, undefined, reject);
    });
    applyDefaultMaterial(obj);
    loadedModels.push(obj);
    return obj;
  } catch (e) {
    console.warn('model load failed:', baseName, e);
    return null;
  }
}

function loadPCBModel(family) {
  const baseName = modelNameForFamily(family);
  if (!modelCache.has(baseName)) {
    const pending = loadModelFile(baseName).then((obj) => {
      // A missing variant model must not leave a card blank: retry with the
      // default board instead.
      if (!obj && baseName !== DEFAULT_MODEL) return loadPCBModel('bmi088');
      return obj;
    });
    modelCache.set(baseName, pending);
  }
  return modelCache.get(baseName);
}

function applyDefaultMaterial(obj) {
  const palette = readVizPalette();
  obj.traverse((child) => {
    if (child.isMesh) {
      const hasMaterial = child.material && !(Array.isArray(child.material) && child.material.length === 0);
      if (!hasMaterial) {
        child.material = new THREE.MeshStandardMaterial({ color: palette.model.clone(), metalness: 0.3, roughness: 0.4 });
        tagVizMaterial(child.material, VIZ_ROLE_MODEL);
      } else {
        // Materials synthesised by OBJLoader get the theme's model colour.
        tagVizMaterial(child.material, VIZ_ROLE_MODEL);
        const materials = Array.isArray(child.material) ? child.material : [child.material];
        materials.forEach((mat) => {
          if (mat && mat.color) mat.color.copy(palette.model);
        });
      }
      if (child.geometry && !child.geometry.attributes.normal && typeof child.geometry.computeVertexNormals === 'function') {
        child.geometry.computeVertexNormals();
      }
    }
  });
}

function layoutGrid(forceRebuild = false) {
  const grid = document.getElementById('grid');
  if (!grid) return;
  const count = getConnections().length;
  if (count === 0) {
    grid.innerHTML = `
      <div class="empty-state">
        <div class="empty-state-icon" aria-hidden="true">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="4" width="18" height="12" rx="2"/><path d="M8 20h8M12 16v4"/><path d="M7 10h4M7 13h7"/></svg>
        </div>
        <h3>还没有连接设备</h3>
        <p>扫描局域网内的 WiFi 设备，或用串口连接单台设备。</p>
        <div class="empty-state-actions">
          <button type="button" class="btn btn-outline" data-empty-action="btn-scan-ips">扫描 IP</button>
          <button type="button" class="btn btn-primary" data-empty-action="btn-scan-serial">扫描串口</button>
        </div>
      </div>
    `;
    grid.querySelectorAll('[data-empty-action]').forEach((el) => el.addEventListener('click', () => document.getElementById(el.dataset.emptyAction)?.click()));
    rendererMap.clear();
    return;
  }
  const rows = Math.ceil(Math.sqrt(count));
  const cols = Math.ceil(count / rows);
  grid.style.gridTemplateColumns = `repeat(${cols}, 1fr)`;
  grid.style.gridTemplateRows = `repeat(${rows}, 1fr)`;
  if (forceRebuild) {
    grid.innerHTML = '';
    rendererMap.clear();
    for (let i = 0; i < count; i++) {
      const conn = getConnections()[i];
      const card = document.createElement('div'); card.className = 'card'; card.style.background = 'var(--bg-card)'; card.style.borderRadius = '8px'; card.style.padding = '8px'; card.style.boxShadow = 'var(--shadow-sm)'; card.style.height = '100%';
      const title = document.createElement('div'); title.textContent = conn ? conn.ip : ('设备 ' + (i + 1)); title.style.fontWeight = '700'; 
      if (conn && isIPv4Address(conn.ip)) {
        title.style.cursor = 'pointer';
        title.style.color = 'var(--primary)';
        title.addEventListener('click', (e) => {
          const url = `http://${conn.ip}`;
          e.preventDefault();
          electronAPI.openUrl(url);
        });
      } else {
        title.style.color = 'var(--text-primary)';
      }
      card.appendChild(title);
      const threeDiv = document.createElement('div'); threeDiv.style.flex = '1'; threeDiv.style.minHeight = '0'; card.appendChild(threeDiv);
      grid.appendChild(card);
      const entry = createAttitudeRenderer(threeDiv, conn);
      if (conn) {
        rendererMap.set(conn.ip, entry);
      } else {
        rendererMap.set('placeholder_' + i, entry);
      }
    }
  } else {
    getConnections().forEach((conn, i) => {
      const key = conn ? conn.ip : 'placeholder_' + i;
      const entry = rendererMap.get(key);
      if (entry && entry.model) {
        updateModelFromConn(entry.model, conn);
      }
    });
  }
}
function updateModelFromConn(model, conn) {
  if (conn && conn.lastMsg && conn.lastMsg.quat) {
    try {
      let q = conn.lastMsg.quat[0];           // 设置为第一个传感器的数据
      if (Array.isArray(q) && Array.isArray(q[0])) q = q[0];
      const w = q[0], x = q[1], y = q[2], z = q[3];
      const threeQ = new THREE.Quaternion(-y, x, z, w);
      if (model.quaternion && typeof model.quaternion.copy === 'function') 
        model.quaternion.copy(threeQ);
      else 
        model.quaternion = threeQ;
    } catch (e) { console.error('updateModelFromConn quat error', e);}
  }
}

// create per-card three.js renderer, load model if any
function createAttitudeRenderer(container, conn) {
  const W = container.clientWidth || 320, H = container.clientHeight || 200;
  const palette = readVizPalette();
  if (!THREE || !THREE.WebGLRenderer) {
    container.innerHTML = '<div style="padding:12px;color:var(--text-secondary)">three.js 未加载，显示占位信息<br/>' + (conn ? JSON.stringify(conn.lastMsg || {}) : '无数据') + '</div>';
    return;
  }
  if (!conn) {
    container.innerHTML = '<div style="height:100%;display:flex;align-items:center;justify-content:center;color:var(--text-secondary);background:var(--bg-card);border-radius:8px">暂无设备</div>';
    return { renderer: null, scene: null, camera: null, model: null, controls: null };
  }

  subscribeToThemeChanges();

  const scene = new THREE.Scene();
  scene.background = palette.background.clone();
  const camera = new THREE.PerspectiveCamera(45, W / H, 0.1, 100);
  camera.position.set(0, -1.5, 1);

  const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
  renderer.setSize(W, H,false);
  renderer.domElement.style.display = 'block';
  renderer.domElement.style.width = '100%';
  renderer.domElement.style.height = '100%';
  container.innerHTML = '';
  container.appendChild(renderer.domElement);

  

  const controls = new OrbitControls(camera, renderer.domElement);
  controls.enableDamping = true;
  controls.dampingFactor = 0.07;
  controls.enablePan = false;
  // const grid = THREE.GridHelper ? new THREE.GridHelper(2, 8) : new THREE.Object3D(); scene.add(grid);
  const axes = THREE.AxesHelper ? new THREE.AxesHelper(1.2) : new THREE.Object3D(); scene.add(axes);
  // AxesHelper ships fixed red/green/blue vertex colours; replace them with the
  // themed axis stroke so the helper stays readable on both backgrounds.
  if (axes.material) {
    const previousMaterial = axes.material;
    axes.material = createLineMaterial(palette.axis);
    if (previousMaterial && typeof previousMaterial.dispose === 'function') previousMaterial.dispose();
  }

  let model = null;

  // add simple lighting so standard materials are visible
  let ambientLight = null;
  let directionalLight = null;
  try {
    ambientLight = new THREE.AmbientLight(palette.ambient, palette.ambientIntensity);
    ambientLight.name = '__ambient_light';
    scene.add(ambientLight);
    directionalLight = new THREE.DirectionalLight(palette.ambient, palette.directionalIntensity);
    directionalLight.position.set(5, 10, 7.5);
    directionalLight.name = '__dir_light';
    scene.add(directionalLight);
  } catch (e) { /* ignore */ }

  const view = {
    renderer,
    scene,
    camera,
    model: null,
    controls,
    axes,
    ambientLight,
    directionalLight,
    disposed: false,
  };

  // create a safe material factory (fallback to Basic if Standard not available)
  function createSafeMaterial(opts) {
    const options = Object.assign({}, opts);
    if (!options.color) options.color = readVizPalette().modelAccent.clone();
    let material = null;
    try {
      if (THREE && typeof THREE.MeshStandardMaterial === 'function') material = new THREE.MeshStandardMaterial(options);
    } catch (e) { /* ignore */ }
    if (!material && THREE && typeof THREE.MeshBasicMaterial === 'function') material = new THREE.MeshBasicMaterial(options);
    if (!material) material = { color: options.color };
    return tagVizMaterial(material, VIZ_ROLE_ACCENT);
  }

  // Mount a board model for the given firmware family. Called once when the
  // card is created and again whenever the device reveals a different family.
  async function applyModelToView(family) {
    const targetFamily = family || 'bmi088';
    const loaded = await loadPCBModel(targetFamily);
    if (view.disposed) return;
    if (!loaded) {
      // fallback box if load failed or no loader available
      if (view.model && view.model.parent) view.model.parent.remove(view.model);
      const geom = THREE.BoxGeometry ? new THREE.BoxGeometry(0.8, 0.02, 0.8) : new THREE.BufferGeometry();
      model = new THREE.Mesh(geom, createSafeMaterial());
      scene.add(model);
      view.model = model;
      view.family = targetFamily;
      applyVizPaletteToView(view, readVizPalette());
      return;
    }

    // clone the object/group so each card has its own transform
    let inst;
    try {
      inst = loaded.clone(true);
    } catch (e) {
      // some loader returns Mesh directly
      inst = loaded;
    }

    // auto-scale to fit view: compute bounding box and scale to target ~1 unit
    try {
      const box = new THREE.Box3().setFromObject(inst);
      const size = new THREE.Vector3(); box.getSize(size);
      const maxDim = Math.max(size.x, size.y, size.z);
      if (maxDim > 0) {
        const s = 1.0 / maxDim;
        if (inst.scale && typeof inst.scale.set === 'function') inst.scale.set(s, s, s);
        else { inst.scale = inst.scale || {}; inst.scale.x = inst.scale.y = inst.scale.z = s; }
      }
      if (inst.position && typeof inst.position.set === 'function') {
        inst.position.set(0, 0, 0);
      }
    } catch (e) { /* ignore bounding box errors */ }

    // Swap in the new board; the previous instance shares cached geometry, so
    // it is detached rather than disposed.
    if (view.model && view.model.parent) view.model.parent.remove(view.model);
    scene.add(inst);
    model = inst;
    view.model = model;
    view.family = targetFamily;
    applyVizPaletteToView(view, readVizPalette());
  }
  view.applyModelToView = applyModelToView;

  // The family is discovered from the first decoded frame of this device.
  applyModelToView((conn && conn.lastMsg && conn.lastMsg.protocolFamily) || 'bmi088');

  function animate() {
    requestAnimationFrame(animate);
    controls.update();
    renderer.render(scene, camera);
  }
  animate();

  new ResizeObserver(() => {
    const w = container.clientWidth || 320;
    const h = container.clientHeight-20 || 500;
    renderer.setSize(w, h,false); 
    camera.aspect = w / h; if (typeof camera.updateProjectionMatrix === 'function') camera.updateProjectionMatrix();
  }).observe(container);

  return view;
}

// Registered once per createAttitudeView() instance; repeated theme events reuse
// this single subscription, and every card is repainted from one palette read.
function subscribeToThemeChanges() {
  if (themeSubscription) return;
  themeSubscription = onThemeChange(() => {
    const palette = readVizPalette();
    rendererMap.forEach((view) => applyVizPaletteToView(view, palette));
  });
}

function disposeDeviceRenderer(ip) {
    const rendererEntry = rendererMap.get(ip);
    if (rendererEntry) {
      rendererEntry.disposed = true;
      // Dispose of Three.js resources
      if (rendererEntry.renderer) {
        rendererEntry.renderer.dispose();
      }
      if (rendererEntry.scene) {
        rendererEntry.scene.traverse((obj) => {
          if (obj.geometry) obj.geometry.dispose();
          if (obj.material) {
            if (Array.isArray(obj.material)) {
              obj.material.forEach(mat => mat.dispose());
            } else {
              obj.material.dispose();
            }
          }
        });
      }
      rendererMap.delete(ip);
    }
}

function setDeviceFamily(ip, family) {
  const view = rendererMap.get(ip);
  if (!view || view.disposed || typeof view.applyModelToView !== 'function') return false;
  if (view.family === family) return false;
  view.applyModelToView(family);
  return true;
}

return { layoutGrid, disposeDeviceRenderer, setDeviceFamily, getModelCache: () => loadedModels };
}
