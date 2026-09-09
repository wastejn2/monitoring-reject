/**
 * MONITORING REJECT — Dashboard page: multi-select filters, KPI cards,
 * bar chart (reject per line), trend line chart, and a detail table.
 */

function allPlantOptions() {
  return PLANT_ORDER.slice();
}
function allLineOptions() {
  const set = new Set();
  Object.values(PLANT_CONFIG).forEach((lines) => lines.forEach((l) => set.add(l)));
  return Array.from(set).sort();
}

// Line options narrow down to only what's possible for the selected Plant(s)
// (all Plants if none picked yet) — same cascade idea as the input form.
function lineOptionsForPlant(selectedPlant) {
  const plantList = selectedPlant && selectedPlant.length ? selectedPlant : allPlantOptions();
  const set = new Set();
  plantList.forEach((p) => (PLANT_CONFIG[p] || []).forEach((l) => set.add(l)));
  return Array.from(set).sort();
}

// NOTE: deliberately NOT using d.toISOString() here — that formats in UTC,
// and since WIB is UTC+7, any local time between 00:00-06:59 is still
// "yesterday" in UTC, silently pushing every date back by one extra day
// during those hours. Format from the LOCAL y/m/d fields instead so the
// result always matches the calendar date shown on the device's own clock.
function toLocalISODate(d) {
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}
function isoDateDaysAgo(days) {
  const d = new Date();
  d.setDate(d.getDate() - days);
  return toLocalISODate(d);
}

// Same S1/S2/S3 palette the TV board uses, so the Dashboard's comparison
// chart reads as the same visual language once it's broken down by shift.
const SHIFT_COLORS = { '1': '#d8b370', '2': '#c81e3a', '3': '#55091a' };
const SHIFT_LABELS = { '1': 'Shift 1', '2': 'Shift 2', '3': 'Shift 3' };

function aggregateByLine(rows) {
  const map = new Map();
  rows.forEach((r) => {
    if (!map.has(r.line)) map.set(r.line, { line: r.line, plant: r.plant, output: 0, reject: 0 });
    const entry = map.get(r.line);
    entry.output += Number(r.output) || 0;
    entry.reject += Number(r.reject) || 0;
  });
  return Array.from(map.values()).map((e) => ({
    ...e,
    pct: e.output > 0 ? (e.reject / e.output) * 100 : 0
  }));
}

// Same grouping as aggregateByLine/aggregateByPlant, but also splits each
// group's reject total by Shift 1/2/3 — this is what feeds the comparison
// chart's "Semua Shift" breakdown and its per-shift filter.
function aggregateByKeyPerShift(rows, keyField) {
  const map = new Map();
  rows.forEach((r) => {
    const key = r[keyField];
    if (!map.has(key)) {
      const entry = { output: 0, reject: 0, shift: { '1': 0, '2': 0, '3': 0 } };
      entry[keyField] = key;
      map.set(key, entry);
    }
    const entry = map.get(key);
    const rejectVal = Number(r.reject) || 0;
    entry.output += Number(r.output) || 0;
    entry.reject += rejectVal;
    const shiftKey = String(r.shift);
    if (entry.shift[shiftKey] !== undefined) entry.shift[shiftKey] += rejectVal;
  });
  return Array.from(map.values());
}

// Draws the value on top of every bar/segment — same "number above the bar"
// style the TV board uses. When shiftTags is given (the "Semua Shift" view,
// one dataset per shift) it also stamps a small S1/S2/S3 tag near the base
// of each bar, exactly like the TV board's chart does, so the two read as
// the same visual language.
function barShiftValueLabelPlugin(shiftTags) {
  return {
    id: 'barShiftValueLabel',
    afterDatasetsDraw(chart) {
      const ctx = chart.ctx;
      chart.data.datasets.forEach((dataset, dsIndex) => {
        const meta = chart.getDatasetMeta(dsIndex);
        if (meta.hidden) return;
        meta.data.forEach((bar, index) => {
          const value = dataset.data[index];
          if (!value) return;
          const barHeight = bar.base - bar.y;
          ctx.save();
          ctx.textAlign = 'center';
          ctx.fillStyle = '#3a0510';
          ctx.font = '700 11px "Segoe UI", sans-serif';
          ctx.fillText(formatNumberID(value, 1), bar.x, bar.y - 6);
          if (shiftTags && barHeight > 22) {
            ctx.fillStyle = dsIndex === 0 ? '#3a0510' : '#ffffff';
            ctx.font = '700 9.5px "Segoe UI", sans-serif';
            ctx.fillText(shiftTags[dsIndex], bar.x, bar.base - 8);
          }
          ctx.restore();
        });
      });
    }
  };
}

function aggregateByDate(rows) {
  const map = new Map();
  rows.forEach((r) => {
    if (!map.has(r.tanggal)) map.set(r.tanggal, { tanggal: r.tanggal, output: 0, reject: 0 });
    const entry = map.get(r.tanggal);
    entry.output += Number(r.output) || 0;
    entry.reject += Number(r.reject) || 0;
  });
  return Array.from(map.values())
    .map((e) => ({ ...e, pct: e.output > 0 ? (e.reject / e.output) * 100 : 0 }))
    .sort((a, b) => (a.tanggal < b.tanggal ? -1 : 1));
}

const Dashboard = {
  msPlant: null,
  msLine: null,
  barChart: null,
  trendChart: null,
  loaded: false,
  barGroupBy: 'line', // 'line' | 'plant' — which grouping the comparison chart shows
  shiftFilter: 'all', // 'all' | '1' | '2' | '3' — which shift(s) the comparison chart shows
  lastRows: [],

  init() {
    this.els = {
      start: document.getElementById('filter-start'),
      end: document.getElementById('filter-end'),
      applyBtn: document.getElementById('btn-filter-apply'),
      resetBtn: document.getElementById('btn-filter-reset'),
      kpiOutput: document.getElementById('kpi-output'),
      kpiReject: document.getElementById('kpi-reject'),
      kpiPct: document.getElementById('kpi-pct'),
      barCanvas: document.getElementById('chart-bar'),
      barTitle: document.getElementById('chart-bar-title'),
      barHint: document.getElementById('chart-bar-hint'),
      barGroupButtons: Array.from(document.querySelectorAll('#bar-groupby-toggle .seg-btn')),
      barShiftButtons: Array.from(document.querySelectorAll('#bar-shift-toggle .seg-btn')),
      trendCanvas: document.getElementById('chart-trend'),
      emptyBar: document.getElementById('empty-bar'),
      emptyTrend: document.getElementById('empty-trend'),
      emptyTable: document.getElementById('empty-table'),
      tableBody: document.getElementById('table-detail-body')
    };

    this.els.barGroupButtons.forEach((btn) => {
      btn.addEventListener('click', () => {
        if (btn.dataset.group === this.barGroupBy) return;
        this.barGroupBy = btn.dataset.group;
        this.els.barGroupButtons.forEach((b) => b.classList.toggle('active', b === btn));
        const isPlant = this.barGroupBy === 'plant';
        this.els.barTitle.textContent = isPlant ? 'Perbandingan Reject per Plant' : 'Perbandingan Reject per Line';
        this.els.barHint.hidden = !isPlant;
        this.updateBarChart();
      });
    });

    this.els.barShiftButtons.forEach((btn) => {
      btn.addEventListener('click', () => {
        if (btn.dataset.shift === this.shiftFilter) return;
        this.shiftFilter = btn.dataset.shift;
        this.els.barShiftButtons.forEach((b) => b.classList.toggle('active', b === btn));
        this.updateBarChart();
      });
    });

    this.els.end.value = isoDateDaysAgo(0);
    this.els.start.value = isoDateDaysAgo(13);

    this.msPlant = createMultiSelect(document.getElementById('ms-plant'), allPlantOptions());
    this.msLine = createMultiSelect(document.getElementById('ms-line'), allLineOptions());

    // Line narrows down to the selected Plant(s) — same cascade idea as the
    // input form.
    this.msPlant.onChange((selectedPlant) => {
      this.msLine.setOptions(lineOptionsForPlant(selectedPlant));
    });

    this.els.applyBtn.addEventListener('click', () => this.refresh());
    this.els.resetBtn.addEventListener('click', () => {
      this.els.end.value = isoDateDaysAgo(0);
      this.els.start.value = isoDateDaysAgo(13);
      this.msPlant.reset();
      this.msPlant.setOptions(allPlantOptions());
      this.msLine.reset();
      this.msLine.setOptions(allLineOptions());
      this.refresh();
    });
  },

  async refresh() {
    setButtonLoading(this.els.applyBtn, true);
    const res = await Api.getDashboardData({
      startDate: this.els.start.value,
      endDate: this.els.end.value,
      plant: this.msPlant.getSelected(),
      line: this.msLine.getSelected()
    });
    setButtonLoading(this.els.applyBtn, false);

    if (!res.ok) {
      toast(res.error === 'unauthorized' ? 'Sesi berakhir, silakan login kembali.' : 'Gagal memuat data dashboard.', 'error');
      return;
    }

    this.loaded = true;
    this.render(res.rows);
  },

  render(rows) {
    const totalOutput = rows.reduce((s, r) => s + (Number(r.output) || 0), 0);
    const totalReject = rows.reduce((s, r) => s + (Number(r.reject) || 0), 0);
    const avgPct = totalOutput > 0 ? (totalReject / totalOutput) * 100 : 0;

    this.els.kpiOutput.textContent = formatNumberID(totalOutput, 2);
    this.els.kpiReject.textContent = formatNumberID(totalReject, 2);
    this.els.kpiPct.textContent = `${formatNumberID(avgPct, 2)}%`;

    const byLine = aggregateByLine(rows).sort((a, b) => a.line.localeCompare(b.line));
    const byDate = aggregateByDate(rows);

    this.lastRows = rows;
    this.updateBarChart();
    this.renderTrendChart(byDate);
    this.renderTable(byLine);
  },

  // Re-aggregates from the last fetched rows according to the current
  // Per Line / Per Plant toggle (and the Shift filter) and re-renders the
  // comparison chart — no need to hit the server again, the raw rows
  // already have everything, shift breakdown included.
  updateBarChart() {
    const keyField = this.barGroupBy === 'plant' ? 'plant' : 'line';
    const items = aggregateByKeyPerShift(this.lastRows, keyField)
      .sort((a, b) => a[keyField].localeCompare(b[keyField]));
    this.renderBarChart(items, keyField);
  },

  renderBarChart(items, labelKey) {
    this.els.emptyBar.hidden = items.length > 0;
    if (!items.length) {
      if (this.barChart) { this.barChart.destroy(); this.barChart = null; }
      return;
    }
    const labels = items.map((e) => e[labelKey]);

    // "Semua Shift" -> one dataset per shift, colored/tagged just like the
    // TV board's chart. A specific shift -> a single dataset in that
    // shift's own color, so it's still visually obvious which shift it is.
    let datasets, shiftTags;
    if (this.shiftFilter === 'all') {
      datasets = ['1', '2', '3'].map((shiftKey) => ({
        label: SHIFT_LABELS[shiftKey],
        data: items.map((e) => Number((e.shift[shiftKey] || 0).toFixed(3))),
        backgroundColor: SHIFT_COLORS[shiftKey],
        borderRadius: 5,
        maxBarThickness: 50,
        barPercentage: 0.98,
        categoryPercentage: 0.82
      }));
      shiftTags = ['S1', 'S2', 'S3'];
    } else {
      datasets = [{
        label: SHIFT_LABELS[this.shiftFilter],
        data: items.map((e) => Number((e.shift[this.shiftFilter] || 0).toFixed(3))),
        backgroundColor: SHIFT_COLORS[this.shiftFilter],
        borderRadius: 6,
        maxBarThickness: 50,
        barPercentage: 0.98,
        categoryPercentage: 0.82
      }];
      shiftTags = null;
    }

    if (this.barChart) this.barChart.destroy();
    this.barChart = new Chart(this.els.barCanvas.getContext('2d'), {
      type: 'bar',
      data: { labels, datasets },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        animation: { duration: 500, easing: 'easeOutQuart' },
        layout: { padding: { top: 22 } },
        plugins: {
          // Legend stays off even with 3 datasets — the S1/S2/S3 tag drawn
          // right on each bar (see barShiftValueLabelPlugin) already says
          // which shift it is, same reasoning as the TV board's chart.
          legend: { display: false },
          tooltip: {
            backgroundColor: '#3a0510',
            padding: 10,
            cornerRadius: 8,
            callbacks: {
              label: (ctx) => ` ${ctx.dataset.label}: ${formatNumberID(ctx.parsed.y, 2)} Kg`
            }
          }
        },
        scales: {
          x: { grid: { display: false }, ticks: { autoSkip: false, maxRotation: 60, minRotation: 45, font: { size: 10.5 } } },
          y: { grid: { color: '#f1e3e5' }, ticks: { callback: (v) => formatNumberID(v, 0) } }
        }
      },
      plugins: [barShiftValueLabelPlugin(shiftTags)]
    });
  },

  renderTrendChart(byDate) {
    this.els.emptyTrend.hidden = byDate.length > 0;
    if (!byDate.length) {
      if (this.trendChart) { this.trendChart.destroy(); this.trendChart = null; }
      return;
    }
    const labels = byDate.map((e) => formatShortDate(e.tanggal));
    const data = byDate.map((e) => Number(e.pct.toFixed(2)));

    const ctx = this.els.trendCanvas.getContext('2d');
    const gradient = ctx.createLinearGradient(0, 0, 0, 300);
    gradient.addColorStop(0, 'rgba(200, 30, 58, 0.35)');
    gradient.addColorStop(1, 'rgba(200, 30, 58, 0.02)');

    if (this.trendChart) this.trendChart.destroy();
    this.trendChart = new Chart(ctx, {
      type: 'line',
      data: {
        labels,
        datasets: [{
          label: 'Reject (%)',
          data,
          borderColor: '#9c1029',
          backgroundColor: gradient,
          fill: true,
          tension: 0.35,
          pointRadius: 3,
          pointBackgroundColor: '#9c1029',
          pointHoverRadius: 5,
          borderWidth: 2.5
        }]
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        animation: { duration: 500, easing: 'easeOutQuart' },
        plugins: {
          legend: { display: false },
          tooltip: {
            backgroundColor: '#3a0510',
            padding: 10,
            cornerRadius: 8,
            callbacks: { label: (ctx) => ` ${formatNumberID(ctx.parsed.y, 2)}%` }
          }
        },
        scales: {
          x: { grid: { display: false }, ticks: { font: { size: 10.5 } } },
          y: { grid: { color: '#f1e3e5' }, ticks: { callback: (v) => `${formatNumberID(Number(v), 1)}%` } }
        }
      }
    });
  },

  renderTable(byLine) {
    this.els.tableBody.innerHTML = '';
    this.els.emptyTable.hidden = byLine.length > 0;
    const sorted = [...byLine].sort((a, b) => b.reject - a.reject);
    sorted.forEach((e) => {
      const tr = document.createElement('tr');
      tr.innerHTML = `
        <td>${escapeHtml(e.line)}</td>
        <td>${escapeHtml(e.plant)}</td>
        <td>${formatNumberID(e.output, 2)}</td>
        <td>${formatNumberID(e.reject, 2)}</td>
        <td>${formatNumberID(e.pct, 2)}%</td>
      `;
      this.els.tableBody.appendChild(tr);
    });
  }
};

function formatShortDate(iso) {
  const [y, m, d] = iso.split('-');
  return `${d}/${m}`;
}
