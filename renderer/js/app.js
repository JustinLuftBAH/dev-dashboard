// ── State ──
let config = null;
let statuses = {};
let uptimes = {};        // serviceId -> start epoch ms (from OS process)
let currentView = null;
let pollTimer = null;
let uptimeTicker = null;
// Track services in loading state: svcId → { action: 'start'|'stop'|'restart', prevStatus: bool, startedAt: number }
const loadingServices = new Map();
// Services that died unexpectedly or failed to start. Cleared when the user
// starts them again or they come back up. Drives the red "crashed" card state.
const crashedServices = new Set();

// Surface a service problem loudly: an in-app red toast AND a native OS
// notification (so it's visible even when the dashboard isn't focused).
async function notifyServiceError(svc, title, detail) {
  const body = detail ? String(detail).replace(/\s+/g, ' ').trim().slice(0, 200) : '';
  showToast(`${svc.name}: ${title}${body ? ' — ' + body : ''}`, 'error');
  try { await window.api.notify(`${svc.name} — ${title}`, body || title); } catch {}
}

// Pull the most relevant error line out of a chunk of log text, skipping our
// own "── … ──" marker lines and preferring lines that look like errors.
function extractErrorLine(logText) {
  if (!logText) return '';
  const lines = logText.split('\n').map(l => l.trim())
    .filter(l => l && !l.startsWith('──'));
  const errLine = [...lines].reverse()
    .find(l => /error|exception|fail|cannot|unable|refused|denied|no listener|eof/i.test(l));
  return (errLine || lines[lines.length - 1] || '').slice(0, 200);
}

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
  if (action === 'start' || action === 'restart') crashedServices.delete(svcId);
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
  applyBackgroundColor();
  applyTextColor();
  statuses = await window.api.checkAll();
  uptimes = await window.api.getUptimes();
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
const DEFAULT_BG = "#050510";
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

// Lighten/darken a hex color by an absolute per-channel amount.
function shade(hex, amt) {
  const m = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(hex);
  if (!m) return hex;
  const clamp = (n) => Math.max(0, Math.min(255, n));
  const r = clamp(parseInt(m[1],16) + amt);
  const g = clamp(parseInt(m[2],16) + amt);
  const b = clamp(parseInt(m[3],16) + amt);
  return '#' + [r,g,b].map(n => n.toString(16).padStart(2,'0')).join('');
}

// ── App text color (main text; dim/dark variants derived) ──
function applyTextColor() {
  const base = config.settings?.textColor;
  const root = document.documentElement.style;
  if (!base) {
    ['--text','--text-dim','--text-dark'].forEach(v => root.removeProperty(v));
    return;
  }
  if (!/^#?([a-f\d]{6})$/i.test(base)) return;
  root.setProperty('--text', base);
  root.setProperty('--text-dim', shade(base, -100));
  root.setProperty('--text-dark', shade(base, -150));
}

// ── App background color (the deep base; lighter shades are derived) ──
function applyBackgroundColor() {
  const base = config.settings?.backgroundColor;
  // No custom background set => keep the original CSS defaults (don't override).
  if (!base) {
    const root = document.documentElement.style;
    ['--bg-deep','--bg','--bg-card','--bg-card-solid','--bg-input'].forEach(v => root.removeProperty(v));
    return;
  }
  if (!/^#?([a-f\d]{6})$/i.test(base)) return;
  const root = document.documentElement.style;
  root.setProperty('--bg-deep', base);
  root.setProperty('--bg', shade(base, 6));
  root.setProperty('--bg-card', shade(base, 14));
  root.setProperty('--bg-card-solid', shade(base, 22));
  root.setProperty('--bg-input', shade(base, 4));
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

// ── Category context menu (right-click a sidebar category) ──
let _activeContextMenu = null;
let _contextMenuBtn = null;
function closeContextMenu() {
  if (_contextMenuBtn) { _contextMenuBtn.classList.remove('context-active'); _contextMenuBtn = null; }
  if (_activeContextMenu) { _activeContextMenu.remove(); _activeContextMenu = null; }
}
document.addEventListener('mousedown', (e) => {
  if (_activeContextMenu && !_activeContextMenu.contains(e.target)) closeContextMenu();
});
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeContextMenu(); });
window.addEventListener('blur', () => closeContextMenu());

function showCategoryContextMenu(x, y, cat, btn) {
  closeContextMenu();
  const menu = document.createElement('div');
  menu.className = 'context-menu';

  const mkItem = (label, handler) => {
    const item = document.createElement('button');
    item.className = 'context-menu-item';
    item.textContent = label;
    item.addEventListener('click', async (ev) => {
      ev.stopPropagation();
      closeContextMenu();
      await handler();
    });
    return item;
  };

  menu.appendChild(mkItem('▶  Start all', () => startAllInCategory(cat)));
  menu.appendChild(mkItem('■  Stop all', () => stopAllInCategory(cat)));

  document.body.appendChild(menu);
  const rect = menu.getBoundingClientRect();
  menu.style.left = Math.min(x, window.innerWidth - rect.width - 8) + 'px';
  menu.style.top = Math.min(y, window.innerHeight - rect.height - 8) + 'px';
  _activeContextMenu = menu;

  // Keep the right-clicked category highlighted while the menu is open.
  if (btn) { btn.classList.add('context-active'); _contextMenuBtn = btn; }
}

// Mark a (possibly on-screen) service card as loading for a start/stop action.
function markServiceLoading(svc, action) {
  if (action === 'start' || action === 'restart') crashedServices.delete(svc.id);
  const card = document.querySelector(`.service-card[data-service-id="${svc.id}"]`);
  if (card) {
    setCardLoading(card, svc.id, action);
  } else {
    loadingServices.set(svc.id, { action, prevStatus: !!statuses[svc.id], startedAt: Date.now() });
  }
}

async function startAllInCategory(cat) {
  const services = cat.services.filter(s => s.type !== 'shortcut' && s.type !== 'build');
  const skipped = [];
  const failed = [];
  let acted = 0;
  for (const svc of services) {
    if (statuses[svc.id]) continue;
    if (svc.requiresInput) { skipped.push(svc.name); continue; }
    markServiceLoading(svc, 'start');
    const res = await window.api.startService(svc);
    if (res && res.ok === false) {
      loadingServices.delete(svc.id);
      crashedServices.add(svc.id);
      failed.push(svc.name);
      notifyServiceError(svc, 'failed to start', res.error);
    } else {
      acted++;
    }
  }
  if (skipped.length) {
    showToast(`${skipped.join(', ')} need manual input — start separately`, 'error');
  } else if (failed.length && acted === 0) {
    showToast(`${cat.name} — ${failed.length} service${failed.length === 1 ? '' : 's'} failed to start`, 'error');
  } else if (acted === 0) {
    showToast(`${cat.name} — nothing to start`, 'info');
  } else {
    showToast(`${cat.name} — starting ${acted} service${acted === 1 ? '' : 's'}`, 'success');
  }
  updateStatusDots();
  updateNavCounts();
}

async function stopAllInCategory(cat) {
  const services = cat.services.filter(s => s.type !== 'shortcut' && s.type !== 'build');
  let acted = 0;
  for (const svc of services) {
    if (!statuses[svc.id]) continue;
    markServiceLoading(svc, 'stop');
    await window.api.stopService(svc);
    acted++;
  }
  if (acted === 0) {
    showToast(`${cat.name} — nothing running`, 'info');
  } else {
    showToast(`${cat.name} — stopping ${acted} service${acted === 1 ? '' : 's'}`, 'success');
  }
  updateStatusDots();
  updateNavCounts();
}

// ── Polling ──
let prevStatuses = {};
function startPolling() {
  if (pollTimer) clearInterval(pollTimer);
  const interval = config.settings?.pollInterval || 5000;
  pollTimer = setInterval(async () => {
    const oldStatuses = { ...statuses };
    statuses = await window.api.checkAll();

    // ── Dead-process / crash detection ──
    // A service that was up and is now down WITHOUT a pending user action
    // (start/stop/restart) died on its own. Flag it and alert the user. Runs
    // BEFORE resolveLoadingStates so a just-completed user stop (still in
    // loadingServices here) isn't misreported as a crash.
    for (const cat of config.categories) {
      for (const svc of cat.services) {
        if (svc.type === 'shortcut' || svc.type === 'build') continue;
        const was = !!oldStatuses[svc.id];
        const now = !!statuses[svc.id];
        if (now) {
          crashedServices.delete(svc.id); // recovered / running again
        } else if (was && !loadingServices.has(svc.id) && !crashedServices.has(svc.id)) {
          crashedServices.add(svc.id);
          let detail = '';
          try { detail = await window.api.getServiceLogs(svc.id, 20); } catch {}
          notifyServiceError(svc, 'stopped unexpectedly', extractErrorLine(detail));
        }
      }
    }

    // Resolve loading states for ALL services (not just visible cards) so that
    // spinners clear even when a linked service lives on another view.
    resolveLoadingStates();

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

    uptimes = await window.api.getUptimes();
    updateStatusDots();
    updateUptimes();
    updateNavCounts();
  }, interval);

  // Tick the displayed timers every 30s so minutes advance between polls.
  if (uptimeTicker) clearInterval(uptimeTicker);
  uptimeTicker = setInterval(updateUptimes, 30000);
}

// Format elapsed ms as H:MM (no seconds).
function formatUptime(startMs) {
  if (!startMs) return '';
  let mins = Math.floor((Date.now() - startMs) / 60000);
  if (mins < 0) mins = 0;
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  return `${h}:${String(m).padStart(2, '0')}`;
}

// Update each visible card's uptime label from `uptimes`.
function updateUptimes() {
  document.querySelectorAll('.service-card').forEach(card => {
    if (card.classList.contains('build-card')) return; // uses "Last built", not uptime
    const id = card.dataset.serviceId;
    if (!id) return;
    const el = card.querySelector('.uptime');
    if (!el) return;
    const start = uptimes[id];
    if (statuses[id] && start) {
      el.textContent = '⏱ ' + formatUptime(start);
      el.style.display = '';
    } else {
      el.style.display = 'none';
    }
  });
}

// ── Sidebar ──
function renderSidebar() {
  const nav = document.getElementById('nav-items');
  nav.innerHTML = '';

  config.categories.forEach(cat => {
    const btn = document.createElement('button');
    btn.className = 'nav-btn';
    btn.dataset.catId = cat.id;
    btn.draggable = true;
    btn.innerHTML = `
      <span class="nav-icon">${cat.icon}</span>
      <span class="nav-label">${cat.name}</span>
      <span class="nav-count" data-count-id="${cat.id}"></span>
    `;
    btn.addEventListener('click', () => navigateTo(cat.id));
    nav.appendChild(btn);
  });

  // ── Category drag & drop reorder ──
  let draggedNav = null;
  nav.addEventListener('dragstart', (e) => {
    const b = e.target.closest('.nav-btn');
    if (!b) return;
    draggedNav = b;
    b.classList.add('dragging');
    e.dataTransfer.effectAllowed = 'move';
    requestAnimationFrame(() => b.style.opacity = '0.4');
  });
  nav.addEventListener('dragend', () => {
    if (draggedNav) { draggedNav.classList.remove('dragging'); draggedNav.style.opacity = ''; draggedNav = null; }
    nav.querySelectorAll('.drag-over, .drag-over-after').forEach(el => el.classList.remove('drag-over', 'drag-over-after'));
  });
  nav.addEventListener('dragover', (e) => {
    if (!draggedNav) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    const target = e.target.closest('.nav-btn');
    nav.querySelectorAll('.drag-over, .drag-over-after').forEach(el => el.classList.remove('drag-over', 'drag-over-after'));
    if (target && target !== draggedNav) {
      const rect = target.getBoundingClientRect();
      const after = e.clientY > rect.top + rect.height / 2;
      target.classList.add(after ? 'drag-over-after' : 'drag-over');
    }
  });
  nav.addEventListener('dragleave', (e) => {
    const target = e.target.closest('.nav-btn');
    if (target && !target.contains(e.relatedTarget)) target.classList.remove('drag-over', 'drag-over-after');
  });
  nav.addEventListener('drop', async (e) => {
    e.preventDefault();
    const target = e.target.closest('.nav-btn');
    nav.querySelectorAll('.drag-over, .drag-over-after').forEach(el => el.classList.remove('drag-over', 'drag-over-after'));
    if (!target || !draggedNav || target === draggedNav) return;
    const rect = target.getBoundingClientRect();
    const after = e.clientY > rect.top + rect.height / 2;
    const draggedId = draggedNav.dataset.catId;
    const targetId = target.dataset.catId;
    const fromIdx = config.categories.findIndex(c => c.id === draggedId);
    if (fromIdx < 0) return;
    const [moved] = config.categories.splice(fromIdx, 1);
    let insertIdx = config.categories.findIndex(c => c.id === targetId);
    if (insertIdx < 0) { config.categories.splice(fromIdx, 0, moved); return; }
    if (after) insertIdx += 1;
    config.categories.splice(insertIdx, 0, moved);
    await window.api.saveConfig(config);
    renderSidebar();
  });

  // Right-click a category to Start all / Stop all its services.
  if (!nav.dataset.ctxBound) {
    nav.dataset.ctxBound = '1';
    nav.addEventListener('contextmenu', (e) => {
      const btn = e.target.closest('.nav-btn');
      if (!btn) return;
      e.preventDefault();
      const cat = config.categories.find(c => c.id === btn.dataset.catId);
      if (cat) showCategoryContextMenu(e.clientX, e.clientY, cat, btn);
    });
  }

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
    const realServices = cat.services.filter(s => s.type !== 'shortcut' && s.type !== 'build');
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
  // Portaled dropdown menus (see renderCategory) must not survive navigating
  // away from the category that created them.
  document.querySelectorAll('.flag-dropdown-menu').forEach(el => el.remove());
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
    updateUptimes();
  }
}

// ── Category View ──
function renderCategory(cat) {
  // Flag dropdown menus are portaled to <body> (position: fixed) so they can
  // escape a card's local stacking context — clean up any leftovers from the
  // previous render before rebuilding cards, or they'd pile up as orphans.
  document.querySelectorAll('.flag-dropdown-menu').forEach(el => el.remove());

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
  const realServices = cat.services.filter(s => s.type !== 'shortcut' && s.type !== 'build');
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
    } else if (svc.type === 'build') {
      cardEl = createBuildCard(svc, cat);
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

  const clearCardIndicators = () =>
    grid.querySelectorAll('.drag-over, .drag-over-after')
      .forEach(el => el.classList.remove('drag-over', 'drag-over-after'));

  grid.addEventListener('dragend', () => {
    if (draggedEl) {
      draggedEl.classList.remove('dragging');
      draggedEl.style.opacity = '';
      draggedEl = null;
    }
    clearCardIndicators();
  });

  grid.addEventListener('dragover', (e) => {
    if (!draggedEl) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    const target = e.target.closest('.service-card, .shortcut-card');
    clearCardIndicators();
    if (target && target !== draggedEl) {
      const rect = target.getBoundingClientRect();
      const after = e.clientY > rect.top + rect.height / 2;
      target.classList.add(after ? 'drag-over-after' : 'drag-over');
    }
  });

  grid.addEventListener('dragleave', (e) => {
    const target = e.target.closest('.service-card, .shortcut-card');
    // Ignore leaves that move to a child of the same card (avoids flicker)
    if (target && !target.contains(e.relatedTarget)) {
      target.classList.remove('drag-over', 'drag-over-after');
    }
  });

  grid.addEventListener('drop', async (e) => {
    e.preventDefault();
    const target = e.target.closest('.service-card, .shortcut-card');
    clearCardIndicators();
    if (!target || !draggedEl || target === draggedEl) return;

    const rect = target.getBoundingClientRect();
    const after = e.clientY > rect.top + rect.height / 2;
    const draggedId = draggedEl.dataset.serviceId;
    const targetId = target.dataset.serviceId;

    // Reorder by stable id so the result is independent of drag direction.
    const fromIdx = cat.services.findIndex(s => s.id === draggedId);
    if (fromIdx < 0) return;
    const [moved] = cat.services.splice(fromIdx, 1);
    let insertIdx = cat.services.findIndex(s => s.id === targetId);
    if (insertIdx < 0) { cat.services.splice(fromIdx, 0, moved); return; }
    if (after) insertIdx += 1;
    cat.services.splice(insertIdx, 0, moved);

    await window.api.saveConfig(config);
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
      else if (opt.dataset.type === 'build') showBuildForm(cat, null);
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

// ── Custom color picker modal ──
// A themed, centered replacement for the OS's native color-picker window
// (used e.g. for per-flag-option colors) — preset swatches for one-click
// picks, plus a native <input type="color"> for anything custom. `onCommit`
// fires immediately for both swatch clicks and live custom-picker changes.
const COLOR_PICKER_PRESETS = ['#a78bfa', '#818cf8', '#4ade80', '#f472b6', '#fb923c', '#22d3ee', '#f87171', '#fbbf24', '#c9a555'];
function openColorPicker(initialColor, onCommit) {
  let overlay = document.getElementById('color-picker-overlay');
  if (overlay) overlay.remove();

  overlay = document.createElement('div');
  overlay.id = 'color-picker-overlay';

  const panel = document.createElement('div');
  panel.className = 'color-picker-panel';

  const header = document.createElement('div');
  header.className = 'color-picker-header';
  const title = document.createElement('span');
  title.className = 'color-picker-title';
  title.textContent = 'Choose Color';
  const closeBtn = document.createElement('button');
  closeBtn.type = 'button';
  closeBtn.className = 'color-picker-close';
  closeBtn.textContent = '✕';
  header.appendChild(title);
  header.appendChild(closeBtn);

  const body = document.createElement('div');
  body.className = 'color-picker-body';

  const swatchGrid = document.createElement('div');
  swatchGrid.className = 'color-picker-swatches';
  COLOR_PICKER_PRESETS.forEach(hex => {
    const sw = document.createElement('div');
    sw.className = 'color-picker-swatch' + (hex.toLowerCase() === (initialColor || '').toLowerCase() ? ' selected' : '');
    sw.style.background = hex;
    sw.addEventListener('click', () => {
      onCommit(hex);
      closePicker();
    });
    swatchGrid.appendChild(sw);
  });

  const customRow = document.createElement('div');
  customRow.className = 'color-picker-custom-row';
  const customLabel = document.createElement('label');
  customLabel.textContent = 'Custom';
  const customInput = document.createElement('input');
  customInput.type = 'color';
  customInput.value = initialColor || '#4ade80';
  customInput.addEventListener('input', () => onCommit(customInput.value));
  customRow.appendChild(customLabel);
  customRow.appendChild(customInput);

  body.appendChild(swatchGrid);
  body.appendChild(customRow);
  panel.appendChild(header);
  panel.appendChild(body);
  overlay.appendChild(panel);
  document.body.appendChild(overlay);

  function closePicker() {
    overlay.remove();
    document.removeEventListener('keydown', onKeydown);
  }
  function onKeydown(e) { if (e.key === 'Escape') closePicker(); }

  closeBtn.addEventListener('click', closePicker);
  overlay.addEventListener('click', (e) => { if (e.target === overlay) closePicker(); });
  document.addEventListener('keydown', onKeydown);
}

function createServiceCard(svc, cat) {
  const tmpl = document.getElementById('tmpl-service-card');
  const card = tmpl.content.cloneNode(true);
  const root = card.querySelector('.service-card');
  root.draggable = true;

  const isRunning = statuses[svc.id];
  const isCrashed = !isRunning && crashedServices.has(svc.id);
  root.classList.add(isRunning ? 'running' : (isCrashed ? 'crashed' : 'stopped'));
  root.dataset.serviceId = svc.id;
  applyRunningColor(root, svc);

  const dot = card.querySelector('.status-dot');
  dot.classList.add(isRunning ? 'running' : (isCrashed ? 'crashed' : 'stopped'));

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
  // {{flag}} in the start command (e.g. a Spring profile). Custom-built
  // (not a native <select>) so it can be fully themed — macOS renders native
  // <select> popups with its own system menu style that CSS can't override.
  const flagDropdown = card.querySelector('.flag-dropdown');
  if (flagDropdown) {
    if (Array.isArray(svc.flagOptions) && svc.flagOptions.length) {
      const btn = flagDropdown.querySelector('.flag-dropdown-btn');
      const menu = flagDropdown.querySelector('.flag-dropdown-menu');
      let currentValue = svc.flag || svc.flagOptions[0].value;

      const closeMenu = () => { menu.classList.remove('open'); };
      const setBtnDisplay = (opt) => {
        btn.textContent = opt.label || opt.value;
        btn.style.color = opt.color || '';
      };
      const positionMenu = () => {
        const r = btn.getBoundingClientRect();
        menu.style.left = 'auto';
        menu.style.top = (r.bottom + 4) + 'px';
        // Right-align to the button, but clamp so it never runs off-screen.
        let right = window.innerWidth - r.right;
        if (right < 8) right = 8;
        menu.style.right = right + 'px';
      };
      const renderOptions = () => {
        menu.innerHTML = '';
        svc.flagOptions.forEach(opt => {
          const item = document.createElement('div');
          item.className = 'flag-dropdown-item' + (opt.value === currentValue ? ' selected' : '');

          const label = document.createElement('span');
          label.className = 'flag-dropdown-label';
          label.textContent = opt.label || opt.value;
          if (opt.color) label.style.color = opt.color;
          item.appendChild(label);

          if (opt.value === currentValue) {
            const check = document.createElement('span');
            check.className = 'flag-dropdown-check';
            check.textContent = '✓';
            item.appendChild(check);
          }

          item.addEventListener('click', async (e) => {
            e.stopPropagation();
            currentValue = opt.value;
            setBtnDisplay(opt);
            closeMenu();
            const liveSvc = findService(svc.id) || svc;
            liveSvc.flag = currentValue;
            svc.flag = currentValue;
            await window.api.saveConfig(config);
            renderOptions();
            showToast(`${svc.name}: flag set to "${currentValue}"`, 'success');
          });

          // Right-click an option to pick its own color via our themed
          // color-picker modal (not the OS's native color picker window).
          // Purely cosmetic for the dropdown text — it does not affect the
          // card's running-state color.
          item.addEventListener('contextmenu', (e) => {
            e.preventDefault();
            e.stopPropagation();
            openColorPicker(opt.color || '#4ade80', async (color) => {
              opt.color = color;
              label.style.color = color;
              if (opt.value === currentValue) {
                btn.style.color = color;
              }
              const liveSvc = findService(svc.id) || svc;
              const liveOpt = (liveSvc.flagOptions || []).find(o => o.value === opt.value);
              if (liveOpt) liveOpt.color = color;
              await window.api.saveConfig(config);
              showToast(`${opt.label || opt.value}: color updated`, 'success');
            });
          });

          menu.appendChild(item);
        });
      };

      const selectedOpt = svc.flagOptions.find(o => o.value === currentValue) || svc.flagOptions[0];
      btn.textContent = selectedOpt.label || selectedOpt.value;
      renderOptions();

      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        document.querySelectorAll('.flag-dropdown-menu.open').forEach(m => { if (m !== menu) m.classList.remove('open'); });
        const willOpen = !menu.classList.contains('open');
        if (willOpen) positionMenu();
        menu.classList.toggle('open');
      });
      document.addEventListener('click', (e) => {
        if (!flagDropdown.contains(e.target) && !menu.contains(e.target)) closeMenu();
      });
      window.addEventListener('scroll', closeMenu, true);
      window.addEventListener('resize', closeMenu);

      // Menu is positioned fixed to escape any card's local stacking
      // context, so it must live at the document root, not nested inside
      // the card (otherwise cards/tabs rendered later can still paint over
      // it despite a high z-index).
      document.body.appendChild(menu);

      flagDropdown.style.display = '';
    } else {
      flagDropdown.style.display = 'none';
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
    // Defense in depth against spam-clicks landing before the button is
    // actually hidden (e.g. a click already queued by the browser before
    // setCardLoading's display:none takes effect).
    if (loadingServices.has(svc.id)) return;
    setCardLoading(root, svc.id, 'restart');
    showToast(`${svc.name} restarting...`, 'success');
    const res = await window.api.restartService(svc);
    if (res && res.ok === false) {
      loadingServices.delete(svc.id);
      crashedServices.add(svc.id);
      notifyServiceError(svc, 'failed to restart', res.error);
      statuses = await window.api.checkAll();
      updateStatusDots();
      updateNavCounts();
    }
  });

  // Track whether we're in "input mode" for requiresInput services
  let inputMode = false;

  toggleBtn.addEventListener('click', async () => {
    // Defense in depth against spam-clicks landing before the button is hidden.
    if (loadingServices.has(svc.id)) return;
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

    const res = inputVal
      ? await window.api.startService(svc, inputVal)
      : await window.api.startService(svc);
    if (res && res.ok === false) {
      loadingServices.delete(svc.id);
      crashedServices.add(svc.id);
      notifyServiceError(svc, 'failed to start', res.error);
      statuses = await window.api.checkAll();
      updateStatusDots();
      updateNavCounts();
    } else {
      showToast(`${svc.name} starting...`, 'success');
    }
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

// ── Build Card ──
// A "build" is a one-shot compile/package command (e.g. `mvn clean install`)
// rather than a persistent process, so it reuses the service card template
// but with a single "Run" action instead of a Start/Stop toggle. Its dot
// color reflects the outcome of the LAST run (idle/gray, running/spinner,
// success/green, failed/red via the existing crashedServices set) instead of
// a polled "is it up" status.
function createBuildCard(svc, cat) {
  const tmpl = document.getElementById('tmpl-service-card');
  const card = tmpl.content.cloneNode(true);
  const root = card.querySelector('.service-card');
  root.classList.add('build-card');
  root.draggable = true;
  root.dataset.serviceId = svc.id;

  const isBuilding = loadingServices.has(svc.id);
  const isFailed = !isBuilding && crashedServices.has(svc.id);
  root.classList.add(isFailed ? 'crashed' : 'stopped');
  applyRunningColor(root, svc);

  const dot = card.querySelector('.status-dot');
  dot.classList.add(isFailed ? 'crashed' : 'stopped');

  card.querySelector('.service-name').textContent = svc.name;
  card.querySelector('.service-desc').textContent = svc.description;

  // Copy the full build command (with working dir prefix) to clipboard.
  const copyBtn = card.querySelector('.copy-cmd-btn');
  if (copyBtn && svc.buildCommand) {
    copyBtn.style.display = '';
    copyBtn.addEventListener('click', async (e) => {
      e.stopPropagation();
      const cmd = svc.workingDir ? `cd "${svc.workingDir}" && ${svc.buildCommand}` : svc.buildCommand;
      await window.api.copyText(cmd);
      showToast(`Copied ${svc.name} command`, 'info');
    });
  }

  // Click card info area to open the build's log viewer.
  const infoEl = card.querySelector('.card-info');
  infoEl.style.cursor = 'pointer';
  infoEl.addEventListener('click', () => openLogViewer(svc));

  // Flag/uptime/restart controls don't apply to builds — hide them.
  const flagDropdown = card.querySelector('.flag-dropdown');
  if (flagDropdown) flagDropdown.style.display = 'none';
  const restartBtn = card.querySelector('.restart-btn');
  if (restartBtn) restartBtn.style.display = 'none';

  // Repurpose the "uptime" slot to show when this build was last run
  // successfully (EST, date + hour:minute) instead of a running duration.
  const lastBuiltEl = card.querySelector('.uptime');
  const renderLastBuilt = () => {
    if (!lastBuiltEl) return;
    if (svc.lastBuiltAt) {
      const d = new Date(svc.lastBuiltAt);
      const formatted = d.toLocaleString('en-US', {
        timeZone: 'America/New_York',
        month: 'short',
        day: 'numeric',
        hour: 'numeric',
        minute: '2-digit'
      });
      lastBuiltEl.textContent = `Last built: ${formatted} ET`;
      lastBuiltEl.title = d.toString();
    } else {
      lastBuiltEl.textContent = 'Never built';
      lastBuiltEl.title = '';
    }
    lastBuiltEl.style.display = '';
  };
  renderLastBuilt();

  const toggleBtn = card.querySelector('.toggle-btn');
  const cancelBtn = card.querySelector('.cancel-btn');
  const editBtn = card.querySelector('.edit-svc-btn');

  toggleBtn.textContent = 'Run';
  toggleBtn.classList.add('start');

  if (isBuilding) {
    setCardLoading(root, svc.id, 'start');
  }

  editBtn.addEventListener('click', () => showBuildForm(cat, svc));

  cancelBtn.addEventListener('click', async () => {
    await window.api.cancelBuild(svc);
    loadingServices.delete(svc.id);
    crashedServices.add(svc.id);
    showToast(`${svc.name} build cancelled`, 'error');
    refreshCurrentView();
  });

  toggleBtn.addEventListener('click', async () => {
    if (loadingServices.has(svc.id)) return;
    crashedServices.delete(svc.id);
    setCardLoading(root, svc.id, 'start');
    showToast(`${svc.name} building...`, 'success');
    const res = await window.api.runBuild(svc);
    loadingServices.delete(svc.id);
    if (res && res.ok === false) {
      if (!res.cancelled) {
        crashedServices.add(svc.id);
        notifyServiceError(svc, 'build failed', res.error);
      }
    } else {
      showToast(`${svc.name} build succeeded`, 'success');
      svc.lastBuiltAt = Date.now();
      const liveSvc = findService(svc.id) || svc;
      liveSvc.lastBuiltAt = svc.lastBuiltAt;
      await window.api.saveConfig(config);
      renderLastBuilt();
    }
    refreshCurrentView();
  });

  return card;
}

// Resolve loading states for ALL tracked services based on real status/timeout,
// independent of whether their card is currently on screen. This ensures a
// shortcut's spinner clears even when a linked service lives on another view.
function resolveLoadingStates() {
  const timeoutSec = config.settings?.startTimeout ?? 90;
  for (const [id, info] of loadingServices) {
    const isRunning = !!statuses[id];
    const statusChanged = (info.action === 'start' && isRunning) ||
                          (info.action === 'stop' && !isRunning) ||
                          (info.action === 'restart' && isRunning);
    const timedOut = timeoutSec > 0 && (Date.now() - info.startedAt > timeoutSec * 1000);
    if (statusChanged) {
      loadingServices.delete(id);
    } else if (timedOut) {
      loadingServices.delete(id);
      // A start/restart that never came up within the timeout is a failure —
      // flag it and alert (unless the user already stopped it).
      if ((info.action === 'start' || info.action === 'restart') && !isRunning) {
        const svc = findService(id);
        if (svc && !crashedServices.has(id)) {
          crashedServices.add(id);
          window.api.getServiceLogs(id, 20)
            .then(log => notifyServiceError(svc, `didn't start within ${timeoutSec}s`, extractErrorLine(log)))
            .catch(() => notifyServiceError(svc, `didn't start within ${timeoutSec}s`, ''));
        }
      }
    }
  }
}

// A compact fingerprint of a shortcut's visible state (loading + each linked
// service's on/off). Stored on the card so we only rebuild it when it changes.
function shortcutSignature(shortcut) {
  const linked = (shortcut.linkedServiceIds || []).map(x => findService(x)).filter(Boolean);
  const anyLoading = linked.some(s => loadingServices.has(s.id));
  return (anyLoading ? 'L|' : '|') + linked.map(s => `${s.id}:${statuses[s.id] ? 1 : 0}`).join(',');
}

// Keep a shortcut card in sync with its linked services. While any linked
// service is still loading we leave the existing spinner in place; once they
// settle we rebuild the card so counts, tags, button label and the (fresh)
// click handler all reflect the new state.
function syncShortcutCard(card) {
  const id = card.dataset.serviceId;
  const shortcut = findService(id);
  if (!shortcut) return;
  const sig = shortcutSignature(shortcut);
  if (card.dataset.shortcutSig === sig) return;
  card.dataset.shortcutSig = sig;

  const linked = (shortcut.linkedServiceIds || []).map(x => findService(x)).filter(Boolean);
  const anyLoading = linked.some(s => loadingServices.has(s.id));
  if (anyLoading) return; // keep the spinner until linked services settle

  const cat = config.categories.find(c => c.services.some(s => s.id === id));
  const fresh = createShortcutCard(shortcut, cat);
  card.replaceWith(fresh);
}

function updateStatusDots() {
  document.querySelectorAll('.service-card').forEach(card => {
    const id = card.dataset.serviceId;
    if (!id) return;

    // Shortcut cards aggregate their linked services; sync them here so their
    // spinner/label clears once the linked services settle (they used to be
    // skipped entirely, leaving the spinner stuck after Start/Stop All).
    if (card.classList.contains('shortcut-card')) {
      syncShortcutCard(card);
      return;
    }

    // Build cards manage their own dot/button state directly around the
    // run promise — they have no persistent "running" status to poll for.
    if (card.classList.contains('build-card')) return;

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

    card.className = `service-card ${isRunning ? 'running' : (crashedServices.has(id) ? 'crashed' : 'stopped')}`;
    const svcForColor = findService(id);
    if (svcForColor) applyRunningColor(card, svcForColor);
    const dot = card.querySelector('.status-dot');
    if (dot) dot.className = `status-dot ${isRunning ? 'running' : (crashedServices.has(id) ? 'crashed' : 'stopped')}`;

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
        const realSvcs = cat.services.filter(s => s.type !== 'shortcut' && s.type !== 'build');
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
  applyRunningColor(root, shortcut);

  const iconEl = card.querySelector('.shortcut-icon');
  if (iconEl) iconEl.textContent = shortcut.icon || '⚡';

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

  root.dataset.shortcutSig = shortcutSignature(shortcut);

  toggleBtn.addEventListener('click', async () => {
    if (toggleBtn.style.display === 'none') return; // already in progress
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
      const failed = [];
      for (const svc of linked) {
        if (statuses[svc.id]) continue;
        if (svc.requiresInput) {
          skipped.push(svc.name);
          continue;
        }
        loadingServices.set(svc.id, { action: 'start', prevStatus: false, startedAt: Date.now() });
        crashedServices.delete(svc.id);
        const res = await window.api.startService(svc);
        if (res && res.ok === false) {
          loadingServices.delete(svc.id);
          crashedServices.add(svc.id);
          failed.push(svc.name);
          notifyServiceError(svc, 'failed to start', res.error);
        }
      }
      if (skipped.length > 0) {
        showToast(`${skipped.join(', ')} need manual input — start separately`, 'error');
      } else if (failed.length > 0) {
        showToast(`${shortcut.name} — ${failed.join(', ')} failed to start`, 'error');
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
    root.querySelector('.shortcut-running-color').value = existing.runningColor || '#4ade80';
    root.querySelector('.btn-delete').style.display = 'block';
  }

  // Running-color reset button
  const colorInput = root.querySelector('.shortcut-running-color');
  root.querySelector('.btn-reset-color').addEventListener('click', () => {
    colorInput.value = '#4ade80';
  });

  // Icon picker — a small curated set of shortcut-related emojis (no custom input)
  const PRESET_ICONS = ['⚡', '🚀', '🔥', '🎯', '🧩', '🛠️', '📦', '🌐', '🖥️', '🗄️', '▶️', '🔗'];
  let selectedIcon = existing?.icon || '⚡';
  const iconRow = root.querySelector('.emoji-preset-row');
  PRESET_ICONS.forEach(em => {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'emoji-preset' + (em === selectedIcon ? ' active' : '');
    b.textContent = em;
    b.addEventListener('click', () => {
      selectedIcon = em;
      iconRow.querySelectorAll('.emoji-preset').forEach(x => x.classList.remove('active'));
      b.classList.add('active');
    });
    iconRow.appendChild(b);
  });

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
    const realServices = c.services.filter(s => s.type !== 'shortcut' && s.type !== 'build');
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
      icon: selectedIcon,
      linkedServiceIds: checkedIds,
      runningColor: root.querySelector('.shortcut-running-color').value || undefined
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

  // Background color
  const bgColor = view.querySelector('#bg-color');
  const currentBg = config.settings?.backgroundColor || '#050510';
  bgColor.value = currentBg;
  const markActiveBg = (hex) => {
    view.querySelectorAll('.bg-swatch').forEach(s => {
      s.classList.toggle('active', (s.dataset.color || '').toLowerCase() === (hex || '').toLowerCase());
    });
  };
  markActiveBg(currentBg);
  const setBg = async (hex) => {
    config.settings.backgroundColor = hex;
    bgColor.value = hex;
    markActiveBg(hex);
    applyBackgroundColor();
    await window.api.saveConfig(config);
  };
  view.querySelectorAll('.bg-swatch').forEach(s => {
    s.addEventListener('click', () => setBg(s.dataset.color));
  });
  bgColor.addEventListener('input', () => { config.settings.backgroundColor = bgColor.value; applyBackgroundColor(); markActiveBg(bgColor.value); });
  bgColor.addEventListener('change', () => setBg(bgColor.value));

  // Text color
  const textColor = view.querySelector('#text-color');
  const currentText = config.settings?.textColor || '#e0ddf0';
  textColor.value = currentText;
  const markActiveText = (hex) => {
    view.querySelectorAll('.text-swatch').forEach(s => {
      s.classList.toggle('active', (s.dataset.color || '').toLowerCase() === (hex || '').toLowerCase());
    });
  };
  markActiveText(currentText);
  const setText = async (hex) => {
    config.settings.textColor = hex;
    textColor.value = hex;
    markActiveText(hex);
    applyTextColor();
    await window.api.saveConfig(config);
  };
  view.querySelectorAll('.text-swatch').forEach(s => {
    s.addEventListener('click', () => setText(s.dataset.color));
  });
  textColor.addEventListener('input', () => { config.settings.textColor = textColor.value; applyTextColor(); markActiveText(textColor.value); });
  textColor.addEventListener('change', () => setText(textColor.value));

  // Reset appearance (colors + animations only — keeps services)
  view.querySelector('#btn-reset-appearance').addEventListener('click', async () => {
    if (!confirm('Reset appearance (accent, background, text, animations) to defaults? Your services are kept.')) return;
    delete config.settings.themeColor;
    delete config.settings.backgroundColor;
    delete config.settings.textColor;
    config.settings.animationsEnabled = true;
    config.settings.animationSpeed = 1;
    await window.api.saveConfig(config);
    applyThemeColor();
    applyBackgroundColor();
    applyTextColor();
    applyAnimationSettings();
    navigateTo('settings');
    showToast('Appearance reset to default', 'success');
  });

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

  // Wipe all services (removes every category/service — keeps appearance settings)
  view.querySelector('#btn-wipe-services').addEventListener('click', async () => {
    if (!confirm('Wipe ALL categories and services? This cannot be undone. Your appearance settings are kept.')) return;
    config.categories = [];
    await window.api.saveConfig(config);
    statuses = await window.api.checkAll();
    renderSidebar();
    navigateTo('settings');
    showToast('All services wiped', 'success');
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

// ── Build Form ──
function showBuildForm(cat, existing) {
  const tmpl = document.getElementById('tmpl-build-form');
  const form = tmpl.content.cloneNode(true);
  const root = form.querySelector('.command-form');

  if (existing) {
    root.querySelector('.build-name').value = existing.name;
    root.querySelector('.build-desc').value = existing.description || '';
    root.querySelector('.build-dir').value = existing.workingDir || '';
    root.querySelector('.build-command').value = existing.buildCommand || '';
    root.querySelector('.build-running-color').value = existing.runningColor || '#4ade80';
    root.querySelector('.btn-delete').style.display = 'block';
  }

  const colorInput = root.querySelector('.build-running-color');
  root.querySelector('.btn-reset-color').addEventListener('click', () => {
    colorInput.value = '#4ade80';
  });

  root.querySelector('.btn-save').addEventListener('click', async () => {
    const name = root.querySelector('.build-name').value.trim();
    const desc = root.querySelector('.build-desc').value.trim();
    const workingDir = root.querySelector('.build-dir').value.trim();
    const buildCommand = root.querySelector('.build-command').value.trim();

    if (!name) { showToast('Name is required', 'error'); return; }
    if (!buildCommand) { showToast('Build command is required', 'error'); return; }

    const runningColorRaw = root.querySelector('.build-running-color').value;
    const runningColor = (runningColorRaw && runningColorRaw.toLowerCase() !== '#4ade80') ? runningColorRaw : undefined;

    const svc = {
      id: existing?.id || name.toLowerCase().replace(/\s+/g, '-') + '-' + Date.now(),
      type: 'build',
      name,
      description: desc,
      workingDir: workingDir || undefined,
      buildCommand,
      runningColor
    };

    if (existing) {
      const idx = cat.services.findIndex(s => s.id === existing.id);
      if (idx >= 0) cat.services[idx] = svc;
    } else {
      cat.services.push(svc);
    }

    await window.api.saveConfig(config);
    renderSidebar();
    navigateTo(cat.id);
    showToast(existing ? 'Build updated' : 'Build added', 'success');
  });

  root.querySelector('.btn-cancel').addEventListener('click', () => navigateTo(cat.id));

  root.querySelector('.btn-delete').addEventListener('click', async () => {
    if (!confirm(`Delete "${existing.name}"?`)) return;
    cat.services = cat.services.filter(s => s.id !== existing.id);
    await window.api.saveConfig(config);
    renderSidebar();
    navigateTo(cat.id);
    showToast('Build deleted', 'success');
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

// Strip ANSI escape/color codes (e.g. from mvn/npm colored output) — left
// unstripped these render as garbled control-character junk in plain text.
function stripAnsi(text) {
  return (text || '').replace(/\x1b\[[0-9;]*[a-zA-Z]/g, '').replace(/\r/g, '');
}

function escapeHtml(s) {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// Renders raw log text as syntax-highlighted HTML: our own "── … ──" run
// markers, error/warn keywords, and success markers each get a distinct
// color so a run's outcome is scannable at a glance instead of a wall of
// uniform gray text.
function renderLogHTML(rawText) {
  const text = stripAnsi(rawText);
  const lines = text.split('\n');
  return lines.map(line => {
    const escaped = escapeHtml(line);
    if (/^── .*(Starting|Stopping|Building) .* ──$/.test(line)) {
      return `<span class="log-line log-marker-start">${escaped}</span>`;
    }
    if (/^── .*(FAILED|error|Error).* ──$/.test(line) || /^── .*cancelled.* ──$/i.test(line)) {
      return `<span class="log-line log-marker-fail">${escaped}</span>`;
    }
    if (/^── .*(succeeded|completed|signaled completion).* ──$/i.test(line)) {
      return `<span class="log-line log-marker-ok">${escaped}</span>`;
    }
    if (/^──.*──$/.test(line)) {
      return `<span class="log-line log-marker">${escaped}</span>`;
    }
    if (/\b(error|exception|fail(ed|ure)?|cannot|unable|denied|refused)\b/i.test(line)) {
      return `<span class="log-line log-error">${escaped}</span>`;
    }
    if (/\b(warn(ing)?)\b/i.test(line)) {
      return `<span class="log-line log-warn">${escaped}</span>`;
    }
    if (/\b(BUILD SUCCESS|success|started successfully|listening on|running on)\b/i.test(line)) {
      return `<span class="log-line log-success">${escaped}</span>`;
    }
    return `<span class="log-line">${escaped}</span>`;
  }).join('\n');
}

// Condense a raw service log into a short, low-token summary suitable for
// pasting into an AI chat: strips ANSI colors, collapses runs of identical
// lines, keeps only the most recent start/stop attempt (older runs are noise
// for debugging "what's wrong right now"), and caps the size.
function condenseLogsForAI(rawLogs, svcName) {
  if (!rawLogs || !rawLogs.trim()) return `${svcName}: no logs available.`;

  // Strip ANSI escape codes.
  let text = rawLogs.replace(/\x1b\[[0-9;]*m/g, '');

  // Keep only from the last "── [timestamp] Starting/Stopping" marker onward
  // — that's the run the user actually cares about right now.
  const markerRegex = /^── \[.*?\] (Starting|Stopping) /gm;
  let lastMarkerIndex = -1;
  let match;
  while ((match = markerRegex.exec(text)) !== null) lastMarkerIndex = match.index;
  if (lastMarkerIndex > -1) text = text.slice(lastMarkerIndex);

  let lines = text.split('\n').map(l => l.trim()).filter(Boolean);

  // Collapse consecutive duplicate lines (e.g. repeated retry/poll noise)
  // into a single "line (xN)" entry.
  const collapsed = [];
  for (const line of lines) {
    const last = collapsed[collapsed.length - 1];
    if (last && last.text === line) {
      last.count++;
    } else {
      collapsed.push({ text: line, count: 1 });
    }
  }
  lines = collapsed.map(l => l.count > 1 ? `${l.text} (x${l.count})` : l.text);

  // Cap length — keep the tail, since the most recent lines (and any final
  // error) matter most, but always keep the very first "Starting/Stopping"
  // marker line for context.
  const MAX_LINES = 60;
  let out = lines;
  if (lines.length > MAX_LINES) {
    out = [lines[0], '… (truncated) …', ...lines.slice(-1 * (MAX_LINES - 1))];
  }

  const MAX_CHARS = 4000;
  let result = `${svcName} log (condensed):\n` + out.join('\n');
  if (result.length > MAX_CHARS) {
    result = result.slice(0, MAX_CHARS) + '\n… (truncated) …';
  }
  return result;
}

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

  // Copy For AI — condensed, low-token summary of the current run's logs.
  overlay.querySelector('#log-copy-ai').onclick = async () => {
    const logs = await window.api.getServiceLogs(svc.id);
    const condensed = condenseLogsForAI(logs, svc.name);
    await window.api.copyText(condensed);
    showToast('Condensed logs copied for AI', 'success');
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
