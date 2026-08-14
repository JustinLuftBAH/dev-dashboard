const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
  getConfig: () => ipcRenderer.invoke('get-config'),
  saveConfig: (config) => ipcRenderer.invoke('save-config', config),
  checkService: (service) => ipcRenderer.invoke('check-service', service),
  checkAll: () => ipcRenderer.invoke('check-all'),
  getUptimes: () => ipcRenderer.invoke('get-uptimes'),
  startService: (service, input) => ipcRenderer.invoke('start-service', service, input),
  runBuild: (service) => ipcRenderer.invoke('run-build', service),
  cancelBuild: (service) => ipcRenderer.invoke('cancel-build', service),
  stopService: (service) => ipcRenderer.invoke('stop-service', service),
  restartService: (service) => ipcRenderer.invoke('restart-service', service),
  stopAll: () => ipcRenderer.invoke('stop-all'),
  openUrl: (url) => ipcRenderer.invoke('open-url', url),
  getAvailableBrowsers: () => ipcRenderer.invoke('get-available-browsers'),
  copyText: (text) => ipcRenderer.invoke('copy-text', text),
  resolveCommand: (service) => ipcRenderer.invoke('resolve-command', service),
  getConfigPath: () => ipcRenderer.invoke('get-config-path'),
  getAppVersion: () => ipcRenderer.invoke('get-app-version'),
  openConfigFile: () => ipcRenderer.invoke('open-config-file'),
  resetConfig: () => ipcRenderer.invoke('reset-config'),
  getServiceLogs: (serviceId, maxLines) => ipcRenderer.invoke('get-service-logs', serviceId, maxLines),
  clearServiceLogs: (serviceId) => ipcRenderer.invoke('clear-service-logs', serviceId),
  openLogWindow: (serviceId, serviceName) => ipcRenderer.invoke('open-log-window', serviceId, serviceName),
  notify: (title, body) => ipcRenderer.invoke('notify', title, body),
  reloadApp: () => ipcRenderer.invoke('reload-app'),
  getJiraTickets: (scope) => ipcRenderer.invoke('jira-get-tickets', scope),
  refreshJiraTickets: (scope) => ipcRenderer.invoke('jira-refresh-tickets', scope),
  getJiraStatus: () => ipcRenderer.invoke('jira-get-status'),
  getJiraTransitions: (issueKey) => ipcRenderer.invoke('jira-get-transitions', issueKey),
  transitionJiraIssue: (payload) => ipcRenderer.invoke('jira-transition-issue', payload),
  onJiraUpdate: (callback) => {
    const listener = (_event, payload) => callback(payload);
    ipcRenderer.on('jira-tickets-updated', listener);
    return () => ipcRenderer.removeListener('jira-tickets-updated', listener);
  }
});
