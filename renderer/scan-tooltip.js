// Viewport coordinates only: the tooltip must not live under a transformed,
// overflow:auto modal card, where z-index cannot prevent clipping.
export function scanTooltipPosition(anchor, tooltip, viewport, gap = 8, margin = 8) {
  let left = anchor.right + gap;
  if (left + tooltip.width > viewport.width - margin) left = anchor.left - gap - tooltip.width;
  const maxLeft = Math.max(margin, viewport.width - margin - tooltip.width);
  const maxTop = Math.max(margin, viewport.height - margin - tooltip.height);
  return {
    left: Math.max(margin, Math.min(left, maxLeft)),
    top: Math.max(margin, Math.min(anchor.top + anchor.height / 2 - tooltip.height / 2, maxTop)),
  };
}

let sequence = 0;
export function createScanTooltip() {
  const element = document.createElement('div');
  element.id = `scan-ip-tooltip-${++sequence}`;
  element.className = 'scan-ip-tooltip';
  element.setAttribute('role', 'tooltip');
  element.setAttribute('aria-hidden', 'true');
  document.body.append(element);
  let anchor = null;
  let disposed = false;

  function hide() {
    if (anchor) {
      const ids = (anchor.getAttribute('aria-describedby') || '').split(/\s+/).filter(id => id && id !== element.id);
      if (ids.length) anchor.setAttribute('aria-describedby', ids.join(' '));
      else anchor.removeAttribute('aria-describedby');
    }
    anchor = null;
    element.classList.remove('is-visible');
    element.setAttribute('aria-hidden', 'true');
  }
  function reposition() {
    if (disposed || !anchor) return;
    if (!anchor.isConnected || !anchor.getClientRects().length) { hide(); return; }
    const position = scanTooltipPosition(anchor.getBoundingClientRect(), {
      width: element.offsetWidth,
      height: element.offsetHeight,
    }, { width: document.documentElement.clientWidth, height: document.documentElement.clientHeight });
    element.style.left = `${position.left}px`;
    element.style.top = `${position.top}px`;
  }
  function show(target, text) {
    if (disposed || !target.isConnected) return;
    hide();
    anchor = target;
    element.textContent = text;
    const ids = (target.getAttribute('aria-describedby') || '').split(/\s+/).filter(Boolean);
    target.setAttribute('aria-describedby', [...ids, element.id].join(' '));
    reposition();
    element.setAttribute('aria-hidden', 'false');
    element.classList.add('is-visible');
  }
  // Scrolling can move a cell behind the card's viewport; hide instead of
  // leaving an orphaned tooltip over another part of the application.
  document.addEventListener('scroll', hide, true);
  window.addEventListener('resize', hide);
  window.addEventListener('blur', hide);
  return { show, hide, reposition, destroy() {
    if (disposed) return;
    hide();
    disposed = true;
    element.remove();
    document.removeEventListener('scroll', hide, true);
    window.removeEventListener('resize', hide);
    window.removeEventListener('blur', hide);
  } };
}
