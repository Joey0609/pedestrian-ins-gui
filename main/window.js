'use strict';

const path = require('node:path');

// Window ownership is private; consumers receive only a guarded sender/getter.
function createWindowService({ BrowserWindow, rootDir }) {
  let mainWin;

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
      icon: path.join(rootDir, 'assets', process.platform === 'win32' ? 'icon.ico' : 'icon.png'),
      webPreferences: {
        preload: path.join(rootDir, 'preload.js'),
        nodeIntegration: false,
        contextIsolation: true
      }
    });

    mainWin.loadFile(path.join(rootDir, 'renderer', 'index.html'));
    // Menu.setApplicationMenu(null);
    // mainWin.webContents.openDevTools();
  }

  return { createWindow, safeSendToRenderer, getWindow: () => mainWin };
}

module.exports = { createWindowService };
