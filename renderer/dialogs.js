import { createModalController } from './ui-controls.js';
import { escapeHtml } from './utils.js';

export function modalCloseButton(id, label = '关闭') {
  return `<button type="button" id="${escapeHtml(id)}" class="modal-close" aria-label="${escapeHtml(label)}" title="${escapeHtml(label)}">×</button>`;
}

export function createDialogs({ onHide = () => {} } = {}) {
let modalContent = null;
const modalController = createModalController(document.getElementById('modal'));
let modalSelect = null;
let scanTooltip = null;
function showModal(contentHtml, options = {}) {
  scanTooltip?.destroy();
  scanTooltip = null;
  modalSelect?.destroy();
  modalSelect = null;
  modalContent = modalController.show(contentHtml, { onRequestClose: hideModal, ...options });
}

function hideModal() {
  scanTooltip?.destroy();
  scanTooltip = null;
  modalSelect?.destroy();
  modalSelect = null;
  modalController.hide();
  modalContent = null;
  onHide();
}

function showConfirmation(title, message, action, onResult) {
  let settled = false;
  const finish = (confirmed) => {
    if (settled) return;
    settled = true;
    hideModal();
    onResult(confirmed);
  };
  showModal(`<div class="confirmation-dialog"><div class="modal-heading"><h3>${escapeHtml(title)}</h3>${modalCloseButton('confirmation-close')}</div><p>${escapeHtml(message)}</p><div class="confirmation-actions"><button id="confirmation-cancel" class="secondary">取消</button><button id="confirmation-accept" class="danger">${escapeHtml(action)}</button></div></div>`, { onRequestClose: () => finish(false) });
  modalContent.querySelector('#confirmation-close').addEventListener('click', () => finish(false));
  modalContent.querySelector('#confirmation-cancel').addEventListener('click', () => finish(false));
  modalContent.querySelector('#confirmation-accept').addEventListener('click', () => finish(true));
}

return { show: showModal, hide: hideModal, showConfirmation, get content() { return modalContent; }, get select() { return modalSelect; }, set select(value) { modalSelect = value; }, get scanTooltip() { return scanTooltip; }, set scanTooltip(value) { scanTooltip = value; } };
}
