const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('desktop', {
  openFile: () => ipcRenderer.invoke('open-file'),
  readFile: path => ipcRenderer.invoke('read-file', path),
  openMedia: () => ipcRenderer.invoke('open-media'),
  resolveShare: url => ipcRenderer.invoke('resolve-share', url)
});
