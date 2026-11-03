'use strict';

const path = require('node:path');

// Window ownership is private; consumers receive only a guarded sender/getter.
function createWindowService({ BrowserWindow, rootDir, nativeTheme }) {
  let mainWin;

  // Painted before the renderer's first frame and kept in sync with the app
  // theme, so window resize / DevTools / native dialogs never flash white.
  const THEME_BACKGROUND = { light: '#f5f7fb', dark: '#0f1115' };
  const TITLE_BAR = {
    light: { color: '#ffffff', symbolColor: '#1a1a2e' },
    dark: { color: '#16181d', symbolColor: '#e8eaee' },
  };
  const TITLE_BAR_HEIGHT = 40;
  // The custom title bar is a Windows-only refinement; other platforms keep the
  // native frame so their window controls (traffic lights) stay untouched.
  const useTitleBarOverlay = process.platform === 'win32';

  function isDark() {
    return !!(nativeTheme && nativeTheme.shouldUseDarkColors);
  }

  function themeBackground() {
    return THEME_BACKGROUND[isDark() ? 'dark' : 'light'];
  }

  function titleBarOptions() {
    const scheme = TITLE_BAR[isDark() ? 'dark' : 'light'];
    return { color: scheme.color, symbolColor: scheme.symbolColor, height: TITLE_BAR_HEIGHT };
  }

  function applyBackground(win) {
    if (!win || win.isDestroyed()) return;
    try {
      win.setBackgroundColor(themeBackground());
    } catch (e) {
      console.warn('[window] setBackgroundColor failed:', e && e.message ? e.message : e);
    }
  }

  // Keeps the native caption buttons legible against the app's own top bar.
  function applyTitleBar(win) {
    if (!useTitleBarOverlay || !win || win.isDestroyed()) return;
    try {
      win.setTitleBarOverlay(titleBarOptions());
    } catch (e) {
      console.warn('[window] setTitleBarOverlay failed:', e && e.message ? e.message : e);
    }
  }

  function applyThemeChrome(win) {
    applyBackground(win);
    applyTitleBar(win);
  }

  if (nativeTheme && typeof nativeTheme.on === 'function') {
    nativeTheme.on('updated', () => applyThemeChrome(mainWin));
  }

  function safeSendToRenderer(channel, payload) {
    try {
      if (!mainWin || mainWin.isDestroyed()) return;
      if (!mainWin.webContents || mainWin.webContents.isDestroyed()) return;
      mainWin.webContents.send(channel, payload);
    } catch (e) {
      console.warn(`[main] safeSendToRenderer failed on ${channel}:`, e && e.message ? e.message : e);
    }
  }

  function createWindow() {
    mainWin = new BrowserWindow({
      width: 1280,
      height: 860,
      backgroundColor: themeBackground(),
      icon: path.join(rootDir, 'assets', process.platform === 'win32' ? 'icon.ico' : 'icon.png'),
      ...(useTitleBarOverlay
        ? { titleBarStyle: 'hidden', titleBarOverlay: titleBarOptions() }
        : {}),
      webPreferences: {
        preload: path.join(rootDir, 'preload.js'),
        nodeIntegration: false,
        contextIsolation: true
      }
    });

    // nativeTheme flips when the OS theme changes while themeSource === 'system';
    // repaint the window chrome so it matches the renderer.
    mainWin.on('ready-to-show', () => applyThemeChrome(mainWin));

    mainWin.loadFile(path.join(rootDir, 'renderer', 'index.html'));
    // Menu.setApplicationMenu(null);
    // mainWin.webContents.openDevTools();
  }

  return {
    createWindow,
    safeSendToRenderer,
    getWindow: () => mainWin,
    applyBackground,
    applyTitleBar,
    applyThemeChrome,
    themeBackground,
    usesTitleBarOverlay: useTitleBarOverlay,
  };
}

module.exports = { createWindowService };
