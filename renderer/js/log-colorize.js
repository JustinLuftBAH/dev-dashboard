// ── Shared log colorizing helper ──
// Loaded as a plain script (not a module) so both the in-app log overlay
// (app.js) and the standalone log window (log-window.js) can use it via a
// global function, without duplicating the coloring rules in two places.
function escapeHtml(str) {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

// Classifies a single log line and returns an HTML string with a class
// applied so CSS can color it. Order matters — more specific patterns first.
function colorizeLogLine(line) {
  const escaped = escapeHtml(line);
  let cls = '';

  if (/^──.*──$/.test(line.trim())) {
    if (/fail|error/i.test(line)) cls = 'log-line-error';
    else if (/succeeded|complete|done/i.test(line)) cls = 'log-line-success';
    else cls = 'log-line-marker';
  } else if (/\b(error|exception|fatal|failed)\b/i.test(line)) {
    cls = 'log-line-error';
  } else if (/\b(warn|warning|deprecated)\b/i.test(line)) {
    cls = 'log-line-warn';
  } else if (/\b(succeeded|success|completed|listening|started|ready)\b/i.test(line)) {
    cls = 'log-line-success';
  } else if (/\b(info|debug)\b/i.test(line)) {
    cls = 'log-line-info';
  }

  return cls ? `<span class="${cls}">${escaped}</span>` : escaped;
}

// Renders a single line as a numbered row: a fixed-width line-number gutter
// plus the colorized content, laid out with flex so numbers stay aligned
// even as content wraps.
function numberedLogLine(line, num) {
  return `<div class="log-line"><span class="log-line-num">${num}</span><span class="log-line-text">${colorizeLogLine(line)}</span></div>`;
}

// Renders a full log blob (newline-separated) into colorized, line-numbered HTML.
function colorizeLogText(text) {
  if (!text) return '';
  const lines = text.split('\n');
  // A trailing empty line from a final newline shouldn't get its own number.
  if (lines.length && lines[lines.length - 1] === '') lines.pop();
  return lines.map((line, i) => numberedLogLine(line, i + 1)).join('');
}
