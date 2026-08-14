// ── Jira settings panel wiring ──
// Attaches behavior to the Jira section markup already present in the
// #tmpl-settings template (renderer/index.html). Kept separate from
// app.js so the Jira feature's renderer code lives in its own module.
export function initJiraSettings(view, { config, api, showToast }) {
  const jiraBaseUrl = view.querySelector('#jira-base-url');
  const jiraToken = view.querySelector('#jira-token');
  const jiraJql = view.querySelector('#jira-jql');
  const jiraSaveStatus = view.querySelector('#jira-save-status');
  const jiraEnabledToggle = view.querySelector('#jira-enabled-toggle');
  const jiraConfigFields = view.querySelector('#jira-config-fields');
  const jiraCfg = config.settings?.jira || {};

  jiraBaseUrl.value = jiraCfg.baseUrl || '';
  jiraToken.value = jiraCfg.token || '';
  jiraJql.value = jiraCfg.jql || '';

  const enabled = jiraCfg.enabled !== false;
  jiraEnabledToggle.checked = enabled;
  jiraConfigFields.style.display = enabled ? '' : 'none';

  jiraEnabledToggle.addEventListener('change', async () => {
    config.settings.jira = { ...(config.settings.jira || {}), enabled: jiraEnabledToggle.checked };
    jiraConfigFields.style.display = jiraEnabledToggle.checked ? '' : 'none';
    await api.saveConfig(config);
    document.dispatchEvent(new CustomEvent('jira-enabled-changed'));
    showToast(jiraEnabledToggle.checked ? 'Tickets page enabled' : 'Tickets page disabled', 'success');
  });

  view.querySelector('#btn-save-jira').addEventListener('click', async () => {
    config.settings.jira = {
      ...(config.settings.jira || {}),
      baseUrl: jiraBaseUrl.value.trim(),
      token: jiraToken.value.trim(),
      jql: jiraJql.value.trim()
    };
    await api.saveConfig(config);
    jiraSaveStatus.textContent = 'Saved.';
    showToast('Jira settings saved', 'success');
  });
}
