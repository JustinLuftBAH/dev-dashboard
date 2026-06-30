const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('path');
const fs = require('fs');
const { exec, spawn } = require('child_process');

// Set the application name early (before any getPath('userData') call) so the
// menu/About/notifications read "Dashboard" instead of "Electron".
app.setName('Dashboard');

const CONFIG_PATH = path.join(app.getPath('userData'), 'config.json');
const LOGS_DIR = path.join(app.getPath('userData'), 'logs');

// Ensure logs directory exists
if (!fs.existsSync(LOGS_DIR)) fs.mkdirSync(LOGS_DIR, { recursive: true });

function getLogPath(serviceId) {
  return path.join(LOGS_DIR, `${serviceId}.log`);
}

// Empty default — dashboard starts blank. Users add their own categories/services.
const DEFAULT_CONFIG = {
  categories: [],
  settings: {
    pollInterval: 5000,
    theme: 'dark'
  }
};

function loadConfig() {
  try {
    if (fs.existsSync(CONFIG_PATH)) {
      const data = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
      // Merge with defaults to pick up any new built-in services
      return data;
    }
  } catch (e) {
    console.error('Error loading config:', e);
  }
  return JSON.parse(JSON.stringify(DEFAULT_CONFIG));
}

function saveConfig(config) {
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2));
}

function runCommand(cmd, opts = {}) {
  return new Promise((resolve, reject) => {
    exec(cmd, {
      shell: '/bin/bash',
      timeout: opts.timeout || 120000, // 2 min default
      maxBuffer: 10 * 1024 * 1024,
      env: { ...process.env, PATH: `${process.env.HOME}/Repositories/crucial/vbms-core/jvm-proxy-authentication-war/devvpn-script:${process.env.PATH}` }
    }, (err, stdout, stderr) => {
      if (err) reject(err);
      else resolve(stdout.trim());
    });
  });
}

async function checkService(service) {
  try {
    if (service.checkType === 'port' && service.port) {
      // Find PIDs listening on the port.
      const pids = (await runCommand(`lsof -ti tcp:${service.port} -sTCP:LISTEN`))
        .split('\n').map(s => s.trim()).filter(Boolean);
      if (!pids.length) return false;
      // If a processMatch is set, the port alone isn't enough — verify the
      // process on that port is actually THIS service. This prevents two
      // services that share a port (e.g. two APIs on 8080) from being
      // reported as both running. ("never confuse deployments")
      if (service.processMatch) {
        for (const pid of pids) {
          const cmd = await runCommand(`ps -p ${pid} -o command= 2>/dev/null || true`);
          if (cmd && cmd.includes(service.processMatch)) return true;
        }
        return false;
      }
      return true;
    } else if (service.checkType === 'docker' && service.dockerName) {
      const result = await runCommand(`docker ps --filter "name=${service.dockerName}" --format "{{.Status}}"`);
      return result.includes('Up');
    } else if (service.checkType === 'command' && service.checkCommand) {
      await runCommand(service.checkCommand);
      return true;
    }
    return false;
  } catch {
    return false;
  }
}

// Resolve a service's start command, substituting {{flag}} with the currently
// selected flag value (for flag-toggle services).
function resolveStartCommand(service) {
  let cmd = service.startCommand || '';
  const flag = service.flag != null ? service.flag : '';
  cmd = cmd.replace(/\{\{\s*flag\s*\}\}/g, flag);
  return cmd;
}

async function startService(service, inputValue) {
  const logPath = getLogPath(service.id);
  const timestamp = new Date().toISOString();
  const startCommand = resolveStartCommand(service);
  // Append a start marker to the log
  fs.appendFileSync(logPath, `\n── [${timestamp}] Starting ${service.name}${service.flag ? ` [flag: ${service.flag}]` : ''} ──\n`);

  if (service.requiresInput && inputValue) {
    return new Promise((resolve, reject) => {
      const child = spawn('/usr/bin/expect', ['-c', `
        log_user 0
        set timeout 30
        spawn bash -c "${startCommand} 2>&1"
        expect {
          "erification code:" { send "${inputValue}\\r" }
          timeout { exit 1 }
        }
        expect {
          eof {}
          timeout {}
        }
      `], {
        env: { ...process.env, PATH: `${process.env.HOME}/Repositories/crucial/vbms-core/jvm-proxy-authentication-war/devvpn-script:${process.env.PATH}` }
      });
      // Capture expect output to log
      if (child.stdout) child.stdout.on('data', d => fs.appendFileSync(logPath, d));
      if (child.stderr) child.stderr.on('data', d => fs.appendFileSync(logPath, d));
      child.on('close', (code) => {
        fs.appendFileSync(logPath, `\n── Process exited with code ${code} ──\n`);
        setTimeout(() => resolve(code === 0), 2000);
      });
      child.on('error', (err) => {
        fs.appendFileSync(logPath, `\n── Error: ${err.message} ──\n`);
        reject(err);
      });
    });
  }

  if (startCommand) {
    try {
      const logFd = fs.openSync(logPath, 'a');
      const child = spawn('/bin/bash', ['-c', startCommand], {
        detached: true,
        stdio: ['ignore', logFd, logFd],
        env: { ...process.env, PATH: `${process.env.HOME}/Repositories/crucial/vbms-core/jvm-proxy-authentication-war/devvpn-script:${process.env.PATH}` }
      });
      child.unref();
      // Close the fd in parent — child keeps its own copy
      fs.closeSync(logFd);
      return true;
    } catch (e) {
      fs.appendFileSync(logPath, `\n── Start error: ${e.message} ──\n`);
      console.error('Start error:', e);
      return false;
    }
  }
  return false;
}

async function stopService(service) {
  const logPath = getLogPath(service.id);
  const timestamp = new Date().toISOString();
  const sleep = (ms) => new Promise(r => setTimeout(r, ms));
  fs.appendFileSync(logPath, `\n── [${timestamp}] Stopping ${service.name} ──\n`);
  try {
    // 1) Run the explicit stop command, if any.
    if (service.stopCommand) {
      const output = await runCommand(service.stopCommand).catch(e => `stopCommand error: ${e.message}`);
      if (output) fs.appendFileSync(logPath, output + '\n');
    }

    // 2) Always also kill the process on the port — this catches processes
    //    started outside the app (another terminal) or that the stop command
    //    didn't fully terminate. Skipped for docker (the port is held by the
    //    Docker VM). When processMatch is set, only kill the MATCHING process
    //    so we never accidentally stop a different service sharing the port.
    if (service.port && service.checkType !== 'docker') {
      const killOnPort = async (signal) => {
        const pids = (await runCommand(`lsof -ti tcp:${service.port} -sTCP:LISTEN 2>/dev/null || true`).catch(() => ''))
          .split('\n').map(s => s.trim()).filter(Boolean);
        for (const pid of pids) {
          if (service.processMatch) {
            const cmd = await runCommand(`ps -p ${pid} -o command= 2>/dev/null || true`).catch(() => '');
            if (!cmd.includes(service.processMatch)) continue; // not ours — leave it alone
          }
          await runCommand(`kill ${signal} ${pid} 2>/dev/null || true`).catch(() => {});
        }
      };
      await killOnPort('');       // SIGTERM (graceful)
      await sleep(1500);
      await killOnPort('-9');     // SIGKILL fallback
      await sleep(500);
    }

    // 3) Verify the real state instead of assuming success.
    const stillRunning = await checkService(service);
    if (stillRunning) {
      fs.appendFileSync(logPath, `── Stop FAILED — still running ──\n`);
    } else {
      fs.appendFileSync(logPath, `── Stop completed ──\n`);
    }
    return !stillRunning;
  } catch (e) {
    fs.appendFileSync(logPath, `── Stop error: ${e.message} ──\n`);
    // Report the actual state rather than blindly claiming success.
    try { return !(await checkService(service)); } catch { return false; }
  }
}

let mainWindow;

// Single instance lock — focus existing window instead of opening a duplicate
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
}
app.on('second-instance', () => {
  if (mainWindow) {
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.focus();
  }
});

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 900,
    height: 700,
    minWidth: 700,
    minHeight: 500,
    icon: path.join(__dirname, '..', 'icon.png'),
    titleBarStyle: 'hiddenInset',
    backgroundColor: '#08071a',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false
    }
  });

  mainWindow.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));
}

app.whenReady().then(() => {
  // Enforce single instance — bail out if another instance already holds the lock.
  if (!gotLock) {
    app.quit();
    return;
  }

  // Set the Dock icon (macOS). Needed when running from source via `electron .`,
  // where the default Electron icon would otherwise show.
  if (process.platform === 'darwin' && app.dock) {
    try { app.dock.setIcon(path.join(__dirname, '..', 'icon.png')); } catch (e) { /* ignore */ }
  }

  let config = loadConfig();

  // IPC Handlers
  ipcMain.handle('get-config', () => config);

  // Copy text to the system clipboard (used by the per-service "copy command" button).
  ipcMain.handle('copy-text', (_, text) => {
    const { clipboard } = require('electron');
    clipboard.writeText(String(text ?? ''));
    return true;
  });

  // Resolve a service's start command (substitute {{flag}}) for display/copy.
  ipcMain.handle('resolve-command', (_, service) => resolveStartCommand(service));

  ipcMain.handle('save-config', (_, newConfig) => {
    config = newConfig;
    saveConfig(config);
    return true;
  });

  ipcMain.handle('check-service', async (_, service) => {
    return await checkService(service);
  });

  ipcMain.handle('check-all', async () => {
    const statuses = {};
    for (const cat of config.categories) {
      for (const svc of cat.services) {
        statuses[svc.id] = await checkService(svc);
      }
    }
    return statuses;
  });

  ipcMain.handle('start-service', async (_, service, inputValue) => {
    return await startService(service, inputValue);
  });

  ipcMain.handle('stop-service', async (_, service) => {
    return await stopService(service);
  });

  ipcMain.handle('restart-service', async (_, service) => {
    await stopService(service);
    await new Promise(r => setTimeout(r, 2000));
    return await startService(service);
  });

  ipcMain.handle('stop-all', async () => {
    for (const cat of config.categories) {
      for (const svc of cat.services) {
        const running = await checkService(svc);
        if (running) await stopService(svc);
      }
    }
    return true;
  });

  ipcMain.handle('open-url', (_, url) => {
    // Open all links in Microsoft Edge. Fall back to the default browser if
    // Edge isn't installed / fails to launch.
    const child = spawn('open', ['-a', 'Microsoft Edge', url]);
    child.on('error', () => {
      const { shell } = require('electron');
      shell.openExternal(url);
    });
    child.on('close', (code) => {
      if (code !== 0) {
        const { shell } = require('electron');
        shell.openExternal(url);
      }
    });
  });

  ipcMain.handle('get-config-path', () => CONFIG_PATH);

  ipcMain.handle('open-config-file', () => {
    const { shell } = require('electron');
    shell.showItemInFolder(CONFIG_PATH);
  });

  ipcMain.handle('reset-config', () => {
    config = JSON.parse(JSON.stringify(DEFAULT_CONFIG));
    saveConfig(config);
    return config;
  });

  ipcMain.handle('reload-app', () => {
    if (mainWindow) mainWindow.reload();
  });

  ipcMain.handle('get-service-logs', (_, serviceId, maxLines) => {
    const logPath = getLogPath(serviceId);
    try {
      if (!fs.existsSync(logPath)) return '';
      const content = fs.readFileSync(logPath, 'utf8');
      if (maxLines) {
        const lines = content.split('\n');
        return lines.slice(-maxLines).join('\n');
      }
      // Cap at last 50KB to avoid sending huge payloads
      if (content.length > 50000) return content.slice(-50000);
      return content;
    } catch {
      return '';
    }
  });

  ipcMain.handle('clear-service-logs', (_, serviceId) => {
    const logPath = getLogPath(serviceId);
    try { fs.writeFileSync(logPath, ''); } catch {}
    return true;
  });

  createWindow();
});

app.on('window-all-closed', () => app.quit());
