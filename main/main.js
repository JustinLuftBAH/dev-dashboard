const { app, BrowserWindow, ipcMain, Notification } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { exec, spawn, execSync } = require('child_process');

// Set the application name early (before any getPath('userData') call) so the
// menu/About/notifications read "Dashboard" instead of "Electron".
app.setName('Dashboard');

const CONFIG_PATH = path.join(app.getPath('userData'), 'config.json');
const LOGS_DIR = path.join(app.getPath('userData'), 'logs');

// GUI apps launched from Finder/Dock inherit a minimal PATH that omits Homebrew
// and any custom dirs (e.g. where `devvpn` lives), so those tools can't be found.
// We rebuild a usable PATH from: the user's real login-shell PATH + the common
// tool dirs + whatever PATH we already have, de-duplicated.
function getLoginShellPath() {
  try {
    const shell = process.env.SHELL || '/bin/zsh';
    // Login, NON-interactive shell: picks up ~/.zprofile / ~/.profile (Homebrew,
    // devvpn, etc.) without running interactive ~/.zshrc side effects. A marker
    // is used so we can extract PATH even if the profile prints banner output.
    const out = execSync(`'${shell}' -lc 'printf %s "DDPATH:$PATH"'`, {
      encoding: 'utf8',
      timeout: 5000,
      stdio: ['ignore', 'pipe', 'ignore']
    });
    const m = out.match(/DDPATH:(.*)$/);
    return m ? m[1] : '';
  } catch (e) {
    return '';
  }
}

const ENHANCED_PATH = (() => {
  const candidates = [
    getLoginShellPath(),
    '/opt/homebrew/bin',
    '/opt/homebrew/sbin',
    '/usr/local/bin',
    // Justin's local devvpn-script location (harmless if it doesn't exist).
    path.join(process.env.HOME || '', 'Repositories/crucial/vbms-core/jvm-proxy-authentication-war/devvpn-script'),
    process.env.PATH || ''
  ];
  const seen = new Set();
  const dirs = [];
  for (const part of candidates) {
    for (const dir of part.split(':')) {
      if (dir && !seen.has(dir)) { seen.add(dir); dirs.push(dir); }
    }
  }
  return dirs.join(':');
})();

// Ensure logs directory exists
if (!fs.existsSync(LOGS_DIR)) fs.mkdirSync(LOGS_DIR, { recursive: true });

function getLogPath(serviceId) {
  return path.join(LOGS_DIR, `${serviceId}.log`);
}

// Show a native OS notification (used for start failures / crashed processes so
// problems are visible even when the dashboard window isn't focused).
function notify(title, body) {
  try {
    if (typeof Notification.isSupported === 'function' && !Notification.isSupported()) return;
    const n = new Notification({
      title: String(title || 'Dashboard'),
      body: String(body || ''),
      silent: false
    });
    n.on('click', () => {
      if (mainWindow) {
        if (mainWindow.isMinimized()) mainWindow.restore();
        mainWindow.show();
        mainWindow.focus();
      }
    });
    n.show();
  } catch (e) {
    console.error('notify error:', e);
  }
}

// Extract a concise error message from a log file, looking only at output
// written since `fromOffset` (i.e. the current start attempt). Prefers the last
// few meaningful lines, skipping our own "── … ──" marker lines.
function readLogTail(logPath, fromOffset = 0, maxChars = 600) {
  try {
    const content = fs.readFileSync(logPath, 'utf8');
    const chunk = fromOffset ? content.slice(fromOffset) : content;
    const lines = chunk.split('\n')
      .map(l => l.trim())
      .filter(l => l && !l.startsWith('──'));
    let msg = lines.slice(-4).join('\n').trim() || chunk.trim();
    if (msg.length > maxChars) msg = msg.slice(-maxChars);
    return msg;
  } catch {
    return '';
  }
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
      return data;
    }
    // One-time migration: earlier builds stored userData under a different app
    // name (e.g. "dev-dashboard") derived from package.json. If we don't have a
    // config at the current path but a legacy one exists, adopt it so upgrading
    // never wipes a user's categories/services.
    const legacy = migrateLegacyConfig();
    if (legacy) return legacy;
  } catch (e) {
    console.error('Error loading config:', e);
  }
  return JSON.parse(JSON.stringify(DEFAULT_CONFIG));
}

// Look for a config.json left behind by an older app name and copy it to the
// current CONFIG_PATH. Returns the parsed config if migrated, else null.
function migrateLegacyConfig() {
  const appData = app.getPath('appData');
  const legacyNames = ['dev-dashboard', 'Electron'];
  for (const name of legacyNames) {
    const legacyPath = path.join(appData, name, 'config.json');
    try {
      if (legacyPath !== CONFIG_PATH && fs.existsSync(legacyPath)) {
        const data = JSON.parse(fs.readFileSync(legacyPath, 'utf8'));
        fs.mkdirSync(path.dirname(CONFIG_PATH), { recursive: true });
        fs.writeFileSync(CONFIG_PATH, JSON.stringify(data, null, 2));
        console.log(`Migrated config from ${legacyPath} -> ${CONFIG_PATH}`);
        return data;
      }
    } catch (e) {
      console.error(`Error migrating legacy config from ${legacyPath}:`, e);
    }
  }
  return null;
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
      env: { ...process.env, PATH: ENHANCED_PATH }
    }, (err, stdout, stderr) => {
      if (err) reject(err);
      else resolve(stdout.trim());
    });
  });
}

async function checkService(service) {
  // Builds are one-shot jobs, not persistent processes — they have no
  // "running" status to poll for.
  if (service.type === 'build') return false;
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

// A start command that exits (non-zero) within this window is treated as a
// failure. If it's still running after the window, we assume a long-lived
// server started successfully and let it keep running.
const START_GRACE_MS = 4000;

// Guards against overlapping start/stop/restart calls for the same service —
// this is what actually happens when a user "spam clicks" a button before the
// renderer has re-rendered to hide it: without this, each click spawns its
// own start/stop attempt concurrently, which is what makes the app feel
// unresponsive (duplicate processes racing on the same port, stop steps
// interleaving with start steps, etc). Any call for a service that already
// has one in flight is rejected immediately instead of queued or duplicated.
const inFlightActions = new Set();
async function withInFlightGuard(serviceId, fn) {
  if (inFlightActions.has(serviceId)) {
    return { ok: false, error: 'Already in progress — please wait for it to finish.' };
  }
  inFlightActions.add(serviceId);
  try {
    return await fn();
  } finally {
    inFlightActions.delete(serviceId);
  }
}

async function startService(service, inputValue) {
  const logPath = getLogPath(service.id);
  const timestamp = new Date().toISOString();
  const startCommand = resolveStartCommand(service);
  // Start each run with a clean log instead of appending onto old runs —
  // otherwise the log view mixes output from several starts/restarts together
  // and it's hard to tell what belongs to the current attempt.
  try { fs.writeFileSync(logPath, ''); } catch {}
  fs.appendFileSync(logPath, `── [${timestamp}] Starting ${service.name}${service.flag ? ` [flag: ${service.flag}]` : ''} ──\n`);

  // Remember where this attempt's output begins so, on failure, we can surface
  // just the error text from THIS attempt (not stale output from a prior run).
  let startOffset = 0;
  try { startOffset = fs.statSync(logPath).size; } catch {}

  if (service.requiresInput && inputValue) {
    return new Promise((resolve) => {
      let settled = false;
      const child = spawn('/usr/bin/expect', ['-c', `
        log_user 0
        set timeout 30
        spawn bash -c "${startCommand} 2>&1"
        expect {
          "erification code:" { send "${inputValue}\\r" }
          timeout { exit 1 }
        }
        expect {
          "===DEVVPN_START_DONE===" { send_user "DASHBOARD_START_DONE\\n"; exit 0 }
          eof {}
          timeout {}
        }
      `], {
        env: { ...process.env, PATH: ENHANCED_PATH }
      });
      // Safety net: 'expect' can end up waiting on a pty that never sees EOF
      // (e.g. something it spawned inherited the pty as its own stdin/stdout
      // and is still holding it open, even after that process has otherwise
      // finished doing real work). If 'close' hasn't fired well past expect's
      // own 30s internal timeout, stop waiting on it — the underlying start
      // command has almost certainly already finished — so this service
      // doesn't stay stuck "in progress" forever and block Stop/Restart.
      const watchdog = setTimeout(() => {
        if (settled) return;
        settled = true;
        fs.appendFileSync(logPath, `\n── Timed out waiting on start process; assuming it finished ──\n`);
        try { child.kill(); } catch {}
        resolve({ ok: true });
      }, 65000);
      // Capture expect output to log, and watch for the explicit "done"
      // marker below — this is what makes Stop instant right after Start:
      // rather than waiting on the pty to close (which can hang if anything
      // devvpn backgrounded is still holding it open), we react the instant
      // devvpn's own script says it's finished.
      if (child.stdout) child.stdout.on('data', d => {
        fs.appendFileSync(logPath, d);
        if (!settled && d.toString().includes('DASHBOARD_START_DONE')) {
          settled = true;
          clearTimeout(watchdog);
          fs.appendFileSync(logPath, `\n── Process signaled completion ──\n`);
          setTimeout(() => resolve({ ok: true }), 500);
        }
      });
      if (child.stderr) child.stderr.on('data', d => fs.appendFileSync(logPath, d));
      child.on('close', (code) => {
        if (settled) return;
        settled = true;
        clearTimeout(watchdog);
        fs.appendFileSync(logPath, `\n── Process exited with code ${code} ──\n`);
        if (code === 0) {
          setTimeout(() => resolve({ ok: true }), 2000);
        } else {
          const error = readLogTail(logPath, startOffset) || `exited with code ${code}`;
          notify(`${service.name} failed to start`, error);
          resolve({ ok: false, error });
        }
      });
      child.on('error', (err) => {
        if (settled) return;
        settled = true;
        clearTimeout(watchdog);
        fs.appendFileSync(logPath, `\n── Error: ${err.message} ──\n`);
        notify(`${service.name} failed to start`, err.message);
        resolve({ ok: false, error: err.message });
      });
    });
  }

  if (startCommand) {
    return new Promise((resolve) => {
      let logFd;
      try {
        logFd = fs.openSync(logPath, 'a');
      } catch (e) {
        fs.appendFileSync(logPath, `\n── Start error: ${e.message} ──\n`);
        notify(`${service.name} failed to start`, e.message);
        return resolve({ ok: false, error: e.message });
      }

      let child;
      try {
        child = spawn('/bin/bash', ['-c', startCommand], {
          detached: true,
          stdio: ['ignore', logFd, logFd],
          env: { ...process.env, PATH: ENHANCED_PATH }
        });
      } catch (e) {
        try { fs.closeSync(logFd); } catch {}
        fs.appendFileSync(logPath, `\n── Start error: ${e.message} ──\n`);
        notify(`${service.name} failed to start`, e.message);
        return resolve({ ok: false, error: e.message });
      }

      let settled = false;
      const finish = (result) => {
        if (settled) return;
        settled = true;
        clearTimeout(graceTimer);
        try { fs.closeSync(logFd); } catch {}
        resolve(result);
      };

      child.on('error', (err) => {
        fs.appendFileSync(logPath, `\n── Start error: ${err.message} ──\n`);
        notify(`${service.name} failed to start`, err.message);
        finish({ ok: false, error: err.message });
      });

      // Exit within the grace window:
      //  - code 0  → command backgrounded / completed cleanly (e.g. `docker
      //              start`, or a server daemonized itself) → success.
      //  - nonzero → the start command failed (e.g. Docker daemon down produces
      //              the "EOF" error) → surface it via notification + log.
      child.on('exit', (code) => {
        if (code === 0) {
          finish({ ok: true });
        } else {
          const error = readLogTail(logPath, startOffset) || `exited with code ${code}`;
          fs.appendFileSync(logPath, `\n── Start FAILED (exit ${code}) ──\n`);
          notify(`${service.name} failed to start`, error);
          finish({ ok: false, error });
        }
      });

      // Still running after the grace window → assume a long-lived server
      // started OK. Detach it so it survives independently of this app.
      const graceTimer = setTimeout(() => {
        try { child.unref(); } catch {}
        finish({ ok: true });
      }, START_GRACE_MS);
    });
  }
  return { ok: false, error: 'No start command configured' };
}

// Tracks in-flight builds so a "Cancel" click can kill the process tree.
// service.id -> spawned child process
const runningBuilds = new Map();

// Runs a one-shot build command (e.g. `mvn clean install ...`) to completion.
// Unlike startService, there's no grace-period/backgrounding logic — a build
// is expected to exit on its own, and success/failure is determined by its
// real exit code whenever that happens (fast or slow).
async function runBuild(service) {
  const logPath = getLogPath(service.id);
  const timestamp = new Date().toISOString();
  const buildCommand = (service.buildCommand || '').trim();
  if (!buildCommand) return { ok: false, error: 'No build command configured' };

  // Expand a leading `~` ourselves: quoting the path (needed for spaces)
  // prevents bash from doing tilde expansion on its own.
  const workingDir = service.workingDir && service.workingDir.startsWith('~')
    ? path.join(os.homedir(), service.workingDir.slice(1))
    : service.workingDir;

  const cmd = workingDir
    ? `cd "${workingDir}" && ${buildCommand}`
    : buildCommand;

  // Fresh log per run, same as startService, so old build output doesn't mix in.
  try { fs.writeFileSync(logPath, ''); } catch {}
  fs.appendFileSync(logPath, `── [${timestamp}] Building ${service.name} ──\n`);

  let startOffset = 0;
  try { startOffset = fs.statSync(logPath).size; } catch {}

  return new Promise((resolve) => {
    let logFd;
    try {
      logFd = fs.openSync(logPath, 'a');
    } catch (e) {
      fs.appendFileSync(logPath, `\n── Build error: ${e.message} ──\n`);
      notify(`${service.name} failed to build`, e.message);
      return resolve({ ok: false, error: e.message });
    }

    let child;
    try {
      // detached (own process group) so Cancel can kill the whole tree
      // (e.g. mvn's child JVM), not just the bash wrapper.
      child = spawn('/bin/bash', ['-c', cmd], {
        detached: true,
        stdio: ['ignore', logFd, logFd],
        env: { ...process.env, PATH: ENHANCED_PATH }
      });
    } catch (e) {
      try { fs.closeSync(logFd); } catch {}
      fs.appendFileSync(logPath, `\n── Build error: ${e.message} ──\n`);
      notify(`${service.name} failed to build`, e.message);
      return resolve({ ok: false, error: e.message });
    }

    runningBuilds.set(service.id, child);

    let settled = false;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      runningBuilds.delete(service.id);
      try { fs.closeSync(logFd); } catch {}
      resolve(result);
    };

    child.on('error', (err) => {
      fs.appendFileSync(logPath, `\n── Build error: ${err.message} ──\n`);
      notify(`${service.name} failed to build`, err.message);
      finish({ ok: false, error: err.message });
    });

    child.on('exit', (code, signal) => {
      if (code === 0) {
        fs.appendFileSync(logPath, `\n── Build succeeded ──\n`);
        finish({ ok: true });
      } else if (signal) {
        fs.appendFileSync(logPath, `\n── Build cancelled ──\n`);
        finish({ ok: false, cancelled: true, error: 'Build cancelled' });
      } else {
        const error = readLogTail(logPath, startOffset) || `exited with code ${code}`;
        fs.appendFileSync(logPath, `\n── Build FAILED (exit ${code}) ──\n`);
        notify(`${service.name} failed to build`, error);
        finish({ ok: false, error });
      }
    });
  });
}

// Kills an in-progress build's whole process group.
function cancelBuild(service) {
  const child = runningBuilds.get(service.id);
  if (!child) return false;
  try { process.kill(-child.pid, 'SIGTERM'); } catch { try { child.kill('SIGTERM'); } catch {} }
  return true;
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
    //    didn't fully terminate. Skipped for any docker-backed service (the
    //    port is held by Docker's long-lived port-forwarding helper, not the
    //    container itself — killing it would not stop the container and could
    //    disrupt Docker's port mapping). When processMatch is set, only kill
    //    the MATCHING process so we never accidentally stop a different
    //    service sharing the port.
    if (service.port && !service.dockerName) {
      const portPids = async () => (await runCommand(`lsof -ti tcp:${service.port} -sTCP:LISTEN 2>/dev/null || true`).catch(() => ''))
        .split('\n').map(s => s.trim()).filter(Boolean);
      const killOnPort = async (signal) => {
        const pids = await portPids();
        for (const pid of pids) {
          if (service.processMatch) {
            const cmd = await runCommand(`ps -p ${pid} -o command= 2>/dev/null || true`).catch(() => '');
            if (!cmd.includes(service.processMatch)) continue; // not ours — leave it alone
          }
          await runCommand(`kill ${signal} ${pid} 2>/dev/null || true`).catch(() => {});
        }
      };
      // Poll for the port to actually clear instead of blindly sleeping the
      // full timeout — this is what made "Stop" feel sluggish even when the
      // process died almost immediately.
      const waitUntilClear = async (maxMs) => {
        const start = Date.now();
        while (Date.now() - start < maxMs) {
          if ((await portPids()).length === 0) return true;
          await sleep(150);
        }
        return (await portPids()).length === 0;
      };
      await killOnPort('');            // SIGTERM (graceful)
      const clearedGracefully = await waitUntilClear(1500);
      if (!clearedGracefully) {
        await killOnPort('-9');        // SIGKILL fallback
        await waitUntilClear(500);
      }
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

  // Returns { serviceId: startEpochMs } for running services (from the OS process),
  // so the UI can show how long each has been running. Survives app reloads.
  ipcMain.handle('get-uptimes', async () => {
    const out = {};
    for (const cat of config.categories) {
      for (const svc of cat.services) {
        try {
          // Any service with a dockerName is backed by a container — use
          // `docker inspect` for its real start time regardless of checkType.
          // (checkType only controls how we detect up/down, e.g. some docker
          // services use checkType:'port' because the host port is what's
          // checked; but `lsof` on that port finds Docker's long-lived
          // port-forwarding helper process, not the container, so its PID
          // never changes across container restarts and the timer would
          // appear stuck.)
          if (svc.dockerName) {
            const started = await runCommand(`docker inspect -f '{{.State.StartedAt}}' ${svc.dockerName} 2>/dev/null || true`).catch(() => '');
            const t = Date.parse(started.trim());
            if (!isNaN(t)) out[svc.id] = t;
          } else if (svc.port) {
            const pids = (await runCommand(`lsof -ti tcp:${svc.port} -sTCP:LISTEN 2>/dev/null || true`).catch(() => ''))
              .split('\n').map(s => s.trim()).filter(Boolean);
            let pid = pids[0];
            if (svc.processMatch && pids.length) {
              for (const p of pids) {
                const cmd = await runCommand(`ps -p ${p} -o command= 2>/dev/null || true`).catch(() => '');
                if (cmd.includes(svc.processMatch)) { pid = p; break; }
              }
            }
            if (pid) {
              const lstart = (await runCommand(`ps -o lstart= -p ${pid} 2>/dev/null || true`).catch(() => '')).trim();
              const t = Date.parse(lstart);
              if (!isNaN(t)) out[svc.id] = t;
            }
          }
        } catch { /* ignore individual failures */ }
      }
    }
    return out;
  });

  ipcMain.handle('start-service', async (_, service, inputValue) => {
    return await withInFlightGuard(service.id, () => startService(service, inputValue));
  });

  ipcMain.handle('run-build', async (_, service) => {
    return await withInFlightGuard(service.id, () => runBuild(service));
  });

  ipcMain.handle('cancel-build', (_, service) => {
    return cancelBuild(service);
  });

  ipcMain.handle('stop-service', async (_, service) => {
    return await withInFlightGuard(service.id, () => stopService(service));
  });

  ipcMain.handle('restart-service', async (_, service) => {
    return await withInFlightGuard(service.id, async () => {
      await stopService(service);
      await new Promise(r => setTimeout(r, 500));
      return await startService(service);
    });
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

  // Show a native OS notification on request from the renderer (used for
  // crashed-process / start-failure alerts so they're visible when unfocused).
  ipcMain.handle('notify', (_, title, body) => {
    notify(title, body);
    return true;
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
      // Cap at last 500KB (was 50KB) — verbose builds/servers (e.g. mvn
      // output) can easily exceed the old cap, silently hiding earlier
      // output from the CURRENT run and making the log look incomplete.
      const MAX_LOG_CHARS = 500000;
      if (content.length > MAX_LOG_CHARS) return content.slice(-MAX_LOG_CHARS);
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
