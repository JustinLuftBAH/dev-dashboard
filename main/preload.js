const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
  getConfig: () => ipcRenderer.invoke('get-config'),
  saveConfig: (config) => ipcRenderer.invoke('save-config', config),
  checkService: (service) => ipcRenderer.invoke('check-service', service),
  checkAll: () => ipcRenderer.invoke('check-all'),
  getUptimes: () => ipcRenderer.invoke('get-uptimes'),
  startService: (service, input) => ipcRenderer.invoke('start-service', service, input),
  stopService: (service) => ipcRenderer.invoke('stop-service', service),
  restartService: (service) => ipcRenderer.invoke('restart-service', service),
  stopAll: () => ipcRenderer.invoke('stop-all'),
  openUrl: (url) => ipcRenderer.invoke('open-url', url),
  copyText: (text) => ipcRenderer.invoke('copy-text', text),
  resolveCommand: (service) => ipcRenderer.invoke('resolve-command', service),
  getConfigPath: () => ipcRenderer.invoke('get-config-path'),
  openConfigFile: () => ipcRenderer.invoke('open-config-file'),
  resetConfig: () => ipcRenderer.invoke('reset-config'),
  getServiceLogs: (serviceId, maxLines) => ipcRenderer.invoke('get-service-logs', serviceId, maxLines),
  clearServiceLogs: (serviceId) => ipcRenderer.invoke('clear-service-logs', serviceId),
  reloadApp: () => ipcRenderer.invoke('reload-app')
});
