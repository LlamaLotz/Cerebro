const { app, BrowserWindow, ipcMain, dialog } = require('electron');
const path = require('path');
const fs = require('fs');
const { exec } = require('child_process');

let mainWindow;
let activeWatcher = null;

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1300,
    height: 850,
    minWidth: 900,
    minHeight: 600,
    titleBarStyle: 'hiddenInset',
    backgroundColor: '#020617',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: false,
    },
  });

  const isDev = process.env.NODE_ENV === 'development' || !app.isPackaged;

  if (isDev) {
    const port = process.env.PORT || 5173;
    mainWindow.loadURL(`http://localhost:${port}`);
    // mainWindow.webContents.openDevTools();
  } else {
    mainWindow.loadFile(path.join(__dirname, '../dist/index.html'));
  }
}

app.whenReady().then(() => {
  createWindow();

  app.on('activate', function () {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', function () {
  if (process.platform !== 'darwin') app.quit();
});

// IPC Handlers

// Select Vault Folder Dialog
ipcMain.handle('select-folder', async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    properties: ['openDirectory', 'createDirectory'],
  });
  if (result.canceled || result.filePaths.length === 0) {
    return null;
  }
  return result.filePaths[0];
});

// Read Vault Files recursively
async function readFilesRecursively(dir, rootDir = dir) {
  let results = [];
  try {
    const list = await fs.promises.readdir(dir, { withFileTypes: true });
    for (const entry of list) {
      if (entry.name.startsWith('.') || entry.name === 'node_modules') continue;
      const fullPath = path.join(dir, entry.name);
      const relativePath = path.relative(rootDir, fullPath);

      if (entry.isDirectory()) {
        const subFiles = await readFilesRecursively(fullPath, rootDir);
        results = results.concat(subFiles);
      } else if (entry.isFile() && (entry.name.endsWith('.md') || entry.name.endsWith('.markdown'))) {
        const stats = await fs.promises.stat(fullPath);
        const content = await fs.promises.readFile(fullPath, 'utf8');
        results.push({
          path: fullPath,
          relativePath: relativePath,
          name: entry.name,
          title: entry.name.replace(/\.(md|markdown)$/i, ''),
          content: content,
          updatedAt: stats.mtimeMs,
        });
      }
    }
  } catch (err) {
    console.error('Error reading vault files:', err);
  }
  return results;
}

ipcMain.handle('read-vault-files', async (event, vaultPath) => {
  if (!vaultPath || !fs.existsSync(vaultPath)) return [];
  
  // Start watcher if not watching this folder
  if (activeWatcher) {
    try { activeWatcher.close(); } catch (e) {}
  }
  
  try {
    activeWatcher = fs.watch(vaultPath, { recursive: true }, (eventType, filename) => {
      if (filename && (filename.endsWith('.md') || filename.endsWith('.markdown'))) {
        if (mainWindow) {
          mainWindow.webContents.send('vault-changed', { eventType, filename });
        }
      }
    });
  } catch (e) {
    console.warn('Folder watch failed:', e);
  }

  return await readFilesRecursively(vaultPath);
});

// Save / Write file
ipcMain.handle('write-file', async (event, { filePath, content }) => {
  try {
    const dir = path.dirname(filePath);
    if (!fs.existsSync(dir)) {
      await fs.promises.mkdir(dir, { recursive: true });
    }
    await fs.promises.writeFile(filePath, content, 'utf8');
    return { success: true };
  } catch (err) {
    return { success: false, error: err.message };
  }
});

// Create file
ipcMain.handle('create-file', async (event, { vaultPath, relativePath, content = '' }) => {
  try {
    const fullPath = path.join(vaultPath, relativePath.endsWith('.md') ? relativePath : `${relativePath}.md`);
    const dir = path.dirname(fullPath);
    if (!fs.existsSync(dir)) {
      await fs.promises.mkdir(dir, { recursive: true });
    }
    await fs.promises.writeFile(fullPath, content, 'utf8');
    return { success: true, fullPath };
  } catch (err) {
    return { success: false, error: err.message };
  }
});

// Delete file
ipcMain.handle('delete-file', async (event, filePath) => {
  try {
    if (fs.existsSync(filePath)) {
      await fs.promises.unlink(filePath);
    }
    return { success: true };
  } catch (err) {
    return { success: false, error: err.message };
  }
});

// Rename file
ipcMain.handle('rename-file', async (event, { oldPath, newPath }) => {
  try {
    if (fs.existsSync(oldPath)) {
      await fs.promises.rename(oldPath, newPath);
    }
    return { success: true };
  } catch (err) {
    return { success: false, error: err.message };
  }
});

// Run Custom Ingestion Script
ipcMain.handle('run-ingestion-script', async (event, { scriptCommand, vaultPath }) => {
  return new Promise((resolve) => {
    if (!scriptCommand || !scriptCommand.trim()) {
      resolve({ success: false, output: 'No script command provided.' });
      return;
    }

    // Replace {vault_path} placeholder with actual vaultPath
    const formattedCommand = scriptCommand.replace(/\{vault_path\}/g, `"${vaultPath}"`);

    exec(formattedCommand, { cwd: vaultPath }, (error, stdout, stderr) => {
      if (error) {
        resolve({
          success: false,
          output: `Execution error: ${error.message}\n${stderr || ''}`,
        });
      } else {
        resolve({
          success: true,
          output: stdout || 'Script executed successfully with no output.',
        });
      }
    });
  });
});
