// ── State ──
let config = null;
let statuses = {};
let currentView = null;
let pollTimer = null;
// Track services in loading state: svcId → { action: 'start'|'stop'|'restart', prevStatus: bool, startedAt: number }
const loadingServices = new Map();

// ── Loading spinner helper ──
function addLoadingDots(cardRoot) {
  const actions = cardRoot.querySelector('.card-actions');
  if (!actions || actions.querySelector('.card-spinner')) return;
  const spinner = document.createElement('div');
  spinner.className = 'card-spinner';
  actions.appendChild(spinner);
}

function removeLoadingDots(cardRoot) {
  const s = cardRoot.querySelector('.card-spinner');
  if (s) s.remove();
}

function setCardLoading(root, svcId, action) {
  const prevStatus = !!statuses[svcId];
  loadingServices.set(svcId, { action, prevStatus, startedAt: Date.now() });
  const dot = root.querySelector('.status-dot');
  const toggleBtn = root.querySelector('.toggle-btn');
  const restartBtn = root.querySelector('.restart-btn');
  const cancelBtn = root.querySelector('.cancel-btn');
  const editBtn = root.querySelector('.edit-svc-btn');
  if (dot) dot.className = 'status-dot loading';
  if (toggleBtn) toggleBtn.style.display = 'none';
  if (restartBtn) restartBtn.style.display = 'none';
  if (editBtn) editBtn.style.display = 'none';
  if (cancelBtn) cancelBtn.style.display = '';
  addLoadingDots(root);
}

// ── Init ──
async function init() {
  config = await window.api.getConfig();
  buildStarfield();
  applyAnimationSettings();
  applyThemeColor();
  statuses = await window.api.checkAll();
  renderSidebar();
  if (config.categories.length > 0) {
    navigateTo(config.categories[0].id);
  } else {
    navigateTo('settings');
  }
  startPolling();
}

// ── Decorative starfield (independent random twinkling + repositioning) ──
const STAR_COUNT = 26; // keep the original star quantity
function placeStar(s, setDur) {
  // Random position + size; stars are always white & circular.
  const size = (Math.random() * 1.4 + 0.9).toFixed(2);
  s.style.left = (Math.random() * 100).toFixed(2) + '%';
  s.style.top = (Math.random() * 100).toFixed(2) + '%';
  s.style.width = size + 'px';
  s.style.height = size + 'px';
  // Only set duration on creation — changing it mid-animation causes glitches.
  if (setDur) s.style.setProperty('--dur', (Math.random() * 4 + 3).toFixed(2) + 's');
}
function buildStarfield() {
  let sf = document.getElementById('starfield');
  if (!sf) {
    sf = document.createElement('div');
    sf.id = 'starfield';
    document.body.appendChild(sf);
  }
  sf.innerHTML = '';
  for (let i = 0; i < STAR_COUNT; i++) {
    const s = document.createElement('div');
    s.className = 'star';
    s.style.background = '#ffffff';
    placeStar(s, true);
    s.style.animationDelay = (-Math.random() * 6).toFixed(2) + 's';
    // When a star finishes a fade cycle (fully invisible at the boundary),
    // move it to a new random spot — but keep its duration so timing is smooth.
    s.addEventListener('animationiteration', () => placeStar(s, false));
    sf.appendChild(s);
  }
}

function applyAnimationSettings() {
  const enabled = config.settings?.animationsEnabled !== false; // default ON
  const speed = config.settings?.animationSpeed ?? 1;
  document.documentElement.style.setProperty('--anim-speed', speed);
  const sf = document.getElementById('starfield');
  if (sf) sf.classList.toggle('paused', !enabled);
}

// ── App theme color (the accent hue; defaults to purple) ──
const DEFAULT_THEME = "#a78bfa";
function applyThemeColor() {
  const hex = config.settings?.themeColor || DEFAULT_THEME;
  const m = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(hex);
  if (!m) return;
  const r = parseInt(m[1],16), g = parseInt(m[2],16), b = parseInt(m[3],16);
  const root = document.documentElement.style;
  root.setProperty('--purple', hex);
  root.setProperty('--accent', hex);
  root.setProperty('--purple-dim', `rgba(${r}, ${g}, ${b}, 0.08)`);
  root.setProperty('--border', `rgba(${r}, ${g}, ${b}, 0.2)`);
  root.setProperty('--border-accent', `rgba(${r}, ${g}, ${b}, 0.5)`);
  root.setProperty('--bg-hover', `rgba(${r}, ${g}, ${b}, 0.06)`);
}

// ── Emoji picker popup (for category icon fields) ──
const EMOJI_CHOICES = ['🚀','⚡','🗄️','🔧','🛠️','📦','🐳','☕','🟢','🔵','🟣','🌐','🔌','🗃️','💾','📊','📈','🧪','🔬','🔥','✨','⭐','🌟','🏷️','🎯','🧩','🛰️','🪐','🌙','☁️','🔒','🔑','🧠','🤖','📡','🖥️','💻','⚙️','📁','📂','🔗','🟡','🔴','🩺','📨','📬','🧾','🗂️','🎛️','🧰'];
let _activeEmojiPicker = null;
function closeEmojiPicker() {
  if (_activeEmojiPicker) { _activeEmojiPicker.remove(); _activeEmojiPicker = null; }
}
function attachEmojiPicker(inputEl) {
  if (!inputEl) return;
  inputEl.readOnly = true;
  inputEl.style.cursor = 'pointer';
  inputEl.addEventListener('click', (e) => {
    e.stopPropagation();
    if (_activeEmojiPicker) { closeEmojiPicker(); return; }
    const picker = document.createElement('div');
    picker.className = 'emoji-picker';
    EMOJI_CHOICES.forEach(em => {
      const b = document.createElement('button');
      b.type = 'button';
      b.textContent = em;
      b.addEventListener('click', (ev) => {
        ev.stopPropagation();
        inputEl.value = em;
        inputEl.dispatchEvent(new Event('input', { bubbles: true }));
        closeEmojiPicker();
      });
      picker.appendChild(b);
    });
    // Custom emoji input — lets the user type/paste any emoji not in the grid.
    const custom = document.createElement('input');
    custom.type = 'text';
    custom.className = 'emoji-custom';
    custom.placeholder = 'Custom… (paste any emoji)';
    custom.maxLength = 4;
    custom.addEventListener('click', (ev) => ev.stopPropagation());
    custom.addEventListener('keydown', (ev) => {
      ev.stopPropagation();
      if (ev.key === 'Enter' && custom.value.trim()) {
        inputEl.value = custom.value.trim();
        inputEl.dispatchEvent(new Event('input', { bubbles: true }));
        closeEmojiPicker();
      }
    });
    custom.addEventListener('input', (ev) => {
      if (custom.value.trim()) {
        inputEl.value = custom.value.trim();
        inputEl.dispatchEvent(new Event('input', { bubbles: true }));
      }
    });
    picker.appendChild(custom);
    document.body.appendChild(picker);
    const r = inputEl.getBoundingClientRect();
    picker.style.left = Math.min(r.left, window.innerWidth - 290) + 'px';
    picker.style.top = (r.bottom + 4) + 'px';
    _activeEmojiPicker = picker;
  });
}
document.addEventListener('click', () => closeEmojiPicker());

// ── Polling ──
let prevStatuses = {};
function startPolling() {
  if (pollTimer) clearInterval(pollTimer);
  const interval = config.settings?.pollInterval || 5000;
  pollTimer = setInterval(async () => {
    const oldStatuses = { ...statuses };
    statuses = await window.api.checkAll();

    // If any requiresInput service changed state, re-render to reset inputMode
    let needsRefresh = false;
    for (const cat of config.categories) {
      for (const svc of cat.services) {
        if (svc.requiresInput && !!oldStatuses[svc.id] !== !!statuses[svc.id] && !loadingServices.has(svc.id)) {
          needsRefresh = true;
        }
      }
    }
    if (needsRefresh) {
      refreshCurrentView();
    }

    updateStatusDots();
    updateNavCounts();
  }, interval);
}

// ── Sidebar ──
function renderSidebar() {
  const nav = document.getElementById('nav-items');
  nav.innerHTML = '';

  config.categories.forEach(cat => {
    const btn = document.createElement('button');
    btn.className = 'nav-btn';
    btn.dataset.catId = cat.id;
    btn.innerHTML = `
      <span class="nav-icon">${cat.icon}</span>
      <span class="nav-label">${cat.name}</span>
      <span class="nav-count" data-count-id="${cat.id}"></span>
    `;
    btn.addEventListener('click', () => navigateTo(cat.id));
    nav.appendChild(btn);
  });

  updateNavCounts();

  // Re-bind footer buttons (they persist, just re-attach listeners)
  const stopBtn = document.getElementById('btn-stop-all');
  const settingsBtn = document.getElementById('btn-settings');
  
  stopBtn.replaceWith(stopBtn.cloneNode(true));
  settingsBtn.replaceWith(settingsBtn.cloneNode(true));
  
  document.getElementById('btn-stop-all').addEventListener('click', async () => {
    if (!confirm('Stop all running services?')) return;
    await window.api.stopAll();
    statuses = await window.api.checkAll();
    updateStatusDots();
    updateNavCounts();
    showToast('All services stopped', 'success');
  });

  document.getElementById('btn-settings').addEventListener('click', () => navigateTo('settings'));

  // Add Category button in sidebar
  const addCatBtn = document.getElementById('btn-add-category');
  addCatBtn.replaceWith(addCatBtn.cloneNode(true));
  document.getElementById('btn-add-category').addEventListener('click', () => showCategoryForm(null));
}

function updateNavCounts() {
  config.categories.forEach(cat => {
    const el = document.querySelector(`[data-count-id="${cat.id}"]`);
    if (!el) return;
    const realServices = cat.services.filter(s => s.type !== 'shortcut');
    const total = realServices.length;
    if (total === 0) { el.textContent = ''; return; }
    const running = realServices.filter(s => statuses[s.id]).length;
    el.textContent = `${running}/${total}`;
    el.className = 'nav-count';
    if (running === total && total > 0) el.classList.add('all-running');
    else if (running > 0) el.classList.add('some-running');
  });
}

// ── Navigation ──
function navigateTo(viewId) {
  currentView = viewId;
  document.querySelectorAll('.nav-btn').forEach(b => b.classList.remove('active'));
  const activeBtn = document.querySelector(`[data-cat-id="${viewId}"]`);
  if (activeBtn) activeBtn.classList.add('active');

  const settingsBtn = document.getElementById('btn-settings');
  settingsBtn.classList.toggle('active', viewId === 'settings');

  if (viewId === 'settings') {
    renderSettings();
  } else {
    const cat = config.categories.find(c => c.id === viewId);
    if (cat) renderCategory(cat);
  }
}

// ── Category View ──
function renderCategory(cat) {
  const tmpl = document.getElementById('tmpl-category');
  const view = tmpl.content.cloneNode(true);
  const root = view.querySelector('.category-view');

  const titleEl = view.querySelector('.category-title');
  const countEl = view.querySelector('.category-count');
  const editBtn = view.querySelector('.btn-edit-cat');
  const inlineRename = view.querySelector('.inline-rename');
  const renameInput = view.querySelector('.rename-input');
  const renameIcon = view.querySelector('.rename-icon');
  attachEmojiPicker(renameIcon);

  titleEl.textContent = `${cat.icon} ${cat.name}`;
  const realServices = cat.services.filter(s => s.type !== 'shortcut');
  const running = realServices.filter(s => statuses[s.id]).length;
  countEl.textContent = `${running}/${realServices.length} running`;

  // ✎ toggles edit mode
  editBtn.addEventListener('click', () => {
    const isEditing = root.classList.toggle('edit-mode');
    if (isEditing) {
      titleEl.style.display = 'none';
      countEl.style.display = 'none';
      inlineRename.style.display = 'flex';
      renameInput.value = cat.name;
      renameIcon.value = cat.icon;
      renameInput.focus();
      editBtn.textContent = '✕';
      editBtn.title = 'Cancel edit';
    } else {
      titleEl.style.display = '';
      countEl.style.display = '';
      inlineRename.style.display = 'none';
      editBtn.textContent = '✎';
      editBtn.title = 'Edit';
    }
  });

  // Save rename
  view.querySelector('.rename-save').addEventListener('click', async () => {
    const name = renameInput.value.trim();
    const icon = renameIcon.value.trim() || '📁';
    if (!name) return;
    cat.name = name;
    cat.icon = icon;
    await window.api.saveConfig(config);
    renderSidebar();
    renderCategory(cat);
    showToast('Category updated', 'success');
  });

  // Delete
  view.querySelector('.rename-delete').addEventListener('click', async () => {
    if (!confirm(`Delete "${cat.name}" and all its services?`)) return;
    config.categories = config.categories.filter(c => c.id !== cat.id);
    await window.api.saveConfig(config);
    renderSidebar();
    if (config.categories.length > 0) navigateTo(config.categories[0].id);
    else navigateTo('settings');
    showToast('Category deleted', 'success');
  });

  const grid = view.querySelector('.service-grid');
  // Render services and shortcuts
  cat.services.forEach(svc => {
    let cardEl;
    if (svc.type === 'shortcut') {
      cardEl = createShortcutCard(svc, cat);
    } else {
      cardEl = createServiceCard(svc, cat);
    }
    grid.appendChild(cardEl);
  });

  // ── Drag & drop reorder ──
  let draggedEl = null;
  grid.addEventListener('dragstart', (e) => {
    const card = e.target.closest('.service-card, .shortcut-card');
    if (!card) return;
    draggedEl = card;
    card.classList.add('dragging');
    e.dataTransfer.effectAllowed = 'move';
    // Delay so the drag image shows the card, not the dragging class
    requestAnimationFrame(() => card.style.opacity = '0.4');
  });

  grid.addEventListener('dragend', (e) => {
    if (draggedEl) {
      draggedEl.classList.remove('dragging');
      draggedEl.style.opacity = '';
      draggedEl = null;
    }
    // Remove all drop indicators
    grid.querySelectorAll('.drag-over').forEach(el => el.classList.remove('drag-over'));
  });

  grid.addEventListener('dragover', (e) => {
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    const target = e.target.closest('.service-card, .shortcut-card');
    // Clear previous indicators
    grid.querySelectorAll('.drag-over').forEach(el => el.classList.remove('drag-over'));
    if (target && target !== draggedEl) {
      target.classList.add('drag-over');
    }
  });

  grid.addEventListener('dragleave', (e) => {
    const target = e.target.closest('.service-card, .shortcut-card');
    if (target) target.classList.remove('drag-over');
  });

  grid.addEventListener('drop', async (e) => {
    e.preventDefault();
    const target = e.target.closest('.service-card, .shortcut-card');
    if (!target || !draggedEl || target === draggedEl) return;

    const cards = [...grid.querySelectorAll('.service-card, .shortcut-card')];
    const fromIdx = cards.indexOf(draggedEl);
    const toIdx = cards.indexOf(target);
    if (fromIdx < 0 || toIdx < 0) return;

    // Reorder in config
    const [moved] = cat.services.splice(fromIdx, 1);
    cat.services.splice(toIdx, 0, moved);
    await window.api.saveConfig(config);

    // Re-render
    renderCategory(cat);
  });

  if (cat.services.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'empty-state';
    empty.innerHTML = '<p>No services yet.</p><p style="font-size:12px;color:var(--text-dark)">Click "+ Add" below to get started</p>';
    grid.appendChild(empty);
  }

  // Add menu (Service / Shortcut)
  const addBtn = view.querySelector('.btn-add-item');
  const addMenu = view.querySelector('.add-menu');

  addBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    const showing = addMenu.style.display !== 'none';
    addMenu.style.display = showing ? 'none' : '';
  });

  // Close menu on any click outside
  document.addEventListener('click', (e) => {
    if (!addBtn.contains(e.target) && !addMenu.contains(e.target)) {
      addMenu.style.display = 'none';
    }
  });

  view.querySelectorAll('.add-menu-opt').forEach(opt => {
    opt.addEventListener('click', () => {
      addMenu.style.display = 'none';
      if (opt.dataset.type === 'service') showServiceForm(cat, null);
      else if (opt.dataset.type === 'shortcut') showShortcutForm(cat, null);
    });
  });

  const content = document.getElementById('content');
  content.innerHTML = '';
  content.appendChild(view);
}

// ── Service links (supports multiple; backward-compatible with single `url`) ──
function getServiceLinks(svc) {
  if (Array.isArray(svc.links) && svc.links.length) {
    return svc.links
      .filter(l => l && l.url)
      .map(l => ({ label: (l.label && l.label.trim()) || l.url, url: l.url }));
  }
  if (svc.url) return [{ label: svc.url, url: svc.url }];
  return [];
}

function renderServiceLinks(container, svc, isRunning) {
  if (!container) return;
  container.innerHTML = '';
  const links = getServiceLinks(svc);
  if (!isRunning || links.length === 0) {
    container.style.display = 'none';
    return;
  }
  container.style.display = '';
  links.forEach(l => {
    const a = document.createElement('a');
    a.className = 'service-url';
    a.href = '#';
    a.textContent = l.label;
    a.title = l.url;
    a.addEventListener('click', (e) => {
      e.preventDefault();
      window.api.openUrl(l.url);
    });
    container.appendChild(a);
  });
}

// Apply a service's custom "running" hue (defaults to green) via CSS vars.
function applyRunningColor(root, svc) {
  const color = svc.runningColor;
  if (color) {
    root.style.setProperty('--run-color', color);
    root.style.setProperty('--run-color-glow', hexToGlow(color));
  } else {
    root.style.removeProperty('--run-color');
    root.style.removeProperty('--run-color-glow');
  }
}
function hexToGlow(hex) {
  const m = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(hex || '');
  if (!m) return 'rgba(74, 222, 128, 0.6)';
  const r = parseInt(m[1], 16), g = parseInt(m[2], 16), b = parseInt(m[3], 16);
  return `rgba(${r}, ${g}, ${b}, 0.6)`;
}

function createServiceCard(svc, cat) {
  const tmpl = document.getElementById('tmpl-service-card');
  const card = tmpl.content.cloneNode(true);
  const root = card.querySelector('.service-card');
  root.draggable = true;

  const isRunning = statuses[svc.id];
  root.classList.add(isRunning ? 'running' : 'stopped');
  root.dataset.serviceId = svc.id;
  applyRunningColor(root, svc);

  const dot = card.querySelector('.status-dot');
  dot.classList.add(isRunning ? 'running' : 'stopped');

  card.querySelector('.service-name').textContent = svc.name;
  card.querySelector('.service-desc').textContent = svc.description;

  // Copy the full WORKING terminal command (with {{flag}} resolved) to clipboard
  const copyBtn = card.querySelector('.copy-cmd-btn');
  if (copyBtn && svc.startCommand) {
    copyBtn.style.display = '';
    copyBtn.addEventListener('click', async (e) => {
      e.stopPropagation();
      let cmd = await window.api.resolveCommand(svc);
      cmd = (cmd || '').replace(/\s*&\s*$/, '').trim(); // drop trailing & so it runs in foreground
      await window.api.copyText(cmd);
      showToast(`Copied ${svc.name} command`, 'info');
    });
  }

  // Click card info area to open log viewer
  const infoEl = card.querySelector('.card-info');
  infoEl.style.cursor = 'pointer';
  infoEl.addEventListener('click', () => openLogViewer(svc));

  const toggleBtn = card.querySelector('.toggle-btn');
  const restartBtn = card.querySelector('.restart-btn');
  const cancelBtn = card.querySelector('.cancel-btn');
  const editBtn = card.querySelector('.edit-svc-btn');
  const inlineInput = card.querySelector('.inline-input');

  // Flag toggle dropdown — lets you pick which value gets substituted for
  // {{flag}} in the start command (e.g. a Spring profile).
  const flagSelect = card.querySelector('.flag-select');
  if (flagSelect) {
    if (Array.isArray(svc.flagOptions) && svc.flagOptions.length) {
      flagSelect.innerHTML = '';
      svc.flagOptions.forEach(opt => {
        const o = document.createElement('option');
        o.value = opt.value;
        o.textContent = opt.label || opt.value;
        flagSelect.appendChild(o);
      });
      flagSelect.value = svc.flag || svc.flagOptions[0].value;
      flagSelect.style.display = '';
      flagSelect.addEventListener('click', (e) => e.stopPropagation());
      flagSelect.addEventListener('change', async () => {
        const liveSvc = findService(svc.id) || svc;
        liveSvc.flag = flagSelect.value;
        svc.flag = flagSelect.value;
        await window.api.saveConfig(config);
        showToast(`${svc.name}: flag set to "${flagSelect.value}"`, 'success');
      });
    } else {
      flagSelect.style.display = 'none';
    }
  }

  if (isRunning) {
    toggleBtn.textContent = 'Stop';
    toggleBtn.classList.add('stop');
    restartBtn.style.display = '';
  } else {
    toggleBtn.textContent = 'Start';
    toggleBtn.classList.add('start');
    restartBtn.style.display = 'none';
  }

  // If this service is still loading, show spinner and hide buttons
  if (loadingServices.has(svc.id)) {
    setCardLoading(root, svc.id, loadingServices.get(svc.id).action);
  }

  // Cancel button — stops the service and clears loading state
  cancelBtn.addEventListener('click', async () => {
    loadingServices.delete(svc.id);
    await window.api.stopService(svc);
    showToast(`${svc.name} cancelled`, 'success');
    statuses = await window.api.checkAll();
    updateStatusDots();
    updateNavCounts();
  });

  // Edit service button
  editBtn.addEventListener('click', () => showServiceForm(cat, svc));

  // Restart button
  restartBtn.addEventListener('click', async () => {
    setCardLoading(root, svc.id, 'restart');
    showToast(`${svc.name} restarting...`, 'success');
    await window.api.restartService(svc);
  });

  // Track whether we're in "input mode" for requiresInput services
  let inputMode = false;

  toggleBtn.addEventListener('click', async () => {
    const liveRunning = !!statuses[svc.id];

    if (liveRunning) {
      // Reset inputMode when stopping so it prompts again on next start
      inputMode = false;
      inlineInput.style.display = 'none';
      inlineInput.value = '';
      setCardLoading(root, svc.id, 'stop');
      await window.api.stopService(svc);
      showToast(`${svc.name} stopping...`, 'success');
      return;
    }

    if (svc.requiresInput && !inputMode) {
      inputMode = true;
      inlineInput.style.display = '';
      inlineInput.placeholder = svc.inputLabel || 'Input';
      inlineInput.focus();
      toggleBtn.textContent = 'Connect';
      return;
    }

    const inputVal = svc.requiresInput ? inlineInput.value.trim() : null;
    
    if (svc.requiresInput && !inputVal) {
      inlineInput.focus();
      return;
    }

    inlineInput.style.display = 'none';
    setCardLoading(root, svc.id, 'start');

    if (inputVal) {
      await window.api.startService(svc, inputVal);
    } else {
      await window.api.startService(svc);
    }
    showToast(`${svc.name} starting...`, 'success');
  });

  // Enter key submits for requiresInput services
  inlineInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') toggleBtn.click();
  });

  // URL(s)
  const urlsEl = card.querySelector('.service-urls');
  renderServiceLinks(urlsEl, svc, isRunning);

  return card;
}

function updateStatusDots() {
  document.querySelectorAll('.service-card').forEach(card => {
    const id = card.dataset.serviceId;
    if (!id) return;

    // Skip shortcut cards — they get fully re-rendered on refresh
    if (card.classList.contains('shortcut-card')) return;

    const isRunning = statuses[id];

    // If service is loading, check if status has changed from before the action
    if (loadingServices.has(id)) {
      const info = loadingServices.get(id);
      const statusChanged = (info.action === 'start' && isRunning) ||
                            (info.action === 'stop' && !isRunning) ||
                            (info.action === 'restart' && isRunning);
      const timeoutSec = config.settings?.startTimeout ?? 90;
      const timedOut = timeoutSec > 0 && (Date.now() - info.startedAt > timeoutSec * 1000);
      if (!statusChanged && !timedOut) {
        // Still loading — keep spinner, don't touch buttons
        const dot = card.querySelector('.status-dot');
        if (dot) dot.className = 'status-dot loading';
        return;
      }
      // Status resolved or timed out — clear loading
      loadingServices.delete(id);
    }

    card.className = `service-card ${isRunning ? 'running' : 'stopped'}`;
    const svcForColor = findService(id);
    if (svcForColor) applyRunningColor(card, svcForColor);
    const dot = card.querySelector('.status-dot');
    if (dot) dot.className = `status-dot ${isRunning ? 'running' : 'stopped'}`;

    const btn = card.querySelector('.toggle-btn');
    if (btn) {
      btn.textContent = isRunning ? 'Stop' : 'Start';
      btn.className = `toggle-btn ${isRunning ? 'stop' : 'start'}`;
      btn.style.display = '';
    }

    // Remove spinner once status resolves
    const sp = card.querySelector('.card-spinner');
    if (sp) sp.remove();

    // Restore cancel and edit button visibility
    const cancelBtn = card.querySelector('.cancel-btn');
    if (cancelBtn) cancelBtn.style.display = 'none';
    const editBtn = card.querySelector('.edit-svc-btn');
    if (editBtn) editBtn.style.display = '';

    const restart = card.querySelector('.restart-btn');
    if (restart) restart.style.display = isRunning ? '' : 'none';

    const urlsEl = card.querySelector('.service-urls');
    const svc = findService(id);
    if (urlsEl && svc) {
      renderServiceLinks(urlsEl, svc, isRunning);
    }
  });

  if (currentView && currentView !== 'settings') {
    const cat = config.categories.find(c => c.id === currentView);
    if (cat) {
      const countEl = document.querySelector('.category-count');
      if (countEl) {
        const realSvcs = cat.services.filter(s => s.type !== 'shortcut');
        const running = realSvcs.filter(s => statuses[s.id]).length;
        countEl.textContent = `${running}/${realSvcs.length} running`;
      }
    }
  }
}

function refreshCurrentView() {
  if (currentView && currentView !== 'settings') {
    const cat = config.categories.find(c => c.id === currentView);
    if (cat) renderCategory(cat);
  }
  updateNavCounts();
}

function findService(id) {
  for (const cat of config.categories) {
    const svc = cat.services.find(s => s.id === id);
    if (svc) return svc;
  }
  return null;
}

// ── Shortcut Card ──
function createShortcutCard(shortcut, cat) {
  const tmpl = document.getElementById('tmpl-shortcut-card');
  const card = tmpl.content.cloneNode(true);
  const root = card.querySelector('.service-card');
  root.dataset.serviceId = shortcut.id;
  root.draggable = true;

  const linked = (shortcut.linkedServiceIds || []).map(id => findService(id)).filter(Boolean);
  const runningCount = linked.filter(s => statuses[s.id]).length;
  const allRunning = linked.length > 0 && runningCount === linked.length;
  const someRunning = runningCount > 0;

  root.classList.add(allRunning ? 'running' : 'stopped');

  card.querySelector('.service-name').textContent = shortcut.name;
  card.querySelector('.shortcut-status').textContent =
    linked.length === 0 ? 'No services linked' : `${runningCount}/${linked.length} running`;

  // Service tags
  const tagsEl = card.querySelector('.shortcut-services');
  if (linked.length === 0) {
    tagsEl.style.display = 'none';
  } else {
    linked.forEach(svc => {
      const tag = document.createElement('span');
      tag.className = 'shortcut-svc-tag';
      const isOn = statuses[svc.id];
      const inputIcon = svc.requiresInput ? ' 🔑' : '';
      tag.innerHTML = `<span class="tag-dot ${isOn ? 'on' : 'off'}"></span>${svc.name}${inputIcon}`;
      tagsEl.appendChild(tag);
    });
  }

  const toggleBtn = card.querySelector('.toggle-btn');
  const editBtn = card.querySelector('.edit-svc-btn');

  if (someRunning) {
    toggleBtn.textContent = 'Stop All';
    toggleBtn.classList.add('stop');
  } else {
    toggleBtn.textContent = 'Start All';
    toggleBtn.classList.add('start');
  }

  editBtn.addEventListener('click', () => showShortcutForm(cat, shortcut));

  toggleBtn.addEventListener('click', async () => {
    toggleBtn.style.display = 'none';
    addLoadingDots(root);
    if (someRunning) {
      for (const svc of linked) {
        if (statuses[svc.id]) {
          loadingServices.set(svc.id, { action: 'stop', prevStatus: true, startedAt: Date.now() });
          await window.api.stopService(svc);
        }
      }
      showToast(`${shortcut.name} — stopping services`, 'success');
    } else {
      const skipped = [];
      for (const svc of linked) {
        if (statuses[svc.id]) continue;
        if (svc.requiresInput) {
          skipped.push(svc.name);
          continue;
        }
        loadingServices.set(svc.id, { action: 'start', prevStatus: false, startedAt: Date.now() });
        await window.api.startService(svc);
      }
      if (skipped.length > 0) {
        showToast(`${skipped.join(', ')} need manual input — start separately`, 'error');
      } else {
        showToast(`${shortcut.name} — starting services`, 'success');
      }
    }
  });

  return card;
}

// ── Shortcut Form ──
function showShortcutForm(cat, existing) {
  const tmpl = document.getElementById('tmpl-shortcut-form');
  const form = tmpl.content.cloneNode(true);
  const root = form.querySelector('.command-form');

  const selectedIds = new Set(existing?.linkedServiceIds || []);

  if (existing) {
    root.querySelector('.shortcut-name').value = existing.name;
    root.querySelector('.shortcut-desc').value = existing.description || '';
    root.querySelector('.btn-delete').style.display = 'block';
  }

  // Build service checklist grouped by category
  const listEl = root.querySelector('.shortcut-service-list');

  // Search bar
  const searchWrap = document.createElement('div');
  searchWrap.className = 'shortcut-search-wrap';
  searchWrap.innerHTML = '<input type="text" class="shortcut-search" placeholder="🔍 Search services...">';
  listEl.parentNode.insertBefore(searchWrap, listEl);

  const searchInput = searchWrap.querySelector('.shortcut-search');
  searchInput.addEventListener('input', () => {
    const q = searchInput.value.toLowerCase();
    listEl.querySelectorAll('.shortcut-check-row').forEach(row => {
      const name = row.querySelector('label').textContent.toLowerCase();
      row.style.display = name.includes(q) ? '' : 'none';
    });
    listEl.querySelectorAll('.shortcut-group-label').forEach(label => {
      let next = label.nextElementSibling;
      let anyVisible = false;
      while (next && !next.classList.contains('shortcut-group-label')) {
        if (next.style.display !== 'none') anyVisible = true;
        next = next.nextElementSibling;
      }
      label.style.display = anyVisible ? '' : 'none';
    });
  });

  config.categories.forEach(c => {
    const realServices = c.services.filter(s => s.type !== 'shortcut');
    if (realServices.length === 0) return;

    const label = document.createElement('div');
    label.className = 'shortcut-group-label';
    label.textContent = `${c.icon} ${c.name}`;
    listEl.appendChild(label);

    realServices.forEach(svc => {
      const row = document.createElement('div');
      row.className = 'shortcut-check-row';
      row.innerHTML = `
        <input type="checkbox" id="sc-${svc.id}" value="${svc.id}" ${selectedIds.has(svc.id) ? 'checked' : ''}>
        <label for="sc-${svc.id}">${svc.name}</label>
      `;
      row.addEventListener('click', (e) => {
        if (e.target.tagName !== 'INPUT') {
          const cb = row.querySelector('input');
          cb.checked = !cb.checked;
        }
      });
      listEl.appendChild(row);
    });
  });

  root.querySelector('.btn-save').addEventListener('click', async () => {
    const name = root.querySelector('.shortcut-name').value.trim();
    const desc = root.querySelector('.shortcut-desc').value.trim();
    if (!name) { showToast('Name is required', 'error'); return; }

    const checkedIds = [...root.querySelectorAll('.shortcut-service-list input:checked')]
      .map(cb => cb.value);

    if (checkedIds.length === 0) { showToast('Select at least one service', 'error'); return; }

    const shortcut = {
      id: existing?.id || 'shortcut-' + Date.now(),
      type: 'shortcut',
      name,
      description: desc,
      linkedServiceIds: checkedIds
    };

    if (existing) {
      const idx = cat.services.findIndex(s => s.id === existing.id);
      if (idx >= 0) cat.services[idx] = shortcut;
    } else {
      cat.services.push(shortcut);
    }

    await window.api.saveConfig(config);
    renderSidebar();
    navigateTo(cat.id);
    showToast(existing ? 'Shortcut updated' : 'Shortcut added', 'success');
  });

  root.querySelector('.btn-cancel').addEventListener('click', () => navigateTo(cat.id));

  root.querySelector('.btn-delete').addEventListener('click', async () => {
    if (!confirm(`Delete shortcut "${existing.name}"?`)) return;
    cat.services = cat.services.filter(s => s.id !== existing.id);
    await window.api.saveConfig(config);
    renderSidebar();
    navigateTo(cat.id);
    showToast('Shortcut deleted', 'success');
  });

  const content = document.getElementById('content');
  content.innerHTML = '';
  content.appendChild(form);
}

// ── Settings View ──
async function renderSettings() {
  const tmpl = document.getElementById('tmpl-settings');
  const view = tmpl.content.cloneNode(true);

  // Poll interval
  const select = view.querySelector('#poll-interval');
  select.value = config.settings?.pollInterval || 5000;
  select.addEventListener('change', async () => {
    config.settings.pollInterval = parseInt(select.value);
    await window.api.saveConfig(config);
    startPolling();
    showToast('Poll interval updated', 'success');
  });

  // Start timeout
  const timeoutSelect = view.querySelector('#start-timeout');
  timeoutSelect.value = config.settings?.startTimeout ?? 90;
  timeoutSelect.addEventListener('change', async () => {
    config.settings.startTimeout = parseInt(timeoutSelect.value);
    await window.api.saveConfig(config);
    showToast('Start timeout updated', 'success');
  });

  // Animations toggle
  const animToggle = view.querySelector('#anim-toggle');
  const animSpeed = view.querySelector('#anim-speed');
  const animSpeedVal = view.querySelector('#anim-speed-val');
  const animSpeedRow = view.querySelector('#anim-speed-row');
  const animEnabled = config.settings?.animationsEnabled !== false;
  const speedVal = config.settings?.animationSpeed ?? 1;
  animToggle.checked = animEnabled;
  animSpeed.value = speedVal;
  animSpeedVal.textContent = Number(speedVal).toFixed(2).replace(/0$/, '') + '×';
  animSpeedRow.style.opacity = animEnabled ? '1' : '0.4';

  animToggle.addEventListener('change', async () => {
    config.settings.animationsEnabled = animToggle.checked;
    animSpeedRow.style.opacity = animToggle.checked ? '1' : '0.4';
    await window.api.saveConfig(config);
    applyAnimationSettings();
  });
  animSpeed.addEventListener('input', () => {
    animSpeedVal.textContent = Number(animSpeed.value).toFixed(2).replace(/0$/, '') + '×';
    document.documentElement.style.setProperty('--anim-speed', animSpeed.value);
  });
  animSpeed.addEventListener('change', async () => {
    config.settings.animationSpeed = parseFloat(animSpeed.value);
    await window.api.saveConfig(config);
    applyAnimationSettings();
  });

  // Theme color
  const themeColor = view.querySelector('#theme-color');
  const currentTheme = config.settings?.themeColor || '#a78bfa';
  themeColor.value = currentTheme;
  const markActiveSwatch = (hex) => {
    view.querySelectorAll('.theme-swatch').forEach(s => {
      s.classList.toggle('active', (s.dataset.color || '').toLowerCase() === (hex || '').toLowerCase());
    });
  };
  markActiveSwatch(currentTheme);
  const setTheme = async (hex) => {
    config.settings.themeColor = hex;
    themeColor.value = hex;
    markActiveSwatch(hex);
    applyThemeColor();
    await window.api.saveConfig(config);
  };
  view.querySelectorAll('.theme-swatch').forEach(s => {
    s.addEventListener('click', () => setTheme(s.dataset.color));
  });
  themeColor.addEventListener('input', () => { config.settings.themeColor = themeColor.value; applyThemeColor(); markActiveSwatch(themeColor.value); });
  themeColor.addEventListener('change', () => setTheme(themeColor.value));

  // Config file path
  const configPath = await window.api.getConfigPath();
  view.querySelector('#config-path').textContent = configPath;
  view.querySelector('#btn-open-config').addEventListener('click', () => {
    window.api.openConfigFile();
  });

  // Refresh button
  view.querySelector('#btn-refresh').addEventListener('click', () => {
    window.api.reloadApp();
  });

  // Reset button
  view.querySelector('#btn-reset').addEventListener('click', async () => {
    if (!confirm('Reset all settings, categories, and services?')) return;
    config = await window.api.resetConfig();
    statuses = await window.api.checkAll();
    renderSidebar();
    navigateTo('settings');
    showToast('Reset to defaults', 'success');
  });

  const content = document.getElementById('content');
  content.innerHTML = '';
  content.appendChild(view);
}

// ── Category Form (add new only — editing is inline) ──
function showCategoryForm() {
  const tmpl = document.getElementById('tmpl-category-form');
  const form = tmpl.content.cloneNode(true);
  const root = form.querySelector('.command-form');

  attachEmojiPicker(root.querySelector('.cat-icon'));

  root.querySelector('.btn-save').addEventListener('click', async () => {
    const name = root.querySelector('.cat-name').value.trim();
    const icon = root.querySelector('.cat-icon').value.trim() || '📁';
    if (!name) { showToast('Name is required', 'error'); return; }

    const newCat = {
      id: name.toLowerCase().replace(/\s+/g, '-') + '-' + Date.now(),
      name,
      icon,
      services: []
    };
    config.categories.push(newCat);
    await window.api.saveConfig(config);
    renderSidebar();
    navigateTo(newCat.id);
    showToast('Category added', 'success');
  });

  root.querySelector('.btn-cancel').addEventListener('click', () => {
    if (config.categories.length > 0) navigateTo(config.categories[0].id);
    else navigateTo('settings');
  });

  const content = document.getElementById('content');
  content.innerHTML = '';
  content.appendChild(form);
}

// ── Service Form (add/edit within a category) ──
function showServiceForm(cat, existingSvc) {
  const tmpl = document.getElementById('tmpl-command-form');
  const form = tmpl.content.cloneNode(true);
  const root = form.querySelector('.command-form');

  if (existingSvc) {
    root.querySelector('.cmd-name').value = existingSvc.name;
    root.querySelector('.cmd-desc').value = existingSvc.description;
    root.querySelector('.cmd-port').value = existingSvc.port || '';
    root.querySelector('.cmd-process-match').value = existingSvc.processMatch || '';
    root.querySelector('.cmd-running-color').value = existingSvc.runningColor || '#4ade80';
    root.querySelector('.cmd-start').value = existingSvc.startCommand || '';
    root.querySelector('.cmd-stop').value = existingSvc.stopCommand || '';
    root.querySelector('.cmd-requires-input').checked = existingSvc.requiresInput || false;
    root.querySelector('.cmd-input-label').value = existingSvc.inputLabel || '';
    if (existingSvc.requiresInput) {
      root.querySelector('.cmd-input-label-row').style.display = '';
    }
    root.querySelector('.btn-delete').style.display = 'block';
  }

  // Running-color reset button
  const colorInput = root.querySelector('.cmd-running-color');
  root.querySelector('.btn-reset-color').addEventListener('click', () => {
    colorInput.value = '#4ade80';
  });

  // ── Links editor (supports multiple links) ──
  const linksContainer = root.querySelector('.cmd-links');
  function addLinkRow(label = '', url = '') {
    const row = document.createElement('div');
    row.className = 'cmd-link-row';
    const labelInput = document.createElement('input');
    labelInput.type = 'text';
    labelInput.className = 'cmd-link-label';
    labelInput.placeholder = 'Label (optional)';
    labelInput.value = label;
    const urlInput = document.createElement('input');
    urlInput.type = 'text';
    urlInput.className = 'cmd-link-url';
    urlInput.placeholder = 'http://localhost:3000';
    urlInput.value = url;
    const removeBtn = document.createElement('button');
    removeBtn.type = 'button';
    removeBtn.className = 'btn-remove-link';
    removeBtn.title = 'Remove link';
    removeBtn.textContent = '✕';
    removeBtn.addEventListener('click', () => row.remove());
    row.appendChild(labelInput);
    row.appendChild(urlInput);
    row.appendChild(removeBtn);
    linksContainer.appendChild(row);
  }

  const existingLinks = existingSvc ? getServiceLinks(existingSvc) : [];
  if (existingLinks.length) {
    existingLinks.forEach(l => addLinkRow(l.label === l.url ? '' : l.label, l.url));
  } else {
    addLinkRow();
  }
  root.querySelector('.btn-add-link').addEventListener('click', () => addLinkRow());

  // ── Flag-toggle editor (optional; values selectable from the card dropdown) ──
  const flagsContainer = root.querySelector('.cmd-flags');
  function addFlagRow(label = '', value = '') {
    const row = document.createElement('div');
    row.className = 'cmd-flag-row';
    const labelInput = document.createElement('input');
    labelInput.type = 'text';
    labelInput.className = 'cmd-flag-label';
    labelInput.placeholder = 'Label (e.g. Local Oracle)';
    labelInput.value = label;
    const valueInput = document.createElement('input');
    valueInput.type = 'text';
    valueInput.className = 'cmd-flag-value';
    valueInput.placeholder = 'Value (e.g. local-orcl)';
    valueInput.value = value;
    const removeBtn = document.createElement('button');
    removeBtn.type = 'button';
    removeBtn.className = 'btn-remove-link';
    removeBtn.title = 'Remove flag option';
    removeBtn.textContent = '✕';
    removeBtn.addEventListener('click', () => row.remove());
    row.appendChild(labelInput);
    row.appendChild(valueInput);
    row.appendChild(removeBtn);
    flagsContainer.appendChild(row);
  }
  if (existingSvc && Array.isArray(existingSvc.flagOptions) && existingSvc.flagOptions.length) {
    existingSvc.flagOptions.forEach(o => addFlagRow(o.label || '', o.value || ''));
  }
  root.querySelector('.btn-add-flag').addEventListener('click', () => addFlagRow());

  // Toggle input label field visibility
  root.querySelector('.cmd-requires-input').addEventListener('change', (e) => {
    root.querySelector('.cmd-input-label-row').style.display = e.target.checked ? '' : 'none';
  });

  root.querySelector('.btn-save').addEventListener('click', async () => {
    const name = root.querySelector('.cmd-name').value.trim();
    const desc = root.querySelector('.cmd-desc').value.trim();
    const port = parseInt(root.querySelector('.cmd-port').value) || null;
    const processMatch = root.querySelector('.cmd-process-match').value.trim();
    const start = root.querySelector('.cmd-start').value.trim();
    const stop = root.querySelector('.cmd-stop').value.trim();
    const links = Array.from(root.querySelectorAll('.cmd-link-row'))
      .map(r => ({
        label: r.querySelector('.cmd-link-label').value.trim(),
        url: r.querySelector('.cmd-link-url').value.trim()
      }))
      .filter(l => l.url);
    links.forEach(l => { if (!l.label) l.label = l.url; });
    const requiresInput = root.querySelector('.cmd-requires-input').checked;
    const inputLabel = root.querySelector('.cmd-input-label').value.trim();

    const flagOptions = Array.from(root.querySelectorAll('.cmd-flag-row'))
      .map(r => ({
        label: r.querySelector('.cmd-flag-label').value.trim(),
        value: r.querySelector('.cmd-flag-value').value.trim()
      }))
      .filter(f => f.value);
    flagOptions.forEach(f => { if (!f.label) f.label = f.value; });

    if (!name) { showToast('Name is required', 'error'); return; }

    // Running color — store only if not the default green.
    const runningColorRaw = root.querySelector('.cmd-running-color').value;
    const runningColor = (runningColorRaw && runningColorRaw.toLowerCase() !== '#4ade80') ? runningColorRaw : undefined;

    // Preserve the current selection if still valid, else default to first.
    let flag = existingSvc?.flag;
    if (flagOptions.length && !flagOptions.some(f => f.value === flag)) {
      flag = flagOptions[0].value;
    }
    if (!flagOptions.length) flag = undefined;

    const svc = {
      id: existingSvc?.id || name.toLowerCase().replace(/\s+/g, '-') + '-' + Date.now(),
      name,
      description: desc,
      port,
      processMatch: processMatch || undefined,
      checkType: port ? 'port' : 'command',
      checkCommand: existingSvc?.checkCommand || '',
      dockerName: existingSvc?.dockerName || '',
      startCommand: start,
      stopCommand: stop,
      links,
      url: links[0]?.url || '',
      flagOptions,
      flag,
      runningColor,
      requiresInput,
      inputLabel
    };

    if (existingSvc) {
      const idx = cat.services.findIndex(s => s.id === existingSvc.id);
      if (idx >= 0) cat.services[idx] = svc;
    } else {
      cat.services.push(svc);
    }

    await window.api.saveConfig(config);
    renderSidebar();
    navigateTo(cat.id);
    showToast(existingSvc ? 'Service updated' : 'Service added', 'success');
  });

  root.querySelector('.btn-cancel').addEventListener('click', () => navigateTo(cat.id));

  root.querySelector('.btn-delete').addEventListener('click', async () => {
    if (!confirm(`Delete "${existingSvc.name}"?`)) return;
    cat.services = cat.services.filter(s => s.id !== existingSvc.id);
    await window.api.saveConfig(config);
    renderSidebar();
    navigateTo(cat.id);
    showToast('Service deleted', 'success');
  });

  const content = document.getElementById('content');
  content.innerHTML = '';
  content.appendChild(form);
}

// ── Toast ──
function showToast(msg, type = 'success') {
  const existing = document.querySelector('.toast');
  if (existing) existing.remove();

  const toast = document.createElement('div');
  toast.className = `toast ${type}`;
  toast.textContent = msg;
  document.body.appendChild(toast);

  requestAnimationFrame(() => toast.classList.add('show'));
  const duration = type === 'error' ? 4000 : 3500;
  setTimeout(() => {
    toast.classList.remove('show');
    setTimeout(() => toast.remove(), 300);
  }, duration);
}

// ── Log Viewer ──
let logInterval = null;
let currentLogServiceId = null;

function openLogViewer(svc) {
  const overlay = document.getElementById('log-overlay');
  const nameEl = overlay.querySelector('.log-service-name');
  const dotEl = overlay.querySelector('.log-dot');
  const contentEl = overlay.querySelector('.log-content');

  currentLogServiceId = svc.id;
  nameEl.textContent = svc.name;
  contentEl.textContent = 'Loading logs...';
  overlay.style.display = '';

  // Update dot status
  const isRunning = statuses[svc.id];
  dotEl.className = `log-dot ${isRunning ? 'running' : 'stopped'}`;

  // Fetch and auto-refresh logs
  async function refreshLogs() {
    const logs = await window.api.getServiceLogs(svc.id);
    const wasAtBottom = contentEl.scrollTop + contentEl.clientHeight >= contentEl.scrollHeight - 20;
    contentEl.textContent = logs || '  No logs yet. Start the service to see output.';
    // Update dot
    const running = statuses[svc.id];
    dotEl.className = `log-dot ${running ? 'running' : 'stopped'}`;
    // Auto-scroll if user was at bottom
    if (wasAtBottom) contentEl.scrollTop = contentEl.scrollHeight;
  }

  refreshLogs();
  logInterval = setInterval(refreshLogs, 2000);

  // Close
  overlay.querySelector('#log-close').onclick = closeLogViewer;
  overlay.addEventListener('click', (e) => {
    if (e.target === overlay) closeLogViewer();
  });

  // Clear
  overlay.querySelector('#log-clear').onclick = async () => {
    await window.api.clearServiceLogs(svc.id);
    contentEl.textContent = '  Logs cleared.';
  };
}

function closeLogViewer() {
  const overlay = document.getElementById('log-overlay');
  overlay.style.display = 'none';
  currentLogServiceId = null;
  if (logInterval) { clearInterval(logInterval); logInterval = null; }
}

// ── Start ──
init();
