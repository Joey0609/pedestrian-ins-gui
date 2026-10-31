// Shared UI lifecycle: keep closing content mounted until its transition finishes.
export function createModalController(root) {
  let revision = 0;
  let closeTimer;
  let requestClose;
  let returnFocus;
  let currentKey;
  let backdropPressed = false;
  const reducedMotion = () => window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  const focusable = () => [...root.querySelectorAll('button, [href], input, select, textarea, [tabindex]')]
    .filter(el => !el.disabled && el.tabIndex >= 0 && el.getClientRects().length);
  function show(html, options = {}) {
    const wasOpen = !root.classList.contains('hidden') && !root.classList.contains('is-closing');
    const refresh = wasOpen && options.key && options.key === currentKey;
    const focusedId = refresh && root.contains(document.activeElement) ? document.activeElement.id : '';
    const token = ++revision;
    clearTimeout(closeTimer);
    if (!wasOpen) returnFocus = document.activeElement;
    currentKey = options.key;
    requestClose = options.onRequestClose || hide;
    root.innerHTML = `<div class="modalCard" role="dialog" aria-modal="true" tabindex="-1">${html}</div>`;
    const card = root.firstElementChild;
    const title = card.querySelector('h3, strong');
    if (title) {
      title.id ||= 'active-modal-title';
      card.setAttribute('aria-labelledby', title.id);
    } else card.setAttribute('aria-label', '对话框');
    root.classList.remove('hidden', 'is-closing');
    root.setAttribute('aria-hidden', 'false');
    if (!refresh) root.classList.remove('is-open');
    requestAnimationFrame(() => requestAnimationFrame(() => {
      if (token !== revision) return;
      root.classList.add('is-open');
      const previous = focusedId && document.getElementById(focusedId);
      if (previous && root.contains(previous)) previous.focus({ preventScroll: true });
      else if (!refresh) card.focus({ preventScroll: true });
    }));
    return card;
  }
  function hide() {
    if (root.classList.contains('hidden') || root.classList.contains('is-closing')) return;
    const token = ++revision;
    requestClose = null;
    root.classList.remove('is-open');
    root.classList.add('is-closing');
    const card = root.firstElementChild;
    if (card) card.inert = true;
    const finish = () => {
      if (token !== revision) return;
      clearTimeout(closeTimer);
      root.classList.add('hidden');
      root.classList.remove('is-closing');
      root.setAttribute('aria-hidden', 'true');
      root.replaceChildren();
      if (returnFocus?.isConnected) returnFocus.focus({ preventScroll: true });
      returnFocus = null;
      currentKey = null;
    };
    closeTimer = setTimeout(finish, reducedMotion() ? 0 : 230);
  }
  root.addEventListener('pointerdown', event => { backdropPressed = event.target === root; });
  root.addEventListener('click', event => {
    if (event.target === root && backdropPressed) requestClose?.();
    backdropPressed = false;
  });
  document.addEventListener('keydown', event => {
    if (root.classList.contains('hidden') || event.defaultPrevented) return;
    if (event.key === 'Escape') {
      event.preventDefault();
      requestClose?.();
    } else if (event.key === 'Tab') {
      const items = focusable();
      if (!items.length) { event.preventDefault(); root.firstElementChild?.focus(); return; }
      const first = items[0], last = items[items.length - 1];
      if (event.shiftKey && (!root.contains(document.activeElement) || document.activeElement === first || document.activeElement === root.firstElementChild)) {
        event.preventDefault(); last.focus();
      } else if (!event.shiftKey && (!root.contains(document.activeElement) || document.activeElement === last)) {
        event.preventDefault(); first.focus();
      }
    }
  });
  return { show, hide };
}

// Preserve the native select's value/change API while rendering an animated listbox.
export function enhanceSelect(select, label) {
  const wrapper = document.createElement('div');
  wrapper.className = 'polished-select';
  select.before(wrapper);
  wrapper.append(select);
  select.classList.add('select-source');
  select.tabIndex = -1;
  select.setAttribute('aria-hidden', 'true');
  const trigger = document.createElement('button');
  trigger.type = 'button';
  trigger.className = 'polished-select-trigger';
  trigger.setAttribute('role', 'combobox');
  trigger.setAttribute('aria-label', label);
  trigger.setAttribute('aria-haspopup', 'listbox');
  trigger.setAttribute('aria-expanded', 'false');
  const value = document.createElement('span');
  value.className = 'polished-select-copy';
  trigger.append(value);
  wrapper.append(trigger);
  const panel = document.createElement('div');
  panel.className = 'polished-select-panel';
  panel.id = `${select.id}-listbox`;
  panel.setAttribute('role', 'listbox');
  panel.setAttribute('aria-label', label);
  trigger.setAttribute('aria-controls', panel.id);
  document.body.append(panel);
  let opened = false, active = -1, closeTimer;
  let search = '', searchAt = 0;
  const options = [...select.options];
  function renderLabel(container, option) {
    const title = document.createElement('span');
    title.className = 'polished-select-title';
    title.textContent = option?.dataset.primary || option?.textContent || '请选择';
    container.replaceChildren(title);
    if (option?.dataset.detail) {
      const detail = document.createElement('span');
      detail.className = 'polished-select-detail';
      detail.textContent = option.dataset.detail;
      container.append(detail);
    }
  }
  const enabledIndices = () => options.flatMap((option, index) => !option.disabled && !option.hidden ? [index] : []);
  const rows = options.map((option, index) => {
    const row = document.createElement('div');
    row.id = `${panel.id}-${index}`;
    row.className = 'polished-select-option';
    row.setAttribute('role', 'option');
    row.setAttribute('aria-disabled', String(option.disabled));
    row.hidden = option.hidden;
    const copy = document.createElement('span');
    copy.className = 'polished-select-copy';
    renderLabel(copy, option);
    row.append(copy);
    row.addEventListener('pointermove', () => setActive(index));
    row.addEventListener('mousedown', event => event.preventDefault());
    row.addEventListener('click', () => commit(index));
    panel.append(row);
    return row;
  });
  function sync() {
    renderLabel(value, options[select.selectedIndex]);
    trigger.title = options[select.selectedIndex]?.textContent || '';
    rows.forEach((row, index) => row.setAttribute('aria-selected', String(index === select.selectedIndex)));
    trigger.disabled = select.disabled || !enabledIndices().length;
  }
  function setActive(index) {
    if (!options[index] || options[index].disabled || options[index].hidden) return;
    active = index;
    rows.forEach((row, i) => row.classList.toggle('is-highlighted', i === index));
    if (rows[index]) {
      trigger.setAttribute('aria-activedescendant', rows[index].id);
      const top = rows[index].offsetTop;
      const bottom = top + rows[index].offsetHeight;
      if (top < panel.scrollTop) panel.scrollTop = top;
      else if (bottom > panel.scrollTop + panel.clientHeight) panel.scrollTop = bottom - panel.clientHeight;
    }
  }
  function position() {
    const rect = trigger.getBoundingClientRect();
    const below = Math.max(0, innerHeight - rect.bottom - 18);
    const above = Math.max(0, rect.top - 18);
    const upwards = below < Math.min(300, panel.scrollHeight) && above > below;
    panel.dataset.side = upwards ? 'above' : 'below';
    panel.style.width = `${Math.max(0, Math.min(rect.width, innerWidth - 24))}px`;
    panel.style.maxHeight = `${Math.max(0, Math.min(300, upwards ? above : below))}px`;
    panel.style.left = `${Math.max(12, Math.min(rect.left, innerWidth - panel.offsetWidth - 12))}px`;
    panel.style.top = upwards ? 'auto' : `${rect.bottom + 6}px`;
    panel.style.bottom = upwards ? `${innerHeight - rect.top + 6}px` : 'auto';
    panel.style.transformOrigin = upwards ? 'bottom center' : 'top center';
  }
  function close() {
    opened = false;
    trigger.setAttribute('aria-expanded', 'false');
    trigger.removeAttribute('aria-activedescendant');
    panel.classList.remove('is-open');
    panel.setAttribute('aria-hidden', 'true');
    clearTimeout(closeTimer);
    closeTimer = setTimeout(() => { if (!opened) panel.classList.remove('is-mounted'); }, 180);
  }
  function open() {
    sync();
    if (trigger.disabled || !trigger.isConnected || !trigger.getClientRects().length) return;
    clearTimeout(closeTimer);
    opened = true;
    panel.setAttribute('aria-hidden', 'false');
    panel.classList.add('is-mounted');
    position();
    panel.getBoundingClientRect(); // Establish the opening transition's starting frame.
    panel.classList.add('is-open');
    trigger.setAttribute('aria-expanded', 'true');
    setActive(enabledIndices().includes(select.selectedIndex) ? select.selectedIndex : enabledIndices()[0]);
  }
  function commit(index) {
    if (!options[index] || options[index].disabled || options[index].hidden) return;
    select.selectedIndex = index;
    sync();
    close();
    select.dispatchEvent(new Event('change', { bubbles: true }));
    trigger.focus({ preventScroll: true });
  }
  trigger.addEventListener('click', () => opened ? close() : open());
  trigger.addEventListener('keydown', event => {
    if (['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) {
      event.preventDefault();
      if (!opened) { open(); if (event.key.startsWith('Arrow')) return; }
      const enabled = enabledIndices();
      const direction = event.key === 'ArrowUp' ? -1 : 1;
      const next = event.key === 'Home' ? 0 : event.key === 'End' ? enabled.length - 1 : Math.max(0, Math.min(enabled.length - 1, enabled.indexOf(active) + direction));
      if (enabled.length) setActive(enabled[next]);
    } else if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault(); opened ? commit(active) : open();
    } else if (event.key === 'Escape' && opened) {
      event.preventDefault(); event.stopPropagation(); close();
    } else if (event.key === 'Tab') close();
    else if (event.key.length === 1 && !event.ctrlKey && !event.metaKey) {
      search = Date.now() - searchAt > 650 ? event.key : search + event.key;
      searchAt = Date.now();
      const index = options.findIndex(option => !option.disabled && !option.hidden && option.textContent.toLowerCase().startsWith(search.toLowerCase()));
      if (index >= 0) { if (!opened) open(); setActive(index); }
    }
  });
  const outside = event => { if (!wrapper.contains(event.target) && !panel.contains(event.target)) close(); };
  const onScroll = event => { if (opened && !panel.contains(event.target)) position(); };
  document.addEventListener('pointerdown', outside);
  window.addEventListener('resize', position);
  document.addEventListener('scroll', onScroll, true);
  select.addEventListener('change', sync);
  sync();
  return { sync, destroy() {
    clearTimeout(closeTimer);
    panel.remove();
    document.removeEventListener('pointerdown', outside);
    document.removeEventListener('scroll', onScroll, true);
    window.removeEventListener('resize', position);
    select.removeEventListener('change', sync);
  } };
}
