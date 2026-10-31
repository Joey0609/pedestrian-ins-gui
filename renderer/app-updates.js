import { escapeHtml } from './utils.js';
import { modalCloseButton } from './dialogs.js';

export function createAppUpdates({ electronAPI, dialogs, showNotification }) {
const appUpdateUi = { open: false, version: '', currentVersion: '', notes: '', stage: 'idle', percent: 0, error: '' };

function updateNotesText(notes) {
  if (Array.isArray(notes)) return notes.map((item) => item && (item.note || item)).join('\n');
  return typeof notes === 'string' ? notes : '';
}

function renderAppUpdateModal() {
  const isDownloading = appUpdateUi.stage === 'downloading';
  const isDownloaded = appUpdateUi.stage === 'downloaded';
  const notes = escapeHtml(appUpdateUi.notes || '本次版本包含功能优化与问题修复。').replace(/\n/g, '<br>');
  const body = isDownloading
    ? `<div style="margin:18px 0 8px;color:#4b5563">正在下载 v${escapeHtml(appUpdateUi.version)}，请勿关闭程序。</div>
       <div style="height:10px;background:#e5e7eb;border-radius:999px;overflow:hidden"><div style="height:100%;width:${Math.max(0, Math.min(100, appUpdateUi.percent))}%;background:linear-gradient(90deg,#2563eb,#06b6d4);transition:width .25s ease"></div></div>
       <div style="margin-top:8px;text-align:right;font-variant-numeric:tabular-nums;color:#2563eb;font-weight:600">${appUpdateUi.percent}%</div>
       ${appUpdateUi.error ? `<div style="margin-top:10px;color:#dc2626">下载失败：${escapeHtml(appUpdateUi.error)}</div>` : ''}`
    : isDownloaded
      ? `<div style="margin:18px 0;color:#166534;line-height:1.7">v${escapeHtml(appUpdateUi.version)} 已下载完成。重启程序后将自动完成安装。</div>`
      : `<div style="margin:12px 0;color:#4b5563">当前版本：<strong>v${escapeHtml(appUpdateUi.currentVersion)}</strong><br>最新版本：<strong style="color:#2563eb">v${escapeHtml(appUpdateUi.version)}</strong></div>
         <div style="margin-top:12px;padding:12px;background:#f5f7fb;border-radius:8px;line-height:1.65;max-height:190px;overflow-y:auto"><div style="font-weight:600;margin-bottom:6px">更新内容</div>${notes}</div>`;
  const actions = isDownloading
    ? ''
    : isDownloaded
      ? `<button id="update-later" class="secondary" style="flex:1">稍后重启</button><button id="update-install" class="primary" style="flex:1">立即重启安装</button>`
      : `<button id="update-later" class="secondary" style="flex:1">暂不更新</button><button id="update-download" class="primary" style="flex:1">下载更新</button>`;
  const close = () => {
    if (appUpdateUi.stage === 'downloading' && !appUpdateUi.error) return;
    appUpdateUi.open = false;
    dialogs.hide();
  };
  dialogs.show(`<div style="width:min(500px,88vw)"><div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:8px"><h3 style="margin:0">发现新版本</h3>${isDownloading ? '' : modalCloseButton('update-close')}</div>${body}<div style="display:flex;gap:8px;margin-top:18px">${actions}</div></div>`, { key: 'app-update', onRequestClose: close });
  dialogs.content.querySelector('#update-close')?.addEventListener('click', close);
  dialogs.content.querySelector('#update-later')?.addEventListener('click', close);
  dialogs.content.querySelector('#update-download')?.addEventListener('click', async () => {
    appUpdateUi.stage = 'downloading'; appUpdateUi.percent = 0; appUpdateUi.error = ''; renderAppUpdateModal();
    const result = await electronAPI.downloadAppUpdate();
    if (!result || !result.ok) { appUpdateUi.error = (result && result.error) || '未知错误'; renderAppUpdateModal(); }
  });
  dialogs.content.querySelector('#update-install')?.addEventListener('click', () => electronAPI.installAppUpdate());
}

function start() {
document.getElementById('btn-check-update').addEventListener('click', async () => {
  showNotification('正在检查更新…', 'info');
  await electronAPI.checkAppUpdate();
});

electronAPI.onAppUpdateStatus((status) => {
  if (!status) return;
  if (status.state === 'available') {
    Object.assign(appUpdateUi, { open: true, version: status.version || '', currentVersion: status.currentVersion || '', notes: updateNotesText(status.releaseNotes), stage: 'available', percent: 0, error: '' });
    renderAppUpdateModal();
  } else if (status.state === 'latest' && status.manual) {
    showNotification('当前已是最新版本', 'success');
  } else if (status.state === 'downloading' && appUpdateUi.open) {
    appUpdateUi.stage = 'downloading'; appUpdateUi.percent = status.percent || 0; renderAppUpdateModal();
  } else if (status.state === 'downloaded' && appUpdateUi.open) {
    appUpdateUi.stage = 'downloaded'; appUpdateUi.percent = 100; renderAppUpdateModal();
  } else if (status.state === 'error' && appUpdateUi.open && appUpdateUi.stage === 'downloading') {
    appUpdateUi.error = status.message || '未知错误'; renderAppUpdateModal();
  } else if (status.state === 'error' && status.manual) {
    showNotification(`检查更新失败：${status.message || '未知错误'}`, 'warning');
  }
});
}

return { start };
}
