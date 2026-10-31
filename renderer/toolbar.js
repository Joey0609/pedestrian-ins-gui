export function bindToolbar({ electronAPI, devices, recording, ota, dialogs, showNotification }) {
document.getElementById('btn-ota').addEventListener('click', async () => {
  ota.show();
});

// other topbar buttons (unchanged behaviour)
document.getElementById('btn-disconnect').addEventListener('click', async () => {
  // Show disconnect modal with device list
  if (devices.getConnections().length === 0) {
    showNotification('没有已连接的设备', 'warning');
    return;
  }
  devices.showDisconnectModal();
});

document.getElementById('btn-record').addEventListener('click', () => {
  if (!recording.isRecording()) {
    // Start recording
    recording.startRecording();
  } else {
    // Stop recording and save
    recording.stopRecording();
  }
});

document.getElementById('btn-zero').addEventListener('click', () => {
  electronAPI.broadcastCmd({ cmd: 'setZero' });
  showNotification('Send Zero Heading to All', 'success');
});
document.getElementById('btn-inertial').addEventListener('click', () => {
  const btn = document.getElementById('btn-inertial');
  electronAPI.broadcastCmd({ cmd: 'insZero' });
  showNotification('Send Inertial Reset to All', 'success');
});
document.getElementById('btn-shutdown').addEventListener('click', () => {
  dialogs.showConfirmation('设备关机', '确定要关闭所有设备吗？', '关机', (confirmed) => {
    if (!confirmed) return;
    electronAPI.broadcastCmd({ cmd: 'shutdown' });
    showNotification('已发送关机指令', 'success');
  });
});

}
