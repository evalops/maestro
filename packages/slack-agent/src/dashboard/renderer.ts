/**
 * Dashboard HTML renderer.
 *
 * Generates a self-contained HTML document from a DashboardSpec.
 * The output includes inline CSS (dark + light themes), Chart.js from CDN,
 * the serialized spec as embedded JSON, and an inline JS renderer that
 * reads the spec and builds the DOM.
 */

import type { DashboardSpec } from "./types.js";

/** Escape HTML special characters to prevent XSS. */
export function escapeHtml(str: string): string {
	return str
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;")
		.replace(/"/g, "&quot;")
		.replace(/'/g, "&#39;");
}

const CHART_JS_CDN =
	"https://cdnjs.cloudflare.com/ajax/libs/Chart.js/4.4.8/chart.umd.min.js";

const COLOR_PALETTE = [
	"#6366f1",
	"#3b82f6",
	"#22c55e",
	"#eab308",
	"#ef4444",
	"#ec4899",
	"#8b5cf6",
	"#14b8a6",
];

/**
 * Generate a complete, self-contained HTML dashboard from a spec.
 */
export function generateDashboardHtml(spec: DashboardSpec): string {
	const safeTitle = escapeHtml(spec.title);
	const safeSubtitle = spec.subtitle ? escapeHtml(spec.subtitle) : "";
	const theme = spec.theme ?? "dark";
	const specJson = JSON.stringify(spec).replace(/<\//g, "<\\/");

	return `<!DOCTYPE html>
<html lang="en" data-theme="${theme}">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>${safeTitle}</title>
<style>
/* ── Theme Variables ─────────────────────────────────── */
[data-theme="dark"] {
  --bg: #0f1117;
  --bg-secondary: #151821;
  --card: #1a1d27;
  --card-hover: #1e2230;
  --border: #2a2d3a;
  --border-subtle: #22252f;
  --text: #e4e4e7;
  --text-secondary: #a1a1aa;
  --muted: #71717a;
  --accent: #6366f1;
  --accent-soft: rgba(99,102,241,0.12);
  --green: #22c55e;
  --green-soft: rgba(34,197,94,0.12);
  --red: #ef4444;
  --red-soft: rgba(239,68,68,0.12);
  --yellow: #eab308;
  --yellow-soft: rgba(234,179,8,0.12);
  --blue: #3b82f6;
  --blue-soft: rgba(59,130,246,0.12);
  --shadow: 0 1px 3px rgba(0,0,0,0.4), 0 1px 2px rgba(0,0,0,0.3);
  --shadow-lg: 0 4px 12px rgba(0,0,0,0.5);
}
[data-theme="light"] {
  --bg: #f8f9fb;
  --bg-secondary: #f0f1f4;
  --card: #ffffff;
  --card-hover: #fafbfc;
  --border: #e4e4e7;
  --border-subtle: #ececef;
  --text: #18181b;
  --text-secondary: #52525b;
  --muted: #71717a;
  --accent: #6366f1;
  --accent-soft: rgba(99,102,241,0.08);
  --green: #16a34a;
  --green-soft: rgba(22,163,74,0.08);
  --red: #dc2626;
  --red-soft: rgba(220,38,38,0.08);
  --yellow: #ca8a04;
  --yellow-soft: rgba(202,138,4,0.08);
  --blue: #2563eb;
  --blue-soft: rgba(37,99,235,0.08);
  --shadow: 0 1px 3px rgba(0,0,0,0.08), 0 1px 2px rgba(0,0,0,0.04);
  --shadow-lg: 0 4px 12px rgba(0,0,0,0.1);
}

/* ── Reset & Base ────────────────────────────────────── */
*, *::before, *::after { margin: 0; padding: 0; box-sizing: border-box; }
body {
  font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', 'Inter', Roboto, sans-serif;
  background: var(--bg);
  color: var(--text);
  padding: 32px 40px;
  min-height: 100vh;
  line-height: 1.5;
  -webkit-font-smoothing: antialiased;
}

/* ── Header ──────────────────────────────────────────── */
.dashboard-header {
  display: flex;
  justify-content: space-between;
  align-items: flex-start;
  margin-bottom: 32px;
  padding-bottom: 24px;
  border-bottom: 1px solid var(--border-subtle);
}
.dashboard-header h1 {
  font-size: 22px;
  font-weight: 700;
  letter-spacing: -0.03em;
  line-height: 1.2;
}
.dashboard-header .subtitle {
  font-size: 13px;
  color: var(--muted);
  margin-top: 6px;
}
.dashboard-header .meta {
  display: flex;
  align-items: center;
  gap: 12px;
  flex-shrink: 0;
}
.theme-toggle {
  background: var(--card);
  border: 1px solid var(--border);
  border-radius: 8px;
  padding: 6px 10px;
  color: var(--muted);
  cursor: pointer;
  font-size: 14px;
  transition: all 0.15s;
}
.theme-toggle:hover { border-color: var(--accent); color: var(--text); }
.badge {
  font-size: 11px;
  padding: 4px 10px;
  border-radius: 999px;
  background: var(--green-soft);
  color: var(--green);
  font-weight: 600;
  letter-spacing: 0.02em;
}
.timestamp {
  font-size: 11px;
  color: var(--muted);
  white-space: nowrap;
}

/* ── Component Container ─────────────────────────────── */
.components { display: flex; flex-direction: column; gap: 24px; }

/* ── Stat Group ──────────────────────────────────────── */
.stat-group {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(180px, 1fr));
  gap: 16px;
}
.stat-card {
  background: var(--card);
  border: 1px solid var(--border);
  border-radius: 12px;
  padding: 20px 22px;
  box-shadow: var(--shadow);
  transition: box-shadow 0.15s, border-color 0.15s;
}
.stat-card:hover {
  box-shadow: var(--shadow-lg);
  border-color: var(--accent);
}
.stat-label {
  font-size: 11px;
  color: var(--muted);
  text-transform: uppercase;
  letter-spacing: 0.06em;
  font-weight: 600;
  margin-bottom: 8px;
}
.stat-value {
  font-size: 28px;
  font-weight: 700;
  letter-spacing: -0.03em;
  line-height: 1.1;
}
.stat-change {
  font-size: 12px;
  margin-top: 6px;
  font-weight: 500;
}
.stat-change.up { color: var(--green); }
.stat-change.down { color: var(--red); }
.stat-change.neutral { color: var(--muted); }

/* ── Card (shared wrapper for chart / table / feed) ─── */
.card {
  background: var(--card);
  border: 1px solid var(--border);
  border-radius: 12px;
  padding: 24px;
  box-shadow: var(--shadow);
}
.card-title {
  font-size: 13px;
  font-weight: 600;
  color: var(--text-secondary);
  text-transform: uppercase;
  letter-spacing: 0.04em;
  margin-bottom: 20px;
}
.chart-container {
  position: relative;
  width: 100%;
  height: 280px;
}
.chart-fallback {
  display: flex;
  align-items: center;
  justify-content: center;
  height: 200px;
  color: var(--muted);
  font-size: 13px;
  border: 1px dashed var(--border);
  border-radius: 8px;
}

/* ── Table ───────────────────────────────────────────── */
.data-table { width: 100%; border-collapse: collapse; }
.data-table th {
  text-align: left;
  font-size: 11px;
  color: var(--muted);
  text-transform: uppercase;
  letter-spacing: 0.05em;
  font-weight: 600;
  padding: 10px 14px;
  border-bottom: 2px solid var(--border);
}
.data-table th.align-center { text-align: center; }
.data-table th.align-right { text-align: right; }
.data-table td {
  font-size: 13px;
  padding: 12px 14px;
  border-bottom: 1px solid var(--border-subtle);
  transition: background 0.1s;
}
.data-table td.align-center { text-align: center; }
.data-table td.align-right { text-align: right; }
.data-table tr:last-child td { border-bottom: none; }
.data-table tr:hover td { background: var(--accent-soft); }

/* ── Activity Feed ───────────────────────────────────── */
.feed-item {
  display: flex;
  align-items: flex-start;
  gap: 12px;
  padding: 12px 0;
  border-bottom: 1px solid var(--border-subtle);
}
.feed-item:last-child { border-bottom: none; }
.feed-dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  margin-top: 6px;
  flex-shrink: 0;
}
.feed-text { font-size: 13px; line-height: 1.5; color: var(--text); }
.feed-time { font-size: 11px; color: var(--muted); margin-top: 3px; }

/* ── Responsive ──────────────────────────────────────── */
@media (max-width: 768px) {
  body { padding: 20px 16px; }
  .stat-group { grid-template-columns: repeat(2, 1fr); }
  .chart-container { height: 220px; }
  .stat-value { font-size: 22px; }
}
@media (max-width: 480px) {
  .stat-group { grid-template-columns: 1fr; }
  .dashboard-header { flex-direction: column; gap: 12px; }
}
</style>
</head>
<body>

<div class="dashboard-header">
  <div>
    <h1>${safeTitle}</h1>
    ${safeSubtitle ? `<div class="subtitle">${safeSubtitle}</div>` : ""}
  </div>
  <div class="meta">
    <span class="timestamp" id="ts"></span>
    <button class="theme-toggle" onclick="toggleTheme()" title="Toggle theme">◑</button>
    <span class="badge">Live</span>
  </div>
</div>

<div class="components" id="components"></div>

<script type="application/json" id="dashboard-spec">${specJson}</script>
<script src="${CHART_JS_CDN}"></script>
<script>
(function() {
  'use strict';

  var COLORS = ${JSON.stringify(COLOR_PALETTE)};
  var spec = JSON.parse(document.getElementById('dashboard-spec').textContent);
  var container = document.getElementById('components');
  var chartInstances = [];

  // Timestamp
  var ts = spec.generatedAt ? new Date(spec.generatedAt).toLocaleString() : new Date().toLocaleString();
  document.getElementById('ts').textContent = ts;

  // Theme toggle
  window.toggleTheme = function() {
    var html = document.documentElement;
    var current = html.getAttribute('data-theme');
    var next = current === 'dark' ? 'light' : 'dark';
    html.setAttribute('data-theme', next);
    // Re-render charts with new theme colors
    rebuildCharts();
  };

  // Escape HTML for data values
  function esc(s) {
    if (typeof s !== 'string') s = String(s == null ? '' : s);
    return s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
  }

  function getColor(i) { return COLORS[i % COLORS.length]; }

  function getChartColors() {
    var isDark = document.documentElement.getAttribute('data-theme') === 'dark';
    return {
      grid: isDark ? 'rgba(255,255,255,0.06)' : 'rgba(0,0,0,0.06)',
      text: isDark ? '#71717a' : '#71717a',
      bg: isDark ? '#1a1d27' : '#ffffff'
    };
  }

  // ── Renderers ──────────────────────────────────────

  function renderStatGroup(comp) {
    var el = document.createElement('div');
    el.className = 'stat-group';
    var items = comp.items || [];
    for (var i = 0; i < items.length; i++) {
      var s = items[i];
      var trend = s.trend || (s.change && s.change.charAt(0) === '+' ? 'up' : s.change && s.change.charAt(0) === '-' ? 'down' : 'neutral');
      el.innerHTML += '<div class="stat-card">'
        + '<div class="stat-label">' + esc(s.label) + '</div>'
        + '<div class="stat-value">' + esc(s.value) + '</div>'
        + (s.change ? '<div class="stat-change ' + trend + '">' + esc(s.change) + '</div>' : '')
        + '</div>';
    }
    return el;
  }

  function renderChart(comp) {
    var wrapper = document.createElement('div');
    wrapper.className = 'card';
    var typeLabel = comp.type.replace('-', ' ').replace(/\\b\\w/g, function(c){ return c.toUpperCase(); });
    wrapper.innerHTML = '<div class="card-title">' + esc(comp.title || typeLabel) + '</div>';

    if (typeof Chart === 'undefined') {
      wrapper.innerHTML += '<div class="chart-fallback">Charts require internet access (Chart.js CDN)</div>';
      return wrapper;
    }

    var cDiv = document.createElement('div');
    cDiv.className = 'chart-container';
    var canvas = document.createElement('canvas');
    cDiv.appendChild(canvas);
    wrapper.appendChild(cDiv);

    chartInstances.push({ canvas: canvas, comp: comp });
    buildChart(canvas, comp);
    return wrapper;
  }

  function buildChart(canvas, comp) {
    var themeColors = getChartColors();
    var chartType, fill = false, datasets, data, options;

    if (comp.type === 'bar-chart') {
      chartType = 'bar';
      datasets = (comp.datasets || []).map(function(ds, i) {
        return { label: ds.label, data: ds.data, backgroundColor: getColor(i), borderRadius: 4 };
      });
      data = { labels: comp.labels || [], datasets: datasets };
      options = {
        responsive: true, maintainAspectRatio: false,
        plugins: { legend: { labels: { color: themeColors.text } } },
        scales: {
          x: { stacked: !!comp.stacked, ticks: { color: themeColors.text }, grid: { color: themeColors.grid } },
          y: { stacked: !!comp.stacked, ticks: { color: themeColors.text }, grid: { color: themeColors.grid } }
        }
      };
    } else if (comp.type === 'line-chart' || comp.type === 'area-chart') {
      chartType = 'line';
      fill = comp.type === 'area-chart';
      datasets = (comp.datasets || []).map(function(ds, i) {
        var c = getColor(i);
        return {
          label: ds.label, data: ds.data, borderColor: c,
          backgroundColor: fill ? c.replace(')', ',0.15)').replace('rgb', 'rgba').replace('#', (function(hex){
            var r = parseInt(hex.slice(1,3),16), g = parseInt(hex.slice(3,5),16), b = parseInt(hex.slice(5,7),16);
            return 'rgba(' + r + ',' + g + ',' + b + ',0.15';
          })(c) ? '' : '') : 'transparent',
          fill: fill, tension: 0.3, pointRadius: 3, pointHoverRadius: 6, borderWidth: 2
        };
      });
      // Fix area chart backgroundColor
      if (fill) {
        datasets = (comp.datasets || []).map(function(ds, i) {
          var hex = getColor(i);
          var r = parseInt(hex.slice(1,3),16), g = parseInt(hex.slice(3,5),16), b = parseInt(hex.slice(5,7),16);
          return {
            label: ds.label, data: ds.data, borderColor: hex,
            backgroundColor: 'rgba(' + r + ',' + g + ',' + b + ',0.15)',
            fill: true, tension: 0.3, pointRadius: 3, pointHoverRadius: 6, borderWidth: 2
          };
        });
      }
      data = { labels: comp.labels || [], datasets: datasets };
      options = {
        responsive: true, maintainAspectRatio: false,
        plugins: { legend: { labels: { color: themeColors.text } } },
        scales: {
          x: { ticks: { color: themeColors.text }, grid: { color: themeColors.grid } },
          y: { ticks: { color: themeColors.text }, grid: { color: themeColors.grid } }
        }
      };
    } else if (comp.type === 'pie-chart' || comp.type === 'doughnut-chart') {
      chartType = comp.type === 'doughnut-chart' ? 'doughnut' : 'pie';
      var colors = comp.colors || (comp.labels || []).map(function(_, i) { return getColor(i); });
      data = {
        labels: comp.labels || [],
        datasets: [{ data: comp.data || [], backgroundColor: colors, borderWidth: 0 }]
      };
      options = {
        responsive: true, maintainAspectRatio: false,
        plugins: { legend: { position: 'right', labels: { color: themeColors.text, padding: 16 } } }
      };
    } else {
      return;
    }

    return new Chart(canvas, { type: chartType, data: data, options: options });
  }

  function rebuildCharts() {
    // Destroy existing Chart instances
    Chart.helpers && Chart.helpers.each && Chart.helpers.each(Chart.instances, function(inst) { inst.destroy(); });
    // Fallback destroy
    try {
      for (var id in Chart.instances) { Chart.instances[id].destroy(); }
    } catch(e) {}
    // Rebuild
    for (var i = 0; i < chartInstances.length; i++) {
      var ci = chartInstances[i];
      buildChart(ci.canvas, ci.comp);
    }
  }

  function renderTable(comp) {
    var wrapper = document.createElement('div');
    wrapper.className = 'card';
    var cols = comp.columns || [];
    var rows = comp.rows || [];
    var title = comp.title || 'Data';
    var html = '<div class="card-title">' + esc(title) + '</div>';
    html += '<table class="data-table"><thead><tr>';
    for (var c = 0; c < cols.length; c++) {
      var align = cols[c].align ? ' class="align-' + cols[c].align + '"' : '';
      html += '<th' + align + '>' + esc(cols[c].label) + '</th>';
    }
    html += '</tr></thead><tbody>';
    for (var r = 0; r < rows.length; r++) {
      html += '<tr>';
      for (var c2 = 0; c2 < cols.length; c2++) {
        var val = rows[r][cols[c2].key];
        var align2 = cols[c2].align ? ' class="align-' + cols[c2].align + '"' : '';
        html += '<td' + align2 + '>' + esc(val) + '</td>';
      }
      html += '</tr>';
    }
    html += '</tbody></table>';
    wrapper.innerHTML = html;
    return wrapper;
  }

  function renderActivityFeed(comp) {
    var wrapper = document.createElement('div');
    wrapper.className = 'card';
    var title = comp.title || 'Activity';
    var html = '<div class="card-title">' + esc(title) + '</div>';
    var items = comp.items || [];
    for (var i = 0; i < items.length; i++) {
      var a = items[i];
      var dotColor = a.color || getColor(i);
      html += '<div class="feed-item">'
        + '<div class="feed-dot" style="background:' + esc(dotColor) + '"></div>'
        + '<div>'
        + '<div class="feed-text">' + esc(a.text) + '</div>'
        + (a.time ? '<div class="feed-time">' + esc(a.time) + '</div>' : '')
        + '</div></div>';
    }
    wrapper.innerHTML = html;
    return wrapper;
  }

  // ── Main render loop ───────────────────────────────

  var components = spec.components || [];
  for (var i = 0; i < components.length; i++) {
    var comp = components[i];
    var el = null;
    switch (comp.type) {
      case 'stat-group': el = renderStatGroup(comp); break;
      case 'bar-chart':
      case 'line-chart':
      case 'area-chart':
      case 'pie-chart':
      case 'doughnut-chart': el = renderChart(comp); break;
      case 'table': el = renderTable(comp); break;
      case 'activity-feed': el = renderActivityFeed(comp); break;
      default:
        el = document.createElement('div');
        el.className = 'card';
        el.innerHTML = '<div class="card-title">Unknown component: ' + esc(comp.type) + '</div>';
    }
    if (el) container.appendChild(el);
  }
})();
</script>
</body>
</html>`;
}
