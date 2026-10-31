// Relative URLs remain resolvable when the renderer is loaded via file:// in
// the packaged Electron application.
import * as THREE from '../node_modules/three/build/three.module.js';
import { OrbitControls } from '../node_modules/three/examples/jsm/controls/OrbitControls.js';
import { OBJLoader } from '../node_modules/three/examples/jsm/loaders/OBJLoader.js';
import { MTLLoader } from '../node_modules/three/examples/jsm/loaders/MTLLoader.js';
import { isIPv4Address } from './utils.js';

export function createAttitudeView({ electronAPI, getConnections }) {
let PCBModelGlobal = null; // cached loaded model/group

let rendererMap = new Map();

async function loadPCBModelOnce() {
  if (PCBModelGlobal) return PCBModelGlobal;
  try {
    console.log('Loading PCB model...');
    // compute a URL relative to the current index.html
    const modelUrl = new URL('../assets/models/PCBmodel.obj', window.location.href).href;
    const objAbsUrl = modelUrl;
    const basePathAbs = objAbsUrl.substring(0, objAbsUrl.lastIndexOf('/') + 1);
    const mtlFilename = modelUrl.substring(modelUrl.lastIndexOf('/') + 1).replace(/\.obj$/i, '.mtl');

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
      PCBModelGlobal = obj;
      return PCBModelGlobal;
    } catch (err) {
      console.info('MTL load failed or not present, falling back to plain OBJ. tried=', basePathAbs + mtlFilename);
    }

    // fallback to plain OBJ
    const objLoader = new OBJLoader();
    const obj = await new Promise((resolve, reject) => {
      objLoader.load(modelUrl, resolve, undefined, reject);
    });
    applyDefaultMaterial(obj);
    PCBModelGlobal = obj;
    return PCBModelGlobal;
  } catch (e) {
    console.warn('loadPCBModelOnce error:', e);
    return null;
  }
}

function applyDefaultMaterial(obj) {
  obj.traverse((child) => {
    if (child.isMesh) {
      if (!child.material || (Array.isArray(child.material) && child.material.length === 0)) {
        child.material = new THREE.MeshStandardMaterial({ color: 0x8fbcd4, metalness: 0.3, roughness: 0.4 });
      } else {
        // ensure material has color if applicable
        if (child.material && child.material.color) child.material.color.set(0x8fbcd4);
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
      <div class="card" style="grid-column:1 / -1;display:flex;align-items:center;justify-content:center;min-height:220px;color:#667085;background:#fff;border-radius:8px;box-shadow:0 2px 6px rgba(0,0,0,0.06)">
        当前没有已连接设备
      </div>
    `;
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
      const card = document.createElement('div'); card.className = 'card'; card.style.background = '#fff'; card.style.borderRadius = '8px'; card.style.padding = '8px'; card.style.boxShadow = '0 2px 6px rgba(0,0,0,0.06)'; card.style.height = '100%';
      const title = document.createElement('div'); title.textContent = conn ? conn.ip : ('设备 ' + (i + 1)); title.style.fontWeight = '700'; 
      if (conn && isIPv4Address(conn.ip)) {
        title.style.cursor = 'pointer';
        title.style.color = '#2b6ef6';
        title.addEventListener('click', (e) => {
          const url = `http://${conn.ip}`;
          e.preventDefault();
          electronAPI.openUrl(url);
        });
      } else {
        title.style.color = '#334155';
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
  if (!THREE || !THREE.WebGLRenderer) {
    container.innerHTML = '<div style="padding:12px;color:#444">three.js 未加载，显示占位信息<br/>' + (conn ? JSON.stringify(conn.lastMsg || {}) : '无数据') + '</div>';
    return;
  }
  if (!conn) {
    container.innerHTML = '<div style="height:100%;display:flex;align-items:center;justify-content:center;color:#667085;background:rgba(255,255,255,0.6);border-radius:8px">暂无设备</div>';
    return { renderer: null, scene: null, camera: null, model: null, controls: null };
  }
  const scene = new THREE.Scene();
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

  let model = null;

  // add simple lighting so standard materials are visible
  try {
    if (!scene.getObjectByName('__ambient_light')) {
      const amb = new THREE.AmbientLight(0xffffff, 0.6);
      amb.name = '__ambient_light';
      scene.add(amb);
    }
    if (!scene.getObjectByName('__dir_light')) {
      const dir = new THREE.DirectionalLight(0xffffff, 0.6);
      dir.position.set(5, 10, 7.5);
      dir.name = '__dir_light';
      scene.add(dir);
    }
  } catch (e) { /* ignore */ }

  // create a safe material factory (fallback to Basic if Standard not available)
  function createSafeMaterial(opts) {
    opts = opts || {};
    try {
      if (THREE && typeof THREE.MeshStandardMaterial === 'function') return new THREE.MeshStandardMaterial(opts);
    } catch (e) { /* ignore */ }
    if (THREE && typeof THREE.MeshBasicMaterial === 'function') return new THREE.MeshBasicMaterial(opts);
    return { color: opts.color || 0x8fb3ff };
  }

  // try to use cached loaded PCB model; if present, clone & add; otherwise fallback to a box
  (async () => {
    const loaded = await loadPCBModelOnce();
    if (loaded) {
      // clone the object/group so each card has its own transform
      let inst;
      try {
        inst = loaded.clone(true);
      } catch (e) {
        // some loader returns Mesh directly
        inst = loaded;
      }

      // auto-scale & center to fit view: compute bounding box and scale to target ~1 unit
      try {
        const box = new THREE.Box3().setFromObject(inst);
        const size = new THREE.Vector3(); box.getSize(size);
        const maxDim = Math.max(size.x, size.y, size.z);
        if (maxDim > 0) {
          const target = 1.0;
          const s = target / maxDim;
          if (inst.scale && typeof inst.scale.set === 'function') inst.scale.set(s, s, s);
          else { inst.scale = inst.scale || {}; inst.scale.x = inst.scale.y = inst.scale.z = s; }
        }
        const center = new THREE.Vector3(); box.getCenter(center);
        if (inst.position && typeof inst.position.set === 'function') {
          inst.position.set(0,0,0);
          // inst.position.set(-center.x, -center.y, -center.z);
        } else {
          inst.position = { x: -center.x, y: -center.y, z: -center.z };
        }
      } catch (e) { /* ignore bounding box errors */ }

      scene.add(inst);
      model = inst;

      const key = conn ? conn.ip : 'placeholder_' + i;
      const entry = rendererMap.get(key);
      entry.model = model;
    } else {
      // fallback box if load failed or no loader available
      const geom = THREE.BoxGeometry ? new THREE.BoxGeometry(0.8, 0.02, 0.8) : new THREE.BufferGeometry();
      const mat = createSafeMaterial({ color: 0x8fb3ff });
      model = new THREE.Mesh(geom, mat);
      scene.add(model);
    }
  })();

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

  return { renderer, scene, camera, model, controls };
}

function disposeDeviceRenderer(ip) {
    const rendererEntry = rendererMap.get(ip);
    if (rendererEntry) {
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

return { layoutGrid, disposeDeviceRenderer, getModelCache: () => PCBModelGlobal };
}
