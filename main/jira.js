// ── Jira integration module ──
// Self-hosted Jira (Data Center/Server) uses Personal Access Tokens via
// Bearer auth — not the Basic auth + API-token scheme used by Jira Cloud.
//
// To stay well under a small daily API request budget, tickets are cached
// to disk and only re-fetched:
//   1. On a fixed daily schedule (08:00 and 13:00 local time), with
//      catch-up-on-launch if the PC was off at the scheduled time, or
//   2. When the user explicitly clicks "Refresh" in the UI.
//
// Tickets are cached separately per "scope" (open / done / all) so the user
// can switch the Tickets page filter without spending extra API requests —
// each scope only re-fetches when it, specifically, is stale or refreshed.
const { app } = require('electron');
const path = require('path');
const fs = require('fs');
const https = require('https');
const { URL } = require('url');

const CACHE_PATH = path.join(app.getPath('userData'), 'jira-cache.json');
const AUTO_REFRESH_TIMES = ['08:00', '13:00']; // 24h HH:MM, local time
const SCOPES = ['open', 'done', 'all'];
const DEFAULT_SCOPE = 'open';

function emptyScopeEntry() {
  return { issues: [], fetchedAt: null, lastError: null };
}

const DEFAULT_CACHE = {
  scopes: { open: emptyScopeEntry(), done: emptyScopeEntry(), all: emptyScopeEntry() },
  requestLog: [], // ISO timestamps of every Jira request made (for the "requests today" readout)
  lastAutoDate: null, // 'YYYY-MM-DD' — date the auto-refresh slots below last ran
  lastAutoSlots: [] // which of AUTO_REFRESH_TIMES have already run for lastAutoDate
};

function loadCache() {
  try {
    if (fs.existsSync(CACHE_PATH)) {
      const raw = JSON.parse(fs.readFileSync(CACHE_PATH, 'utf8'));
      const merged = { ...DEFAULT_CACHE, ...raw };
      merged.scopes = { ...DEFAULT_CACHE.scopes, ...(raw.scopes || {}) };
      for (const s of SCOPES) merged.scopes[s] = { ...emptyScopeEntry(), ...(merged.scopes[s] || {}) };
      return merged;
    }
  } catch (e) {
    console.error('Error loading Jira cache:', e);
  }
  return JSON.parse(JSON.stringify(DEFAULT_CACHE));
}

function saveCache(cache) {
  try {
    fs.writeFileSync(CACHE_PATH, JSON.stringify(cache, null, 2));
  } catch (e) {
    console.error('Error saving Jira cache:', e);
  }
}

let cache = loadCache();

function pad2(n) { return String(n).padStart(2, '0'); }
function todayKey(d = new Date()) { return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`; }

function requestsToday() {
  const today = todayKey();
  return (cache.requestLog || []).filter(ts => ts.startsWith(today)).length;
}

function normalizeScope(scope) {
  return SCOPES.includes(scope) ? scope : DEFAULT_SCOPE;
}

// Builds the JQL for a given scope, layering the user's base JQL (assignee
// filter etc.) with a resolution constraint. Any resolution clause already
// present in the user's base JQL is stripped first so scope switching always
// works, even if their saved JQL hard-codes "resolution = Unresolved". If the
// JQL contains an ORDER BY, the scope clause is inserted before it.
function jqlForScope(baseJql, scope) {
  let jql = (baseJql || 'assignee = currentUser()').trim();

  // Strip any existing resolution clause (e.g. "AND resolution = Unresolved",
  // "resolution != Unresolved AND", or a lone "resolution = Unresolved").
  jql = jql
    .replace(/\s+AND\s+resolution\s*(=|!=)\s*\S+/gi, '')
    .replace(/resolution\s*(=|!=)\s*\S+\s+AND\s+/gi, '')
    .replace(/^resolution\s*(=|!=)\s*\S+$/i, '')
    .trim();
  if (!jql) jql = 'assignee = currentUser()';

  let clause;
  if (scope === 'open') clause = 'resolution = Unresolved';
  else if (scope === 'done') clause = 'resolution != Unresolved';
  else clause = null; // 'all' — no resolution constraint

  const orderMatch = jql.match(/\border\s+by\b/i);
  const head = orderMatch ? jql.slice(0, orderMatch.index).trim() : jql;
  const tail = orderMatch ? ' ' + jql.slice(orderMatch.index) : ' ORDER BY updated DESC';

  if (!clause) return `${head}${tail}`;
  return `${head} AND ${clause}${tail}`;
}

function jiraRequest(baseUrl, token, apiPath, { method = 'GET', body } = {}) {
  return new Promise((resolve, reject) => {
    let url;
    try {
      url = new URL(apiPath, baseUrl);
    } catch (e) {
      reject(new Error('Invalid Jira base URL'));
      return;
    }
    const payload = body ? JSON.stringify(body) : null;
    const headers = {
      'Authorization': `Bearer ${token}`,
      'Accept': 'application/json'
    };
    if (payload) {
      headers['Content-Type'] = 'application/json';
      headers['Content-Length'] = Buffer.byteLength(payload);
    }
    const req = https.request(url, { method, headers, timeout: 10000 }, (res) => {
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => {
        if (res.statusCode >= 200 && res.statusCode < 300) {
          if (!data) { resolve(null); return; }
          try {
            resolve(JSON.parse(data));
          } catch (e) {
            reject(new Error('Failed to parse Jira response'));
          }
        } else if (res.statusCode === 401 || res.statusCode === 403) {
          reject(new Error('Jira authentication failed — check your Personal Access Token'));
        } else {
          reject(new Error(`Jira request failed (${res.statusCode})`));
        }
      });
    });
    req.on('timeout', () => { req.destroy(new Error('Jira request timed out')); });
    req.on('error', (e) => reject(e));
    if (payload) req.write(payload);
    req.end();
  });
}

// Fetches the set of workflow transitions currently available for an issue
// (e.g. "Start Progress", "Done") so the UI can offer only valid status moves.
async function getIssueTransitions(baseUrl, token, issueKey) {
  const cleanBase = baseUrl.replace(/\/+$/, '');
  const result = await jiraRequest(cleanBase, token, `/rest/api/2/issue/${encodeURIComponent(issueKey)}/transitions`);
  return (result?.transitions || []).map(t => ({
    id: t.id,
    name: t.name,
    toStatus: t.to?.name || '',
    toStatusCategory: t.to?.statusCategory?.key || 'unknown'
  }));
}

// Applies a workflow transition to move an issue to a new status.
async function transitionIssue(baseUrl, token, issueKey, transitionId) {
  const cleanBase = baseUrl.replace(/\/+$/, '');
  await jiraRequest(cleanBase, token, `/rest/api/2/issue/${encodeURIComponent(issueKey)}/transitions`, {
    method: 'POST',
    body: { transition: { id: transitionId } }
  });
}

// Updates a single cached issue's status fields in-place, across whichever
// scope buckets currently contain it, so the UI reflects the change without
// needing a full re-fetch (saving API requests).
function patchCachedIssueStatus(issueKey, status, statusCategory) {
  for (const scope of SCOPES) {
    const entry = cache.scopes[scope];
    const issue = (entry.issues || []).find(i => i.key === issueKey);
    if (issue) {
      issue.status = status;
      issue.statusCategory = statusCategory;
    }
  }
  saveCache(cache);
}

// The Sprint field is a custom field whose ID varies per Jira instance, so
// look it up by name once and cache the ID for the life of the process.
let sprintFieldId = null;
async function resolveSprintFieldId(baseUrl, token) {
  if (sprintFieldId !== null) return sprintFieldId;
  try {
    const cleanBase = baseUrl.replace(/\/+$/, '');
    const fields = await jiraRequest(cleanBase, token, '/rest/api/2/field');
    const match = (fields || []).find(f => /^sprint$/i.test(f.name));
    sprintFieldId = match ? match.id : false;
  } catch (e) {
    sprintFieldId = false; // don't retry every call if lookup fails
  }
  return sprintFieldId;
}

// Jira's sprint custom field returns either an array of plain sprint names,
// an array of objects ({ name, state, ... }), or (on older Data Center
// instances) an array of stringified Java objects like
// "com.atlassian.greenhopper...[id=1,...,name=FY26Q4.4,state=ACTIVE,...]".
// This extracts a readable sprint name from whichever shape shows up, using
// the last entry (most recent/current sprint the issue was placed in).
function parseSprintValue(raw) {
  if (!raw) return '';
  const list = Array.isArray(raw) ? raw : [raw];
  if (!list.length) return '';
  const last = list[list.length - 1];
  if (typeof last === 'object' && last) return last.name || '';
  const str = String(last);
  const nameMatch = str.match(/name=([^,\]]+)/);
  return nameMatch ? nameMatch[1] : str;
}

async function searchJiraIssues(baseUrl, token, jql) {
  if (!baseUrl || !token) throw new Error('Jira base URL and token are required');
  const cleanBase = baseUrl.replace(/\/+$/, '');
  const query = encodeURIComponent(jql || 'assignee = currentUser() AND resolution = Unresolved ORDER BY updated DESC');
  const sprintField = await resolveSprintFieldId(cleanBase, token);
  const fieldList = ['summary', 'status', 'priority', 'updated'];
  if (sprintField) fieldList.push(sprintField);
  const fields = encodeURIComponent(fieldList.join(','));
  const result = await jiraRequest(
    cleanBase,
    token,
    `/rest/api/2/search?jql=${query}&fields=${fields}&maxResults=50`
  );
  return (result.issues || []).map(issue => ({
    key: issue.key,
    url: `${cleanBase}/browse/${issue.key}`,
    summary: issue.fields?.summary || '',
    status: issue.fields?.status?.name || '',
    statusCategory: issue.fields?.status?.statusCategory?.key || 'unknown', // 'new' | 'indeterminate' | 'done'
    priority: issue.fields?.priority?.name || 'None',
    updated: issue.fields?.updated || '',
    sprint: sprintField ? parseSprintValue(issue.fields?.[sprintField]) : ''
  }));
}

// Fetches fresh data from Jira for one scope and updates the on-disk cache.
// Used for both scheduled and manual refreshes so the request log/cache
// stay consistent.
async function refreshTickets(getConfig, scope = DEFAULT_SCOPE) {
  scope = normalizeScope(scope);
  const jiraConfig = getConfig().settings?.jira || {};
  cache.requestLog = [...(cache.requestLog || []), new Date().toISOString()].slice(-500);
  const entry = cache.scopes[scope];
  try {
    const jql = jqlForScope(jiraConfig.jql, scope);
    const issues = await searchJiraIssues(jiraConfig.baseUrl, jiraConfig.token, jql);
    entry.issues = issues;
    entry.fetchedAt = new Date().toISOString();
    entry.lastError = null;
    saveCache(cache);
    return { ok: true, scope, issues, fetchedAt: entry.fetchedAt, requestsToday: requestsToday() };
  } catch (e) {
    entry.lastError = e.message || String(e);
    saveCache(cache);
    return { ok: false, scope, error: entry.lastError, requestsToday: requestsToday() };
  }
}

function getCachedTickets(scope = DEFAULT_SCOPE) {
  scope = normalizeScope(scope);
  const entry = cache.scopes[scope];
  return {
    ok: !entry.lastError,
    scope,
    issues: entry.issues || [],
    fetchedAt: entry.fetchedAt,
    error: entry.lastError,
    requestsToday: requestsToday()
  };
}

function nextAutoRefresh() {
  const now = new Date();
  for (const slot of AUTO_REFRESH_TIMES) {
    const [h, m] = slot.split(':').map(Number);
    const candidate = new Date(now.getFullYear(), now.getMonth(), now.getDate(), h, m, 0, 0);
    if (candidate > now) return candidate.toISOString();
  }
  // All of today's slots have passed — next one is tomorrow's first slot.
  const [h, m] = AUTO_REFRESH_TIMES[0].split(':').map(Number);
  const tomorrow = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1, h, m, 0, 0);
  return tomorrow.toISOString();
}

// Schedules the two daily auto-refreshes. Runs a catch-up refresh immediately
// if today's slot(s) already passed before the app launched (e.g. PC was off
// at 8am), then arranges timers for any remaining slots today and reschedules
// itself for tomorrow. Each slot refreshes all three scopes so the cache is
// warm no matter which one the user picks in the UI.
function scheduleAutoRefresh(getConfig, onRefreshed) {
  const today = todayKey();
  if (cache.lastAutoDate !== today) {
    cache.lastAutoDate = today;
    cache.lastAutoSlots = [];
  }

  const runSlot = async (slot) => {
    if (cache.lastAutoSlots.includes(slot)) return;
    cache.lastAutoSlots = [...cache.lastAutoSlots, slot];
    saveCache(cache);
    for (const scope of SCOPES) {
      const result = await refreshTickets(getConfig, scope);
      if (onRefreshed) onRefreshed(result);
    }
  };

  const now = new Date();
  const pending = [];
  for (const slot of AUTO_REFRESH_TIMES) {
    const [h, m] = slot.split(':').map(Number);
    const slotTime = new Date(now.getFullYear(), now.getMonth(), now.getDate(), h, m, 0, 0);
    if (slotTime <= now) {
      // Missed slot (e.g. PC was off) — catch up as soon as possible.
      if (!cache.lastAutoSlots.includes(slot)) runSlot(slot);
    } else {
      pending.push({ slot, delay: slotTime - now });
    }
  }

  pending.forEach(({ slot, delay }) => setTimeout(() => runSlot(slot), delay));

  // Reschedule at the top of the next day so tomorrow's slots get set up too.
  const midnight = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1, 0, 5, 0, 0);
  setTimeout(() => scheduleAutoRefresh(getConfig, onRefreshed), midnight - now);
}

function registerJiraIpc(ipcMain, getConfig, getMainWindow) {
  ipcMain.handle('jira-get-tickets', (event, scope) => getCachedTickets(scope));

  ipcMain.handle('jira-refresh-tickets', async (event, scope) => {
    return await refreshTickets(getConfig, scope);
  });

  ipcMain.handle('jira-get-status', () => ({
    fetchedAt: cache.scopes[DEFAULT_SCOPE].fetchedAt,
    requestsToday: requestsToday(),
    nextAutoRefresh: nextAutoRefresh(),
    lastError: cache.scopes[DEFAULT_SCOPE].lastError
  }));

  ipcMain.handle('jira-get-transitions', async (event, issueKey) => {
    const jiraConfig = getConfig().settings?.jira || {};
    cache.requestLog = [...(cache.requestLog || []), new Date().toISOString()].slice(-500);
    try {
      const transitions = await getIssueTransitions(jiraConfig.baseUrl, jiraConfig.token, issueKey);
      return { ok: true, transitions, requestsToday: requestsToday() };
    } catch (e) {
      return { ok: false, error: e.message || String(e), requestsToday: requestsToday() };
    }
  });

  ipcMain.handle('jira-transition-issue', async (event, { issueKey, transitionId, toStatus, toStatusCategory }) => {
    const jiraConfig = getConfig().settings?.jira || {};
    cache.requestLog = [...(cache.requestLog || []), new Date().toISOString()].slice(-500);
    try {
      await transitionIssue(jiraConfig.baseUrl, jiraConfig.token, issueKey, transitionId);
      patchCachedIssueStatus(issueKey, toStatus, toStatusCategory);
      return { ok: true, requestsToday: requestsToday() };
    } catch (e) {
      return { ok: false, error: e.message || String(e), requestsToday: requestsToday() };
    }
  });

  scheduleAutoRefresh(getConfig, (result) => {
    const win = getMainWindow();
    if (win && !win.isDestroyed()) {
      win.webContents.send('jira-tickets-updated', result);
    }
  });
}

module.exports = { registerJiraIpc, refreshTickets, getCachedTickets, searchJiraIssues, getIssueTransitions, transitionIssue };
