// ── Standalone log window logic ──
// This window is opened via main.js's openLogWindow() with serviceId/serviceName
// passed as query params. Polls logs same as the in-app overlay and colorizes
// lines using the shared log-colorize.js helpers.
(function () {
  const params = new URLSearchParams(window.location.search);
  const serviceId = params.get('serviceId');
  const serviceName = params.get('serviceName') || serviceId;

  const nameEl = document.getElementById('win-log-name');
  const dotEl = document.getElementById('win-log-dot');
  const contentEl = document.getElementById('win-log-content');
  const timestampEl = document.getElementById('win-log-timestamp');
  const clearBtn = document.getElementById('win-log-clear');

  nameEl.textContent = serviceName;
  document.title = `${serviceName} — Logs`;

  let lastLogLength = 0;

  function formatTimestamp(d) {
    return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
  }

  async function refreshLogs() {
    const logs = await window.api.getServiceLogs(serviceId);
    const wasAtBottom = contentEl.scrollTop + contentEl.clientHeight >= contentEl.scrollHeight - 20;

    if (logs) {
      contentEl.innerHTML = colorizeLogText(logs);
      dotEl.className = 'log-dot running';
      // Only bump the "last message" timestamp when new content actually
      // arrived, so it reflects when the last log line was written, not
      // just when we last polled.
      if (logs.length !== lastLogLength) {
        lastLogLength = logs.length;
        timestampEl.textContent = `Last message: ${formatTimestamp(new Date())}`;
      }
    } else {
      contentEl.textContent = '  No logs yet. Start the service to see output.';
      dotEl.className = 'log-dot stopped';
    }

    if (wasAtBottom) contentEl.scrollTop = contentEl.scrollHeight;
  }

  clearBtn.addEventListener('click', async () => {
    await window.api.clearServiceLogs(serviceId);
    contentEl.textContent = '  Logs cleared.';
    lastLogLength = 0;
    timestampEl.textContent = '';
  });

  refreshLogs();
  setInterval(refreshLogs, 2000);
})();
