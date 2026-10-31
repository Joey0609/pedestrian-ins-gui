'use strict';

const fs = require('node:fs');
const path = require('node:path');

// rootDir remains the application's original main.js directory, including packaged builds.
function registerFileIpc({ ipcMain, shell, rootDir }) {
  ipcMain.on('open-url', (event, url) => {
    shell.openExternal(url);
  });

  ipcMain.handle('save-recording-files', async (event, { files }) => {
    try {
      const dataLoggerPath = path.join(rootDir, 'dataLogger');
      if (!fs.existsSync(dataLoggerPath)) {
        fs.mkdirSync(dataLoggerPath, { recursive: true });
      }

      const savedFiles = [];
      for (const file of files) {
        const filePath = path.join(dataLoggerPath, file.name);
        fs.writeFileSync(filePath, file.content, 'utf8');
        savedFiles.push({
          name: file.name,
          path: filePath,
          folder: dataLoggerPath
        });
      }
      return { success: true, files: savedFiles };
    } catch (e) {
      console.error('save-recording-files error:', e);
      return { success: false, error: e.message };
    }
  });

  ipcMain.on('open-file', (event, filePath) => {
    shell.openPath(filePath);
  });

  ipcMain.on('open-folder', (event, folderPath) => {
    shell.showItemInFolder(folderPath);
  });
}

module.exports = { registerFileIpc };
