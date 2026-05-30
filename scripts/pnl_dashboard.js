#!/usr/bin/env node
import http from 'node:http';
import { URL } from 'node:url';
import { createDashboardStore } from '../src/analysis/pnlDashboard.js';

const DEFAULTS = {
  liveDb: '/opt/trading-data/charon.sqlite',
  shadowDb: '/opt/trading-data/charon-shadow.sqlite',
  host: '127.0.0.1',
  port: 8787,
};

function parseArgs(argv) {
  const opts = { ...DEFAULTS };
  for (const arg of argv) {
    const match = arg.match(/^--([^=]+)=(.*)$/);
    if (!match) throw new Error(`Unknown argument: ${arg}`);
    const [, key, value] = match;
    if (key === 'live-db') opts.liveDb = value;
    else if (key === 'shadow-db') opts.shadowDb = value;
    else if (key === 'host') opts.host = value;
    else if (key === 'port') opts.port = Number(value);
    else throw new Error(`Unknown argument: ${arg}`);
  }
  if (!Number.isInteger(opts.port) || opts.port <= 0 || opts.port > 65535) throw new Error('--port must be a valid TCP port');
  return opts;
}

function html() {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Charon PnL Dashboard</title>
  <style>
    :root {
      color-scheme: dark;
      --bg: #0d1117;
      --panel: #151b23;
      --panel-2: #1b222d;
      --border: #303845;
      --text: #e6edf3;
      --muted: #8b949e;
      --good: #3fb950;
      --bad: #f85149;
      --warn: #d29922;
      --info: #58a6ff;
      --chip: #222b36;
      --cell-vpad: 7px;
      --row-white-space: nowrap;
    }
    body.rows-roomy {
      --cell-vpad: 11px;
    }
    body.rows-expanded {
      --cell-vpad: 13px;
      --row-white-space: normal;
    }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      background: var(--bg);
      color: var(--text);
      font: 13px/1.45 Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      letter-spacing: 0;
    }
    button, input, select { font: inherit; }
    .topbar {
      position: sticky;
      top: 0;
      z-index: 5;
      display: flex;
      gap: 10px;
      align-items: center;
      padding: 10px 14px;
      background: rgba(13, 17, 23, 0.96);
      border-bottom: 1px solid var(--border);
    }
    .brand { font-weight: 700; font-size: 15px; margin-right: 4px; }
    .pill {
      display: inline-flex;
      align-items: center;
      min-height: 24px;
      padding: 2px 8px;
      border: 1px solid var(--border);
      border-radius: 999px;
      background: var(--chip);
      color: var(--muted);
      white-space: nowrap;
    }
    .pill.good { color: var(--good); }
    .pill.bad { color: var(--bad); }
    .pill.warn { color: var(--warn); }
    .spacer { flex: 1; }
    .wrap { padding: 14px; }
    .filters {
      display: flex;
      flex-wrap: wrap;
      gap: 10px;
      align-items: center;
      margin-bottom: 12px;
    }
    select, input {
      height: 30px;
      color: var(--text);
      background: var(--panel);
      border: 1px solid var(--border);
      border-radius: 6px;
      padding: 0 8px;
    }
    .btn {
      height: 30px;
      color: var(--text);
      background: var(--panel-2);
      border: 1px solid var(--border);
      border-radius: 6px;
      padding: 0 10px;
      cursor: pointer;
    }
    .btn:hover { border-color: var(--info); }
    .tabs {
      display: flex;
      gap: 6px;
      border-bottom: 1px solid var(--border);
      margin-bottom: 12px;
      overflow-x: auto;
    }
    .tab {
      padding: 8px 10px;
      color: var(--muted);
      border: 0;
      border-bottom: 2px solid transparent;
      background: transparent;
      cursor: pointer;
      white-space: nowrap;
    }
    .tab.active {
      color: var(--text);
      border-bottom-color: var(--info);
    }
    .kpis {
      display: grid;
      grid-template-columns: repeat(8, minmax(118px, 1fr));
      gap: 8px;
      margin-bottom: 12px;
    }
    .kpi {
      padding: 10px;
      border: 1px solid var(--border);
      border-radius: 8px;
      background: var(--panel);
      min-width: 0;
    }
    .kpi .label { color: var(--muted); font-size: 11px; text-transform: uppercase; }
    .kpi .value { margin-top: 3px; font-size: 18px; font-weight: 700; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .grid {
      display: grid;
      grid-template-columns: repeat(2, minmax(0, 1fr));
      gap: 12px;
    }
    .panel {
      border: 1px solid var(--border);
      border-radius: 8px;
      background: var(--panel);
      min-width: 0;
    }
    .panel h2 {
      margin: 0;
      padding: 10px 12px;
      border-bottom: 1px solid var(--border);
      font-size: 13px;
    }
    .panel-body { padding: 10px 12px; }
    .banner {
      margin-bottom: 10px;
      padding: 8px 10px;
      color: var(--warn);
      border: 1px solid rgba(210, 153, 34, 0.45);
      background: rgba(210, 153, 34, 0.08);
      border-radius: 6px;
    }
    table {
      width: 100%;
      border-collapse: collapse;
      table-layout: fixed;
    }
    th, td {
      padding: var(--cell-vpad) 8px;
      border-bottom: 1px solid var(--border);
      vertical-align: top;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: var(--row-white-space);
    }
    th {
      position: sticky;
      top: 0;
      z-index: 2;
      background: var(--panel-2);
      color: var(--muted);
      font-size: 11px;
      text-align: left;
      text-transform: uppercase;
      cursor: pointer;
    }
    tr:hover td { background: rgba(88, 166, 255, 0.07); }
    a.chart-link {
      color: var(--info);
      text-decoration: none;
      font-weight: 650;
    }
    a.chart-link:hover { text-decoration: underline; }
    .table-wrap { max-height: calc(100vh - 280px); overflow: auto; border: 1px solid var(--border); border-radius: 8px; }
    .num { text-align: right; font-variant-numeric: tabular-nums; }
    .good { color: var(--good); }
    .bad { color: var(--bad); }
    .muted { color: var(--muted); }
    .drawer {
      position: fixed;
      top: 0;
      right: 0;
      z-index: 10;
      width: min(720px, 100vw);
      height: 100vh;
      overflow: auto;
      transform: translateX(100%);
      transition: transform 160ms ease;
      border-left: 1px solid var(--border);
      background: var(--bg);
      box-shadow: -24px 0 50px rgba(0,0,0,0.35);
    }
    .drawer.open { transform: translateX(0); }
    .drawer-head {
      position: sticky;
      top: 0;
      display: flex;
      align-items: center;
      gap: 8px;
      padding: 12px;
      background: var(--panel);
      border-bottom: 1px solid var(--border);
    }
    pre {
      margin: 0;
      padding: 10px;
      overflow: auto;
      color: var(--text);
      background: #090c10;
      border-radius: 6px;
      border: 1px solid var(--border);
      white-space: pre-wrap;
    }
    @media (max-width: 1100px) {
      .kpis { grid-template-columns: repeat(2, minmax(0, 1fr)); }
      .grid { grid-template-columns: 1fr; }
      th { top: 0; }
    }
  </style>
</head>
<body>
  <div class="topbar">
    <div class="brand">Charon PnL</div>
    <span id="live-pill" class="pill">Live</span>
    <span id="shadow-pill" class="pill">Shadow</span>
    <span id="fresh-pill" class="pill">DB freshness</span>
    <span id="counts-pill" class="pill">Rows</span>
    <div class="spacer"></div>
    <span id="refresh-pill" class="pill">Never refreshed</span>
    <button class="btn" id="refresh">Refresh</button>
  </div>
  <div class="wrap">
    <div class="filters">
      <label>Source <select id="source"><option value="live">live</option><option value="shadow">shadow</option></select></label>
      <label>Window <select id="window"><option value="all">all</option><option value="24h">24h</option><option value="7d">7d</option><option value="30d">30d</option></select></label>
      <label>From ID <input id="fromId" type="number" value="25" min="1" style="width:84px"></label>
      <label>To ID <input id="toId" type="number" min="1" style="width:84px"></label>
      <label>Rows <select id="rowSize"><option value="compact">compact</option><option value="roomy" selected>roomy</option><option value="expanded">expanded</option></select></label>
      <label><input id="currentOnly" type="checkbox" checked> Current cleaned live cohort</label>
    </div>
    <div class="tabs">
      <button class="tab active" data-tab="pnl">Live PnL</button>
      <button class="tab" data-tab="watch">Live Watch-Dip</button>
      <button class="tab" data-tab="shadow">Shadow Runs</button>
      <button class="tab" data-tab="cohorts">Cohorts</button>
      <button class="tab" data-tab="detail">Position Detail</button>
    </div>
    <div id="banners"></div>
    <div class="kpis" id="kpis"></div>
    <main id="content"></main>
  </div>
  <aside class="drawer" id="drawer">
    <div class="drawer-head">
      <strong id="drawer-title">Position</strong>
      <div class="spacer"></div>
      <button class="btn" id="close-drawer">Close</button>
    </div>
    <div class="panel-body" id="drawer-body"></div>
  </aside>
  <script>
    const state = { tab: 'pnl', source: 'live', sort: ['id', 'desc'], selectedId: null };
    const $ = id => document.getElementById(id);
    const fmt = {
      n: (v, d = 0) => v == null || Number.isNaN(Number(v)) ? 'n/a' : Number(v).toLocaleString(undefined, { maximumFractionDigits: d, minimumFractionDigits: d }),
      sol: v => v == null ? 'n/a' : Number(v).toFixed(4),
      pct: v => v == null ? 'n/a' : Number(v).toFixed(1) + '%',
      dt: v => v ? new Date(Number(v)).toLocaleString() : 'n/a',
      age: ms => {
        if (ms == null) return 'n/a';
        const m = Math.round(Number(ms) / 60000);
        if (m < 90) return m + 'm';
        const h = Math.round(m / 60);
        if (h < 72) return h + 'h';
        return Math.round(h / 24) + 'd';
      }
    };
    async function api(path) {
      const res = await fetch(path);
      const body = await res.json();
      if (!res.ok) throw new Error(body.error || res.statusText);
      return body;
    }
    function params(extra = {}) {
      const p = new URLSearchParams();
      p.set('source', $('source').value);
      p.set('window', $('window').value);
      if ($('fromId').value) p.set('fromId', $('fromId').value);
      if ($('toId').value) p.set('toId', $('toId').value);
      if ($('currentOnly').checked && $('source').value === 'live') p.set('currentOnly', '1');
      for (const [k, v] of Object.entries(extra)) if (v != null && v !== '') p.set(k, v);
      return p.toString();
    }
    function pill(id, text, cls) {
      const el = $(id);
      el.textContent = text;
      el.className = 'pill' + (cls ? ' ' + cls : '');
    }
    function kpi(label, value, cls = '') {
      return '<div class="kpi"><div class="label">' + label + '</div><div class="value ' + cls + '">' + value + '</div></div>';
    }
    function escapeHtml(value) {
      return String(value ?? '').replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));
    }
    function gmgnUrl(mint) {
      return 'https://gmgn.ai/sol/token/' + encodeURIComponent(mint || '');
    }
    function applyRowSize() {
      document.body.classList.remove('rows-roomy', 'rows-expanded');
      const value = $('rowSize').value;
      if (value === 'roomy') document.body.classList.add('rows-roomy');
      if (value === 'expanded') document.body.classList.add('rows-expanded');
    }
    function renderTable(rows, columns, onClick) {
      if (!rows.length) return '<div class="panel-body muted">No rows.</div>';
      const head = '<tr>' + columns.map(c => '<th data-sort="' + c.key + '">' + c.label + '</th>').join('') + '</tr>';
      const body = rows.map(row => '<tr data-id="' + (row.id || '') + '">' + columns.map(c => {
        const rendered = c.render ? c.render(row) : row[c.key];
        return '<td class="' + (c.cls || '') + '">' + (c.raw ? rendered : escapeHtml(rendered)) + '</td>';
      }).join('') + '</tr>').join('');
      setTimeout(() => {
        document.querySelectorAll('th[data-sort]').forEach(th => th.onclick = () => { state.sort = [th.dataset.sort, state.sort[0] === th.dataset.sort && state.sort[1] === 'desc' ? 'asc' : 'desc']; refresh(); });
        if (onClick) document.querySelectorAll('tr[data-id]').forEach(tr => tr.onclick = () => onClick(tr.dataset.id));
      });
      return '<div class="table-wrap"><table><thead>' + head + '</thead><tbody>' + body + '</tbody></table></div>';
    }
    function applySort(rows) {
      const [key, dir] = state.sort;
      return [...rows].sort((a, b) => {
        const av = a[key], bv = b[key];
        const cmp = typeof av === 'number' || typeof bv === 'number' ? Number(av || 0) - Number(bv || 0) : String(av ?? '').localeCompare(String(bv ?? ''));
        return dir === 'desc' ? -cmp : cmp;
      });
    }
    async function renderSources() {
      const data = await api('/api/sources');
      const live = data.sources.find(s => s.source === 'live');
      const shadow = data.sources.find(s => s.source === 'shadow');
      pill('live-pill', live.available ? 'Live online' : 'Live unavailable', live.available ? 'good' : 'bad');
      pill('shadow-pill', shadow.available ? 'Shadow online' : 'Shadow unavailable', shadow.available ? 'good' : 'bad');
      pill('fresh-pill', live.stale ? 'Live DB stale' : 'Live DB fresh', live.stale ? 'warn' : 'good');
      pill('counts-pill', 'Positions ' + (live.rowCounts?.dry_run_positions ?? 0) + ' / ' + (shadow.rowCounts?.dry_run_positions ?? 0));
      $('refresh-pill').textContent = 'Refreshed ' + new Date(data.generatedAtMs).toLocaleTimeString();
      return data;
    }
    function renderKpis(summary) {
      $('kpis').innerHTML = [
        kpi('Closed', fmt.n(summary.counts.closed)),
        kpi('Open', fmt.n(summary.counts.open)),
        kpi('Win rate', fmt.pct((summary.pnl.winRate ?? 0) * 100), summary.pnl.winRate >= 0.5 ? 'good' : 'bad'),
        kpi('Total SOL', fmt.sol(summary.pnl.totalSol), summary.pnl.totalSol >= 0 ? 'good' : 'bad'),
        kpi('Avg PnL', fmt.pct(summary.pnl.avgPercent), summary.pnl.avgPercent >= 0 ? 'good' : 'bad'),
        kpi('Worst loss', fmt.pct(summary.pnl.worstLossPercent), 'bad'),
        kpi('Best runup', fmt.pct(summary.pnl.bestRunupPercent), 'good'),
        kpi('Watch-dip', summary.watchDip.triggered + ' triggered')
      ].join('');
      const banners = [];
      if (summary.sampleWarning) banners.push(summary.sampleWarning);
      if (summary.watchDip.noActiveWatchDip) banners.push('no active watch-dip rows yet');
      $('banners').innerHTML = banners.map(text => '<div class="banner">' + escapeHtml(text) + '</div>').join('');
    }
    async function renderPnl() {
      const [summary, data] = await Promise.all([
        api('/api/pnl/summary?' + params()),
        api('/api/pnl/positions?' + params({ limit: 500 }))
      ]);
      renderKpis(summary);
      const columns = [
        { key: 'id', label: 'ID', cls: 'num' },
        { key: 'symbol', label: 'Token', render: r => r.symbol || r.mint },
        { key: 'chart', label: 'Chart', raw: true, render: r => '<a class="chart-link" href="' + gmgnUrl(r.mint) + '" target="_blank" rel="noopener noreferrer" onclick="event.stopPropagation()">GMGN</a>' },
        { key: 'openedAtMs', label: 'Opened', render: r => fmt.dt(r.openedAtMs) },
        { key: 'closedAtMs', label: 'Closed', render: r => fmt.dt(r.closedAtMs) },
        { key: 'holdMs', label: 'Hold', render: r => fmt.age(r.holdMs), cls: 'num' },
        { key: 'executionMode', label: 'Mode' },
        { key: 'strategyId', label: 'Strategy' },
        { key: 'sizeSol', label: 'Size', render: r => fmt.sol(r.sizeSol), cls: 'num' },
        { key: 'entryMcap', label: 'Entry MC', render: r => fmt.n(r.entryMcap), cls: 'num' },
        { key: 'highWaterMcap', label: 'High MC', render: r => fmt.n(r.highWaterMcap), cls: 'num' },
        { key: 'exitMcap', label: 'Exit MC', render: r => fmt.n(r.exitMcap), cls: 'num' },
        { key: 'runupPercent', label: 'Runup', render: r => fmt.pct(r.runupPercent), cls: 'num' },
        { key: 'pnlPercent', label: 'PnL %', render: r => fmt.pct(r.pnlPercent), cls: 'num' },
        { key: 'pnlSol', label: 'PnL SOL', render: r => fmt.sol(r.pnlSol), cls: 'num' },
        { key: 'exitReason', label: 'Exit' },
        { key: 'tpPercent', label: 'TP', render: r => fmt.pct(r.tpPercent), cls: 'num' },
        { key: 'slPercent', label: 'SL', render: r => fmt.pct(r.slPercent), cls: 'num' },
        { key: 'riskProfile', label: 'Risk' },
        { key: 'watchType', label: 'Watch' }
      ];
      $('content').innerHTML = renderTable(applySort(data.positions), columns, id => openPosition(id));
    }
    async function renderWatch() {
      const data = await api('/api/watch-dip?' + params());
      $('kpis').innerHTML = [
        kpi('Active', fmt.n(data.summary.active)),
        kpi('Expired', fmt.n(data.summary.expired)),
        kpi('Triggered', fmt.n(data.summary.triggered)),
        kpi('Decision types', fmt.n(data.summary.decisionActions.length))
      ].join('');
      $('banners').innerHTML = data.summary.noActiveWatchDip ? '<div class="banner">no active watch-dip rows yet</div>' : '';
      const columns = [
        { key: 'id', label: 'ID', cls: 'num' },
        { key: 'mint', label: 'Mint' },
        { key: 'watch_type', label: 'Type' },
        { key: 'status', label: 'Status' },
        { key: 'cohort', label: 'Cohort' },
        { key: 'attempt_count', label: 'Attempts', cls: 'num' },
        { key: 'next_check_at_ms', label: 'Next', render: r => fmt.dt(r.next_check_at_ms) },
        { key: 'expires_at_ms', label: 'Expires', render: r => fmt.dt(r.expires_at_ms) },
        { key: 'triggered_position_id', label: 'Position', cls: 'num' },
        { key: 'last_check_reason', label: 'Last reason' }
      ];
      $('content').innerHTML = '<div class="grid"><div class="panel"><h2>Entry Watchlist</h2>' + renderTable(data.rows, columns) + '</div><div class="panel"><h2>Observation Queue</h2><div class="panel-body"><pre>' + escapeHtml(JSON.stringify(data.observationQueue, null, 2)) + '</pre></div></div></div>';
    }
    async function renderShadow() {
      $('source').value = 'shadow';
      const [summary, positions, outcomes] = await Promise.all([
        api('/api/pnl/summary?' + params()),
        api('/api/pnl/positions?' + params({ limit: 300 })),
        api('/api/shadow/outcomes')
      ]);
      renderKpis(summary);
      $('banners').innerHTML = '<div class="banner">' + escapeHtml(outcomes.warning || 'analysis-only shadow data') + '</div>';
      $('content').innerHTML = '<div class="grid"><div class="panel"><h2>Shadow Dry-Run PnL</h2>' + renderTable(applySort(positions.positions), [
        { key: 'id', label: 'ID', cls: 'num' },
        { key: 'symbol', label: 'Token', render: r => r.symbol || r.mint },
        { key: 'chart', label: 'Chart', raw: true, render: r => '<a class="chart-link" href="' + gmgnUrl(r.mint) + '" target="_blank" rel="noopener noreferrer" onclick="event.stopPropagation()">GMGN</a>' },
        { key: 'status', label: 'Status' },
        { key: 'pnlPercent', label: 'PnL %', render: r => fmt.pct(r.pnlPercent), cls: 'num' },
        { key: 'pnlSol', label: 'PnL SOL', render: r => fmt.sol(r.pnlSol), cls: 'num' },
        { key: 'exitReason', label: 'Exit' },
        { key: 'route', label: 'Route' }
      ], id => openPosition(id)) + '</div><div class="panel"><h2>Shadow Observed Outcomes</h2><div class="panel-body"><pre>' + escapeHtml(JSON.stringify(outcomes, null, 2)) + '</pre></div></div></div>';
    }
    async function renderCohorts() {
      const [live, shadow] = await Promise.all([
        api('/api/pnl/cohorts?' + new URLSearchParams({ source: 'live', window: $('window').value, currentOnly: '1' })),
        api('/api/pnl/cohorts?' + new URLSearchParams({ source: 'shadow', window: $('window').value }))
      ]);
      $('kpis').innerHTML = '';
      $('banners').innerHTML = '<div class="banner">live actual trades, shadow dry-run trades, and shadow observed outcomes are separate evidence lanes</div>';
      const panel = (title, value) => '<div class="panel"><h2>' + title + '</h2><div class="panel-body"><pre>' + escapeHtml(JSON.stringify(value, null, 2)) + '</pre></div></div>';
      $('content').innerHTML = '<div class="grid">' + panel('Live Actual Trades', live.panels) + panel('Shadow Dry-Run Trades', shadow.panels) + '</div>';
    }
    function renderDetailEmpty() {
      $('content').innerHTML = '<div class="panel"><h2>Position Detail</h2><div class="panel-body muted">Click a position row to open detail, or enter an ID in the From ID filter and refresh.</div></div>';
    }
    async function openPosition(id) {
      state.selectedId = id;
      const data = await api('/api/pnl/position?' + new URLSearchParams({ source: $('source').value, id }));
      $('drawer-title').textContent = 'Position #' + id + ' ' + (data.position.symbol || '');
      $('drawer-body').innerHTML = '<pre>' + escapeHtml(JSON.stringify(data, null, 2)) + '</pre>';
      $('drawer').classList.add('open');
    }
    async function refresh() {
      try {
        await renderSources();
        if (state.tab === 'pnl') await renderPnl();
        else if (state.tab === 'watch') await renderWatch();
        else if (state.tab === 'shadow') await renderShadow();
        else if (state.tab === 'cohorts') await renderCohorts();
        else renderDetailEmpty();
      } catch (error) {
        $('banners').innerHTML = '<div class="banner">' + escapeHtml(error.message) + '</div>';
      }
    }
    document.querySelectorAll('.tab').forEach(tab => tab.onclick = () => {
      document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
      tab.classList.add('active');
      state.tab = tab.dataset.tab;
      if (state.tab === 'pnl') $('source').value = 'live';
      refresh();
    });
    $('refresh').onclick = refresh;
    $('source').onchange = refresh;
    $('window').onchange = refresh;
    $('fromId').onchange = refresh;
    $('toId').onchange = refresh;
    $('currentOnly').onchange = refresh;
    $('rowSize').onchange = () => { applyRowSize(); refresh(); };
    $('close-drawer').onclick = () => $('drawer').classList.remove('open');
    applyRowSize();
    refresh();
    setInterval(refresh, 45000);
  </script>
</body>
</html>`;
}

function sendJson(res, status, body) {
  const raw = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(raw),
  });
  res.end(raw);
}

function sendHtml(res, body) {
  res.writeHead(200, {
    'content-type': 'text/html; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(body),
  });
  res.end(body);
}

function queryParams(url) {
  return Object.fromEntries(url.searchParams.entries());
}

function createServer(store) {
  return http.createServer((req, res) => {
    try {
      if (req.method !== 'GET') {
        sendJson(res, 405, { error: 'method not allowed' });
        return;
      }
      const url = new URL(req.url, 'http://127.0.0.1');
      if (url.pathname === '/' || url.pathname === '/index.html') return sendHtml(res, html());
      if (url.pathname === '/api/sources') return sendJson(res, 200, store.sources());
      if (url.pathname === '/api/pnl/summary') return sendJson(res, 200, store.summary(queryParams(url)));
      if (url.pathname === '/api/pnl/positions') return sendJson(res, 200, store.positions(queryParams(url)));
      if (url.pathname === '/api/pnl/position') return sendJson(res, 200, store.positionDetail(queryParams(url)));
      if (url.pathname === '/api/pnl/cohorts') return sendJson(res, 200, store.cohorts(queryParams(url)));
      if (url.pathname === '/api/watch-dip') return sendJson(res, 200, store.watchDip(queryParams(url)));
      if (url.pathname === '/api/shadow/outcomes') return sendJson(res, 200, store.shadowOutcomes());
      sendJson(res, 404, { error: 'not found' });
    } catch (error) {
      sendJson(res, error.status || 500, { error: error.message });
    }
  });
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const opts = parseArgs(process.argv.slice(2));
  const store = createDashboardStore({ liveDbPath: opts.liveDb, shadowDbPath: opts.shadowDb });
  const server = createServer(store);
  server.listen(opts.port, opts.host, () => {
    console.log(`Charon PnL dashboard listening on http://${opts.host}:${opts.port}`);
    console.log('Access: viewer-only. No write, config, Telegram, trading, or restart endpoints are exposed.');
  });
  const shutdown = () => {
    server.close(() => {
      store.close();
      process.exit(0);
    });
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

export { createServer, parseArgs };
