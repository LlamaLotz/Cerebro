const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
  selectFolder: () => ipcRenderer.invoke('select-folder'),
  readVaultFiles: (vaultPath) => ipcRenderer.invoke('read-vault-files', vaultPath),
  writeFile: (data) => ipcRenderer.invoke('write-file', data),
  createFile: (data) => ipcRenderer.invoke('create-file', data),
  deleteFile: (filePath) => ipcRenderer.invoke('delete-file', filePath),
  renameFile: (data) => ipcRenderer.invoke('rename-file', data),
  runIngestionScript: (data) => ipcRenderer.invoke('run-ingestion-script', data),
  onVaultChanged: (callback) => {
    const handler = (event, data) => callback(data);
    ipcRenderer.on('vault-changed', handler);
    return () => ipcRenderer.removeListener('vault-changed', handler);
  },
  isElectron: true,
});
