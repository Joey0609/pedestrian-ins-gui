import { modalCloseButton } from './dialogs.js';

export function createRecording({ electronAPI, dialogs, showNotification }) {
let recording = false;
// Recording data storage
let recordingData = {}; // { ip: { sensorIndex: [rows...] } }
let recordingCount = 0;
let recordingStartTime = null;

// IMU sensor configuration
const BMI088_NUM = 4; // 0..3 actual sensors, 4 is combined/average

function startRecording() {
  recording = true;
  recordingData = {};
  recordingCount = 0;
  recordingStartTime = new Date();
  
  const btn = document.getElementById('btn-record');
  btn.classList.add('recording');
  btn.innerHTML = `<span class="record-dot"></span><span class="record-text">0 条</span>`;
  
  showNotification('开始录制数据', 'success');
}

function updateRecordingCount() {
  if (!recording) return;
  const btn = document.getElementById('btn-record');
  const textEl = btn.querySelector('.record-text');
  if (textEl) {
    textEl.textContent = `${recordingCount} 条`;
  }
}

function recordIMUData(ip, data) {
  if (!recording || !data) return;
  
  // Initialize storage for this IP if not exists
  if (!recordingData[ip]) {
    recordingData[ip] = {};
    for (let s = 0; s < BMI088_NUM + 1; s++) {
      recordingData[ip][s] = [];
    }
  }
  
  // For each sensor, create a row
  for (let s = 0; s < BMI088_NUM + 1; s++) {
    const row = {
      timestamp: data.timestamp,
      // raw_accel (3)
      raw_accel_x: data.raw_accel?.[s]?.[0] ?? '',
      raw_accel_y: data.raw_accel?.[s]?.[1] ?? '',
      raw_accel_z: data.raw_accel?.[s]?.[2] ?? '',
      // raw_gyro (3)
      raw_gyro_x: data.raw_gyro?.[s]?.[0] ?? '',
      raw_gyro_y: data.raw_gyro?.[s]?.[1] ?? '',
      raw_gyro_z: data.raw_gyro?.[s]?.[2] ?? '',
      // quat (4)
      quat_w: data.quat?.[s]?.[0] ?? '',
      quat_x: data.quat?.[s]?.[1] ?? '',
      quat_y: data.quat?.[s]?.[2] ?? '',
      quat_z: data.quat?.[s]?.[3] ?? '',
      // rotation_matrix (9)
      rotation_matrix_0: data.rotation_matrix?.[s]?.[0] ?? '',
      rotation_matrix_1: data.rotation_matrix?.[s]?.[1] ?? '',
      rotation_matrix_2: data.rotation_matrix?.[s]?.[2] ?? '',
      rotation_matrix_3: data.rotation_matrix?.[s]?.[3] ?? '',
      rotation_matrix_4: data.rotation_matrix?.[s]?.[4] ?? '',
      rotation_matrix_5: data.rotation_matrix?.[s]?.[5] ?? '',
      rotation_matrix_6: data.rotation_matrix?.[s]?.[6] ?? '',
      rotation_matrix_7: data.rotation_matrix?.[s]?.[7] ?? '',
      rotation_matrix_8: data.rotation_matrix?.[s]?.[8] ?? '',
      // eular (3)
      roll: data.eular?.[s]?.[0] ?? '',
      pitch: data.eular?.[s]?.[1] ?? '',
      yaw: data.eular?.[s]?.[2] ?? '',
      // linear_accel (3)
      linear_accel_x: data.linear_accel?.[s]?.[0] ?? '',
      linear_accel_y: data.linear_accel?.[s]?.[1] ?? '',
      linear_accel_z: data.linear_accel?.[s]?.[2] ?? '',
      // earth_accel (3)
      earth_accel_x: data.earth_accel?.[s]?.[0] ?? '',
      earth_accel_y: data.earth_accel?.[s]?.[1] ?? '',
      earth_accel_z: data.earth_accel?.[s]?.[2] ?? '',
      // kf_accel (3)
      kf_accel_x: data.kf_accel?.[s]?.[0] ?? '',
      kf_accel_y: data.kf_accel?.[s]?.[1] ?? '',
      kf_accel_z: data.kf_accel?.[s]?.[2] ?? '',
      // kf_velocity (3)
      kf_velocity_x: data.kf_velocity?.[s]?.[0] ?? '',
      kf_velocity_y: data.kf_velocity?.[s]?.[1] ?? '',
      kf_velocity_z: data.kf_velocity?.[s]?.[2] ?? '',
      // displacement (3)
      displacement_x: data.displacement?.[s]?.[0] ?? '',
      displacement_y: data.displacement?.[s]?.[1] ?? '',
      displacement_z: data.displacement?.[s]?.[2] ?? '',
      // stationary (1)
      stationary: data.stationary?.[s] ? 1 : 0
    };
    recordingData[ip][s].push(row);
  }
  
  recordingCount++;
  // Throttle UI update
  if (recordingCount % 10 === 0) {
    updateRecordingCount();
  }
}

function generateCSVContent(rows) {
  if (!rows || rows.length === 0) return '';
  
  // Header
  const headers = Object.keys(rows[0]);
  let csv = headers.join(',') + '\n';
  
  // Data rows
  for (const row of rows) {
    const values = headers.map(h => row[h]);
    csv += values.join(',') + '\n';
  }
  
  return csv;
}

function formatTimeForFilename(date) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  const h = String(date.getHours()).padStart(2, '0');
  const min = String(date.getMinutes()).padStart(2, '0');
  return `${y}${m}${d}${h}${min}`;
}

async function stopRecording() {
  recording = false;
  
  const btn = document.getElementById('btn-record');
  btn.classList.remove('recording');
  btn.innerHTML = '录制';
  
  // Prepare files
  const files = [];
  const timeStr = formatTimeForFilename(recordingStartTime);
  
  for (const ip of Object.keys(recordingData)) {
    const ipForFilename = ip.replace(/\./g, '');
    
    for (let s = 0; s < BMI088_NUM + 1; s++) {
      const rows = recordingData[ip][s];
      if (rows && rows.length > 0) {
        const filename = `imudata_${timeStr}_${ipForFilename}_sensor${s}.csv`;
        const content = generateCSVContent(rows);
        files.push({ name: filename, content });
      }
    }
  }
  
  if (files.length === 0) {
    showNotification('没有录制到数据', 'warning');
    return;
  }
  
  // Save files
  try {
    const result = await electronAPI.saveRecordingFiles({ files });
    
    if (result.success) {
      showRecordingSavedModal(result.files);
    } else {
      showNotification('保存失败: ' + result.error, 'error');
    }
  } catch (e) {
    console.error('Save recording error:', e);
    showNotification('保存失败', 'error');
  }
  
  // Reset
  recordingData = {};
  recordingCount = 0;
}

function showRecordingSavedModal(savedFiles) {
  const fileListHtml = savedFiles.map(f => `
    <div class="saved-file-item">
      <div class="saved-file-name" title="${f.path}">${f.name}</div>
      <div class="saved-file-actions">
        <button class="btn-open-file" data-path="${f.path}" title="打开文件">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/>
            <polyline points="14 2 14 8 20 8"/>
            <line x1="16" y1="13" x2="8" y2="13"/>
            <line x1="16" y1="17" x2="8" y2="17"/>
          </svg>
        </button>
        <button class="btn-open-folder" data-folder="${f.path}" title="打开文件夹">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/>
          </svg>
        </button>
      </div>
    </div>
  `).join('');
  
  const html = `
    <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:16px">
      <h3 style="margin:0">录制完成</h3>
      ${modalCloseButton('closeRecordingModal')}
    </div>
    <div class="recording-stats" style="margin-bottom:16px;padding:12px;background:#f0f7ff;border-radius:8px">
      <div style="display:flex;gap:20px">
        <div><strong>录制条数：</strong>${recordingCount} 条</div>
        <div><strong>文件数量：</strong>${savedFiles.length} 个</div>
      </div>
    </div>
    <div class="saved-files-list" style="max-height:300px;overflow-y:auto">
      ${fileListHtml}
    </div>
    <div style="display:flex;gap:8px;margin-top:16px">
      <button id="openAllFolderBtn" class="primary" style="flex:1">打开文件夹</button>
      ${modalCloseButton('closeRecordingBtn')}
    </div>
  `;
  
  dialogs.show(html);
  
  // Event listeners
  dialogs.content.querySelector('#closeRecordingModal').addEventListener('click', dialogs.hide);
  dialogs.content.querySelector('#closeRecordingBtn').addEventListener('click', dialogs.hide);
  
  dialogs.content.querySelector('#openAllFolderBtn').addEventListener('click', () => {
    if (savedFiles.length > 0) {
      electronAPI.openFolder(savedFiles[0].path);
    }
  });
  
  dialogs.content.querySelectorAll('.btn-open-file').forEach(btn => {
    btn.addEventListener('click', () => {
      electronAPI.openFile(btn.dataset.path);
    });
  });
  
  dialogs.content.querySelectorAll('.btn-open-folder').forEach(btn => {
    btn.addEventListener('click', () => {
      electronAPI.openFolder(btn.dataset.folder);
    });
  });
}

return { startRecording, stopRecording, recordIMUData, isRecording: () => recording, getCacheData: () => ({ recordingData }) };
}
