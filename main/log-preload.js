const { contextBridge, ipcRenderer } = require('electron');

// Minimal API surface for the standalone log window — only what's needed to
// fetch/clear logs for the single service this window was opened for.
contextBridge.exposeInMainWorld('api', {
  getServiceLogs: (serviceId, maxLines) => ipcRenderer.invoke('get-service-logs', serviceId, maxLines),
  clearServiceLogs: (serviceId) => ipcRenderer.invoke('clear-service-logs', serviceId),
  copyText: (text) => ipcRenderer.invoke('copy-text', text)
});
