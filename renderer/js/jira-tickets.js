// ── Jira tickets view ──
// Renders the "Tickets" page: reads from the local cache (populated by the
// main-process Jira module — see main/jira.js), and provides client-side
// filtering/sorting so no extra Jira requests are needed to slice the data.
// Kept as its own module so the Jira feature's renderer code doesn't live in
// the app.js monolith.

function escapeHtml(str) {
  return String(str ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// Jira instances customize priority names/schemes per project (this one uses
// "None", "4 Low", etc.) so we classify by keyword instead of exact match.
function priorityInfo(name) {
  const n = (name || '').toLowerCase();
  if (/critical|highest|blocker|\b1\b/.test(n)) return { cls: 'critical', rank: 0 };
  if (/\bhigh\b|\b2\b/.test(n)) return { cls: 'high', rank: 1 };
  if (/medium|\b3\b/.test(n)) return { cls: 'medium', rank: 2 };
  if (/lowest|very low|\b5\b/.test(n)) return { cls: 'lowest', rank: 4 };
  if (/\blow\b|\b4\b/.test(n)) return { cls: 'low', rank: 3 };
  return { cls: 'none', rank: 5 };
}

// statusCategory from Jira's API (new/indeterminate/done) is workflow-agnostic,
// but the user wants specific named statuses to have distinct colors within
// the "in progress" category, so check status name first and fall back to
// category-based classification for anything else.
function statusInfo(category, name) {
  const n = (name || '').toLowerCase();
  if (/in\s*development/.test(n)) return { cls: 'dev' };
  if (/ba\s*review/.test(n)) return { cls: 'review' };
  switch (category) {
    case 'new': return { cls: 'todo' };
    case 'indeterminate': return { cls: 'inprogress' };
    case 'done': return { cls: 'done' };
    default: return { cls: 'unknown' };
  }
}

function formatRelativeTime(iso) {
  if (!iso) return 'never';
  const diffMs = Date.now() - new Date(iso).getTime();
  const mins = Math.round(diffMs / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.round(hours / 24);
  return `${days}d ago`;
}

function formatClockTime(iso) {
  if (!iso) return '—';
  return new Date(iso).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
}

// Custom themed dropdown — mirrors the app's existing service-card
// "flag dropdown" pattern (renderer/js/app.js) so filter/sort controls stay
// fully square and on-brand instead of falling back to a native <select>
// (which renders with OS chrome/rounded corners that can't be restyled).
function createDropdown({ options, value, onChange }) {
  const wrap = document.createElement('div');
  wrap.className = 'jira-select';

  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'jira-select-btn';

  const menu = document.createElement('div');
  menu.className = 'jira-select-menu';

  let currentValue = value;

  function setOptions(newOptions) {
    options = newOptions;
    if (!options.some(o => o.value === currentValue)) currentValue = options[0]?.value ?? '';
    renderMenu();
    updateBtnLabel();
  }

  function updateBtnLabel() {
    const opt = options.find(o => o.value === currentValue);
    btn.textContent = opt ? opt.label : '';
  }

  function renderMenu() {
    menu.innerHTML = '';
    options.forEach(opt => {
      const item = document.createElement('div');
      item.className = 'jira-select-item' + (opt.value === currentValue ? ' selected' : '');
      item.textContent = opt.label;
      item.addEventListener('click', (e) => {
        e.stopPropagation();
        currentValue = opt.value;
        renderMenu();
        updateBtnLabel();
        closeMenu();
        onChange(currentValue);
      });
      menu.appendChild(item);
    });
  }

  function closeMenu() { menu.classList.remove('open'); }

  btn.addEventListener('click', (e) => {
    e.stopPropagation();
    document.querySelectorAll('.jira-select-menu.open').forEach(m => { if (m !== menu) m.classList.remove('open'); });
    menu.classList.toggle('open');
  });
  document.addEventListener('click', (e) => {
    if (!wrap.contains(e.target)) closeMenu();
  });

  renderMenu();
  updateBtnLabel();
  wrap.appendChild(btn);
  wrap.appendChild(menu);
  return { el: wrap, setOptions, getValue: () => currentValue };
}

let unsubscribeLiveUpdates = null;

export async function mountTicketsView(contentEl, { config, api, showToast }) {
  if (unsubscribeLiveUpdates) { unsubscribeLiveUpdates(); unsubscribeLiveUpdates = null; }

  contentEl.innerHTML = '';
  const root = document.createElement('div');
  root.className = 'tickets-view';
  root.innerHTML = `
    <div class="tickets-header">
      <h2>
        <span class="tickets-header-icon"><svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 7a2 2 0 0 1 2-2h12a2 2 0 0 1 2 2v2a2 2 0 0 0 0 4v2a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2v-2a2 2 0 0 0 0-4V7z"></path><line x1="13" y1="7" x2="13" y2="9"></line><line x1="13" y1="15" x2="13" y2="17"></line><line x1="13" y1="11" x2="13" y2="13"></line></svg></span>
        Jira Tickets
      </h2>
      <div class="tickets-header-actions">
        <div id="scope-dropdown-slot"></div>
        <button id="btn-refresh-tickets" class="btn-secondary">Refresh</button>
      </div>
    </div>
    <p id="tickets-meta" class="settings-hint"></p>
    <div id="tickets-toolbar" class="tickets-toolbar" style="display:none">
      <input type="text" id="ticket-search" class="ticket-search" placeholder="Search key or summary…">
      <div id="tickets-filters" class="tickets-filters"></div>
    </div>
    <div id="tickets-body"><p class="settings-hint">Loading tickets…</p></div>
  `;
  contentEl.appendChild(root);

  const meta = root.querySelector('#tickets-meta');
  const toolbar = root.querySelector('#tickets-toolbar');
  const filters = root.querySelector('#tickets-filters');
  const body = root.querySelector('#tickets-body');
  const searchInput = root.querySelector('#ticket-search');

  const scopeDropdown = createDropdown({
    options: [
      { value: 'open', label: 'Open Tickets' },
      { value: 'done', label: 'Done Tickets' },
      { value: 'all', label: 'All Tickets' }
    ],
    value: 'open',
    onChange: (scope) => loadScope(scope)
  });
  root.querySelector('#scope-dropdown-slot').appendChild(scopeDropdown.el);

  const statusDropdown = createDropdown({
    options: [{ value: '', label: 'Status: All' }],
    value: '',
    onChange: renderTable
  });
  const priorityDropdown = createDropdown({
    options: [{ value: '', label: 'Priority: All' }],
    value: '',
    onChange: renderTable
  });
  const updatedDropdown = createDropdown({
    options: [
      { value: 'desc', label: 'Updated: Newest first' },
      { value: 'asc', label: 'Updated: Oldest first' }
    ],
    value: 'desc',
    onChange: renderTable
  });
  const sprintDropdown = createDropdown({
    options: [{ value: '', label: 'Sprint: All' }],
    value: '',
    onChange: renderTable
  });
  filters.appendChild(statusDropdown.el);
  filters.appendChild(priorityDropdown.el);
  filters.appendChild(updatedDropdown.el);
  filters.appendChild(sprintDropdown.el);

  let allIssues = [];

  function updateMeta(fetchedAt, requestsToday) {
    meta.textContent = `Last updated ${formatRelativeTime(fetchedAt)} (${formatClockTime(fetchedAt)}) · ${requestsToday ?? 0} Jira request${requestsToday === 1 ? '' : 's'} today`;
  }

  function populateFilterOptions() {
    const statuses = [...new Set(allIssues.map(i => i.status).filter(Boolean))].sort();
    const priorities = [...new Set(allIssues.map(i => i.priority).filter(Boolean))].sort();
    const sprints = [...new Set(allIssues.map(i => i.sprint).filter(Boolean))].sort();
    statusDropdown.setOptions([{ value: '', label: 'Status: All' }, ...statuses.map(s => ({ value: s, label: s }))]);
    priorityDropdown.setOptions([{ value: '', label: 'Priority: All' }, ...priorities.map(p => ({ value: p, label: p }))]);
    sprintDropdown.setOptions([{ value: '', label: 'Sprint: All' }, ...sprints.map(s => ({ value: s, label: s }))]);
  }

  function renderTable() {
    let issues = allIssues.slice();

    const q = searchInput.value.trim().toLowerCase();
    if (q) {
      issues = issues.filter(i => i.key.toLowerCase().includes(q) || i.summary.toLowerCase().includes(q));
    }
    const statusVal = statusDropdown.getValue();
    const priorityVal = priorityDropdown.getValue();
    const sprintVal = sprintDropdown.getValue();
    if (statusVal) issues = issues.filter(i => i.status === statusVal);
    if (priorityVal) issues = issues.filter(i => i.priority === priorityVal);
    if (sprintVal) issues = issues.filter(i => i.sprint === sprintVal);

    const sortDir = updatedDropdown.getValue();
    issues.sort((a, b) => {
      const cmp = new Date(a.updated) - new Date(b.updated);
      return sortDir === 'desc' ? -cmp : cmp;
    });

    if (!issues.length) {
      body.innerHTML = '<p class="settings-hint">No tickets match your filters.</p>';
      return;
    }

    const rows = issues.map(issue => {
      const pInfo = priorityInfo(issue.priority);
      const sInfo = statusInfo(issue.statusCategory, issue.status);
      return `
        <tr>
          <td><a href="#" class="ticket-key" data-url="${escapeHtml(issue.url)}">${escapeHtml(issue.key)}</a></td>
          <td class="ticket-summary">${escapeHtml(issue.summary)}</td>
          <td><button type="button" class="status-badge status-badge--${sInfo.cls} status-badge-btn" data-key="${escapeHtml(issue.key)}">${escapeHtml(issue.status)}</button></td>
          <td><span class="priority-badge priority-badge--${pInfo.cls}">${escapeHtml(issue.priority)}</span></td>
          <td class="ticket-sprint">${escapeHtml(issue.sprint || '—')}</td>
          <td class="ticket-updated" title="${escapeHtml(issue.updated)}">${formatRelativeTime(issue.updated)}</td>
        </tr>
      `;
    }).join('');

    body.innerHTML = `
      <table class="tickets-table">
        <thead>
          <tr><th>Key</th><th>Summary</th><th>Status</th><th>Priority</th><th>Sprint</th><th>Updated</th></tr>
        </thead>
        <tbody>${rows}</tbody>
      </table>
    `;
    body.querySelectorAll('.ticket-key').forEach(a => {
      a.addEventListener('click', (e) => {
        e.preventDefault();
        api.openUrl(a.dataset.url);
      });
    });
    body.querySelectorAll('.status-badge-btn').forEach(btn => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        openStatusMenu(btn, btn.dataset.key);
      });
    });
  }

  // Popup menu (opened from a status badge) letting the user pick a new
  // workflow status from the transitions Jira actually allows for that
  // issue, then confirm with an explicit Submit click before it's applied.
  let closeStatusMenu = null;
  async function openStatusMenu(anchorBtn, issueKey) {
    if (closeStatusMenu) closeStatusMenu();

    const menu = document.createElement('div');
    menu.className = 'status-menu';
    menu.innerHTML = '<p class="settings-hint">Loading transitions…</p>';
    document.body.appendChild(menu);

    const positionMenu = () => {
      const rect = anchorBtn.getBoundingClientRect();
      menu.style.top = `${rect.bottom + window.scrollY + 4}px`;
      menu.style.left = `${rect.left + window.scrollX}px`;
    };
    positionMenu();

    const onOutsideClick = (e) => {
      if (!menu.contains(e.target) && e.target !== anchorBtn) teardown();
    };
    function teardown() {
      menu.remove();
      document.removeEventListener('click', onOutsideClick);
      window.removeEventListener('resize', teardown);
      if (closeStatusMenu === teardown) closeStatusMenu = null;
    }
    closeStatusMenu = teardown;
    setTimeout(() => document.addEventListener('click', onOutsideClick), 0);
    window.addEventListener('resize', teardown);

    const result = await api.getJiraTransitions(issueKey);
    if (!result.ok) {
      menu.innerHTML = `<p class="settings-hint">Failed to load statuses: ${escapeHtml(result.error)}</p>`;
      return;
    }
    if (!result.transitions.length) {
      menu.innerHTML = '<p class="settings-hint">No status changes available.</p>';
      return;
    }

    let selected = result.transitions[0];
    menu.innerHTML = `
      <div class="status-menu-options"></div>
      <div class="status-menu-actions">
        <button type="button" class="btn-secondary status-menu-cancel">Cancel</button>
        <button type="button" class="btn-primary status-menu-submit">Submit</button>
      </div>
    `;
    const optionsEl = menu.querySelector('.status-menu-options');
    result.transitions.forEach((t, idx) => {
      const opt = document.createElement('button');
      opt.type = 'button';
      opt.className = 'status-menu-option' + (idx === 0 ? ' selected' : '');
      opt.textContent = t.toStatus || t.name;
      opt.addEventListener('click', () => {
        selected = t;
        optionsEl.querySelectorAll('.status-menu-option').forEach(o => o.classList.remove('selected'));
        opt.classList.add('selected');
      });
      optionsEl.appendChild(opt);
    });

    menu.querySelector('.status-menu-cancel').addEventListener('click', teardown);
    menu.querySelector('.status-menu-submit').addEventListener('click', async () => {
      const submitBtn = menu.querySelector('.status-menu-submit');
      submitBtn.disabled = true;
      submitBtn.textContent = 'Saving…';
      const res = await api.transitionJiraIssue({
        issueKey,
        transitionId: selected.id,
        toStatus: selected.toStatus || selected.name,
        toStatusCategory: selected.toStatusCategory
      });
      teardown();
      if (res.ok) {
        const issue = allIssues.find(i => i.key === issueKey);
        if (issue) {
          issue.status = selected.toStatus || selected.name;
          issue.statusCategory = selected.toStatusCategory;
        }
        populateFilterOptions();
        renderTable();
        showToast(`${issueKey} moved to ${selected.toStatus || selected.name}`, 'success');
      } else {
        showToast(`Failed to update status: ${res.error}`, 'error');
      }
    });
  }

  function applyResult(result) {
    if (!result.ok && !allIssues.length) {
      toolbar.style.display = 'none';
      body.innerHTML = `<p class="settings-hint">Failed to load tickets: ${escapeHtml(result.error)}</p>`;
      updateMeta(result.fetchedAt, result.requestsToday);
      return;
    }
    allIssues = result.issues || allIssues;
    updateMeta(result.fetchedAt, result.requestsToday);
    if (!allIssues.length) {
      toolbar.style.display = 'none';
      body.innerHTML = '<p class="settings-hint">No tickets found.</p>';
      return;
    }
    toolbar.style.display = '';
    populateFilterOptions();
    renderTable();
    if (!result.ok) showToast(`Showing cached tickets — refresh failed: ${result.error}`, 'error');
  }

  searchInput.addEventListener('input', renderTable);

  async function loadScope(scope) {
    body.innerHTML = '<p class="settings-hint">Loading tickets…</p>';
    const cached = await api.getJiraTickets(scope);
    applyResult(cached);
  }

  root.querySelector('#btn-refresh-tickets').addEventListener('click', async () => {
    body.innerHTML = '<p class="settings-hint">Refreshing…</p>';
    const result = await api.refreshJiraTickets(scopeDropdown.getValue());
    applyResult(result);
    if (result.ok) showToast('Tickets refreshed', 'success');
  });

  if (!config.settings?.jira?.baseUrl || !config.settings?.jira?.token) {
    toolbar.style.display = 'none';
    body.innerHTML = '<p class="settings-hint">Jira isn\'t configured yet. Add your Jira base URL and Personal Access Token in Settings.</p>';
    return;
  }

  const cached = await api.getJiraTickets(scopeDropdown.getValue());
  applyResult(cached);

  // Live-update the table if a scheduled auto-refresh completes while this
  // page happens to be open (only apply updates matching the currently
  // selected scope, since auto-refresh fetches all three scopes).
  unsubscribeLiveUpdates = api.onJiraUpdate((result) => {
    if (result.scope && result.scope !== scopeDropdown.getValue()) return;
    applyResult(result);
  });
}
